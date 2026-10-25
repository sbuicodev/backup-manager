import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  defaultConfig,
  newDestination,
  newSource,
  type Config,
  type Schedule
} from '@shared/schema'
import type { JobReason, JobResult, JobStatus, QueuedRun, RunLog } from '@shared/types'
import { Scheduler, type SchedulerDeps } from '../../src/main/scheduler/scheduler'
import { loadState, saveState, emptyState } from '../../src/main/scheduler/state'
import { tmpDir } from '../helpers/fs'

const MIN = 60_000
const at = (d: number, h = 0, mi = 0): Date => new Date(2026, 9, d, h, mi)

type Outcome = { status: JobStatus; reason?: JobReason }

async function harness(
  schedules: (Schedule | null)[],
  opts: { now?: Date; destCount?: number } = {}
): Promise<{
  s: Scheduler
  cfg: Config
  runs: QueuedRun[]
  clock: { now: Date }
  battery: { on: boolean }
  avail: Record<string, boolean>
  outcome: (key: string, o: Outcome) => void
  crashOnRun: { value: boolean }
  stateFile: string
  advance: (ms: number) => Promise<void>
}> {
  const dir = await tmpDir()
  const stateFile = join(dir, 'state.json')
  const cfg = defaultConfig()
  for (let i = 0; i < (opts.destCount ?? 1); i++) {
    cfg.destinations.push({ ...newDestination(`/d${i}`, `D${i}`), id: `d${i}` })
  }
  schedules.forEach((schedule, i) => {
    cfg.sources.push({
      ...newSource(
        `/s${i}`,
        `S${i}`,
        cfg.sources.map((s) => s.slug)
      ),
      id: `s${i}`,
      schedule
    })
  })
  const clock = { now: opts.now ?? at(20, 10) }
  const battery = { on: false }
  const avail: Record<string, boolean> = {}
  const outcomes: Record<string, Outcome> = {}
  const runs: QueuedRun[] = []
  const crashOnRun = { value: false }
  let tickFn: (() => void) | null = null
  let n = 0
  const deps: SchedulerDeps = {
    now: () => clock.now,
    setInterval: (fn) => {
      tickFn = fn
      return () => {
        tickFn = null
      }
    },
    getConfig: () => cfg,
    stateFile,
    isOnBattery: () => battery.on,
    isDestinationAvailable: async (id) => avail[id] ?? true,
    newRunId: () => `run-${++n}`,
    execute: async (run, _signal, onJobEnd): Promise<RunLog> => {
      runs.push(run)
      if (crashOnRun.value) return new Promise<RunLog>(() => {}) // never finishes: simulates a crash
      const jobs: JobResult[] = run.jobs.map((j) => ({
        sourceId: j.sourceId,
        destId: j.destId,
        status: 'completed',
        counts: { copied: 0, updated: 0, zipped: 0, trashed: 0, deleted: 0, pruned: 0, skipped: 0 },
        bytesWritten: 0,
        warnings: [],
        ...outcomes[`${j.sourceId}:${j.destId}`]
      }))
      for (const r of jobs) onJobEnd(r)
      return {
        id: run.id,
        trigger: run.trigger,
        startedAt: clock.now.toISOString(),
        endedAt: clock.now.toISOString(),
        status: 'completed',
        jobs
      }
    }
  }
  const s = new Scheduler(deps)
  return {
    s,
    cfg,
    runs,
    clock,
    battery,
    avail,
    crashOnRun,
    stateFile,
    outcome: (key, o) => {
      outcomes[key] = o
    },
    advance: async (ms) => {
      clock.now = new Date(clock.now.getTime() + ms)
      tickFn?.()
      await s.whenIdle()
    }
  }
}

const daily = (time: string): Schedule => ({ kind: 'daily', time })

test('start registers a 60 s interval', async () => {
  const h = await harness([daily('02:00')])
  let ms = 0
  const s = new Scheduler({
    ...(h.s as unknown as { deps: SchedulerDeps }).deps,
    setInterval: (_fn, m) => {
      ms = m
      return () => {}
    }
  })
  await s.start()
  expect(ms).toBe(60_000)
  s.stop()
})

