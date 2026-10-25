import { once } from 'node:events'
import { open } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import type { Destination } from '../destination'

export type ZipEntry = { absPath: string; name: string; mtimeMs: number }

export type WriteZipOptions = {
  signal?: AbortSignal
  onBytes?: (n: number) => void
  onEntryError?: (e: ZipEntry, err: NodeJS.ErrnoException) => void
}

/** Errors opening an entry's file that skip the entry instead of failing the archive. */
const SKIPPABLE = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY'])

/**
 * Streams `entries` into `<rel>.partial`, verifies the entry count, then renames to `rel`.
 * Files are opened one at a time so large trees don't exhaust file descriptors.
 */
export async function writeZip(
  dest: Destination,
  rel: string,
  entries: ZipEntry[],
  level: number,
  opts: WriteZipOptions
): Promise<{ bytes: number; entryCount: number }> {
  const partialRel = `${rel}.partial`
  const out = await dest.writeStream(partialRel)
  const zip = new yazl.ZipFile()
  const zipError = new Promise<never>((_, reject) => zip.on('error', reject))
  const written = pipeline(zip.outputStream, out, { signal: opts.signal })
  // Either may reject while we're still adding entries; observe them so nothing goes unhandled.
  zipError.catch(() => {})
  written.catch(() => {})
  const failed = Promise.race([
    zipError,
    written.then(() => Promise.reject(new Error('zip closed early')))
  ])
  failed.catch(() => {})

  let bytes = 0
  let entryCount = 0
  try {
    for (const e of entries) {
      opts.signal?.throwIfAborted()
      let fh
      try {
        fh = await open(e.absPath, 'r')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code && SKIPPABLE.has(code)) {
          opts.onEntryError?.(e, err as NodeJS.ErrnoException)
          continue
        }
        throw err
      }
      const rs = fh.createReadStream()
      rs.on('data', (c) => {
        bytes += c.length
        opts.onBytes?.(c.length)
      })
      const consumed = once(rs, 'close')
      zip.addReadStream(rs, e.name, { mtime: new Date(e.mtimeMs), compressionLevel: level })
      entryCount++
      try {
        await Promise.race([consumed, failed])
      } catch (err) {
        rs.destroy()
        throw err
      }
    }
    zip.end()
    await Promise.race([written, zipError])
    const size = (await dest.stat(partialRel))?.size ?? 0
    const count = await readZipEntryCount(dest.abs(partialRel))
    if (size === 0 || count !== entryCount) {
      throw new Error(
        `zip verification failed for ${rel}: ${count} entries, expected ${entryCount}`
      )
    }
    await dest.rename(partialRel, rel)
    return { bytes, entryCount }
  } catch (err) {
    (zip.outputStream as unknown as Readable).destroy()
    await written.catch(() => {})
    await dest.remove(partialRel)
    throw err
  }
}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50

/** Reads the total entry count from the zip's (ZIP64) end-of-central-directory record. */
export async function readZipEntryCount(file: string): Promise<number> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const tailLen = Math.min(size, 65557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error(`not a zip file: ${file}`)
    const total = tail.readUInt16LE(eocd + 10)
    if (total !== 0xffff) return total
    const loc = eocd - 20
    if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) {
      throw new Error(`missing ZIP64 locator: ${file}`)
    }
    const offset = Number(tail.readBigUInt64LE(loc + 8))
    const rec = Buffer.alloc(56)
    await fh.read(rec, 0, 56, offset)
    if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error(`bad ZIP64 record: ${file}`)
    return Number(rec.readBigUInt64LE(32))
  } finally {
    await fh.close()
  }
}
