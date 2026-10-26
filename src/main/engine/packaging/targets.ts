import { createHash } from 'node:crypto'
import type { Source } from '@shared/schema'
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

/** Archive layout for a zip source; entry names inside each archive are rels from the source root. */
export function computeZipTargets(source: Source, files: FileEntry[]): ZipTarget[] {
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

  const dirs = new Map<string, FileEntry[]>()
  const loose: FileEntry[] = []
  for (const f of files) {
    const slash = f.rel.indexOf('/')
    if (slash < 0) {
      loose.push(f)
      continue
    }
    const top = f.rel.slice(0, slash)
    const group = dirs.get(top) ?? []
    group.push(f)
    dirs.set(top, group)
  }

  const taken = new Set<string>()
  const claim = (stem: string): string => {
    let name = `${stem}.zip`
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}.zip`
    taken.add(name.toLowerCase())
    return name
  }
  const target = (stem: string, group: FileEntry[]): ZipTarget => {
    const name = claim(stem)
    return {
      base: name.slice(0, -'.zip'.length),
      name,
      files: group,
      fingerprint: fingerprint(group, level)
    }
  }

  const targets = [...dirs].map(([dir, group]) => target(dir, group))
  if (source.zip.looseFiles === 'bundle') {
    if (loose.length > 0) targets.push(target('_files', loose))
  } else {
    for (const f of loose) targets.push(target(f.rel, [f]))
  }
  return targets
}
