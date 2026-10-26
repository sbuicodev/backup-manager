import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { newSource, type Source } from '@shared/schema'
import type { ChangeEntry } from '@shared/types'
import { FsDestination } from '../../src/main/engine/destination'
import { formatTimestamp } from '../../src/main/engine/naming'
import { prepareSnapshot } from '../../src/main/engine/snapshot'
import { readSnapshotIndex } from '../../src/main/engine/snapshot-index'
import { tmpDir } from '../helpers/fs'
import { ctxFor, exec } from '../helpers/job'

const KB = 1024
const MB = 1024 * KB
const NOW = new Date(2026, 9, 26, 10, 0, 0)
const TS = formatTimestamp(NOW)

async function put(dir: string, rel: string, size: number): Promise<void> {
  const abs = join(dir, ...rel.split('/'))
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, randomBytes(size))
}

async function world(
  packaging: Source['packaging'],
  files: Record<string, number>,
  limit: number | null
): Promise<{ src: string; root: string; source: Source; dest: FsDestination; index: string }> {
  const src = await tmpDir()
  const root = await tmpDir()
  for (const [rel, size] of Object.entries(files)) await put(src, rel, size)
  const source = { ...newSource(src, 'S', []), mode: 'snapshot' as const, packaging }
  source.zip = { ...source.zip, level: 0, partLimitBytes: limit }
  return { src, root, source, dest: new FsDestination(root), index: join(await tmpDir(), 'idx') }
}

async function snap(
  w: Awaited<ReturnType<typeof world>>,
  now = NOW,
  changes: ChangeEntry[] = [],
  dest: FsDestination = w.dest
): Promise<void> {
  const ctx = await ctxFor(w.source, dest, now)
  ctx.indexDir = w.index
  await (await prepareSnapshot(ctx)).execute(exec([], undefined, changes))
}

const ls = async (dir: string): Promise<string[]> => (await readdir(dir)).sort()

