import { randomBytes } from 'node:crypto'
import { chmod, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import yauzl from 'yauzl'
import { effectiveZipSettings, newDestination, newSource, type Source } from '@shared/schema'
import type { ChangeEntry, JobResult } from '@shared/types'
import { FsDestination, MANIFEST_NAME } from '../../src/main/engine/destination'
import type { ExecContext, JobContext } from '../../src/main/engine/job'
import { prepareMirrorZip } from '../../src/main/engine/mirror'
import { formatTimestamp } from '../../src/main/engine/naming'
import { partSize } from '../../src/main/engine/packaging/parts'
import { walkTree } from '../../src/main/engine/walk'
import { tmpDir } from '../helpers/fs'

const KB = 1024
const MB = 1024 * KB
const NOW = new Date(2026, 9, 26, 10, 0, 0)
const TS = formatTimestamp(NOW)
const posixNonRoot = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test

type World = { src: string; root: string; source: Source; dest: FsDestination; current: string }

async function world(files: Record<string, number>, limit: number | null): Promise<World> {
  const src = await tmpDir()
  const root = await tmpDir()
  for (const [rel, size] of Object.entries(files)) await put(src, rel, size)
  const source = { ...newSource(src, 'S', []), packaging: 'zip-whole' as const }
  source.zip = { ...source.zip, level: 0, partLimitBytes: limit }
  return { src, root, source, dest: new FsDestination(root), current: join(root, 'S', 'current') }
}

async function put(dir: string, rel: string, size: number): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  const abs = join(dir, ...rel.split('/'))
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, randomBytes(size))
}

async function run(w: World, changes: ChangeEntry[] = []): Promise<JobResult> {
  const { files, skipped } = await walkTree(w.source.path, { excludes: [] })
  const ctx: JobContext = {
    source: w.source,
    destId: 'd1',
    dest: w.dest,
    globalExcludes: [],
    srcFiles: files,
    srcSkipped: skipped,
    now: NOW,
    zip: effectiveZipSettings(w.source, newDestination('/d', 'D'))
  }
  const x: ExecContext = {
    runId: 'r',
    signal: new AbortController().signal,
    emit: () => {},
    record: (c) => changes.push(c)
  }
  return (await prepareMirrorZip(ctx)).execute(x)
}

const names = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n !== MANIFEST_NAME).sort()

function unzip(file: string): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err)
      const out: Record<string, Buffer> = {}
      zf.on('entry', (e: yauzl.Entry) =>
        zf.openReadStream(e, (err2, rs) => {
          if (err2 || !rs) return reject(err2)
          const chunks: Buffer[] = []
          rs.on('data', (c: Buffer) => chunks.push(c))
          rs.on('end', () => {
            out[e.fileName] = Buffer.concat(chunks)
            zf.readEntry()
          })
        })
      )
      zf.on('end', () => resolve(out))
      zf.on('error', reject)
      zf.readEntry()
    })
  })
}

/** All files contained in the archives in `dir` (chunks are rejoined first). */
async function contents(dir: string, scratch: string): Promise<Record<string, Buffer>> {
  const all: Record<string, Buffer> = {}
  const files = await names(dir)
  const groups = new Map<string, string[]>()
  for (const n of files) {
    const key = n.replace(/\.\d{3}$/, '')
    groups.set(key, [...(groups.get(key) ?? []), n])
  }
  for (const [key, parts] of groups) {
    const joined = join(scratch, key)
    await writeFile(
      joined,
      Buffer.concat(await Promise.all(parts.sort().map((p) => readFile(join(dir, p)))))
    )
    Object.assign(all, await unzip(joined))
  }
  return all
}

async function sourceFiles(src: string): Promise<Record<string, Buffer>> {
  const { files } = await walkTree(src, { excludes: [] })
  return Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [f.rel, await readFile(join(src, ...f.rel.split('/')))])
    )
  )
}

const age = async (file: string): Promise<void> => {
  const old = new Date(2020, 0, 1)
  await utimes(file, old, old)
}

