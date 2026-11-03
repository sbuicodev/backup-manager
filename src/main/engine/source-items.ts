import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { itemRel, storesFlat, type Source } from '@shared/schema'
import type { FileEntry, SkippedEntry } from '@shared/types'
import { walkTree } from './walk'

export type SourceFiles = {
  /**
   * Every file, named `<item>` for a file item and `<item>/<path inside it>` for a folder, where
   * `<item>` is `[<subfolder>/]<name>`; a backup of one folder names them by their path inside it.
   */
  files: FileEntry[]
  /** Unreadable entries; a whole missing item is reported under its own name. */
  skipped: SkippedEntry[]
  /** Absolute path of a file named as above. */
  absOf: (rel: string) => string
}

/**
 * Reads a source's items. Exclusions apply inside each folder, relative to that folder. Returns
 * null when not one item could be read (the source is "missing", like an unplugged drive).
 */
export async function readSourceItems(
  source: Source,
  excludes: string[],
  signal?: AbortSignal
): Promise<SourceFiles | null> {
  const files: FileEntry[] = []
  const skipped: SkippedEntry[] = []
  const paths = new Map<string, { path: string; folder: boolean }>()
  let readable = 0
  if (storesFlat(source)) {
    const root = source.items[0].path
    try {
      const r = await walkTree(root, { excludes, signal })
      return { files: r.files, skipped: r.skipped, absOf: (rel) => join(root, ...rel.split('/')) }
    } catch (err) {
      signal?.throwIfAborted()
      void err
      return null
    }
  }
  for (const item of source.items) {
    const name = itemRel(item)
    paths.set(name, { path: item.path, folder: item.kind === 'folder' })
    try {
      if (item.kind === 'folder') {
        const r = await walkTree(item.path, { excludes, signal })
        for (const f of r.files) files.push({ ...f, rel: `${name}/${f.rel}` })
        for (const s of r.skipped) skipped.push({ ...s, rel: `${name}/${s.rel}` })
      } else {
        const st = await stat(item.path)
        if (!st.isFile()) throw new Error('not a file')
        files.push({ rel: name, size: st.size, mtimeMs: st.mtimeMs })
      }
      readable++
    } catch (err) {
      signal?.throwIfAborted()
      // Missing or unreadable: its backup is protected like any unreadable path.
      skipped.push({ rel: name, reason: 'unreadable' })
      void err
    }
  }
  if (readable === 0) return null
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const absOf = (rel: string): string => {
    const exact = paths.get(rel)
    if (exact) return exact.path
    // A file inside a folder item: the item whose name starts the path.
    for (const [name, top] of paths) {
      if (top.folder && rel.startsWith(`${name}/`)) {
        return join(top.path, ...rel.slice(name.length + 1).split('/'))
      }
    }
    throw new Error(`no item holds "${rel}"`)
  }
  return { files, skipped, absOf }
}
