import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Source } from '@shared/schema'
import type { ChangeEntry } from '@shared/types'
import { readChanges } from '../../src/main/engine/changes'
import { runBackup } from '../../src/main/engine/executor'
import { readSourceItems } from '../../src/main/engine/source-items'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

/** A source with a folder (Docs) and two files from elsewhere, backed up to one destination. */
async function world(extra: Partial<Source> = {}) {
  const base = await tmpDir()
  await makeTree(base, {
    'home/Docs/a.txt': 'a',
    'home/Docs/sub/b.txt': 'b',
    'home/Docs/skip.tmp': 't',
    'desk/tax.pdf': 'tax',
    'vault/vault.kdbx': 'vault',
    'dest/': ''
  })
  const cfg = defaultConfig()
  cfg.destinations.push(newDestination(join(base, 'dest'), 'D'))
  const items: Source['items'] = [
    { path: join(base, 'home/Docs'), kind: 'folder' },
    { path: join(base, 'desk/tax.pdf'), kind: 'file' },
    { path: join(base, 'vault/vault.kdbx'), kind: 'file' }
  ]
  cfg.sources.push({ ...newSource('', 'Mixed', []), items, excludes: ['*.tmp'], ...extra })
  let n = 0
  const run = async () => {
    const id = `run-${++n}`
    const log = await runBackup(
      cfg,
      {},
      {
        runId: id,
        trigger: 'manual',
        signal: new AbortController().signal,
        emit: () => {},
        historyDir: join(base, 'history'),
        now: () => new Date(2026, 10, 3, 10, 0, n)
      }
    )
    const changes: ChangeEntry[] = (
      await readChanges(join(base, 'history'), id, {
        sourceId: cfg.sources[0].id,
        destId: cfg.destinations[0].id
      })
    ).items
    return { job: log.jobs[0], changes }
  }
  return { base, cfg, run, S: join(base, 'dest/Mixed') }
}

const visible = (dir: string): string[] =>
  readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .sort()

test('readSourceItems names files by item; exclusions apply inside each folder', async () => {
  const w = await world()
  const r = (await readSourceItems(w.cfg.sources[0], ['*.tmp']))!
  expect(r.files.map((f) => f.rel)).toEqual([
    'Docs/a.txt',
    'Docs/sub/b.txt',
    'tax.pdf',
    'vault.kdbx'
  ])
  expect(r.absOf('Docs/sub/b.txt')).toBe(join(w.base, 'home/Docs/sub/b.txt'))
  expect(r.absOf('tax.pdf')).toBe(join(w.base, 'desk/tax.pdf'))
})

test('a missing item is reported under its name; with every item missing the source is missing', async () => {
  const w = await world()
  await rm(join(w.base, 'desk'), { recursive: true })
  const r = (await readSourceItems(w.cfg.sources[0], []))!
  expect(r.skipped).toEqual([{ rel: 'tax.pdf', reason: 'unreadable' }])
  await rm(join(w.base, 'home'), { recursive: true })
  await rm(join(w.base, 'vault'), { recursive: true })
  expect(await readSourceItems(w.cfg.sources[0], [])).toBeNull()
})

test('a mixed mirror stores each item under its name; a removed item goes to the trash', async () => {
  const w = await world()
  expect((await w.run()).job.status).toBe('completed')
  expect(await readTree(w.S)).toEqual({
    'Docs/a.txt': 'a',
    'Docs/sub/b.txt': 'b',
    'tax.pdf': 'tax',
    'vault.kdbx': 'vault'
  })
  w.cfg.sources[0].items = w.cfg.sources[0].items.filter((i) => i.kind === 'file')
  const { changes } = await w.run()
  expect(changes.map((c) => [c.action, c.path]).sort()).toEqual([
    ['trashed', 'Docs/a.txt'],
    ['trashed', 'Docs/sub/b.txt']
  ])
  expect(visible(w.S)).toEqual(['tax.pdf', 'vault.kdbx'])
})

test('a missing item is skipped with a warning and its backup is kept', async () => {
  const w = await world()
  await w.run()
  await rm(join(w.base, 'desk/tax.pdf'))
  const { job } = await w.run()
  expect(job.status).toBe('completed-with-warnings')
  expect(existsSync(join(w.S, 'tax.pdf'))).toBe(true)
})

test('every item missing → job skipped as source not available', async () => {
  const w = await world()
  for (const d of ['home', 'desk', 'vault']) await rm(join(w.base, d), { recursive: true })
  expect((await w.run()).job).toMatchObject({ status: 'skipped', reason: 'source-missing' })
})

test('an excluded file left at the destination is never touched', async () => {
  const w = await world()
  await w.run()
  await makeTree(w.S, { 'Docs/old.tmp': 'keep me' })
  const { changes } = await w.run()
  expect(changes).toEqual([])
  expect(existsSync(join(w.S, 'Docs/old.tmp'))).toBe(true)
})

test('zip each item: one archive per entry inside each folder, one per listed file', async () => {
  const w = await world({ packaging: 'zip-children' })
  await w.run()
  expect(visible(w.S)).toEqual(['Docs', 'tax.pdf.zip', 'vault.kdbx.zip'])
  expect(visible(join(w.S, 'Docs'))).toEqual(['a.txt.zip', 'sub.zip'])
  expect((await w.run()).changes).toEqual([]) // nothing rewritten on an unchanged second run
})

test('one zip holds every item under its name', async () => {
  const w = await world({ packaging: 'zip-whole' })
  await w.run()
  expect(visible(w.S)).toEqual(['Mixed.zip'])
})

test('snapshots store each item under its name inside the dated folder', async () => {
  const w = await world({ mode: 'snapshot' })
  await w.run()
  const [snap] = visible(w.S)
  expect(await readTree(join(w.S, snap))).toEqual({
    'Docs/a.txt': 'a',
    'Docs/sub/b.txt': 'b',
    'tax.pdf': 'tax',
    'vault.kdbx': 'vault'
  })
})
