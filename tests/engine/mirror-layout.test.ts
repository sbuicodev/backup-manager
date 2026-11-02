import { existsSync, readdirSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
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
  cfg.sources.push({ ...newSource(join(base, 'src'), 'S', []), ...extra })
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

test('a copy mirror lands directly in S/, with the trash and layout marker hidden beside it', async () => {
  const w = await world({ 'a.txt': 'a', 'docs/b.txt': 'b' })
  await w.run()
  expect(visible(w.S)).toEqual(['a.txt', 'docs'])
  expect(existsSync(join(w.S, 'current'))).toBe(false)
  expect(existsSync(join(w.S, '.backup-manager-layout'))).toBe(true)
  const { rmSync } = await import('node:fs')
  rmSync(join(w.base, 'src/a.txt'))
  const second = await w.run()
  expect(second.changes.map((c) => [c.action, c.path])).toEqual([['trashed', 'a.txt']])
  expect(Object.keys(await readTree(join(w.S, '.trash')))).toEqual(['2026-11-02_100002/a.txt'])
  expect(visible(w.S)).toEqual(['docs'])
})

test('top-level source items with reserved names are skipped with a warning', async () => {
  const w = await world({ '.trash': 'mine', 'deep/.trash': 'fine', 'a.txt': 'a' })
  const { job } = await w.run()
  expect(job.status).toBe('completed-with-warnings')
  expect(job.warnings.map((x) => [x.path, x.code])).toEqual([['.trash', 'RESERVED']])
  expect(await readTree(join(w.S, 'deep'))).toEqual({ '.trash': 'fine' })
})

test('snapshots left from an earlier snapshot mode are never trashed by the mirror', async () => {
  const w = await world({ 'a.txt': 'a' })
  await makeTree(w.S, { '2026-10-01_120000/old.txt': 'o', '2026-10-02_120000.zip': 'z' })
  const { changes } = await w.run()
  expect(changes.map((c) => c.action)).toEqual(['added'])
  expect(visible(w.S)).toEqual(['2026-10-01_120000', '2026-10-02_120000.zip', 'a.txt'])
})

test('a zip mirror writes archives and its manifest directly in S/, leaving snapshot zips alone', async () => {
  const w = await world({ 'A/x.txt': 'x', 'B/y.txt': 'y' }, { packaging: 'zip-children' })
  await makeTree(w.S, { '2026-10-02_120000.zip': 'z' })
  await w.run()
  expect(visible(w.S)).toEqual(['2026-10-02_120000.zip', 'A.zip', 'B.zip'])
  expect(existsSync(join(w.S, '.backup-manager.json'))).toBe(true)
})

test('an old S/current backup is moved up once, without copying anything again', async () => {
  const w = await world({ 'a.txt': 'a', 'docs/b.txt': 'b' })
  await makeTree(w.S, { 'current/a.txt': 'a', 'current/docs/b.txt': 'b', '.trash/T/old.txt': 't' })
  for (const [rel, src] of [
    ['current/a.txt', 'a.txt'],
    ['current/docs/b.txt', 'docs/b.txt']
  ]) {
    const t = new Date(2026, 0, 1)
    await utimes(join(w.S, rel), t, t)
    await utimes(join(w.base, 'src', src), t, t)
  }
  const plan = (await planRun(w.cfg, {})).plan.jobs[0]
  expect(plan.counts).toMatchObject({ copy: 0, update: 0, trash: 0, unchanged: 2 })
  expect(existsSync(join(w.S, 'current/a.txt'))).toBe(true) // planning moves nothing
  const { changes, job } = await w.run()
  expect(job.status).toBe('completed')
  expect(changes).toEqual([])
  expect(visible(w.S)).toEqual(['a.txt', 'docs'])
  expect(existsSync(join(w.S, '.trash/T/old.txt'))).toBe(true)
})

test('a source with its own top-level "current" folder is not moved again on later runs', async () => {
  const w = await world({ 'current/c.txt': 'c', 'a.txt': 'a' })
  await w.run()
  await w.run()
  expect(await readTree(join(w.S, 'current'))).toEqual({ 'c.txt': 'c' })
  expect(visible(w.S)).toEqual(['a.txt', 'current'])
})

test('a move blocked by an existing item fails the job and finishes on the next run', async () => {
  const w = await world({ 'a.txt': 'a', 'b.txt': 'b' })
  await makeTree(w.S, { 'current/a.txt': 'a', 'current/b.txt': 'b', 'b.txt/': '' })
  const first = await w.run()
  expect(first.job.status).toBe('failed')
  expect(existsSync(join(w.S, 'current/b.txt'))).toBe(true)
  const { rmSync } = await import('node:fs')
  rmSync(join(w.S, 'b.txt'), { recursive: true })
  const second = await w.run()
  expect(second.job.status).toBe('completed')
  expect(visible(w.S)).toEqual(['a.txt', 'b.txt'])
})
