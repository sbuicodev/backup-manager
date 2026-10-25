import { join } from 'node:path'
import type { JobPlan } from '@shared/types'
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
import { formatTimestamp, uniqueTimestampName } from './naming'
import { computeZipTargets, type ZipTarget } from './packaging/targets'
import { writeZip } from './packaging/zip'

export async function prepareSnapshot(ctx: JobContext): Promise<PreparedJob> {
  const { source, dest } = ctx
  const isCopy = source.packaging === 'copy'
  const targets: ZipTarget[] = isCopy ? [] : computeZipTargets(source, ctx.srcFiles)
  const plan: JobPlan = {
    sourceId: source.id,
    destId: ctx.destId,
    kind: isCopy ? 'snapshot-copy' : 'snapshot-zip',
    status: 'ready',
    counts: {
      copy: isCopy ? ctx.srcFiles.length : 0,
      update: 0,
      zip: targets.length,
      trash: 0,
      delete: 0,
      unchanged: 0
    },
    bytes: ctx.srcFiles.reduce((n, f) => n + f.size, 0),
    skippedEntries: ctx.srcSkipped
  }

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
      const zipTo = async (rel: string, t: ZipTarget): Promise<void> => {
        await writeZip(
          dest,
          rel,
          t.files.map((f) => ({ absPath: absOf(f.rel), name: f.rel, mtimeMs: f.mtimeMs })),
          source.zip.level,
          {
            signal: x.signal,
            onBytes: (n) => run.progress(t.name, n),
            onEntryError: (e, err) =>
              run.warn({ path: e.name, code: err.code ?? 'ERROR', message: err.message })
          }
        )
        run.progress(t.name, 0, true)
        run.counts.zipped++
      }
      try {
        if (source.packaging === 'zip-whole') {
          await zipTo(`${slug}/${name}.zip`, targets[0])
        } else {
          await dest.mkdirp(partialDir)
          if (isCopy) {
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
              }
            }
          } else {
            for (const t of targets) {
              x.signal.throwIfAborted()
              await run.guard(t.name, () => zipTo(`${partialDir}/${t.name}`, t))
            }
          }
          await dest.rename(partialDir, `${slug}/${name}`)
        }
      } catch (err) {
        await dest.remove(partialDir).catch(() => {})
        throw err
      }
      return run.result()
    })
  return { plan, execute }
}
