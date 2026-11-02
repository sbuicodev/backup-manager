import { existsSync, readdirSync } from 'node:fs'
import { utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Source } from '@shared/schema'
import type { ChangeEntry } from '@shared/types'
import { readChanges } from '../../src/main/engine/changes'
import { runBackup } from '../../src/main/engine/executor'
import { planRun } from '../../src/main/engine/planner'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

/** One folder source "S" mirrored to one destination; `run` performs a real backup. */
async function world(tree: Record<string, string>, extra: Partial<Source> = {}) {
  const base = await tmpDir()
  const spec: Record<string, string> = { 'dest/': '' }
  for (const [k, v] of Object.entries(tree)) spec[`src/${k}`] = v
  await makeTree(base, spec)
  const cfg = defaultConfig()
  cfg.destinations.push(newDestination(join(base, 'dest'), 'D'))
  // One folder item named "src", as a source converted from a one-folder config would be.
  cfg.sources.push({ ...newSource(join(base, 'src'), 'S', []), legacyFlatName: 'src', ...extra })
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
        now: () => new Date(2026, 10, 2, 10, 0, n)
      }
    )
    const changes: ChangeEntry[] = (
      await readChanges(join(base, 'history'), id, {
        sourceId: cfg.sources[0].id,
        destId: cfg.destinations[0].id
      })
    ).items
    return { log, job: log.jobs[0], changes }
  }
  return { base, cfg, run, S: join(base, 'dest/S') }
}

const visible = (dir: string): string[] =>
  readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .sort()
const MARKER_2 = 'mirror layout 2: files directly in this folder\n'

/** Gives a backed-up file and its source the same mtime, so the mirror sees them as unchanged. */
async function sameTime(...files: string[]): Promise<void> {
  const t = new Date(2026, 0, 1)
  for (const f of files) await utimes(f, t, t)
}

test('a mirror stores the folder under its name, with the trash and marker hidden beside it', async () => {
  const w = await world({ 'a.txt': 'a', 'docs/b.txt': 'b' }, { legacyFlatName: null })
  await w.run()
  expect(visible(w.S)).toEqual(['src'])
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a', 'docs/b.txt': 'b' })
  const { rmSync } = await import('node:fs')
  rmSync(join(w.base, 'src/a.txt'))
  const second = await w.run()
  expect(second.changes.map((c) => [c.action, c.path])).toEqual([['trashed', 'src/a.txt']])
  expect(Object.keys(await readTree(join(w.S, '.trash')))).toEqual(['2026-11-02_100002/src/a.txt'])
})

test('snapshots left from an earlier snapshot mode are never trashed by the mirror', async () => {
  const w = await world({ 'a.txt': 'a' }, { legacyFlatName: null })
  await makeTree(w.S, { '2026-10-01_120000/old.txt': 'o', '2026-10-02_120000.zip': 'z' })
  const { changes } = await w.run()
  expect(changes.map((c) => c.action)).toEqual(['added'])
  expect(visible(w.S)).toEqual(['2026-10-01_120000', '2026-10-02_120000.zip', 'src'])
})

test('a zip mirror keeps its manifest at the top and leaves snapshot zips alone', async () => {
  const w = await world(
    { 'A/x.txt': 'x', 'B/y.txt': 'y' },
    { packaging: 'zip-children', legacyFlatName: null }
  )
  await makeTree(w.S, { '2026-10-02_120000.zip': 'z' })
  await w.run()
  expect(visible(w.S)).toEqual(['2026-10-02_120000.zip', 'src'])
  expect(visible(join(w.S, 'src'))).toEqual(['A.zip', 'B.zip'])
  expect(existsSync(join(w.S, '.backup-manager.json'))).toBe(true)
})

