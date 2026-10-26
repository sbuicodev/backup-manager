import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
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
  checks: Date[]
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
  const checks: Date[] = []
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
    isDestinationAvailable: async (id) => {
      checks.push(clock.now)
      return avail[id] ?? true
    },
    newRunId: () => `run-${++n}`,
    execute: async (run, _signal, onJobEnd): Promise<RunLog> => {
      runs.push(run)
      if (crashOnRun.value) return new Promise<RunLog>(() => {}) // never finishes: simulates a crash
      const jobs: JobResult[] = run.jobs.map((j) => ({
        sourceId: j.sourceId,
        destId: j.destId,
        status: outcomes[`${j.sourceId}:${j.destId}`]?.status ?? 'completed',
        reason: outcomes[`${j.sourceId}:${j.destId}`]?.reason,
        counts: { copied: 0, updated: 0, zipped: 0, trashed: 0, deleted: 0, pruned: 0, skipped: 0 },
        bytesWritten: 0,
        warnings: []
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
    checks,
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
  expect(h.s.status().pendingRetries).toMatchObject([{ sourceId: 's0', destId: 'd0' }])
  h.avail.d0 = false
  await h.advance(MIN) // first check (+1 min): still missing → next check +2 min later
  expect(h.runs).toHaveLength(1)
  h.avail.d0 = true
  h.outcome('s0:d0', { status: 'completed' })
  await h.advance(2 * MIN)
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
  // Wait (up to 2 s) for the run's activeRun record to reach disk.
  let persisted = await loadState(h.stateFile, h.cfg)
  for (let i = 0; i < 100 && !persisted.activeRun; i++) {
    await new Promise((r) => setTimeout(r, 20))
    persisted = await loadState(h.stateFile, h.cfg)
  }
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

test('a run whose executor throws still clears activeRun and reports a failed run', async () => {
  const h = await harness([null])
  const finished: RunLog[] = []
  const s = new Scheduler({
    ...(h.s as unknown as { deps: SchedulerDeps }).deps,
    execute: async () => {
      throw new Error('boom')
    },
    onRunFinished: (log) => finished.push(log)
  })
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await s.start()
  s.runNow()
  await s.whenIdle()
  spy.mockRestore()
  expect((await loadState(h.stateFile, h.cfg)).activeRun).toBeNull()
  expect(finished).toHaveLength(1)
  expect(finished[0]).toMatchObject({ status: 'failed', trigger: 'manual' })
  expect(finished[0].jobs[0]).toMatchObject({ status: 'failed', reason: 'error', error: 'boom' })
})

describe('retry timing', () => {
  async function skipped(): Promise<Awaited<ReturnType<typeof harness>>> {
    const h = await harness([daily('11:00')])
    h.outcome('s0:d0', { status: 'skipped', reason: 'destination-missing' })
    await h.s.start()
    await h.advance(60 * MIN) // 11:00 scheduled run → skipped → pending retry
    h.avail.d0 = false
    h.checks.length = 0
    return h
  }
  const minutesAfter11 = (h: Awaited<ReturnType<typeof harness>>): number[] =>
    h.checks.map((d) => (d.getTime() - at(20, 11).getTime()) / MIN)

  test('an old state file without retry fields loads with defaults', async () => {
    const h = await harness([null])
    const st = emptyState()
    st.jobs['s0:d0'] = { lastSuccessAt: null, lastAttemptAt: null, pendingRetry: true } as never
    await saveState(h.stateFile, st)
    const loaded = await loadState(h.stateFile, h.cfg)
    expect(loaded.jobs['s0:d0']).toMatchObject({ retryAttempts: 0, nextRetryAt: null })
  })

  test('checks at +1, +2, +3, +4, +5 min after the skip, then every 5 min', async () => {
    const h = await skipped()
    for (let i = 0; i < 25; i++) await h.advance(MIN)
    expect(minutesAfter11(h)).toEqual([1, 3, 6, 10, 15, 20, 25])
  })

  test('destination back at a check → retry run queued', async () => {
    const h = await skipped()
    await h.advance(MIN)
    h.avail.d0 = true
    h.outcome('s0:d0', { status: 'completed' })
    await h.advance(MIN)
    expect(h.runs.map((r) => r.trigger)).toEqual(['scheduled'])
    await h.advance(MIN)
    expect(h.runs.map((r) => r.trigger)).toEqual(['scheduled', 'retry'])
  })

  test('wake from sleep makes pending retries due now and restarts the sequence', async () => {
    const h = await skipped()
    for (let i = 0; i < 7; i++) await h.advance(MIN) // checks at 1, 3, 6 → next at 10
    h.clock.now = new Date(h.clock.now.getTime() + 30_000)
    await h.s.onResume()
    await h.s.whenIdle()
    for (let i = 0; i < 3; i++) await h.advance(MIN)
    expect(minutesAfter11(h)).toEqual([1, 3, 6, 7.5, 9.5])
  })

  test('AC power behaves like wake', async () => {
    const h = await skipped()
    await h.advance(MIN)
    await h.advance(MIN)
    await h.s.onPowerChange()
    await h.s.whenIdle()
    expect(minutesAfter11(h)).toEqual([1, 2])
  })

  test('a retry that fails again continues the sequence instead of restarting', async () => {
    const h = await skipped()
    for (let i = 0; i < 3; i++) await h.advance(MIN) // checks at 1, 3 → next due at 6
    h.avail.d0 = true // available at the check, but the retry run finds it missing again
    await h.advance(3 * MIN) // check at 6 → retry run → skipped again
    expect(h.runs.map((r) => r.trigger)).toEqual(['scheduled', 'retry'])
    h.avail.d0 = false
    h.checks.length = 0
    for (let i = 0; i < 5; i++) await h.advance(MIN)
    // every check advances the sequence, so after the check at 6 the next one is at 10
    expect(minutesAfter11(h)).toEqual([10])
  })

  test("the source's next regular slot clears the pending retry and its timing", async () => {
    const h = await skipped()
    for (let i = 0; i < 3; i++) await h.advance(MIN)
    h.outcome('s0:d0', { status: 'completed' })
    h.clock.now = at(21, 10, 59)
    await h.advance(MIN) // 11:00 next day: regular run
    const st = await loadState(h.stateFile, h.cfg)
    expect(st.jobs['s0:d0']).toMatchObject({
      pendingRetry: false,
      retryAttempts: 0,
      nextRetryAt: null
    })
  })

  test('nextRetryAt far in the future (clock moved back) is treated as due', async () => {
    const h = await skipped()
    await h.advance(MIN) // check at +1 → next at +3
    h.clock.now = new Date(h.clock.now.getTime() - 60 * MIN) // clock jumps back an hour
    h.checks.length = 0
    await h.advance(MIN)
    expect(h.checks).toHaveLength(1)
  })

  test('status exposes nextRetryAt for each pending retry', async () => {
    const h = await skipped()
    await h.advance(MIN)
    expect(h.s.status().pendingRetries).toEqual([
      { sourceId: 's0', destId: 'd0', nextRetryAt: at(20, 11, 3).toISOString() }
    ])
  })

  test('status leaves out retries whose source or destination no longer allows them', async () => {
    const h = await skipped()
    h.cfg.sources[0].retryWhenAvailable = false
    expect(h.s.status().pendingRetries).toEqual([])
    h.cfg.sources[0].retryWhenAvailable = true
    h.cfg.destinations[0].enabled = false
    expect(h.s.status().pendingRetries).toEqual([])
    h.cfg.destinations[0].enabled = true
    h.cfg.sources[0].destinationIds = []
    expect(h.s.status().pendingRetries).toEqual([])
  })

  test('an invalid nextRetryAt is treated as due instead of stalling the retry', async () => {
    const h = await skipped()
    const state = (h.s as unknown as { state: { jobs: Record<string, { nextRetryAt: string }> } })
      .state
    state.jobs['s0:d0'].nextRetryAt = 'not a date'
    expect(h.s.status().pendingRetries[0].nextRetryAt).toBeNull()
    h.checks.length = 0
    await h.advance(MIN)
    expect(h.checks).toHaveLength(1)
  })
})

test('a retry check that moves the next check time notifies status listeners', async () => {
  const h = await harness([daily('11:00')])
  h.outcome('s0:d0', { status: 'skipped', reason: 'destination-missing' })
  await h.s.start()
  await h.advance(60 * MIN)
  h.avail.d0 = false
  let calls = 0
  h.s.onChange(() => calls++)
  await h.advance(MIN) // check at +1 → next check moves to +3
  expect(calls).toBeGreaterThan(0)
})
