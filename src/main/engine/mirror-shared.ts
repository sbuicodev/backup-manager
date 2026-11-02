import type { FileEntry, JobPlan } from '@shared/types'
import { MANIFEST_NAME } from './destination'
import type { JobContext, JobRun } from './job'
import { formatTimestamp, snapshotKey } from './naming'

export const MTIME_TOLERANCE_MS = 2000

/**
 * Mirror layout: the mirror lives directly in `<slug>/`, next to these hidden items of its own.
 * Older versions mirrored into `<slug>/current/`; the marker says the move up has been done.
 */
export const TRASH_DIR = '.trash'
export const LAYOUT_MARKER = '.backup-manager-layout'
const LEGACY_DIR = 'current'
const RESERVED_TOP = new Set([TRASH_DIR, MANIFEST_NAME, LAYOUT_MARKER])

/** Top-level names in `<slug>/` the mirror must not treat as backed-up files. */
export function mirrorSkipTop(ctx: JobContext): (name: string) => boolean {
  const sourceTops = new Set(ctx.srcFiles.map((f) => f.rel.split('/')[0]))
  // Snapshots from an earlier snapshot mode share the folder; never touch them.
  return (name) => RESERVED_TOP.has(name) || (snapshotKey(name) !== null && !sourceTops.has(name))
}

/** Source files whose top-level name is one the mirror reserves; they are skipped with a warning. */
export function reservedSourceFiles(files: FileEntry[]): Set<string> {
  return new Set(files.filter((f) => RESERVED_TOP.has(f.rel.split('/')[0])).map((f) => f.rel))
}

export function warnReserved(run: JobRun, files: FileEntry[]): void {
  const tops = new Set([...reservedSourceFiles(files)].map((r) => r.split('/')[0]))
  for (const top of tops) {
    run.warn({
      path: top,
      code: 'RESERVED',
      message: 'not backed up: this name is used by the backup itself at the top of the folder'
    })
  }
}

/**
 * Where the mirror's current files are: `<slug>/`, or `<slug>/current/` for a backup made
 * before the layout change that has not been moved up yet. Planning reads from there; a run
 * moves it up first (`settleLayout`), after which every relative path is the same.
 */
export async function mirrorReadRoot(ctx: JobContext): Promise<{ read: string; legacy: boolean }> {
  const { slug } = ctx.source
  if (await ctx.dest.stat(`${slug}/${LAYOUT_MARKER}`)) return { read: slug, legacy: false }
  const old = await ctx.dest.stat(`${slug}/${LEGACY_DIR}`)
  return old?.isDir
    ? { read: `${slug}/${LEGACY_DIR}`, legacy: true }
    : { read: slug, legacy: false }
}

/** Moves a legacy `<slug>/current/` up into `<slug>/` (renames only), then writes the marker. */
export async function settleLayout(ctx: JobContext, legacy: boolean): Promise<void> {
  const { slug } = ctx.source
  await ctx.dest.mkdirp(slug)
  if (legacy) {
    const from = `${slug}/${LEGACY_DIR}`
    await ctx.dest.removePartials(from, true)
    for (const e of await ctx.dest.list(from)) {
      if (await ctx.dest.stat(`${slug}/${e.name}`)) {
        // Stop rather than overwrite; what is left in current/ is moved on the next run.
        throw new Error(
          `cannot move "${LEGACY_DIR}/${e.name}" up to the backup folder: "${e.name}" already exists there`
        )
      }
      await ctx.dest.rename(`${from}/${e.name}`, `${slug}/${e.name}`)
    }
    await ctx.dest.remove(from)
  }
  await ctx.dest.writeTextAtomic(
    `${slug}/${LAYOUT_MARKER}`,
    'mirror layout 2: files directly in this folder\n'
  )
}

/**
 * A source with no files at all while its backup has some is far more likely an unmounted
 * drive or disconnected share than a real mass deletion: never remove anything then.
 */
export function looksUnmounted(ctx: JobContext, backupHasFiles: boolean): boolean {
  return ctx.srcFiles.length === 0 && backupHasFiles
}

export function warnEmptySource(run: JobRun): void {
  run.warn({
    path: '',
    code: 'EMPTY_SOURCE',
    message: 'the source folder is empty; nothing was removed from the backup'
  })
}

/** True when `rel` is `p` or lies under it. */
export const isAtOrUnder = (rel: string, p: string): boolean => rel === p || rel.startsWith(`${p}/`)

/** Source paths the walk could not read: their backups must never be removed or replaced. */
export function unreadableRels(ctx: JobContext): string[] {
  return ctx.srcSkipped.filter((s) => s.reason === 'unreadable').map((s) => s.rel)
}

export function basePlan(ctx: JobContext, kind: JobPlan['kind']): JobPlan {
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

export function removalCounts(ctx: JobContext, n: number): { trash: number; delete: number } {
  const policy = ctx.source.mirror.deletion
  return { trash: policy === 'trash' ? n : 0, delete: policy === 'exact' ? n : 0 }
}

/** Applies the deletion policy to `rel` (relative to `<slug>/`). */
export async function removeByPolicy(
  ctx: JobContext,
  run: JobRun,
  rel: string,
  recordChange = true
): Promise<boolean> {
  const { slug, mirror } = ctx.source
  if (mirror.deletion === 'never') return false
  const from = `${slug}/${rel}`
  const done = await run.guard(rel, async () => {
    if (mirror.deletion === 'trash') {
      await ctx.dest.rename(from, `${slug}/${TRASH_DIR}/${formatTimestamp(ctx.now)}/${rel}`)
    } else {
      await ctx.dest.remove(from)
    }
    return true
  })
  if (done) {
    if (mirror.deletion === 'trash') run.counts.trashed++
    else run.counts.deleted++
    if (recordChange) run.change(mirror.deletion === 'trash' ? 'trashed' : 'deleted', rel)
  }
  return done === true
}
