import { createHash } from 'node:crypto'
import { itemRel, type Source } from '@shared/schema'
import type { FileEntry } from '@shared/types'

/** `base` is the archive name without `.zip`; parts are named from it (see parts.ts). */
export type ZipTarget = { base: string; name: string; files: FileEntry[]; fingerprint: string }

export function fingerprint(files: FileEntry[], level: number): string {
  const lines = [...files]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((f) => `${f.rel}|${f.size}|${Math.floor(f.mtimeMs)}`)
  return createHash('sha256')
    .update(`level:${level}\n${lines.join('\n')}`)
    .digest('hex')
}

/**
 * Archive layout for a zip source; entry names inside each archive are the files' rels. With
 * `itemized` (files named `<item>/…`), "zip each item" works inside each folder item —
 * `<folder>/<entry>.zip` — and gives each listed file its own `<file>.zip`.
 */
export function computeZipTargets(
  source: Source,
  files: FileEntry[],
  itemized = false
): ZipTarget[] {
  const level = source.zip.level
  if (source.packaging === 'zip-whole') {
    return [
      {
        base: source.slug,
        name: `${source.slug}.zip`,
        files,
        fingerprint: fingerprint(files, level)
      }
    ]
  }

  if (!itemized) return zipEachEntry(files, '', source.zip.looseFiles, level)
  // Listed files each get their own zip in their subfolder; each folder item is laid out like a
  // folder, in its own place.
  const folderRels = source.items.filter((i) => i.kind === 'folder').map((i) => itemRel(i))
  const items = new Map<string, FileEntry[]>()
  const fileItems = new Map<string, FileEntry[]>()
  for (const f of files) {
    const folder = folderRels.find((r) => f.rel.startsWith(`${r}/`))
    const [map, key] =
      folder !== undefined
        ? [items, folder]
        : [fileItems, f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '']
    map.set(key, [...(map.get(key) ?? []), f])
  }
  return [
    ...[...fileItems].flatMap(([sub, group]) =>
      zipEachEntry(group, sub ? `${sub}/` : '', 'individual', level)
    ),
    ...[...items].flatMap(([item, group]) =>
      zipEachEntry(group, `${item}/`, source.zip.looseFiles, level)
    )
  ]
}

/**
 * One archive per entry directly under `prefix` (a folder → its files, a loose file → itself, or
 * all loose files together in `_files`). Archive names live under `prefix` too.
 */
function zipEachEntry(
  files: FileEntry[],
  prefix: string,
  looseFiles: Source['zip']['looseFiles'],
  level: number
): ZipTarget[] {
  const dirs = new Map<string, FileEntry[]>()
  const loose: FileEntry[] = []
  for (const f of files) {
    const rest = f.rel.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) {
      loose.push(f)
      continue
    }
    const top = rest.slice(0, slash)
    const group = dirs.get(top) ?? []
    group.push(f)
    dirs.set(top, group)
  }

  const taken = new Set<string>()
  // A stem ending in ".partN" would share file names with another archive's parts.
  const unusable = (name: string): boolean =>
    taken.has(name.toLowerCase()) || /\.part\d+\.zip$/i.test(name)
  const claim = (stem: string): string => {
    let name = `${stem}.zip`
    for (let n = 2; unusable(name); n++) name = `${stem}-${n}.zip`
    taken.add(name.toLowerCase())
    return name
  }
  const target = (stem: string, group: FileEntry[]): ZipTarget => {
    const name = `${prefix}${claim(stem)}`
    return {
      base: name.slice(0, -'.zip'.length),
      name,
      files: group,
      fingerprint: fingerprint(group, level)
    }
  }

  const targets = [...dirs].map(([dir, group]) => target(dir, group))
  if (looseFiles === 'bundle') {
    if (loose.length > 0) targets.push(target('_files', loose))
  } else {
    for (const f of loose) targets.push(target(f.rel.slice(prefix.length), [f]))
  }
  return targets
}
