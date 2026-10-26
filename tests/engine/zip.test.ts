import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import yauzl from 'yauzl'
import { FsDestination } from '../../src/main/engine/destination'
import { partSize } from '../../src/main/engine/packaging/parts'
import {
  readZipEntryCount,
  splitIntoChunks,
  writeZip,
  type ZipEntry
} from '../../src/main/engine/packaging/zip'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

type ReadEntry = { name: string; content: string; method: number; mtime: Date }

function readZip(file: string): Promise<ReadEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err)
      const out: ReadEntry[] = []
      zf.on('entry', (e: yauzl.Entry) => {
        zf.openReadStream(e, (err2, rs) => {
          if (err2 || !rs) return reject(err2)
          const chunks: Buffer[] = []
          rs.on('data', (c: Buffer) => chunks.push(c))
          rs.on('end', () => {
            out.push({
              name: e.fileName,
              content: Buffer.concat(chunks).toString('utf8'),
              method: e.compressionMethod,
              mtime: e.getLastModDate()
            })
            zf.readEntry()
          })
        })
      })
      zf.on('end', () => resolve(out))
      zf.on('error', reject)
      zf.readEntry()
    })
  })
}

async function fixture(): Promise<{ src: string; root: string; entries: ZipEntry[] }> {
  const src = await tmpDir()
  const root = await tmpDir()
  const mtime = new Date(2025, 5, 6, 7, 8, 10)
  await makeTree(src, {
    'a.txt': { content: 'aaaa'.repeat(100), mtime },
    'd/b.txt': { content: 'b', mtime },
    'd/e/c.txt': { content: 'c', mtime }
  })
  const entries = ['a.txt', 'd/b.txt', 'd/e/c.txt'].map((name) => ({
    absPath: join(src, ...name.split('/')),
    name,
    mtimeMs: mtime.getTime()
  }))
  return { src, root, entries }
}

test('writes entries with names, contents and mtimes; no partial left', async () => {
  const { root, entries } = await fixture()
  const dest = new FsDestination(root)
  const r = await writeZip(dest, 'S/out.zip', entries, 6, {})
  expect(r.entryCount).toBe(3)
  expect(r.bytes).toBe(402)
  const read = await readZip(join(root, 'S/out.zip'))
  expect(read.map((e) => e.name)).toEqual(['a.txt', 'd/b.txt', 'd/e/c.txt'])
  expect(read[0].content).toBe('aaaa'.repeat(100))
  expect(Math.abs(read[1].mtime.getTime() - entries[1].mtimeMs)).toBeLessThanOrEqual(2000)
  expect(Object.keys(await readTree(root))).toEqual(['S/out.zip'])
})

test('level 0 stores, level 9 deflates', async () => {
  const { root, entries } = await fixture()
  const dest = new FsDestination(root)
  await writeZip(dest, 'store.zip', entries, 0, {})
  await writeZip(dest, 'max.zip', entries, 9, {})
  expect((await readZip(join(root, 'store.zip'))).map((e) => e.method)).toEqual([0, 0, 0])
  expect((await readZip(join(root, 'max.zip'))).map((e) => e.method)).toEqual([8, 8, 8])
})

test('readZipEntryCount for 0 and 3 entries', async () => {
  const { root, entries } = await fixture()
  const dest = new FsDestination(root)
  await writeZip(dest, 'empty.zip', [], 6, {})
  await writeZip(dest, 'three.zip', entries, 6, {})
  expect(await readZipEntryCount(join(root, 'empty.zip'))).toBe(0)
  expect(await readZipEntryCount(join(root, 'three.zip'))).toBe(3)
})

test('readZipEntryCount handles ZIP64 (70 000 entries)', { timeout: 60_000 }, async () => {
  const src = await tmpDir()
  const root = await tmpDir()
  const one = join(src, 'one')
  await writeFile(one, 'x')
  const entries = Array.from({ length: 70_000 }, (_, i) => ({
    absPath: one,
    name: `f${i}`,
    mtimeMs: Date.now()
  }))
  const r = await writeZip(new FsDestination(root), 'big.zip', entries, 0, {})
  expect(r.entryCount).toBe(70_000)
  expect(await readZipEntryCount(join(root, 'big.zip'))).toBe(70_000)
})

test('a missing entry file is reported and skipped, archive still valid', async () => {
  const { root, entries } = await fixture()
  const missing = { absPath: join(root, 'nope.txt'), name: 'nope.txt', mtimeMs: 0 }
  const errors: string[] = []
  const r = await writeZip(new FsDestination(root), 'x.zip', [entries[0], missing, entries[1]], 6, {
    onEntryError: (e, err) => errors.push(`${e.name}:${err.code}`)
  })
  expect(errors).toEqual(['nope.txt:ENOENT'])
  expect(r.entryCount).toBe(2)
  expect((await readZip(join(root, 'x.zip'))).map((e) => e.name)).toEqual(['a.txt', 'd/b.txt'])
})

