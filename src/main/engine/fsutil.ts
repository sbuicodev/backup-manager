import { randomBytes } from 'node:crypto'
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

export function isPartialName(name: string): boolean {
  return name.endsWith('.partial')
}
