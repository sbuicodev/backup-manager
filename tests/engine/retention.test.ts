import { expect, test } from 'vitest'
import { newSource } from '@shared/schema'
import { FsDestination } from '../../src/main/engine/destination'
import { formatTimestamp } from '../../src/main/engine/naming'
import {
  applyRetention,
  selectSnapshotsToPrune,
  selectTrashToPurge
} from '../../src/main/engine/retention'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

const DAY = 86_400_000
const now = new Date(2026, 9, 25, 12, 0, 0)
const ago = (days: number): Date => new Date(now.getTime() - days * DAY)
const snap = (name: string, days: number): { name: string; date: Date } => ({
  name,
  date: ago(days)
})

test('keepMin always kept even if old', () => {
  const snaps = [snap('a', 100), snap('b', 101), snap('c', 102)]
  expect(selectSnapshotsToPrune(snaps, 2, 30, now)).toEqual(['c'])
})

test('maxAgeDays null prunes nothing', () => {
  const snaps = Array.from({ length: 20 }, (_, i) => snap(`s${i}`, i * 10))
  expect(selectSnapshotsToPrune(snaps, 1, null, now)).toEqual([])
})

test('snapshots newer than maxAge are kept beyond keepMin', () => {
  const snaps = Array.from({ length: 12 }, (_, i) => snap(`s${i}`, i * 0.4))
  expect(selectSnapshotsToPrune(snaps, 10, 30, now)).toEqual([])
})

test('order of input does not matter; oldest beyond keepMin and older than maxAge pruned', () => {
  const snaps = [snap('old', 40), snap('new', 1), snap('mid', 20), snap('older', 50)]
  expect(selectSnapshotsToPrune(snaps, 1, 30, now).sort()).toEqual(['old', 'older'])
})

test('trash: null retention purges nothing; 7 days purges older entries only', () => {
  const entries = [snap('t1', 1), snap('t8', 8), snap('t30', 30)]
  expect(selectTrashToPurge(entries, null, now)).toEqual([])
  expect(selectTrashToPurge(entries, 7, now).sort()).toEqual(['t30', 't8'])
})

test('applyRetention on disk removes selected snapshots, ignores current/.trash/partials', async () => {
  const root = await tmpDir()
  const n = (d: number): string => formatTimestamp(ago(d))
  await makeTree(root, {
    [`S/${n(40)}/a.txt`]: '',
    [`S/${n(35)}.zip`]: '',
    [`S/${n(1)}/a.txt`]: 'keep',
    [`S/${n(50)}.partial/a.txt`]: 'p',
    'S/current/x': 'c',
    'S/.trash/x': 't'
  })
  const source = { ...newSource('/src', 'S', []), mode: 'snapshot' as const }
  source.snapshot = { keepMin: 1, maxAgeDays: 30 }
  const r = await applyRetention(new FsDestination(root), source, now)
  expect(r.pruned).toBe(2)
  expect(await readTree(root)).toEqual({
    [`S/${n(1)}/a.txt`]: 'keep',
    [`S/${n(50)}.partial/a.txt`]: 'p',
    'S/current/x': 'c',
    'S/.trash/x': 't'
  })
})

test('applyRetention in mirror mode purges expired trash', async () => {
  const root = await tmpDir()
  const n = (d: number): string => formatTimestamp(ago(d))
  await makeTree(root, {
    [`S/.trash/${n(10)}/a.txt`]: 'old',
    [`S/.trash/${n(2)}/b.txt`]: 'new',
    'S/current/c.txt': 'c'
  })
  const source = newSource('/src', 'S', [])
  source.mirror.trashRetentionDays = 7
  const r = await applyRetention(new FsDestination(root), source, now)
  expect(r.pruned).toBe(1)
  expect(await readTree(root)).toEqual({
    [`S/.trash/${n(2)}/b.txt`]: 'new',
    'S/current/c.txt': 'c'
  })
})

test('applyRetention prunes every part and chunk of an old split snapshot as one snapshot', async () => {
  const root = await tmpDir()
  const old = formatTimestamp(ago(40))
  const recent = formatTimestamp(ago(1))
  await makeTree(root, {
    [`S/${old}.part1.zip`]: '1',
    [`S/${old}.part2.zip.001`]: '2a',
    [`S/${old}.part2.zip.002`]: '2b',
    [`S/${recent}/a.txt`]: 'keep'
  })
  const source = { ...newSource('/src', 'S', []), mode: 'snapshot' as const }
  source.snapshot = { keepMin: 1, maxAgeDays: 30 }
  const r = await applyRetention(new FsDestination(root), source, now)
  expect(r.pruned).toBe(1)
  expect(await readTree(root)).toEqual({ [`S/${recent}/a.txt`]: 'keep' })
})
