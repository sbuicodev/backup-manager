import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import picomatch from 'picomatch'
import type { FileEntry, SkippedEntry } from '@shared/types'

export type WalkOptions = {
  excludes: string[]
  signal?: AbortSignal
  skipNames?: (name: string) => boolean
  /** Entries directly in root to leave out entirely (not walked, not reported). */
  skipTop?: (name: string) => boolean
}

/**
 * Compiles exclude globs. A pattern without '/' matches the basename at any depth;
 * a trailing '/' restricts the pattern to directories.
 */
export function buildMatcher(excludes: string[]): (rel: string, isDir: boolean) => boolean {
  const rules = excludes
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => {
      const dirOnly = p.endsWith('/')
      const pattern = dirOnly ? p.replace(/\/+$/, '') : p
      const isMatch = picomatch(pattern, { dot: true, basename: !pattern.includes('/') })
      return { dirOnly, isMatch }
    })
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.isMatch(rel))
}

/** Recursively lists files under root (sorted by rel). Rejects if root itself cannot be read. */
export async function walkTree(
  root: string,
  opts: WalkOptions
): Promise<{ files: FileEntry[]; skipped: SkippedEntry[] }> {
  const excluded = buildMatcher(opts.excludes)
  const files: FileEntry[] = []
  const skipped: SkippedEntry[] = []

  async function visit(absDir: string, relDir: string, isRoot: boolean): Promise<void> {
    opts.signal?.throwIfAborted()
    let dir
    try {
      dir = await opendir(absDir)
    } catch (err) {
      if (isRoot) throw err
      skipped.push({ rel: relDir, reason: 'unreadable' })
      return
    }
    for await (const d of dir) {
      if (opts.skipNames?.(d.name)) continue
      if (isRoot && opts.skipTop?.(d.name)) continue
      const rel = relDir === '' ? d.name : `${relDir}/${d.name}`
      const abs = join(absDir, d.name)
      if (d.isSymbolicLink()) {
        if (!excluded(rel, false)) skipped.push({ rel, reason: 'symlink' })
      } else if (d.isDirectory()) {
        if (!excluded(rel, true)) await visit(abs, rel, false)
      } else if (d.isFile()) {
        if (excluded(rel, false)) continue
        try {
          const s = await stat(abs)
          files.push({ rel, size: s.size, mtimeMs: s.mtimeMs })
        } catch {
          skipped.push({ rel, reason: 'unreadable' })
        }
      }
    }
  }

  await visit(root, '', true)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files, skipped }
}
