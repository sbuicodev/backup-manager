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

/** True when `rel` is `p` or lies under it. */
const isAtOrUnder = (rel: string, p: string): boolean => rel === p || rel.startsWith(`${p}/`)

/** Source paths the walk could not read: their backups must never be removed or replaced. */
function unreadableRels(ctx: JobContext): string[] {
  return ctx.srcSkipped.filter((s) => s.reason === 'unreadable').map((s) => s.rel)
}

/**
 * `protectedRels` are source paths that could not be read; destination files at or under
 * them are never scheduled for removal, since their absence from the walk proves nothing.
 */
export function diffMirror(
  src: FileEntry[],
  dst: FileEntry[],
  protectedRels: string[] = []
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
  const remove = [...existing.keys()].filter(
    (rel) => !protectedRels.some((p) => isAtOrUnder(rel, p))
  )
  return { copy, update, remove, unchanged }
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
  const diff = diffMirror(ctx.srcFiles, dst, unreadableRels(ctx))
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
      await ctx.dest.removePartials(slug, false)
      await ctx.dest.removePartials(current, true)
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
  // Top-level names (or everything, for zip-whole) whose archive would be missing members
  // because part of the source could not be read: keep the existing archive instead.
  const unreadableTops = new Set(unreadableRels(ctx).map((r) => r.split('/')[0]))
  const isBundle = ctx.source.zip.looseFiles === 'bundle'
  const stemOf = (name: string): string => name.replace(/(-\d+)?\.zip$/, '')
  const unreadableTopLevel = unreadableRels(ctx).some((r) => !r.includes('/'))
  const isBundleTarget = (t: ZipTarget): boolean =>
    isBundle && stemOf(t.name) === '_files' && t.files.every((f) => !f.rel.includes('/'))
  // Conservative: an unreadable top-level entry may be a loose file, so the bundle is kept too.
  const coversUnreadable = (t: ZipTarget): boolean =>
    unreadableTops.size > 0 &&
    (ctx.source.packaging === 'zip-whole' ||
      t.files.some((f) => unreadableTops.has(f.rel.split('/')[0])) ||
      (unreadableTopLevel && isBundleTarget(t)))
  const keptByUnreadable = targets.filter(coversUnreadable)
  const toWrite: ZipTarget[] = []
  for (const t of targets) {
    if (keptByUnreadable.includes(t)) continue
    const exists = (await ctx.dest.stat(`${current}/${t.name}`)) !== null
    if (!exists || manifest.archives[t.name] !== t.fingerprint) toWrite.push(t)
  }
  const names = new Set(targets.map((t) => t.name))
  const protectsArchive = (name: string): boolean =>
    ctx.source.packaging === 'zip-whole'
      ? unreadableTops.size > 0
      : unreadableTops.has(stemOf(name)) ||
        (isBundle && stemOf(name) === '_files' && unreadableTopLevel)
  const stale = (await ctx.dest.list(current))
    .filter((e) => !e.isDir && e.name.endsWith('.zip') && !names.has(e.name))
    .map((e) => e.name)
    .filter((name) => !protectsArchive(name))

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
      await ctx.dest.removePartials(slug, false)
      await ctx.dest.removePartials(current, true)
      await ctx.dest.mkdirp(current)
      const archives: Record<string, string> = {}
      for (const t of targets) {
        if (keptByUnreadable.includes(t)) {
          if (manifest.archives[t.name] !== undefined) archives[t.name] = manifest.archives[t.name]
          run.warn({
            path: t.name,
            code: 'KEPT',
            message: 'previous archive kept because some of its files could not be read'
          })
        } else if (!toWrite.includes(t)) {
          archives[t.name] = t.fingerprint
        }
      }
      for (const t of toWrite) {
        x.signal.throwIfAborted()
        let entryErrors = 0
        // An archive that cannot be written (e.g. a name the filesystem rejects) is skipped
        // and left out of the manifest, so it is retried on the next run.
        const written = await run.guard(t.name, () =>
          writeZip(
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
        )
        if (!written) continue
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