describe('snapshot parts', () => {
  test('zip-whole over the limit → <ts>.partN.zip at the slug top level, no staging left', async () => {
    const w = await world('zip-whole', { a: 400 * KB, b: 400 * KB, c: 400 * KB }, MB)
    await snap(w)
    expect(await ls(join(w.root, 'S'))).toEqual([`${TS}.part1.zip`, `${TS}.part2.zip`])
    for (const f of await ls(join(w.root, 'S'))) {
      expect((await stat(join(w.root, 'S', f))).size).toBeLessThanOrEqual(MB)
    }
  })

  test('zip-whole within the limit stays <ts>.zip', async () => {
    const w = await world('zip-whole', { a: 100 * KB }, MB)
    await snap(w)
    expect(await ls(join(w.root, 'S'))).toEqual([`${TS}.zip`])
  })

  test('zip-children: only archives over the limit are split, inside <ts>/', async () => {
    const w = await world(
      'zip-children',
      { 'A/x': 400 * KB, 'A/y': 400 * KB, 'A/z': 400 * KB, 'B/w': 10 * KB },
      MB
    )
    await snap(w)
    expect(await ls(join(w.root, 'S', TS))).toEqual(['A.part1.zip', 'A.part2.zip', 'B.zip'])
  })

  test('a chunked oversized file in a snapshot is stored as chunks within the limit', async () => {
    const w = await world('zip-whole', { a: 100 * KB, big: 3 * MB }, MB)
    w.source.zip.oversized = 'chunk'
    await snap(w)
    const files = await ls(join(w.root, 'S'))
    expect(files).toEqual([
      `${TS}.part1.zip`,
      `${TS}.part2.zip.001`,
      `${TS}.part2.zip.002`,
      `${TS}.part2.zip.003`,
      `${TS}.part2.zip.004`
    ])
    for (const f of files) expect((await stat(join(w.root, 'S', f))).size).toBeLessThanOrEqual(MB)
  })

  test('a failure while writing a split zip-whole leaves no <ts>.part files', async () => {
    const w = await world('zip-whole', { a: 400 * KB, b: 400 * KB, c: 400 * KB }, MB)
    let calls = 0
    const failing = new (class extends FsDestination {
      override async writeStream(rel: string): Promise<NodeJS.WritableStream> {
        if (++calls === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        return super.writeStream(rel)
      }
    })(w.root)
    await expect(snap(w, NOW, [], failing)).rejects.toThrow()
    expect(await ls(join(w.root, 'S'))).toEqual([])
    expect(await readSnapshotIndex(w.index, w.source.id, 'd1')).toBeNull()
  })
})

describe('snapshot change diff', () => {
  test('first snapshot records every file as added; the next records only the diff', async () => {
    const w = await world('copy', { a: 10, b: 10, c: 10 }, null)
    const first: ChangeEntry[] = []
    await snap(w, NOW, first)
    expect(first.map((c) => [c.action, c.path])).toEqual([
      ['added', 'a'],
      ['added', 'b'],
      ['added', 'c']
    ])
    await put(w.src, 'b', 20)
    await rm(join(w.src, 'c'))
    await put(w.src, 'd', 10)
    const second: ChangeEntry[] = []
    await snap(w, new Date(NOW.getTime() + 60_000), second)
    expect(second.map((c) => [c.action, c.path]).sort()).toEqual([
      ['added', 'd'],
      ['removed', 'c'],
      ['updated', 'b']
    ])
  })

  test('zip snapshot changes name the part that holds the file', async () => {
    const w = await world('zip-whole', { a: 400 * KB, b: 400 * KB, c: 400 * KB }, MB)
    const changes: ChangeEntry[] = []
    await snap(w, NOW, changes)
    expect(changes.find((c) => c.path === 'c')).toMatchObject({
      action: 'added',
      archive: `${TS}.part2.zip`
    })
  })

  test('the snapshot index is written after success, with the files written', async () => {
    const w = await world('copy', { a: 10, b: 10 }, null)
    await snap(w)
    expect((await readSnapshotIndex(w.index, w.source.id, 'd1'))?.map((f) => f.rel)).toEqual([
      'a',
      'b'
    ])
  })
})

test('a snapshot index that cannot be written does not fail a finished snapshot', async () => {
  const w = await world('copy', { a: 10 }, null)
  await writeFile(w.index, 'not a folder') // the index folder path is a file
  const ctx = await ctxFor(w.source, w.dest, NOW)
  ctx.indexDir = w.index
  const r = await (await prepareSnapshot(ctx)).execute(exec())
  expect(r.status).toBe('completed')
  expect(await ls(join(w.root, 'S'))).toEqual([TS])
})

describe('split snapshot crash safety and accurate changes', () => {
  test('the first part is moved into place last', async () => {
    const w = await world('zip-whole', { a: 400 * KB, b: 400 * KB, c: 400 * KB }, MB)
    const moves: string[] = []
    const dest = new (class extends FsDestination {
      override async rename(from: string, to: string): Promise<void> {
        moves.push(to)
        return super.rename(from, to)
      }
    })(w.root)
    await snap(w, NOW, [], dest)
    expect(moves.filter((m) => m.startsWith('S/')).at(-1)).toBe(`S/${TS}.part1.zip`)
  })

  test('a split set left by a crash is removed by the next snapshot', async () => {
    const w = await world('zip-whole', { a: 10 * KB }, MB)
    const old = formatTimestamp(new Date(NOW.getTime() - 86_400_000))
    await put(w.root, `S/${old}.part2.zip`, 10)
    await snap(w)
    expect(await ls(join(w.root, 'S'))).toEqual([`${TS}.zip`])
  })

  test('files of a part that failed are logged as skipped, never as removed', async () => {
    const w = await world('zip-children', { 'A/x': 10, 'B/y': 10 }, null)
    await snap(w)
    let calls = 0
    const failing = new (class extends FsDestination {
      override async writeStream(rel: string): Promise<NodeJS.WritableStream> {
        if (++calls === 1) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return super.writeStream(rel)
      }
    })(w.root)
    const changes: ChangeEntry[] = []
    await snap(w, new Date(NOW.getTime() + 60_000), changes, failing)
    expect(changes.filter((c) => c.action === 'removed')).toEqual([])
    expect(changes).toContainEqual(
      expect.objectContaining({ action: 'skipped', path: 'A/x', archive: 'A.zip' })
    )
    expect(changes.some((c) => c.path.endsWith('.zip'))).toBe(false)
  })

  test('the previous file list is read when the snapshot runs, not when it is planned', async () => {
    const w = await world('copy', { a: 10 }, null)
    await snap(w)
    const ctx = await ctxFor(w.source, w.dest, new Date(NOW.getTime() + 60_000))
    ctx.indexDir = w.index
    const prepared = await prepareSnapshot(ctx)
    await rm(w.index, { recursive: true })
    const changes: ChangeEntry[] = []
    await prepared.execute(exec([], undefined, changes))
    expect(changes.map((c) => [c.action, c.path])).toEqual([['added', 'a']])
  })
})