test('new schedule does not run immediately; runs at next slot', async () => {
  const h = await harness([daily('11:00')])
  await h.s.start()
  await h.s.whenIdle()
  expect(h.runs).toEqual([])
  await h.advance(50 * MIN)
  expect(h.runs).toEqual([])
  await h.advance(10 * MIN)
  expect(h.runs.map((r) => [r.trigger, r.jobs])).toEqual([
    ['scheduled', [{ sourceId: 's0', destId: 'd0' }]]
  ])
  await h.advance(MIN)
  expect(h.runs).toHaveLength(1)
})

test('due sources at the same tick are grouped into one scheduled run', async () => {
  const h = await harness([daily('11:00'), daily('11:00')], { destCount: 2 })
  await h.s.start()
  await h.advance(60 * MIN)
  expect(h.runs).toHaveLength(1)
  expect(h.runs[0].jobs).toHaveLength(4)
})

test('missed slots while off → one catch-up run on start', async () => {
  const h = await harness([daily('02:00')])
  const st = emptyState()
  st.sources.s0 = { lastScheduledAt: at(15, 2).toISOString() }
  await saveState(h.stateFile, st)
  await h.s.start()
  await h.s.whenIdle()
  expect(h.runs.map((r) => r.trigger)).toEqual(['catch-up'])
  await h.advance(MIN)
  expect(h.runs).toHaveLength(1)
})

test('paused: no runs; after pausedUntil passes, catch-up runs once', async () => {
  const h = await harness([daily('11:00')])
  await h.s.start()
  await h.s.pause(at(20, 12))
  await h.advance(60 * MIN)
  expect(h.runs).toEqual([])
  expect(h.s.status().pausedUntil).toBe(at(20, 12).toISOString())
  await h.advance(61 * MIN)
  expect(h.runs.map((r) => r.trigger)).toEqual(['catch-up'])
  expect(h.s.status().pausedUntil).toBeNull()
})

test('pause forever + resume', async () => {
  const h = await harness([daily('11:00')])
  await h.s.start()
  await h.s.pause('forever')
  await h.advance(120 * MIN)
  expect(h.runs).toEqual([])
  expect(h.s.status().pausedUntil).toBe('forever')
  await h.s.resume()
  await h.s.whenIdle()
  expect(h.runs.map((r) => r.trigger)).toEqual(['catch-up'])
})

test('manual runNow works while paused', async () => {
  const h = await harness([null], { destCount: 2 })
  await h.s.start()
  await h.s.pause('forever')
  const r = h.s.runNow()
  await h.s.whenIdle()
  expect(r?.trigger).toBe('manual')
  expect(h.runs[0].jobs).toHaveLength(2)
})

test('battery deferral keeps the source due until on AC', async () => {
  const h = await harness([daily('11:00')])
  h.cfg.settings.skipScheduledOnBattery = true
  h.battery.on = true
  await h.s.start()
  await h.advance(60 * MIN)
  expect(h.runs).toEqual([])
  h.battery.on = false
  await h.s.onPowerChange()
  await h.s.whenIdle()
  expect(h.runs).toHaveLength(1)
})

test('scheduled job skipped for destination-missing → pendingRetry; retried when available', async () => {
  const h = await harness([daily('11:00')])
  h.outcome('s0:d0', { status: 'skipped', reason: 'destination-missing' })
  await h.s.start()
  await h.advance(60 * MIN)
  expect(h.s.status().pendingRetries).toEqual([{ sourceId: 's0', destId: 'd0' }])
  h.avail.d0 = false
  await h.advance(MIN)
  expect(h.runs).toHaveLength(1)
  h.avail.d0 = true
  h.outcome('s0:d0', { status: 'completed' })
  await h.advance(MIN)
  expect(h.runs.map((r) => r.trigger)).toEqual(['scheduled', 'retry'])
  expect(h.s.status().pendingRetries).toEqual([])
  await h.advance(MIN)
  expect(h.runs).toHaveLength(2)
})

test('destination-lost during scheduled run → pendingRetry', async () => {
  const h = await harness([daily('11:00')])
  h.outcome('s0:d0', { status: 'failed', reason: 'destination-lost' })
  await h.s.start()
  await h.advance(60 * MIN)
  expect(h.s.status().pendingRetries).toHaveLength(1)
})

