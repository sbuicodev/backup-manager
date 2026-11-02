import type { FileEntry } from '@shared/types'
import { MANIFEST_NAME } from './destination'
import {
  JobRun,
  asJobAbort,
  sourceAbs,
  type ExecContext,
  type JobContext,
  type PreparedJob
} from './job'
import {
  MTIME_TOLERANCE_MS,
  basePlan,
  isAtOrUnder,
  looksUnmounted,
  removalCounts,
  removeByPolicy,
  mirrorLayout,
  mirrorSkipTop,
  settleLayout,
  unreadableRels,
  warnEmptySource
} from './mirror-shared'
import {
  chunkName,
  ownsFile,
  packStable,
  partBaseName,
  type ManifestArchive,
  type ManifestPart,
  type PartPlan
} from './packaging/parts'
import { computeZipTargets, fingerprint, type ZipTarget } from './packaging/targets'
import { splitIntoChunks, writeZip } from './packaging/zip'

type ManifestV2 = { version: 2; archives: Record<string, ManifestArchive> }

/** Archive files in the mirror folder: B.zip, B.partN.zip and their .NNN chunks. */
const ARCHIVE_FILE = /\.zip(\.\d{3,})?$/

async function readManifest(ctx: JobContext, rel: string): Promise<ManifestV2> {
  try {
    const m = JSON.parse((await ctx.dest.readText(rel)) ?? '') as ManifestV2
    if (m?.version === 2 && typeof m.archives === 'object' && m.archives) return m
  } catch {
    // unreadable, invalid or version 1: treat as empty, every archive is rebuilt once
  }
  return { version: 2, archives: {} }
}

/** File names a manifest part occupies at the destination. */
function partFiles(base: string, p: Pick<ManifestPart, 'n' | 'chunked' | 'chunks'>): string[] {
  const file = partBaseName(base, p)
  if (!p.chunked) return [file]
  return Array.from({ length: p.chunks ?? 0 }, (_, i) => chunkName(file, i + 1))
}

/** Name shown as a change's `archive`: the part file, or its first chunk. */
const displayName = (base: string, p: Pick<PartPlan, 'n' | 'chunked'>): string =>
  p.chunked ? chunkName(partBaseName(base, p), 1) : partBaseName(base, p)

const unchanged = (a: FileEntry, b: FileEntry): boolean =>
  a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) <= MTIME_TOLERANCE_MS

/** Source files whose change an archive kept as it was does not carry. */
function pendingRels(files: FileEntry[], prev: ManifestArchive | undefined): string[] {
  const before = new Map(prev?.parts.flatMap((p) => p.files.map((f) => [f.rel, f] as const)))
  const now = new Set(files.map((f) => f.rel))
  return [
    ...files
      .filter((f) => !before.has(f.rel) || !unchanged(before.get(f.rel)!, f))
      .map((f) => f.rel),
    ...[...before.keys()].filter((rel) => !now.has(rel))
  ]
}

type PartWork = { part: PartPlan; fingerprint: string; write: boolean; prev?: ManifestPart }
type ArchiveWork = { target: ZipTarget; prev?: ManifestArchive; parts: PartWork[] }

