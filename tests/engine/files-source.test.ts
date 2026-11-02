import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Source } from '@shared/schema'
import type { ChangeEntry } from '@shared/types'
import { readChanges } from '../../src/main/engine/changes'
import { runBackup } from '../../src/main/engine/executor'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

/** A Files source with two files from different folders, backed up to one destination. */
async function world(extra: Partial<Source> = {}) {
  const base = await tmpDir()
  await makeTree(base, { 'desk/tax.pdf': 'tax', 'home/vault.kdbx': 'vault', 'dest/': '' })
  const cfg = defaultConfig()
  cfg.destinations.push(newDestination(join(base, 'dest'), 'D'))
  const files = [join(base, 'desk/tax.pdf'), join(base, 'home/vault.kdbx')]
  cfg.sources.push({ ...newSource('', 'Important', []), kind: 'files', files, ...extra })
  const run = async (id: string) =>
    runBackup(
      cfg,
      {},
      {
        runId: id,
        trigger: 'manual',
        signal: new AbortController().signal,
        emit: () => {},
        historyDir: join(base, 'history'),
        now: () => new Date(2026, 10, 2, 10, 0, Number(id.slice(-1)))
      }
    )
  const changes = async (id: string): Promise<ChangeEntry[]> =>
    (
      await readChanges(join(base, 'history'), id, {
        sourceId: cfg.sources[0].id,
        destId: cfg.destinations[0].id
      })
    ).items
  return { base, cfg, run, changes, dest: join(base, 'dest/Important') }
}

test('mirror copy stores each file by name; removing one from the list trashes it', async () => {
  const w = await world()
  expect((await w.run('r1')).status).toBe('completed')
  expect(await readTree(w.dest)).toEqual({
    'tax.pdf': 'tax',
    'vault.kdbx': 'vault'
  })
  w.cfg.sources[0].files = [w.cfg.sources[0].files[1]]
  await w.run('r2')
  expect(Object.keys(await readTree(w.dest))).toEqual([
    '.trash/2026-11-02_100002/tax.pdf',
    'vault.kdbx'
  ])
  expect((await w.changes('r2')).map((c) => [c.action, c.path])).toEqual([['trashed', 'tax.pdf']])
})

test('a missing file is skipped with a warning and its backup is kept', async () => {
  const w = await world()
  await w.run('r1')
  await rm(join(w.base, 'desk/tax.pdf'))
  const log = await w.run('r2')
  expect(log.jobs[0].status).toBe('completed-with-warnings')
  expect(Object.keys(await readTree(w.dest))).toEqual(['tax.pdf', 'vault.kdbx'])
})

test('every file missing → job skipped as source not available', async () => {
  const w = await world()
  await rm(join(w.base, 'desk'), { recursive: true })
  await rm(join(w.base, 'home'), { recursive: true })
  const log = await w.run('r1')
  expect(log.jobs[0]).toMatchObject({ status: 'skipped', reason: 'source-missing' })
})

test('one zip holds every file; zip each item makes one zip per file', async () => {
  const one = await world({ packaging: 'zip-whole' })
  await one.run('r1')
  expect(readdirSync(one.dest).filter((n) => n.endsWith('.zip'))).toEqual(['Important.zip'])
  const each = await world({ packaging: 'zip-children' })
  await each.run('r1')
  expect(
    readdirSync(each.dest)
      .filter((n) => n.endsWith('.zip'))
      .sort()
  ).toEqual(['tax.pdf.zip', 'vault.kdbx.zip'])
})

test('snapshots copy the files into a dated folder', async () => {
  const w = await world({ mode: 'snapshot' })
  await w.run('r1')
  const [snap] = readdirSync(w.dest)
  expect(await readTree(join(w.dest, snap))).toEqual({ 'tax.pdf': 'tax', 'vault.kdbx': 'vault' })
})
