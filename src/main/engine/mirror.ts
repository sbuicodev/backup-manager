import { join } from 'node:path'
import type { FileEntry, JobPlan } from '@shared/types'
import { MANIFEST_NAME } from './destination'
import {
  JobRun,
  asJobAbort,
  effectiveExcludes,
  type ExecContext,
  type JobContext,
  type PreparedJob
} from './job'
import { formatTimestamp } from './naming'
import { computeZipTargets, type ZipTarget } from './packaging/targets'
import { writeZip } from './packaging/zip'

const MTIME_TOLERANCE_MS = 2000

export function diffMirror(
  src: FileEntry[],
  dst: FileEntry[]
): { copy: FileEntry[]; update: FileEntry[]; remove: string[]; unchanged: number } {
  const existing = new Map(dst.map((f) => [f.rel, f]))
  const copy: FileEntry[] = []
  const update: FileEntry[] = []
  let unchanged = 0
  for (const f of src) {
    const d = existing.get(f.rel)
    existing.delete(f.rel)
    if (!d) copy.push(f)
    else if (d.size !== f.size || Math.abs(d.mtimeMs - f.mtimeMs) > MTIME_TOLERANCE_MS)
      update.push(f)
    else unchanged++
  }
  return { copy, update, remove: [...existing.keys()], unchanged }
}

function basePlan(ctx: JobContext, kind: JobPlan['kind']): JobPlan {
  return {
    sourceId: ctx.source.id,
    destId: ctx.destId,
    kind,
    status: 'ready',
    counts: { copy: 0, update: 0, zip: 0, trash: 0, delete: 0, unchanged: 0 },
    bytes: 0,
    skippedEntries: ctx.srcSkipped
  }
}

function removalCounts(ctx: JobContext, n: number): { trash: number; delete: number } {
  const policy = ctx.source.mirror.deletion
  return { trash: policy === 'trash' ? n : 0, delete: policy === 'exact' ? n : 0 }
}

/** Applies the deletion policy to `rel` (relative to `<slug>/current`). */
async function removeByPolicy(ctx: JobContext, run: JobRun, rel: string): Promise<void> {
  const { slug, mirror } = ctx.source
  if (mirror.deletion === 'never') return
  const from = `${slug}/current/${rel}`
  const done = await run.guard(rel, async () => {
    if (mirror.deletion === 'trash') {
      await ctx.dest.rename(from, `${slug}/.trash/${formatTimestamp(ctx.now)}/${rel}`)
    } else {
      await ctx.dest.remove(from)
    }
    return true
  })
  if (done) {
    if (mirror.deletion === 'trash') run.counts.trashed++
    else run.counts.deleted++
  }
}

export async function prepareMirrorCopy(ctx: JobContext): Promise<PreparedJob> {
  const { slug } = ctx.source
  const current = `${slug}/current`
  const dst = await ctx.dest.walk(current, effectiveExcludes(ctx.source, ctx.globalExcludes))
  const diff = diffMirror(ctx.srcFiles, dst)
  const plan = basePlan(ctx, 'mirror-copy')
  plan.counts = {
    ...plan.counts,
    copy: diff.copy.length,
    update: diff.update.length,
    unchanged: diff.unchanged,
    ...removalCounts(ctx, diff.remove.length)
  }
  plan.bytes = [...diff.copy, ...diff.update].reduce((n, f) => n + f.size, 0)

  const execute = (x: ExecContext): ReturnType<PreparedJob['execute']> =>
    asJobAbort(ctx.dest, async () => {
      const run = new JobRun(ctx, x, plan.bytes)
      await ctx.dest.removePartials(slug)
      await ctx.dest.mkdirp(current)
      // Removals first: on case-insensitive filesystems a case-only rename must not
      // have its freshly copied file trashed afterwards.
      for (const rel of diff.remove) await removeByPolicy(ctx, run, rel)
      if (ctx.source.mirror.deletion !== 'never') await ctx.dest.removeEmptyDirs(current)
      const copyOne = async (f: FileEntry, isUpdate: boolean): Promise<void> => {
        const ok = await run.guard(f.rel, () =>
          ctx.dest.copyFileIn(
            join(ctx.source.path, ...f.rel.split('/')),
            `${current}/${f.rel}`,
            x.signal,
            (n) => run.progress(f.rel, n)
          )
        )
        if (ok) {
          run.progress(f.rel, 0, true)
          if (isUpdate) run.counts.updated++
          else run.counts.copied++
        }
      }
      for (const f of diff.copy) await copyOne(f, false)
      for (const f of diff.update) await copyOne(f, true)
      return run.result()
    })
  return { plan, execute }
}