export async function prepareMirrorZip(ctx: JobContext): Promise<PreparedJob> {
  const { slug } = ctx.source
  // Planning reads from where the archives are now (older layouts, see mirrorLayout); a run
  // moves them into place first, so every name below stays valid.
  const layout = await mirrorLayout(ctx)
  const current = slug
  const manifestRel = `${slug}/${MANIFEST_NAME}`
  const level = ctx.source.zip.level
  const targets = computeZipTargets(ctx.source, ctx.srcFiles, ctx.itemized)
  // A move into an item's folder renames every archive, so the old archive list no longer applies.
  const manifest =
    layout.move === 'current-into' || layout.move === 'flat-into'
      ? ({ version: 2, archives: {} } satisfies ManifestV2)
      : await readManifest(ctx, `${layout.reads[0].root}/${MANIFEST_NAME}`)

  // Archives with members the walk could not read keep their previous state (all parts).
  const unreadableTops = new Set(unreadableRels(ctx).map((r) => r.split('/')[0]))
  const unreadableTopLevel = unreadableRels(ctx).some((r) => !r.includes('/'))
  const isBundle = ctx.source.zip.looseFiles === 'bundle'
  const stem = (base: string): string => base.replace(/-\d+$/, '')
  const unreadable = unreadableRels(ctx)
  // Itemized: an archive is kept when an unreadable path is inside what it holds, or holds it
  // (a whole item that could not be read); a bundle covers its folder's loose files.
  const coversItemized = (base: string): boolean => {
    const s = stem(base)
    const dir = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : ''
    return unreadable.some((u) =>
      isBundle &&
      s.endsWith('_files') &&
      (u.slice(0, u.lastIndexOf('/')) === dir || isAtOrUnder(dir, u))
        ? true
        : isAtOrUnder(u, s) || isAtOrUnder(s, u)
    )
  }
  const coversUnreadable = (base: string, files: FileEntry[]): boolean =>
    ctx.itemized && ctx.source.packaging !== 'zip-whole'
      ? coversItemized(base)
      : unreadableTops.size > 0 &&
        (ctx.source.packaging === 'zip-whole' ||
          unreadableTops.has(stem(base)) ||
          files.some((f) => unreadableTops.has(f.rel.split('/')[0])) ||
          // Conservative: an unreadable top-level entry may be a loose file in the bundle.
          (isBundle && unreadableTopLevel && stem(base) === '_files'))

  const skipTop = mirrorSkipTop(ctx)
  // The mirror's own hidden items and snapshot zips at the top of the backup folder are never
  // archives of this mirror (unless a target produces that very name).
  const ours = (name: string): boolean =>
    !skipTop(name) || targets.some((t) => ownsFile(t.base, name))
  const archivesIn = async (root: string, prefix: string): Promise<string[]> =>
    (await ctx.dest.list(root))
      .filter((e) => !e.isDir && ARCHIVE_FILE.test(e.name) && (root !== slug || ours(e.name)))
      .map((e) => `${prefix}${e.name}`)
  const existing: string[] = []
  for (const { root, prefix } of layout.reads) {
    existing.push(...(await archivesIn(root, prefix)))
    // In layout 3 a folder item's archives sit in its own subfolder (also one no longer listed).
    if (prefix === '' && ctx.itemized && (layout.move === 'none' || layout.move === 'mark')) {
      for (const e of await ctx.dest.list(root)) {
        if (e.isDir && !skipTop(e.name)) {
          existing.push(...(await archivesIn(`${root}/${e.name}`, `${e.name}/`)))
        }
      }
    }
  }
  const emptySource = looksUnmounted(ctx, existing.length > 0)

  const partFingerprint = (p: PartPlan): string =>
    p.chunked
      ? `${fingerprint(p.files, level)}|chunk:${ctx.zip.chunkSize}`
      : fingerprint(p.files, level)

  const kept = new Set<string>() // archive bases left exactly as they were
  const work: ArchiveWork[] = []
  for (const target of targets) {
    const prev = manifest.archives[target.base]
    if (emptySource || coversUnreadable(target.base, target.files)) {
      kept.add(target.base)
      continue
    }
    const parts: PartWork[] = []
    for (const part of packStable(target.files, prev, ctx.zip)) {
      const fp = partFingerprint(part)
      const prevPart = prev?.parts.find((p) => p.n === part.n && p.chunked === part.chunked)
      const present =
        prevPart !== undefined &&
        partFiles(target.base, prevPart).every((n) => existing.includes(n)) &&
        (!prevPart.chunked || (prevPart.chunks ?? 0) > 0)
      parts.push({
        part,
        fingerprint: fp,
        prev: prevPart,
        write: !present || prevPart.fingerprint !== fp
      })
    }
    work.push({ target, prev, parts })
  }

  // Every file name the new state owns; anything else archive-like in current/ is stale.
  const owned = (name: string): boolean => {
    for (const w of work) {
      for (const pw of w.parts) {
        const file = partBaseName(w.target.base, pw.part)
        if (!pw.part.chunked && name === file) return true
        if (
          pw.part.chunked &&
          (pw.write
            ? new RegExp(`^${escape(file)}\\.\\d{3,}$`).test(name)
            : partFiles(w.target.base, pw.prev!).includes(name))
        )
          return true
      }
    }
    for (const base of kept) {
      const prev = manifest.archives[base]
      if (prev ? prev.parts.some((p) => partFiles(base, p).includes(name)) : ownsFile(base, name))
        return true
    }
    return false
  }
  // The archive a stale file belonged to: from the previous manifest, else from its name.
  const baseOf = (name: string): string =>
    Object.keys(manifest.archives).find((b) => ownsFile(b, name)) ??
    name.replace(/(\.part\d+)?\.zip(\.\d{3,})?$/, '')
  const stale = emptySource
    ? []
    : existing.filter((name) => !owned(name) && !coversUnreadable(baseOf(name), []))
  const targetBases = new Set(targets.map((t) => t.base))

  const toWrite = work.flatMap((w) => w.parts.filter((p) => p.write))
  const plan = basePlan(ctx, 'mirror-zip')
  plan.counts = {
    ...plan.counts,
    zip: toWrite.length,
    unchanged: work.reduce((n, w) => n + w.parts.length, 0) - toWrite.length,
    ...removalCounts(ctx, stale.length)
  }
  plan.bytes = toWrite.reduce((n, p) => n + p.part.files.reduce((m, f) => m + f.size, 0), 0)

  const execute = (x: ExecContext): ReturnType<PreparedJob['execute']> =>
    asJobAbort(ctx.dest, async () => {
      const run = new JobRun(ctx, x, plan.bytes)
      await ctx.dest.removePartials(slug, false)
      await settleLayout(ctx, layout)
      await ctx.dest.removePartials(current, true)
      if (emptySource) warnEmptySource(run)
      const archives: Record<string, ManifestArchive> = {}
      for (const base of kept) {
        if (manifest.archives[base]) archives[base] = manifest.archives[base]
        if (!emptySource) {
          const files = targets.find((t) => t.base === base)!.files
          run.warn(
            {
              path: `${base}.zip`,
              code: 'KEPT',
              message: 'previous archive kept because some of its files could not be read'
            },
            { rels: pendingRels(files, manifest.archives[base]), archive: `${base}.zip` }
          )
        }
      }

      // Archives whose new parts could not all be produced keep their previous state, and none
      // of their old files are removed (C1/I7 in the review: never trade a good copy for none).
      const failedBases = new Set<string>()
      const keepPrevious = (w: ArchiveWork, why: string, noted: Set<string>): void => {
        failedBases.add(w.target.base)
        if (!w.prev) return // nothing to keep; the failure itself was already warned about
        archives[w.target.base] = w.prev
        run.warn(
          { path: `${w.target.base}.zip`, code: 'KEPT', message: why },
          {
            rels: pendingRels(w.target.files, w.prev).filter((rel) => !noted.has(rel)),
            archive: `${w.target.base}.zip`
          }
        )
      }

      for (const w of work) {
        const { base } = w.target
        const prevFiles = new Map<string, { f: FileEntry; archive: string }>()
        for (const p of w.prev?.parts ?? []) {
          for (const f of p.files) prevFiles.set(f.rel, { f, archive: displayName(base, p) })
        }

        // 1. Write every changed part to a temp file; nothing visible changes yet.
        type Staged = { pw: PartWork; file: string; tempRel: string; entryErrors: number }
        const staged: Staged[] = []
        let failed: string | null = null
        const noted = new Set<string>() // files already logged as skipped
        const affected = (part: PartPlan): { rels: string[]; archive: string } => ({
          rels: part.files.map((f) => f.rel),
          archive: displayName(base, part)
        })
        const noteFailed = (part: PartPlan): void => {
          for (const f of part.files) noted.add(f.rel)
        }
        for (const pw of w.parts.filter((p) => p.write)) {
          x.signal.throwIfAborted()
          const file = partBaseName(base, pw.part)
          if (file.includes('/')) {
            await ctx.dest.mkdirp(`${current}/${file.slice(0, file.lastIndexOf('/'))}`)
          }
          let entryErrors = 0
          const r = await run.guard(
            file,
            () =>
              writeZip(
                ctx.dest,
                `${current}/${file}`,
                pw.part.files.map((f) => ({
                  absPath: sourceAbs(ctx, f.rel),
                  name: f.rel,
                  mtimeMs: f.mtimeMs
                })),
                level,
                {
                  signal: x.signal,
                  finalize: false,
                  onBytes: (n: number) => run.progress(file, n),
                  onEntryError: (e, err) => {
                    entryErrors++
                    noted.add(e.name)
                    run.warn({ path: e.name, code: err.code ?? 'ERROR', message: err.message })
                  }
                }
              ),
            affected(pw.part)
          )
          if (!r) {
            noteFailed(pw.part)
            failed = 'previous archive kept because a part could not be written'
            break
          }
          staged.push({ pw, file, tempRel: r.tempRel!, entryErrors })
          if (entryErrors > 0 && w.prev) {
            failed = 'previous archive kept because some of its files could not be read'
            break
          }
        }
        if (failed) {
          for (const st of staged) await ctx.dest.remove(st.tempRel)
          keepPrevious(w, failed, noted)
          continue
        }

        // 2. Commit: move each temp into place (or split it into pieces).
        const committed = new Map<number, number>() // part n → pieces (0 when not chunked)
        for (const [k, st] of staged.entries()) {
          const pieces = await run.guard(
            st.file,
            async () => {
              if (!st.pw.part.chunked) {
                await ctx.dest.rename(st.tempRel, `${current}/${st.file}`)
                return 0
              }
              const names = await splitIntoChunks(
                ctx.dest,
                st.tempRel,
                `${current}/${st.file}`,
                ctx.zip.chunkSize!,
                x.signal
              )
              return names.length
            },
            affected(st.pw.part)
          )
          if (pieces === undefined) {
            noteFailed(st.pw.part)
            for (const rest of staged.slice(k)) await ctx.dest.remove(rest.tempRel)
            break
          }
          committed.set(st.pw.part.n, pieces)
          run.progress(st.file, 0, true)
          run.counts.zipped++
        }
        if (committed.size < staged.length) {
          // Some parts already carry new content under their old names; the previous manifest
          // entry no longer matches them, so the next run rewrites them from the source.
          keepPrevious(w, 'previous archive kept because a part could not be written', noted)
          continue
        }

        // 3. Record the new state and what changed.
        const parts: ManifestPart[] = []
        for (const pw of w.parts) {
          const { part } = pw
          if (!pw.write) {
            parts.push({ ...pw.prev!, files: part.files, fingerprint: pw.fingerprint })
            continue
          }
          const st = staged.find((x) => x.pw === pw)!
          const pieces = committed.get(part.n)!
          parts.push({
            n: part.n,
            chunked: part.chunked,
            ...(part.chunked ? { chunks: pieces } : {}),
            // A skipped entry leaves the fingerprint unset so the part is retried next run.
            fingerprint: st.entryErrors === 0 ? pw.fingerprint : '',
            files: part.files
          })
          for (const f of part.files) {
            const before = prevFiles.get(f.rel)
            if (!before)
              run.change('added', f.rel, { size: f.size, archive: displayName(base, part) })
            else if (!unchanged(before.f, f)) {
              run.change('updated', f.rel, { size: f.size, archive: displayName(base, part) })
            }
            await run.settle()
          }
        }
        const now = new Set(w.target.files.map((f) => f.rel))
        for (const [rel, before] of prevFiles) {
          if (!now.has(rel)) run.change('removed', rel, { archive: before.archive })
          await run.settle()
        }
        if (parts.length > 0) archives[base] = { limit: ctx.zip.limit, parts }
      }

      // Archives whose source content is gone entirely: their files were removed.
      if (!emptySource) {
        for (const [base, prev] of Object.entries(manifest.archives)) {
          if (targetBases.has(base) || kept.has(base)) continue
          if (coversUnreadable(base, [])) {
            archives[base] = prev // its files may still exist but could not be read
            continue
          }
          for (const p of prev.parts) {
            for (const f of p.files) {
              run.change('removed', f.rel, { archive: displayName(base, p) })
              await run.settle()
            }
          }
        }
      }
      for (const name of stale) {
        if (!failedBases.has(baseOf(name))) await removeByPolicy(ctx, run, name, false)
      }
      await ctx.dest.writeTextAtomic(
        manifestRel,
        JSON.stringify({ version: 2, archives } satisfies ManifestV2, null, 2)
      )
      return run.result()
    })
  return { plan, execute }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
