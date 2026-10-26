import { join } from 'node:path'
import type { FileEntry, JobPlan } from '@shared/types'
import { PARTIAL_SUFFIX } from './fsutil'
import {
  JobRun,
  asJobAbort,
  caseConflicts,
  warnCaseConflict,
  type ExecContext,
  type JobContext,
  type PreparedJob
} from './job'
import { MTIME_TOLERANCE_MS } from './mirror-shared'
import { formatTimestamp, uniqueTimestampName } from './naming'
import { chunkName, packFresh, partBaseName, type PartPlan } from './packaging/parts'
import { computeZipTargets } from './packaging/targets'
import { splitIntoChunks, writeZip } from './packaging/zip'
import { readSnapshotIndex, writeSnapshotIndex } from './snapshot-index'

type ArchivePlan = { base: string; parts: PartPlan[] }

export async function prepareSnapshot(ctx: JobContext): Promise<PreparedJob> {
  const { source, dest } = ctx
  const isCopy = source.packaging === 'copy'
  // zip-whole parts are named after the snapshot timestamp, so their base is filled in later.
  const archives: ArchivePlan[] = isCopy
    ? []
    : computeZipTargets(source, ctx.srcFiles).map((t) => ({
        base: t.base,
        parts: packFresh(t.files, ctx.zip)
      }))
  const partCount = archives.reduce((n, a) => n + a.parts.length, 0)
  const plan: JobPlan = {
    sourceId: source.id,
    destId: ctx.destId,
    kind: isCopy ? 'snapshot-copy' : 'snapshot-zip',
    status: 'ready',
    counts: {
      copy: isCopy ? ctx.srcFiles.length : 0,
      update: 0,
      zip: partCount,
      trash: 0,
      delete: 0,
      unchanged: 0
    },
    bytes: ctx.srcFiles.reduce((n, f) => n + f.size, 0),
    skippedEntries: ctx.srcSkipped
  }
  const previous = ctx.indexDir
    ? await readSnapshotIndex(ctx.indexDir, source.id, ctx.destId)
    : null

  const execute = (x: ExecContext): ReturnType<PreparedJob['execute']> =>
    asJobAbort(dest, async () => {
      const run = new JobRun(ctx, x, plan.bytes)
      const slug = source.slug
      // Partials only ever live at the top of <slug>/; finalized snapshots are never swept.
      await dest.removePartials(slug, false)
      await dest.mkdirp(slug)
      const taken = new Set((await dest.list(slug)).map((e) => e.name))
      const name = uniqueTimestampName(formatTimestamp(ctx.now), taken)
      const partialDir = `${slug}/${name}${PARTIAL_SUFFIX}`
      const absOf = (rel: string): string => join(source.path, ...rel.split('/'))
      // rel → archive file holding it (zip snapshots), for successfully written files only
      const written = new Map<string, { f: FileEntry; archive?: string }>()

      /** Writes one part into `dir` as `<base>.zip`, `<base>.partN.zip` or its chunks. */
      const writePart = async (dir: string, base: string, part: PartPlan): Promise<string[]> => {
        const file = partBaseName(base, part)
        const failed = new Set<string>()
        const entries = part.files.map((f) => ({
          absPath: absOf(f.rel),
          name: f.rel,
          mtimeMs: f.mtimeMs
        }))
        const opts = {
          signal: x.signal,
          onBytes: (n: number) => run.progress(file, n),
          onEntryError: (e: { name: string }, err: NodeJS.ErrnoException) => {
            failed.add(e.name)
            run.warn({ path: e.name, code: err.code ?? 'ERROR', message: err.message })
          }
        }
        let files: string[]
        if (part.chunked) {
          const r = await writeZip(dest, `${dir}/${file}`, entries, source.zip.level, {
            ...opts,
            finalize: false
          })
          files = await splitIntoChunks(
            dest,
            r.tempRel!,
            `${dir}/${file}`,
            ctx.zip.chunkSize!,
            x.signal
          )
        } else {
          await writeZip(dest, `${dir}/${file}`, entries, source.zip.level, opts)
          files = [file]
        }
        run.progress(file, 0, true)
        run.counts.zipped++
        const shown = part.chunked ? chunkName(file, 1) : file
        for (const f of part.files)
          if (!failed.has(f.rel)) written.set(f.rel, { f, archive: shown })
        return files
      }

      const moved: string[] = [] // split zip-whole parts already moved out of staging
      try {
        if (isCopy) {
          await dest.mkdirp(partialDir)
          const conflicts = await caseConflicts(dest, partialDir, ctx.srcFiles)
          for (const f of ctx.srcFiles) {
            if (conflicts.has(f.rel)) {
              warnCaseConflict(run, f.rel)
              continue
            }
            const ok = await run.guard(f.rel, () =>
              dest.copyFileIn(absOf(f.rel), `${partialDir}/${f.rel}`, x.signal, (n) =>
                run.progress(f.rel, n)
              )
            )
            if (ok) {
              run.progress(f.rel, 0, true)
              run.counts.copied++
              written.set(f.rel, { f })
            }
          }
          await dest.rename(partialDir, `${slug}/${name}`)
        } else if (source.packaging === 'zip-whole') {
          const parts = archives[0].parts
          if (parts.length === 1 && parts[0].n === 0) {
            await writePart(slug, name, parts[0])
          } else {
            // Parts are staged together and only moved next to other snapshots at the end,
            // so a failure never leaves a partial set of <ts>.partN.zip files behind.
            await dest.mkdirp(partialDir)
            const files: string[] = []
            for (const part of parts) {
              x.signal.throwIfAborted()
              files.push(...(await writePart(partialDir, name, part)))
            }
            for (const f of files) {
              await dest.rename(`${partialDir}/${f}`, `${slug}/${f}`)
              moved.push(f)
            }
            await dest.remove(partialDir)
          }
        } else {
          await dest.mkdirp(partialDir)
          for (const a of archives) {
            for (const part of a.parts) {
              x.signal.throwIfAborted()
              await run.guard(partBaseName(a.base, part), () => writePart(partialDir, a.base, part))
            }
          }
          await dest.rename(partialDir, `${slug}/${name}`)
        }
      } catch (err) {
        await dest.remove(partialDir).catch(() => {})
        for (const f of moved) await dest.remove(`${slug}/${f}`).catch(() => {})
        throw err
      }

      if (ctx.indexDir) {
        const before = new Map((previous ?? []).map((f) => [f.rel, f]))
        for (const [rel, { f, archive }] of written) {
          const p = before.get(rel)
          const extra = { size: f.size, ...(archive ? { archive } : {}) }
          if (!p) run.change('added', rel, extra)
          else if (p.size !== f.size || Math.abs(p.mtimeMs - f.mtimeMs) > MTIME_TOLERANCE_MS) {
            run.change('updated', rel, extra)
          }
        }
        for (const rel of before.keys()) if (!written.has(rel)) run.change('removed', rel)
        await writeSnapshotIndex(
          ctx.indexDir,
          source.id,
          ctx.destId,
          [...written.values()].map((w) => w.f)
        )
      }
      return run.result()
    })
  return { plan, execute }
}