test('abort mid-write rejects and leaves no partial or target', async () => {
  const src = await tmpDir()
  const root = await tmpDir()
  await writeFile(join(src, 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 7))
  const ac = new AbortController()
  const entries = [{ absPath: join(src, 'big.bin'), name: 'big.bin', mtimeMs: Date.now() }]
  await expect(
    writeZip(new FsDestination(root), 'S/a.zip', entries, 0, {
      signal: ac.signal,
      onBytes: () => ac.abort()
    })
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(await readTree(root)).toEqual({})
})

test('several multi-chunk files at level 6 keep their full contents', async () => {
  const src = await tmpDir()
  const root = await tmpDir()
  const entries: ZipEntry[] = []
  for (let i = 0; i < 5; i++) {
    const p = join(src, `f${i}.bin`)
    await writeFile(p, randomBytes(200_000 + i * 1000))
    entries.push({ absPath: p, name: `f${i}.bin`, mtimeMs: Date.now() })
  }
  await writeZip(new FsDestination(root), 'x.zip', entries, 6, {})
  const read = await readZipBuffers(join(root, 'x.zip'))
  for (const e of entries) {
    expect(read[e.name]?.equals(await readFile(e.absPath)), e.name).toBe(true)
  }
})

function readZipBuffers(file: string): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err)
      const out: Record<string, Buffer> = {}
      zf.on('entry', (e: yauzl.Entry) => {
        zf.openReadStream(e, (err2, rs) => {
          if (err2 || !rs) return reject(err2)
          const chunks: Buffer[] = []
          rs.on('data', (c: Buffer) => chunks.push(c))
          rs.on('end', () => {
            out[e.fileName] = Buffer.concat(chunks)
            zf.readEntry()
          })
        })
      })
      zf.on('end', () => resolve(out))
      zf.on('error', reject)
      zf.readEntry()
    })
  })
}