test('manual run skipped for destination-missing does not set pendingRetry', async () => {
  const h = await harness([null])
  h.outcome('s0:d0', { status: 'skipped', reason: 'destination-missing' })
  await h.s.start()
  h.s.runNow(['s0'])
  await h.s.whenIdle()
  expect(h.s.status().pendingRetries).toEqual([])
})

test('retryWhenAvailable false → no retry', async () => {
  const h = await harness([daily('11:00')])
  h.cfg.sources[0].retryWhenAvailable = false
  h.outcome('s0:d0', { status: 'skipped', reason: 'destination-missing' })
  await h.s.start()
  await h.advance(60 * MIN)
  expect(h.s.status().pendingRetries).toEqual([])
})

test('leftover activeRun on start → unfinished jobs re-enqueued as recovery', async () => {
  const h = await harness([null], { destCount: 2 })
  const st = emptyState()
  st.activeRun = { runId: 'old', jobs: ['s0:d1'] }
  await saveState(h.stateFile, st)
  await h.s.start()
  await h.s.whenIdle()
  expect(h.runs.map((r) => [r.trigger, r.jobs])).toEqual([
    ['recovery', [{ sourceId: 's0', destId: 'd1' }]]
  ])
  expect((await loadState(h.stateFile, h.cfg)).activeRun).toBeNull()
})

test('job finished before a crash is not re-run on recovery', async () => {
  const h = await harness([null], { destCount: 2 })
  await h.s.start()
  // a run whose first job finishes, then the app "crashes"
  h.crashOnRun.value = true
  h.s.runNow()
  await new Promise((r) => setTimeout(r, 20))
  const persisted = await loadState(h.stateFile, h.cfg)
  expect(persisted.activeRun?.jobs).toEqual(['s0:d0', 's0:d1'])
  // simulate: first job ended before the crash
  persisted.activeRun = { runId: persisted.activeRun!.runId, jobs: ['s0:d1'] }
  await saveState(h.stateFile, persisted)
  const h2 = await harness([null], { destCount: 2 })
  await saveState(h2.stateFile, persisted)
  await h2.s.start()
  await h2.s.whenIdle()
  expect(h2.runs[0].jobs).toEqual([{ sourceId: 's0', destId: 'd1' }])
})

test('onJobEnd removes finished jobs from activeRun as they complete', async () => {
  const h = await harness([null], { destCount: 2 })
  await h.s.start()
  h.s.runNow()
  await h.s.whenIdle()
  const st = await loadState(h.stateFile, h.cfg)
  expect(st.activeRun).toBeNull()
  expect(st.jobs['s0:d0'].lastSuccessAt).toBe(h.clock.now.toISOString())
})

test('clock moved backwards: future lastScheduledAt is clamped and persisted, interval fires', async () => {
  const h = await harness([{ kind: 'interval', everyHours: 1 }])
  const st = emptyState()
  st.sources.s0 = { lastScheduledAt: at(25, 10).toISOString() }
  await saveState(h.stateFile, st)
  await h.s.start()
  await h.s.whenIdle()
  expect(h.runs).toEqual([])
  expect((await loadState(h.stateFile, h.cfg)).sources.s0.lastScheduledAt).toBe(
    h.clock.now.toISOString()
  )
  await h.advance(61 * MIN)
  expect(h.runs).toHaveLength(1)
})

test('status reports nextRuns, pending retries and pause', async () => {
  const h = await harness([daily('11:00'), null])
  await h.s.start()
  const st = h.s.status()
  expect(st.nextRuns).toEqual([
    { sourceId: 's0', at: at(20, 11).toISOString() },
    { sourceId: 's1', at: null }
  ])
  expect(st).toMatchObject({ active: null, pending: [], pausedUntil: null, pendingRetries: [] })
})

test('onChange notifies on pause', async () => {
  const h = await harness([null])
  await h.s.start()
  let calls = 0
  h.s.onChange(() => calls++)
  await h.s.pause('forever')
  expect(calls).toBeGreaterThan(0)
})
