import { createHash, randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'

/** Writes text to `file` via a temp file + fsync + rename, so readers never see a partial file. */
export async function atomicWriteText(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Joins relative posix path parts; throws on absolute parts or `..` segments. */
export function joinRel(...parts: string[]): string {
  const segs: string[] = []
  for (const part of parts) {
    const p = toPosix(part)
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p))
      throw new Error(`absolute path not allowed: ${part}`)
    for (const s of p.split('/')) {
      if (s === '' || s === '.') continue
      if (s === '..') throw new Error(`path escapes root: ${part}`)
      segs.push(s)
    }
  }
  return segs.join('/')
}

/** Suffix of every in-progress output the app writes; specific enough not to clash with user files. */
export const PARTIAL_SUFFIX = '.bm-partial'

export function isPartialName(name: string): boolean {
  return name.endsWith(PARTIAL_SUFFIX)
}

/**
 * Temp name for writing `rel` atomically: a short hidden sibling, so even names near the
 * filesystem's 255-byte limit still get a valid temp name.
 */
export function partialSiblingRel(rel: string): string {
  const r = joinRel(rel)
  const slash = r.lastIndexOf('/')
  const base = r.slice(slash + 1)
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 12)
  return `${slash < 0 ? '' : r.slice(0, slash + 1)}.${hash}${PARTIAL_SUFFIX}`
}