describe('chunked parts', () => {
  async function bigZipTemp(): Promise<{
    root: string
    dest: FsDestination
    tempRel: string
    content: Buffer
  }> {
    const src = await tmpDir()
    const root = await tmpDir()
    const content = randomBytes(3 * 1024 * 1024 + 123)
    await writeFile(join(src, 'big.bin'), content)
    const dest = new FsDestination(root)
    const r = await writeZip(
      dest,
      'S/B.part1.zip',
      [{ absPath: join(src, 'big.bin'), name: 'big.bin', mtimeMs: Date.now() }],
      0,
      {
        finalize: false
      }
    )
    return { root, dest, tempRel: r.tempRel!, content }
  }

  test('finalize:false leaves a verified temp zip and no target', async () => {
    const { root, tempRel } = await bigZipTemp()
    expect(tempRel).toMatch(/\.bm-partial$/)
    expect(await readZipEntryCount(join(root, ...tempRel.split('/')))).toBe(1)
    expect(Object.keys(await readTree(root)).some((k) => k === 'S/B.part1.zip')).toBe(false)
  })

  test('chunks rejoin byte-identically to the zip, which extracts the file', async () => {
    const { root, dest, tempRel, content } = await bigZipTemp()
    const zipBytes = await readFile(join(root, ...tempRel.split('/')))
    const names = await splitIntoChunks(dest, tempRel, 'S/B.part1.zip', 1024 * 1024)
    expect(names).toEqual([
      'B.part1.zip.001',
      'B.part1.zip.002',
      'B.part1.zip.003',
      'B.part1.zip.004'
    ])
    const joined = Buffer.concat(await Promise.all(names.map((n) => readFile(join(root, 'S', n)))))
    expect(joined.equals(zipBytes)).toBe(true)
    await writeFile(join(root, 'joined.zip'), joined)
    expect((await readZipBuffers(join(root, 'joined.zip')))['big.bin'].equals(content)).toBe(true)
    expect((await dest.list('S')).map((e) => e.name).sort()).toEqual(names)
  })

  test('stale higher-numbered chunks from a larger previous version are removed', async () => {
    const { dest, tempRel } = await bigZipTemp()
    await dest.writeTextAtomic('S/B.part1.zip.005', 'old')
    await dest.writeTextAtomic('S/B.part1.zip.006', 'old')
    await splitIntoChunks(dest, tempRel, 'S/B.part1.zip', 1024 * 1024)
    expect((await dest.list('S')).map((e) => e.name).sort()).toEqual([
      'B.part1.zip.001',
      'B.part1.zip.002',
      'B.part1.zip.003',
      'B.part1.zip.004'
    ])
  })

  test('abort mid-split leaves no chunk files and no temp file', async () => {
    const { dest, tempRel } = await bigZipTemp()
    const ac = new AbortController()
    const p = splitIntoChunks(dest, tempRel, 'S/B.part1.zip', 1024 * 1024, ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(await dest.list('S')).toEqual([])
  })
})

describe('part size budget', () => {
  test.each([
    ['empty files, level 0', 0, 0],
    ['10-byte files, level 6', 10, 6],
    ['1 KB files, level 0', 1024, 0],
    ['1 KB files, level 6', 1024, 6]
  ])(
    'real archive never exceeds partSize: %s',
    { timeout: 60_000 },
    async (_label, size, level) => {
      const src = await tmpDir()
      const root = await tmpDir()
      const files: { rel: string; size: number; mtimeMs: number }[] = []
      for (let i = 0; i < 2000; i++) {
        const rel = `dir-${i % 7}/file-${i}.bin`
        await mkdir(join(src, `dir-${i % 7}`), { recursive: true })
        await writeFile(join(src, rel), randomBytes(size))
        files.push({ rel, size, mtimeMs: Date.now() })
      }
      await writeZip(
        new FsDestination(root),
        'x.zip',
        files.map((f) => ({ absPath: join(src, f.rel), name: f.rel, mtimeMs: f.mtimeMs })),
        level,
        {}
      )
      expect((await stat(join(root, 'x.zip'))).size).toBeLessThanOrEqual(partSize(files))
    }
  )
})

test('splitIntoChunks removes a stale 4-digit piece', async () => {
  const src = await tmpDir()
  const root = await tmpDir()
  await writeFile(join(src, 'big.bin'), randomBytes(3 * 1024 * 1024))
  const dest = new FsDestination(root)
  await dest.writeTextAtomic('S/B.part1.zip.1000', 'old')
  const r = await writeZip(
    dest,
    'S/B.part1.zip',
    [{ absPath: join(src, 'big.bin'), name: 'big.bin', mtimeMs: Date.now() }],
    0,
    { finalize: false }
  )
  await splitIntoChunks(dest, r.tempRel!, 'S/B.part1.zip', 1024 * 1024)
  expect((await dest.list('S')).map((e) => e.name)).not.toContain('B.part1.zip.1000')
})

describe('replacing an existing piece set', () => {
  // Hashes, not buffers: a failing deep-equal on megabytes of bytes takes forever to diff.
  const snapshot = async (root: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    for (const n of await readdir(join(root, 'S'))) {
      out[n] = createHash('sha1').update(await readFile(join(root, 'S', n))).digest('hex')
    }
    return out
  }
  async function oldSet(): Promise<{ src: string; dest: FsDestination; root: string; old: Record<string, string> }> {
    const src = await tmpDir()
    const root = await tmpDir()
    const dest = new FsDestination(root)
    await writeFile(join(src, 'big.bin'), randomBytes(3 * 1024 * 1024))
    const r = await writeZip(dest, 'S/B.part1.zip', [{ absPath: join(src, 'big.bin'), name: 'big.bin', mtimeMs: Date.now() }], 0, { finalize: false })
    await splitIntoChunks(dest, r.tempRel!, 'S/B.part1.zip', 1024 * 1024)
    const old = await snapshot(root)
    await writeFile(join(src, 'big.bin'), randomBytes(3 * 1024 * 1024)) // the file changes
    return { src, dest, root, old }
  }

  test('cancel while splitting leaves the previous pieces untouched', async () => {
    const { src, dest, root, old } = await oldSet()
    const r = await writeZip(dest, 'S/B.part1.zip', [{ absPath: join(src, 'big.bin'), name: 'big.bin', mtimeMs: Date.now() }], 0, { finalize: false })
    const ac = new AbortController()
    let writes = 0
    const watching = new (class extends FsDestination {
      override async writeStream(rel: string): Promise<NodeJS.WritableStream> {
        if (rel.includes('.bm-partial') && ++writes === 2) ac.abort()
        return super.writeStream(rel)
      }
    })(root)
    await expect(splitIntoChunks(watching, r.tempRel!, 'S/B.part1.zip', 1024 * 1024, ac.signal)).rejects.toThrow()
    expect(await snapshot(root)).toEqual(old)
  })

  test('a write error while splitting leaves the previous pieces untouched', async () => {
    const { src, root, old } = await oldSet()
    let writes = 0
    const failing = new (class extends FsDestination {
      override async writeStream(rel: string): Promise<NodeJS.WritableStream> {
        if (rel.includes('.bm-partial') && ++writes === 3) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        return super.writeStream(rel)
      }
    })(root)
    const r = await writeZip(failing, 'S/B.part1.zip', [{ absPath: join(src, 'big.bin'), name: 'big.bin', mtimeMs: Date.now() }], 0, { finalize: false })
    await expect(splitIntoChunks(failing, r.tempRel!, 'S/B.part1.zip', 1024 * 1024)).rejects.toThrow('ENOSPC')
    expect(await snapshot(root)).toEqual(old)
  })
})
