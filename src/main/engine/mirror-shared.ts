import { fileName, itemRel } from '@shared/schema'
import type { FileEntry, JobPlan } from '@shared/types'
import { MANIFEST_NAME } from './destination'
import type { JobContext, JobRun } from './job'
import { formatTimestamp, snapshotKey } from './naming'
import { buildMatcher } from './walk'

export const MTIME_TOLERANCE_MS = 2000

/**
 * Mirror layout: each item lives in `<slug>/<item>` — or, for a backup of one folder, that
 * folder's contents directly in `<slug>/` — next to these hidden items of the mirror's own.
 * Older backups are moved into place by `settleLayout`; the marker records that it is done.
 *  - layout 1: everything in `<slug>/current/` (a one-folder source's contents)
 *  - layout 2: a one-folder source's contents directly in `<slug>/`
 *  - layout 3: by item, or one folder's contents directly ("flat", naming that folder)
 */
export const TRASH_DIR = '.trash'
export const LAYOUT_MARKER = '.backup-manager-layout'
const LEGACY_DIR = 'current'
/** Staging folder while layout-2 contents move down into `<slug>/<item>/` (kept across crashes). */
const NESTING_DIR = '.backup-manager-nesting'
/** Staging folder while `<slug>/<folder>/` moves up into `<slug>/` (kept across crashes). */
const UNNESTING_DIR = '.backup-manager-unnesting'
const RESERVED_TOP = new Set([TRASH_DIR, MANIFEST_NAME, LAYOUT_MARKER, NESTING_DIR, UNNESTING_DIR])
const LAYOUT_3 = 'mirror layout 3: each file or folder under its own name\n'
const LAYOUT_3_FLAT = 'mirror layout 3: the contents of one folder directly here: '
const flatMarker = (name: string): string => `${LAYOUT_3_FLAT}${name}\n`

/** Top-level names in `<slug>/` the mirror must not treat as backed-up files. */
export function mirrorSkipTop(ctx: JobContext): (name: string) => boolean {
  const sourceTops = new Set(ctx.srcFiles.map((f) => f.rel.split('/')[0]))
  // Snapshots from an earlier snapshot mode share the folder; never touch them.
  return (name) => RESERVED_TOP.has(name) || (snapshotKey(name) !== null && !sourceTops.has(name))
}

/**
 * Exclusions at the destination, matched like at the source: inside each folder item, relative
 * to that folder (or to the whole tree when the job is not itemized).
 */
