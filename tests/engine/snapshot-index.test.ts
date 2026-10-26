import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  indexFileName,
  pruneSnapshotIndexes,
  readSnapshotIndex,
  writeSnapshotIndex
} from '../../src/main/engine/snapshot-index'
import { tmpDir } from '../helpers/fs'

const files = [
  { rel: 'a.txt', size: 1, mtimeMs: 1000 },
  { rel: 'd/b.txt', size: 2, mtimeMs: 2000 }
]

test('round trip, creating the folder', async () => {
  const dir = join(await tmpDir(), 'snapshot-index')
  await writeSnapshotIndex(dir, 's1', 'd1', files)
  expect(await readdir(dir)).toEqual([indexFileName('s1', 'd1')])
  expect(indexFileName('s1', 'd1')).toBe('s1__d1.json.gz')
  expect(await readSnapshotIndex(dir, 's1', 'd1')).toEqual(files)
})

test('missing or corrupt index → null', async () => {
  const dir = await tmpDir()
  expect(await readSnapshotIndex(dir, 's1', 'd1')).toBeNull()
  expect(await readSnapshotIndex(join(dir, 'none'), 's1', 'd1')).toBeNull()
  await writeFile(join(dir, indexFileName('s1', 'd1')), 'not gzip')
  expect(await readSnapshotIndex(dir, 's1', 'd1')).toBeNull()
})

test('prune keeps only listed pairs', async () => {
  const dir = await tmpDir()
  await writeSnapshotIndex(dir, 's1', 'd1', files)
  await writeSnapshotIndex(dir, 's1', 'd2', files)
  await writeSnapshotIndex(dir, 's2', 'd1', files)
  expect(await pruneSnapshotIndexes(dir, new Set(['s1__d1']))).toBe(2)
  expect(await readdir(dir)).toEqual(['s1__d1.json.gz'])
  expect(await pruneSnapshotIndexes(join(dir, 'none'), new Set())).toBe(0)
})