test('layout 1: S/current is renamed to S/<folder>, without copying anything again', async () => {
  const w = await world({ 'a.txt': 'a', 'docs/b.txt': 'b' })
  await makeTree(w.S, { 'current/a.txt': 'a', 'current/docs/b.txt': 'b', '.trash/T/old.txt': 't' })
  await sameTime(
    join(w.S, 'current/a.txt'),
    join(w.S, 'current/docs/b.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/docs/b.txt')
  )
  const plan = (await planRun(w.cfg, {})).plan.jobs[0]
  expect(plan.counts).toMatchObject({ copy: 0, update: 0, trash: 0, unchanged: 2 })
  expect(existsSync(join(w.S, 'current/a.txt'))).toBe(true) // planning moves nothing
  const { changes, job } = await w.run()
  expect(job.status).toBe('completed')
  expect(changes).toEqual([])
  expect(visible(w.S)).toEqual(['src'])
  expect(existsSync(join(w.S, '.trash/T/old.txt'))).toBe(true)
})

test('layout 2: the folder contents move down into S/<folder>, even an entry with its own name', async () => {
  const w = await world({ 'a.txt': 'a', 'src/inner.txt': 'i' })
  await makeTree(w.S, {
    'a.txt': 'a',
    'src/inner.txt': 'i',
    '.trash/T/old.txt': 't',
    '2026-10-01_120000/snap.txt': 's'
  })
  await writeFile(join(w.S, '.backup-manager-layout'), MARKER_2)
  await sameTime(
    join(w.S, 'a.txt'),
    join(w.S, 'src/inner.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/src/inner.txt')
  )
  const { changes, job } = await w.run()
  expect(job.status).toBe('completed')
  expect(changes).toEqual([])
  expect(visible(w.S)).toEqual(['2026-10-01_120000', 'src'])
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a', 'src/inner.txt': 'i' })
})

test('layout 2: a move interrupted part-way finishes on the next run', async () => {
  const w = await world({ 'a.txt': 'a', 'b.txt': 'b' })
  // a crash left a.txt already in the staging folder and b.txt still at the top
  await makeTree(w.S, { '.backup-manager-nesting/a.txt': 'a', 'b.txt': 'b' })
  await writeFile(join(w.S, '.backup-manager-layout'), MARKER_2)
  await sameTime(
    join(w.S, '.backup-manager-nesting/a.txt'),
    join(w.S, 'b.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/b.txt')
  )
  const { changes } = await w.run()
  expect(changes).toEqual([])
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a', 'b.txt': 'b' })
  expect(existsSync(join(w.S, '.backup-manager-nesting'))).toBe(false)
})

test('layout 1 of a folder named "current" is already in place: nothing moves', async () => {
  const w = await world({ 'c.txt': 'c' })
  const { renameSync } = await import('node:fs')
  renameSync(join(w.base, 'src'), join(w.base, 'current'))
  w.cfg.sources[0].items = [{ path: join(w.base, 'current'), kind: 'folder' }]
  w.cfg.sources[0].legacyFlatName = 'current'
  await makeTree(w.S, { 'current/c.txt': 'c' })
  await sameTime(join(w.S, 'current/c.txt'), join(w.base, 'current/c.txt'))
  expect((await w.run()).changes).toEqual([])
  expect((await w.run()).changes).toEqual([])
  expect(await readTree(w.S)).toEqual({ 'current/c.txt': 'c' })
})

test('a move blocked by an existing item fails the job and finishes on the next run', async () => {
  const w = await world({ 'a.txt': 'a' })
  await makeTree(w.S, { 'current/a.txt': 'a', 'src/': '' })
  const first = await w.run()
  expect(first.job.status).toBe('failed')
  expect(existsSync(join(w.S, 'current/a.txt'))).toBe(true)
  const { rmSync } = await import('node:fs')
  rmSync(join(w.S, 'src'), { recursive: true })
  const second = await w.run()
  expect(second.job.status).toBe('completed')
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a' })
})

test("an item named like one of the backup's own hidden files is skipped with a warning", async () => {
  const w = await world({ 'a.txt': 'a' }, { legacyFlatName: null })
  await makeTree(w.base, { 'other/.trash': 'mine' })
  w.cfg.sources[0].items.push({ path: join(w.base, 'other/.trash'), kind: 'file' })
  const { job } = await w.run()
  expect(job.warnings.map((x) => [x.path, x.code])).toEqual([['.trash', 'RESERVED']])
  expect(existsSync(join(w.S, '.trash'))).toBe(false)
})
