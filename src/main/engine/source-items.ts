import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileName, type Source } from '@shared/schema'
import type { FileEntry, SkippedEntry } from '@shared/types'
import { walkTree } from './walk'

export type SourceFiles = {
  /** Every file, named `<item>` for a file item and `<item>/<path inside it>` for a folder. */
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
  for (const item of source.items) {
    const name = fileName(item.path)
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
    const slash = rel.indexOf('/')
    const top = paths.get(slash < 0 ? rel : rel.slice(0, slash))!
    return slash < 0 ? top.path : join(top.path, ...rel.slice(slash + 1).split('/'))
  }
  return { files, skipped, absOf }
}
