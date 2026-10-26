import type { JobPlan } from '@shared/types'
import type { JobContext, JobRun } from './job'
import { formatTimestamp } from './naming'

export const MTIME_TOLERANCE_MS = 2000

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

/** Applies the deletion policy to `rel` (relative to `<slug>/current`). */
export async function removeByPolicy(
  ctx: JobContext,
  run: JobRun,
  rel: string,
  recordChange = true
): Promise<boolean> {
  const { slug, mirror } = ctx.source
  if (mirror.deletion === 'never') return false
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
    if (recordChange) run.change(mirror.deletion === 'trash' ? 'trashed' : 'deleted', rel)
  }
  return done === true
}