type Manifest = { version: 1; archives: Record<string, string> }

async function readManifest(ctx: JobContext, rel: string): Promise<Manifest> {
  try {
    const m = JSON.parse((await ctx.dest.readText(rel)) ?? '') as Manifest
    if (m?.version === 1 && typeof m.archives === 'object' && m.archives) return m
  } catch {
    // unreadable or invalid manifest: treat as empty, everything is rewritten
  }
  return { version: 1, archives: {} }
}

export async function prepareMirrorZip(ctx: JobContext): Promise<PreparedJob> {
  const { slug } = ctx.source
  const current = `${slug}/current`
  const manifestRel = `${current}/${MANIFEST_NAME}`
  const targets = computeZipTargets(ctx.source, ctx.srcFiles)
  const manifest = await readManifest(ctx, manifestRel)
  const toWrite: ZipTarget[] = []
  for (const t of targets) {
    const exists = (await ctx.dest.stat(`${current}/${t.name}`)) !== null
    if (!exists || manifest.archives[t.name] !== t.fingerprint) toWrite.push(t)
  }
  const names = new Set(targets.map((t) => t.name))
  const stale = (await ctx.dest.list(current))
    .filter((e) => !e.isDir && e.name.endsWith('.zip') && !names.has(e.name))
    .map((e) => e.name)

  const plan = basePlan(ctx, 'mirror-zip')
  plan.counts = {
    ...plan.counts,
    zip: toWrite.length,
    unchanged: targets.length - toWrite.length,
    ...removalCounts(ctx, stale.length)
  }
  plan.bytes = toWrite.reduce((n, t) => n + t.files.reduce((m, f) => m + f.size, 0), 0)

  const execute = (x: ExecContext): ReturnType<PreparedJob['execute']> =>
    asJobAbort(ctx.dest, async () => {
      const run = new JobRun(ctx, x, plan.bytes)
      await ctx.dest.removePartials(slug)
      await ctx.dest.mkdirp(current)
      const archives: Record<string, string> = {}
      for (const t of targets) {
        if (!toWrite.includes(t)) archives[t.name] = t.fingerprint
      }
      for (const t of toWrite) {
        x.signal.throwIfAborted()
        let entryErrors = 0
        await writeZip(
          ctx.dest,
          `${current}/${t.name}`,
          t.files.map((f) => ({
            absPath: join(ctx.source.path, ...f.rel.split('/')),
            name: f.rel,
            mtimeMs: f.mtimeMs
          })),
          ctx.source.zip.level,
          {
            signal: x.signal,
            onBytes: (n) => run.progress(t.name, n),
            onEntryError: (e, err) => {
              entryErrors++
              run.warn({ path: e.name, code: err.code ?? 'ERROR', message: err.message })
            }
          }
        )
        run.progress(t.name, 0, true)
        run.counts.zipped++
        // A skipped entry leaves the fingerprint unset so the archive is retried next run.
        archives[t.name] = entryErrors === 0 ? t.fingerprint : ''
      }
      for (const name of stale) await removeByPolicy(ctx, run, name)
      await ctx.dest.writeTextAtomic(manifestRel, JSON.stringify({ version: 1, archives }, null, 2))
      return run.result()
    })
  return { plan, execute }
}