export function destExcluded(ctx: JobContext, excludes: string[]): (rel: string) => boolean {
  const match = buildMatcher(excludes)
  const folders = ctx.source.items.filter((i) => i.kind === 'folder').map((i) => itemRel(i))
  return (rel) => {
    let rest = rel
    if (ctx.itemized) {
      const folder = folders.find((f) => rel.startsWith(`${f}/`))
      if (folder === undefined) return false
      rest = rel.slice(folder.length + 1)
    }
    if (match(rest, false)) return true
    const parts = rest.split('/')
    for (let i = 1; i < parts.length; i++) if (match(parts.slice(0, i).join('/'), true)) return true
    return false
  }
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
 * Where the mirror's files are now, and what a run must do first to reach layout 3.
 * `reads`: folders planning reads, with the prefix that turns their names into final names
 * (so a plan made before the move stays valid after it).
 */
export type MirrorLayout = {
  /** `skip`: a top-level name of `root` that is read through another entry. */
  reads: Array<{ root: string; prefix: string; skip?: string }>
  move: 'none' | 'mark' | 'current-up' | 'current-into' | 'flat-into' | 'nested-up'
  /** Item the old contents belong to (`*-into` moves), or that moves up (`nested-up`). */
  into: string | null
}

/** The marker a mirror of this source has once its layout is settled. */
function markerFor(ctx: JobContext): string {
  return ctx.itemized ? LAYOUT_3 : flatMarker(fileName(ctx.source.items[0]?.path ?? ''))
}

export async function mirrorLayout(ctx: JobContext): Promise<MirrorLayout> {
  const { slug } = ctx.source
  const marker = await ctx.dest.readText(`${slug}/${LAYOUT_MARKER}`)
  const here = { reads: [{ root: slug, prefix: '' }], into: null }
  // A single zip (named after the backup folder, not an item) stays where it is.
  const moves = ctx.source.packaging !== 'zip-whole'
  if (marker === markerFor(ctx)) return { ...here, move: 'none' }
  if (marker?.startsWith(LAYOUT_3_FLAT)) {
    const was = marker.slice(LAYOUT_3_FLAT.length).trim()
    return ctx.itemized && moves && was
      ? {
          reads: [
            { root: slug, prefix: `${was}/` },
            { root: `${slug}/${NESTING_DIR}`, prefix: `${was}/` }
          ],
          move: 'flat-into',
          into: was
        }
      : { ...here, move: 'mark' }
  }
  if (marker?.startsWith('mirror layout 3')) {
    // By item; a backup now of one folder moves that folder's contents up.
    const up = ctx.itemized || !moves ? null : fileName(ctx.source.items[0].path)
    if (up === null) return { ...here, move: 'mark' }
    const staged = (await ctx.dest.stat(`${slug}/${UNNESTING_DIR}`))?.isDir
    const nested = (await ctx.dest.stat(`${slug}/${up}`))?.isDir
    if (!staged && !nested) return { ...here, move: 'mark' }
    return {
      reads: [
        ...(nested ? [{ root: `${slug}/${up}`, prefix: '' }] : []),
        ...(staged ? [{ root: `${slug}/${UNNESTING_DIR}`, prefix: '' }] : []),
        { root: slug, prefix: '', ...(nested ? { skip: up } : {}) }
      ],
      move: 'nested-up',
      into: up
    }
  }
  // Only a source converted from a one-folder config has contents to move down.
  const n = ctx.itemized && moves ? ctx.source.legacyFlatName : null
  if (marker !== null) {
    return n
      ? {
          reads: [
            { root: slug, prefix: `${n}/` },
            { root: `${slug}/${NESTING_DIR}`, prefix: `${n}/` }
          ],
          move: 'flat-into',
          into: n
        }
      : { reads: [{ root: slug, prefix: '' }], move: 'mark', into: null }
  }
  if ((await ctx.dest.stat(`${slug}/${LEGACY_DIR}`))?.isDir) {
    if (n === LEGACY_DIR) return { reads: [{ root: slug, prefix: '' }], move: 'mark', into: null }
    return n
      ? {
          reads: [{ root: `${slug}/${LEGACY_DIR}`, prefix: `${n}/` }],
          move: 'current-into',
          into: n
        }
      : { reads: [{ root: `${slug}/${LEGACY_DIR}`, prefix: '' }], move: 'current-up', into: null }
  }
  return { reads: [{ root: slug, prefix: '' }], move: 'mark', into: null }
}

/**
 * Puts an older backup into layout 3 with renames only, then writes the marker. A name that is
 * already taken stops the job; whatever was not moved yet is moved on the next run.
 */
export async function settleLayout(ctx: JobContext, layout: MirrorLayout): Promise<void> {
  const { slug } = ctx.source
  const exists = async (rel: string): Promise<boolean> => (await ctx.dest.stat(rel)) !== null
  const blocked = (what: string, name: string): Error =>
    new Error(`cannot move "${what}" in the backup folder: "${name}" already exists there`)
  await ctx.dest.mkdirp(slug)
  if (layout.move === 'current-up') {
    const from = `${slug}/${LEGACY_DIR}`
    await ctx.dest.removePartials(from, true)
    for (const e of await ctx.dest.list(from)) {
      if (await exists(`${slug}/${e.name}`)) throw blocked(`${LEGACY_DIR}/${e.name}`, e.name)
      await ctx.dest.rename(`${from}/${e.name}`, `${slug}/${e.name}`)
    }
    await ctx.dest.remove(from)
  } else if (layout.move === 'current-into') {
    const to = `${slug}/${layout.into}`
    if (await exists(to)) throw blocked(LEGACY_DIR, layout.into!)
    await ctx.dest.removePartials(`${slug}/${LEGACY_DIR}`, true)
    await ctx.dest.rename(`${slug}/${LEGACY_DIR}`, to)
    await ctx.dest.remove(`${to}/${MANIFEST_NAME}`) // its archive list no longer applies
  } else if (layout.move === 'flat-into') {
    // Contents go through a staging folder, so a folder containing an entry with its own name
    // still works, and a crash part-way resumes from where it stopped.
    const nest = `${slug}/${NESTING_DIR}`
    await ctx.dest.removePartials(slug, false)
    await ctx.dest.mkdirp(nest)
    for (const e of await ctx.dest.list(slug)) {
      if (RESERVED_TOP.has(e.name) || snapshotKey(e.name) !== null) continue
      if (await exists(`${nest}/${e.name}`)) throw blocked(e.name, `${NESTING_DIR}/${e.name}`)
      await ctx.dest.rename(`${slug}/${e.name}`, `${nest}/${e.name}`)
    }
    await ctx.dest.rename(nest, `${slug}/${layout.into}`)
  } else if (layout.move === 'nested-up') {
    // Through a staging folder too, so an entry named like the folder itself still works.
    const stage = `${slug}/${UNNESTING_DIR}`
    if (!(await exists(stage))) {
      await ctx.dest.removePartials(`${slug}/${layout.into}`, true)
      await ctx.dest.rename(`${slug}/${layout.into}`, stage)
    }
    for (const e of await ctx.dest.list(stage)) {
      if (await exists(`${slug}/${e.name}`)) throw blocked(`${layout.into}/${e.name}`, e.name)
      await ctx.dest.rename(`${stage}/${e.name}`, `${slug}/${e.name}`)
    }
    await ctx.dest.remove(stage)
    await ctx.dest.remove(`${slug}/${MANIFEST_NAME}`) // its archive list no longer applies
  }
  if (layout.move !== 'none') {
    await ctx.dest.writeTextAtomic(`${slug}/${LAYOUT_MARKER}`, markerFor(ctx))
  }
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
