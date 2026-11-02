import type { FileEntry } from '@shared/types'
import {
  JobRun,
  asJobAbort,
  caseConflicts,
  sourceAbs,
  warnCaseConflict,
  effectiveExcludes,
  type ExecContext,
  type JobContext,
  type PreparedJob
} from './job'
import {
  MTIME_TOLERANCE_MS,
  basePlan,
  isAtOrUnder,
  looksUnmounted,
  destExcluded,
  mirrorLayout,
  mirrorSkipTop,
  removalCounts,
  removeByPolicy,
  reservedSourceFiles,
  settleLayout,
  unreadableRels,
  warnEmptySource,
  warnReserved
} from './mirror-shared'

export { prepareMirrorZip } from './mirror-zip'

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

export async function prepareMirrorCopy(ctx: JobContext): Promise<PreparedJob> {
  const { slug } = ctx.source
  const layout = await mirrorLayout(ctx)
  const excluded = destExcluded(ctx, effectiveExcludes(ctx.source, ctx.globalExcludes))
  const dst = (
    await Promise.all(
      layout.reads.map(async ({ root, prefix }) =>
        (await ctx.dest.walk(root, [], root === slug ? mirrorSkipTop(ctx) : undefined)).map(
          (f) => ({ ...f, rel: `${prefix}${f.rel}` })
        )
      )
    )
  )
    .flat()
    .filter((f) => !excluded(f.rel))
  const reserved = reservedSourceFiles(ctx.srcFiles)
  const srcFiles = ctx.srcFiles.filter((f) => !reserved.has(f.rel))
  const emptySource = looksUnmounted(ctx, dst.length > 0)
  const diff = diffMirror(srcFiles, dst, unreadableRels(ctx))
  if (emptySource) diff.remove = []
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
      if (emptySource) warnEmptySource(run)
      warnReserved(run, ctx.srcFiles)
      await settleLayout(ctx, layout)
      await ctx.dest.removePartials(slug, true)
      // Removals first: on case-insensitive filesystems a case-only rename must not
      // have its freshly copied file trashed afterwards.
      for (const rel of diff.remove) {
        await removeByPolicy(ctx, run, rel)
        await run.settle()
      }
      if (ctx.source.mirror.deletion !== 'never') await ctx.dest.removeEmptyDirs(slug)
      const conflicts = await caseConflicts(ctx.dest, slug, srcFiles)
      const copyOne = async (f: FileEntry, isUpdate: boolean): Promise<void> => {
        if (conflicts.has(f.rel)) return warnCaseConflict(run, f.rel)
        const ok = await run.guard(f.rel, () =>
          ctx.dest.copyFileIn(sourceAbs(ctx, f.rel), `${slug}/${f.rel}`, x.signal, (n) =>
            run.progress(f.rel, n)
          )
        )
        if (ok) {
          run.progress(f.rel, 0, true)
          if (isUpdate) run.counts.updated++
          else run.counts.copied++
          run.change(isUpdate ? 'updated' : 'added', f.rel, { size: f.size })
          await run.settle()
        }
      }
      for (const f of diff.copy) await copyOne(f, false)
      for (const f of diff.update) await copyOne(f, true)
      return run.result()
    })
  return { plan, execute }
}
