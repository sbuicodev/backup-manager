import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Config } from '@shared/schema'
import type { ProgressEvent } from '@shared/types'
import { FsDestination } from '../../src/main/engine/destination'
import { runBackup } from '../../src/main/engine/executor'
import { listRuns } from '../../src/main/engine/history'
import { makeTree, readTree, tmpDir } from '../helpers/fs'
import { FailingDest } from '../helpers/job'

async function world(nFiles = 3): Promise<{ cfg: Config; base: string; history: string }> {
  const base = await tmpDir()
  const spec: Record<string, string> = { 'd1/': '', 'd2/': '' }
  for (let i = 0; i < nFiles; i++) spec[`s1/f${i}.txt`] = `content ${i}`
  spec['s2/x.txt'] = 'x'
  await makeTree(base, spec)
  const cfg = defaultConfig()
  const d1 = newDestination(join(base, 'd1'), 'D1')
  const d2 = newDestination(join(base, 'd2'), 'D2')
  cfg.destinations.push(d1, d2)
  cfg.sources.push(
    { ...newSource(join(base, 's1'), 'S1', []), destinationIds: [d1.id] },
    { ...newSource(join(base, 's2'), 'S2', ['S1']), destinationIds: [d2.id] }
  )
  return { cfg, base, history: join(base, 'history') }
}

const opts = (
  history: string,
  extra: Partial<Parameters<typeof runBackup>[2]> = {}
): Parameters<typeof runBackup>[2] => ({
  runId: 'run-1',
  trigger: 'manual',
  signal: new AbortController().signal,
  emit: () => {},
  historyDir: history,
  ...extra
})

test('runs jobs sequentially and writes a history log', async () => {
  const { cfg, history } = await world()
  const events: ProgressEvent[] = []
  const log = await runBackup(cfg, {}, opts(history, { emit: (e) => events.push(e) }))
  expect(log).toMatchObject({ id: 'run-1', trigger: 'manual', status: 'completed' })
  expect(log.jobs.map((j) => j.status)).toEqual(['completed', 'completed'])
  expect((await listRuns(history)).map((r) => r.id)).toEqual(['run-1'])
  const types = events.map((e) => e.type).filter((t) => t !== 'file')
  expect(types).toEqual(['run-start', 'job-start', 'job-end', 'job-start', 'job-end', 'run-end'])
})

test('skipped destination → run completed-with-warnings, other jobs still run', async () => {
  const { cfg, history, base } = await world()
  cfg.destinations[0].path = join(base, 'unplugged')
  const log = await runBackup(cfg, {}, opts(history))
  expect(log.status).toBe('completed-with-warnings')
  expect(log.jobs.map((j) => [j.status, j.reason])).toEqual([
    ['skipped', 'destination-missing'],
    ['completed', undefined]
  ])
})

test('destination removed mid-job → failed destination-lost, next job runs, no partial left', async () => {
  const { cfg, history, base } = await world(5)
  let removed = false
  const log = await runBackup(
    cfg,
    {},
    opts(history, {
      emit: (e) => {
        if (!removed && e.type === 'file') {
          removed = true
          rmSync(join(base, 'd1'), { recursive: true, force: true })
        }
      }
    })
  )
  expect(log.jobs[0]).toMatchObject({ status: 'failed', reason: 'destination-lost' })
  expect(log.jobs[1].status).toBe('completed')
  expect(log.status).toBe('failed')
  expect(await readTree(join(base, 'd2'))).toEqual({ 'S2/current/x.txt': 'x' })
})

test('cancel during job 1 → job 1 cancelled, job 2 cancelled without running, run cancelled', async () => {
  const { cfg, history, base } = await world(5)
  const ac = new AbortController()
  const log = await runBackup(
    cfg,
    {},
    opts(history, { signal: ac.signal, emit: (e) => e.type === 'file' && ac.abort() })
  )
  expect(log.jobs.map((j) => j.status)).toEqual(['cancelled', 'cancelled'])
  expect(log.status).toBe('cancelled')
  expect(await readTree(join(base, 'd2'))).toEqual({})
})

test('retention runs only after success', async () => {
  const { cfg, history, base } = await world(1)
  cfg.sources[0] = { ...cfg.sources[0], mode: 'snapshot', snapshot: { keepMin: 1, maxAgeDays: 0 } }
  cfg.sources.pop()
  let t = new Date(2026, 9, 25, 10, 0, 0).getTime()
  const now = (): Date => new Date((t += 1000))
  await runBackup(cfg, {}, opts(history, { now }))
  const log2 = await runBackup(cfg, {}, opts(history, { now, runId: 'run-2' }))
  expect(log2.jobs[0].counts.pruned).toBe(1)
  expect((await new FsDestination(join(base, 'd1')).list('S1')).length).toBe(1)
  const log3 = await runBackup(
    cfg,
    {},
    opts(history, { now, runId: 'run-3', makeDestination: (r) => new FailingDest(r, 1, 'ENOSPC') })
  )
  expect(log3.jobs[0]).toMatchObject({ status: 'failed', reason: 'disk-full' })
  expect((await new FsDestination(join(base, 'd1')).list('S1')).length).toBe(1)
})

test('zero jobs → completed', async () => {
  const { history } = await world()
  const log = await runBackup(defaultConfig(), {}, opts(history))
  expect(log).toMatchObject({ status: 'completed', jobs: [] })
})

test('an error while preparing one job fails only that job; the rest run and history is written', async () => {
  const { cfg, history, base } = await world()
  const d1 = join(base, 'd1')
  const makeDestination = (r: string): FsDestination =>
    r === d1
      ? new (class extends FsDestination {
          override async walk(): Promise<never> {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          }
        })(r)
      : new FsDestination(r)
  const log = await runBackup(cfg, {}, opts(history, { makeDestination }))
  expect(log.jobs.map((j) => [j.status, j.reason])).toEqual([
    ['failed', 'error'],
    ['completed', undefined]
  ])
  expect(log.jobs[0].error).toMatch(/EACCES/)
  expect(log.status).toBe('failed')
  expect((await listRuns(history)).map((r) => r.id)).toEqual(['run-1'])
})
