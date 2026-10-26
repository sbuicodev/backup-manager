import { readdir } from 'node:fs/promises'
import { expect, test } from 'vitest'
import type { ChangeEntry } from '@shared/types'
import { ChangeRecorder, changeFileName, readChanges } from '../../src/main/engine/changes'
import { tmpDir } from '../helpers/fs'

const e = (action: ChangeEntry['action'], path: string, destId = 'd1'): ChangeEntry => ({
  sourceId: 's1',
  destId,
  action,
  path
})

test('entries round-trip through gzip NDJSON with filters, search, paging and counts', async () => {
  const dir = await tmpDir()
  const rec = await ChangeRecorder.open(dir, 'run-1')
  for (let i = 0; i < 200; i++) rec.record({ ...e('added', `a/${i}.txt`), size: i })
  for (let i = 0; i < 30; i++) rec.record(e('updated', `u/${i}.txt`))
  for (let i = 0; i < 20; i++) rec.record({ ...e('skipped', `s/${i}`), code: 'EACCES' })
  for (let i = 0; i < 5; i++) rec.record(e('added', `x/${i}`, 'd2'))
  expect(rec.countFor('s1', 'd1')).toBe(250)
  expect(rec.countFor('s1', 'd2')).toBe(5)
  await rec.close()
  expect(await readdir(dir)).toEqual([changeFileName('run-1')])

  const q = { sourceId: 's1', destId: 'd1' }
  const page1 = await readChanges(dir, 'run-1', q)
  expect(page1.total).toBe(250)
  expect(page1.items).toHaveLength(200)
  expect(page1.items[0]).toEqual({ ...e('added', 'a/0.txt'), size: 0 })
  expect(page1.counts).toEqual({
    added: 200,
    updated: 30,
    removed: 0,
    trashed: 0,
    deleted: 0,
    skipped: 20
  })
  expect((await readChanges(dir, 'run-1', { ...q, offset: 200 })).items).toHaveLength(50)
  const upd = await readChanges(dir, 'run-1', { ...q, actions: ['updated'] })
  expect(upd.total).toBe(30)
  expect(upd.counts.added).toBe(200)
  const found = await readChanges(dir, 'run-1', { ...q, search: 'A/1' })
  expect(found.items.every((i) => i.path.toLowerCase().includes('a/1'))).toBe(true)
  expect(found.total).toBe(111) // a/1, a/10-19, a/100-199
  expect((await readChanges(dir, 'run-1', { ...q, limit: 5000 })).items).toHaveLength(250)
  expect((await readChanges(dir, 'run-1', { ...q, limit: 0 })).items).toHaveLength(1)
})

test('nothing recorded → no file left behind', async () => {
  const dir = await tmpDir()
  const rec = await ChangeRecorder.open(dir, 'run-2')
  await rec.close()
  expect(await readdir(dir)).toEqual([])
})

test('missing change file → empty page', async () => {
  const dir = await tmpDir()
  expect(await readChanges(dir, 'nope', { sourceId: 's', destId: 'd' })).toEqual({
    total: 0,
    counts: { added: 0, updated: 0, removed: 0, trashed: 0, deleted: 0, skipped: 0 },
    items: []
  })
})