describe('mirror zip parts', () => {
  test('an archive within the limit stays S.zip', async () => {
    const w = await world({ a: 100 * KB, b: 100 * KB }, MB)
    await run(w)
    expect(await names(w.current)).toEqual(['S.zip'])
  })

  test('over the limit: S.part1.zip… each within the limit, together holding every file', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB, d: 400 * KB, e: 400 * KB }, MB)
    await run(w)
    const parts = await names(w.current)
    expect(parts).toEqual(['S.part1.zip', 'S.part2.zip', 'S.part3.zip'])
    for (const p of parts) expect((await stat(join(w.current, p))).size).toBeLessThanOrEqual(MB)
    expect(await contents(w.current, await tmpDir())).toEqual(await sourceFiles(w.src))
  })

  test('one changed file rewrites only its part', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB, d: 400 * KB }, MB)
    await run(w)
    for (const p of await names(w.current)) await age(join(w.current, p))
    await put(w.src, 'd', 400 * KB)
    const r = await run(w)
    expect(r.counts.zipped).toBe(1)
    expect((await stat(join(w.current, 'S.part1.zip'))).mtime.getFullYear()).toBe(2020)
    expect((await stat(join(w.current, 'S.part2.zip'))).mtime.getFullYear()).not.toBe(2020)
  })

  test('a new file appends to the last part and is recorded as added there', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 300 * KB }, MB) // part1 a b, part2 c
    await run(w)
    await put(w.src, 'z', 300 * KB)
    const changes: ChangeEntry[] = []
    await run(w, changes)
    expect(changes).toEqual([
      expect.objectContaining({
        action: 'added',
        path: 'z',
        archive: 'S.part2.zip',
        size: 300 * KB
      })
    ])
  })

  test('oversized file: own part over the limit, or chunks that rejoin', async () => {
    const own = await world({ a: 100 * KB, big: 3 * MB }, MB)
    await run(own)
    expect(await names(own.current)).toEqual(['S.part1.zip', 'S.part2.zip'])
    expect((await stat(join(own.current, 'S.part2.zip'))).size).toBeGreaterThan(MB)

    const ch = await world({ a: 100 * KB, big: 3 * MB }, MB)
    ch.source.zip.oversized = 'chunk'
    await run(ch)
    const files = await names(ch.current)
    expect(files[0]).toBe('S.part1.zip')
    expect(files.slice(1)).toEqual([
      'S.part2.zip.001',
      'S.part2.zip.002',
      'S.part2.zip.003',
      'S.part2.zip.004'
    ])
    for (const f of files) expect((await stat(join(ch.current, f))).size).toBeLessThanOrEqual(MB)
    expect(await contents(ch.current, await tmpDir())).toEqual(await sourceFiles(ch.src))
    const again = await run(ch)
    expect(again.counts.zipped).toBe(0)
  })

  test('limit switched off: parts become S.zip and old parts are trashed', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB }, MB)
    await run(w)
    w.source.zip.partLimitBytes = null
    await run(w)
    expect(await names(w.current)).toEqual(['S.zip'])
    expect((await readdir(join(w.root, 'S', '.trash', TS))).sort()).toEqual([
      'S.part1.zip',
      'S.part2.zip'
    ])
    expect(await contents(w.current, await tmpDir())).toEqual(await sourceFiles(w.src))
  })

  test('limit lowered: repacked, old part names follow the deletion policy, nothing lost', async () => {
    const w = await world(
      { a: 300 * KB, b: 300 * KB, c: 300 * KB, d: 300 * KB, e: 300 * KB },
      2 * MB
    )
    w.source.mirror.deletion = 'exact'
    await run(w)
    expect(await names(w.current)).toEqual(['S.zip'])
    w.source.zip.partLimitBytes = MB
    await run(w)
    const parts = await names(w.current)
    expect(parts).toEqual(['S.part1.zip', 'S.part2.zip'])
    expect(await contents(w.current, await tmpDir())).toEqual(await sourceFiles(w.src))
  })

  test('a version-1 manifest is treated as empty: archives rebuilt once, nothing lost', async () => {
    const w = await world({ a: 100 * KB }, null)
    await run(w)
    await writeFile(
      join(w.current, MANIFEST_NAME),
      JSON.stringify({ version: 1, archives: { 'S.zip': 'x' } })
    )
    const r = await run(w)
    expect(r.counts.zipped).toBe(1)
    expect(JSON.parse(await readFile(join(w.current, MANIFEST_NAME), 'utf8')).version).toBe(2)
    expect((await run(w)).counts.zipped).toBe(0)
  })

  posixNonRoot('an unreadable member keeps every part of that archive unchanged', async () => {
    const w = await world({ 'A/x': 400 * KB, 'A/y': 400 * KB, 'A/sub/z': 400 * KB }, MB)
    w.source.packaging = 'zip-children'
    await run(w)
    const before = await names(w.current)
    const bytes = await Promise.all(before.map((n) => readFile(join(w.current, n))))
    await chmod(join(w.src, 'A', 'sub'), 0o000)
    try {
      const r = await run(w)
      expect(r.counts.zipped).toBe(0)
      expect(await names(w.current)).toEqual(before)
      for (const [i, n] of before.entries())
        expect((await readFile(join(w.current, n))).equals(bytes[i])).toBe(true)
    } finally {
      await chmod(join(w.src, 'A', 'sub'), 0o755)
    }
  })

  test('an empty-looking source rewrites and removes nothing', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB }, MB)
    w.source.mirror.deletion = 'exact'
    await run(w)
    const before = await names(w.current)
    for (const f of ['a', 'b', 'c']) await rm(join(w.src, f))
    const r = await run(w)
    expect(r.counts.zipped + r.counts.deleted).toBe(0)
    expect(await names(w.current)).toEqual(before)
  })

  test('a removed source file is recorded as removed with its previous part', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB, d: 400 * KB }, MB)
    await run(w)
    await rm(join(w.src, 'd'))
    const changes: ChangeEntry[] = []
    await run(w, changes)
    expect(changes).toEqual([
      expect.objectContaining({ action: 'removed', path: 'd', archive: 'S.part2.zip' })
    ])
  })

  test('files only moved by a merge are not recorded as changes', async () => {
    // part1 [a b], part2 [c d]; removing b leaves part1 below half the limit, so part2 merges
    // into it and the single remaining part collapses to S.zip — a, c and d only moved
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB, d: 100 * KB }, MB)
    await run(w)
    expect(await names(w.current)).toEqual(['S.part1.zip', 'S.part2.zip'])
    await rm(join(w.src, 'b'))
    const changes: ChangeEntry[] = []
    await run(w, changes)
    expect(changes.map((c) => [c.action, c.path])).toEqual([['removed', 'b']])
    expect(await names(w.current)).toEqual(['S.zip'])
    expect(await contents(w.current, await tmpDir())).toEqual(await sourceFiles(w.src))
  })

  test('budget check: test parts are near the limit', () => {
    expect(
      partSize([
        { rel: 'a', size: 400 * KB, mtimeMs: 0 },
        { rel: 'b', size: 400 * KB, mtimeMs: 0 }
      ])
    ).toBeLessThan(MB)
  })
})

describe('a part that cannot be written never costs the previous archive', () => {
  /** FsDestination whose renames onto `target` (a final archive name) fail with EACCES. */
  const failingRenameTo = (root: string, target: string): FsDestination =>
    new (class extends FsDestination {
      override async rename(from: string, to: string): Promise<void> {
        if (to.endsWith(`/${target}`)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return super.rename(from, to)
      }
    })(root)

  const sha = async (file: string): Promise<string> =>
    (await import('node:crypto')).createHash('sha1').update(await readFile(file)).digest('hex')

  test('limit switched off but S.zip cannot be written: old parts and manifest stay', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB }, MB)
    w.source.mirror.deletion = 'exact'
    await run(w)
    const before = await names(w.current)
    const hashes = await Promise.all(before.map((n) => sha(join(w.current, n))))
    const manifest = await readFile(join(w.current, MANIFEST_NAME), 'utf8')
    w.source.zip.partLimitBytes = null
    w.dest = failingRenameTo(w.root, 'S.zip')
    const r = await run(w)
    expect(r.status).toBe('completed-with-warnings')
    expect(await names(w.current)).toEqual(before)
    expect(await Promise.all(before.map((n) => sha(join(w.current, n))))).toEqual(hashes)
    expect(await readFile(join(w.current, MANIFEST_NAME), 'utf8')).toBe(manifest)
  })

  test('a merge whose merged part cannot be written keeps both old parts', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB, c: 400 * KB, d: 100 * KB }, MB)
    w.source.mirror.deletion = 'exact'
    await run(w)
    await rm(join(w.src, 'b'))
    w.dest = failingRenameTo(w.root, 'S.zip')
    await run(w)
    expect(await names(w.current)).toEqual(['S.part1.zip', 'S.part2.zip'])
  })

  posixNonRoot('a file unreadable at zip time keeps the previous part instead of dropping it', async () => {
    const w = await world({ a: 400 * KB, b: 400 * KB }, MB)
    await run(w)
    const before = await sha(join(w.current, 'S.zip'))
    await put(w.src, 'a', 400 * KB) // a changed, so S.zip must be rewritten…
    const { files, skipped } = await walkTree(w.src, { excludes: [] })
    const ctx: JobContext = {
      source: w.source,
      destId: 'd1',
      dest: w.dest,
      globalExcludes: [],
      srcFiles: files,
      srcSkipped: skipped,
      now: NOW,
      zip: effectiveZipSettings(w.source, newDestination('/d', 'D'))
    }
    const prepared = await prepareMirrorZip(ctx)
    await chmod(join(w.src, 'b'), 0o000) // …but b cannot be read when the zip is written
    try {
      const r = await prepared.execute({ runId: 'r', signal: new AbortController().signal, emit: () => {}, record: () => {} })
      expect(r.status).toBe('completed-with-warnings')
      expect(await sha(join(w.current, 'S.zip'))).toBe(before)
    } finally {
      await chmod(join(w.src, 'b'), 0o644)
    }
    expect((await run(w)).counts.zipped).toBe(1) // retried on the next run
  })
})
