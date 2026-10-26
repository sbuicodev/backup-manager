import type { Config, Source } from '@shared/schema'
import type { JobRequest, JobResult, QueuedRun, RunLog, SchedulerStatus } from '@shared/types'
import { destinationsFor } from '../engine/planner'
import { RunQueue } from './queue'
import { clampLast, isDue, nextRunAt } from './schedule'
import {
  emptyState,
  jobKey,
  loadState,
  parseJobKey,
  saveState,
  type JobState,
  type State
} from './state'

export const CHECK_INTERVAL_MS = 60_000

export type SchedulerDeps = {
  now(): Date
  setInterval(fn: () => void, ms: number): () => void
  getConfig(): Config
  stateFile: string
  isOnBattery(): boolean
  isDestinationAvailable(destId: string): Promise<boolean>
  execute(run: QueuedRun, signal: AbortSignal, onJobEnd: (r: JobResult) => void): Promise<RunLog>
  onRunFinished?(log: RunLog): void
  newRunId(): string
}

const RETRY_REASONS = new Set(['destination-missing', 'destination-lost'])

export const RETRY_STEP_MS = 60_000
export const RETRY_MAX_MS = 300_000

/** Delay before the next availability check after `attempts` checks: 1, 2, 3, 4, then 5 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_STEP_MS * (attempts + 1), RETRY_MAX_MS)
}

export class Scheduler {
  private state: State = emptyState()
  private queue: RunQueue
  private listeners = new Set<() => void>()
  private stopInterval: (() => void) | null = null
  private saving: Promise<void> = Promise.resolve()
  private ticking: Promise<void> | null = null

  constructor(private readonly deps: SchedulerDeps) {
    this.queue = new RunQueue((run, signal) => this.execute(run, signal), deps.newRunId)
    this.queue.onChange(() => this.changed())
  }

  async start(): Promise<void> {
    this.state = await loadState(this.deps.stateFile, this.deps.getConfig())
    const leftover = this.state.activeRun
    this.state.activeRun = null
    await this.save()
    if (leftover && leftover.jobs.length > 0) {
      this.queue.enqueue(leftover.jobs.map(parseJobKey), 'recovery')
    }
    await this.tick()
    this.stopInterval = this.deps.setInterval(() => void this.tick(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    this.stopInterval?.()
    this.stopInterval = null
  }

  /** Serializes ticks so overlapping triggers (interval, resume, power) don't double-enqueue. */
  tick(): Promise<void> {
    const prev = this.ticking ?? Promise.resolve()
    const next = prev.then(() => this.doTick())
    const tracked: Promise<void> = next
      .catch((err) => console.error('scheduler tick failed', err))
      .finally(() => {
        if (this.ticking === tracked) this.ticking = null
      })
    this.ticking = tracked
    return next
  }

  onResume(): Promise<void> {
    this.resetRetryTiming()
    return this.tick()
  }

  onPowerChange(): Promise<void> {
    this.resetRetryTiming()
    return this.tick()
  }

  /** Wake or AC power: drives often come back now, so every pending retry is due again. */
  private resetRetryTiming(): void {
    for (const js of Object.values(this.state.jobs)) {
      if (!js.pendingRetry) continue
      js.retryAttempts = 0
      js.nextRetryAt = null
    }
  }

  runNow(sourceIds?: string[]): QueuedRun | null {
    const config = this.deps.getConfig()
    const jobs = config.sources
      .filter((s) => s.enabled && (!sourceIds || sourceIds.includes(s.id)))
      .flatMap((s) => this.jobsFor(config, s))
    return this.queue.enqueue(jobs, 'manual')
  }

  cancel(): void {
    this.queue.cancelActive()
  }

  async pause(until: Date | 'forever'): Promise<void> {
    this.state.pausedUntil = until === 'forever' ? 'forever' : until.toISOString()
    await this.save()
    this.changed()
  }

  async resume(): Promise<void> {
    this.state.pausedUntil = null
    await this.save()
    this.changed()
    await this.tick()
  }

  status(): SchedulerStatus {
    const now = this.deps.now()
    const config = this.deps.getConfig()
    return {
      active: this.queue.active,
      pending: [...this.queue.pending],
      pausedUntil: this.state.pausedUntil,
      nextRuns: config.sources.map((s) => {
        if (!s.enabled || !s.schedule) return { sourceId: s.id, at: null }
        const last = this.lastScheduled(s.id) ?? now
        return { sourceId: s.id, at: nextRunAt(s.schedule, last, now).toISOString() }
      }),
      pendingRetries: Object.entries(this.state.jobs)
        .filter(([, j]) => j.pendingRetry)
        .map(([k, j]) => ({ ...parseJobKey(k), nextRetryAt: j.nextRetryAt }))
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Resolves when no tick is in progress and the queue is empty. */
  async whenIdle(): Promise<void> {
    while (this.ticking) await this.ticking
    await this.queue.whenIdle()
    await this.saving
  }

  private changed(): void {
    for (const cb of this.listeners) cb()
  }

  private save(): Promise<void> {
    const snapshot = structuredClone(this.state)
    this.saving = this.saving
      .then(() => saveState(this.deps.stateFile, snapshot))
      .catch((err) => console.error('failed to save scheduler state', err))
    return this.saving
  }

  private lastScheduled(sourceId: string): Date | null {
    const v = this.state.sources[sourceId]?.lastScheduledAt
    return v ? new Date(v) : null
  }

  private jobsFor(config: Config, source: Source): JobRequest[] {
    return destinationsFor(config, source).map((d) => ({ sourceId: source.id, destId: d.id }))
  }

  private job(key: string): JobState {
    return (this.state.jobs[key] ??= {
      lastSuccessAt: null,
      lastAttemptAt: null,
      pendingRetry: false,
      retryAttempts: 0,
      nextRetryAt: null
    })
  }

  private isPaused(now: Date): boolean {
    const p = this.state.pausedUntil
    if (p === null) return false
    if (p === 'forever' || new Date(p).getTime() > now.getTime()) return true
    this.state.pausedUntil = null
    return false
  }

  private async doTick(): Promise<void> {
    const now = this.deps.now()
    const config = this.deps.getConfig()
    const wasPaused = this.state.pausedUntil !== null
    if (this.isPaused(now)) return
    if (wasPaused) this.changed()
    const deferForBattery = config.settings.skipScheduledOnBattery && this.deps.isOnBattery()

    const due: JobRequest[] = []
    let allLate = true
    for (const source of config.sources) {
      if (!source.enabled || !source.schedule) continue
      const stored = this.lastScheduled(source.id)
      if (!stored) {
        this.state.sources[source.id] = { lastScheduledAt: now.toISOString() }
        continue
      }
      const last = clampLast(stored, now)
      if (last !== stored) this.state.sources[source.id] = { lastScheduledAt: last.toISOString() }
      const check = isDue(source.schedule, last, now)
      if (!check.due || deferForBattery) continue
      allLate &&= check.late
      this.state.sources[source.id] = { lastScheduledAt: check.slot.toISOString() }
      for (const j of this.jobsFor(config, source)) {
        clearRetry(this.job(jobKey(j)))
        due.push(j)
      }
    }

    const retries: JobRequest[] = []
    let retryTimingChanged = false
    if (!deferForBattery) {
      const active = new Set(this.queue.active?.jobs.map(jobKey) ?? [])
      for (const [key, js] of Object.entries(this.state.jobs)) {
        if (!js.pendingRetry || active.has(key)) continue
        const j = parseJobKey(key)
        const source = config.sources.find((s) => s.id === j.sourceId)
        const dest = config.destinations.find((d) => d.id === j.destId)
        if (!source?.enabled || !source.retryWhenAvailable || !dest?.enabled) continue
        const next = js.nextRetryAt === null ? null : new Date(js.nextRetryAt).getTime()
        // A due time beyond the cap means the clock moved back: check now rather than stall.
        const due = next === null || next <= now.getTime() || next > now.getTime() + RETRY_MAX_MS
        if (!due) continue
        // Every check moves the sequence on, so a retry that fails again waits its turn.
        js.retryAttempts += 1
        js.nextRetryAt = new Date(now.getTime() + retryDelayMs(js.retryAttempts)).toISOString()
        retryTimingChanged = true
        if (await this.deps.isDestinationAvailable(j.destId)) retries.push(j)
      }
    }

    await this.save()
    // The UI shows "next check in N min", so it must hear when a check moves that time.
    if (retryTimingChanged) this.changed()
    if (due.length > 0) this.queue.enqueue(due, allLate ? 'catch-up' : 'scheduled')
    if (retries.length > 0) this.queue.enqueue(retries, 'retry')
  }

  private async execute(run: QueuedRun, signal: AbortSignal): Promise<void> {
    this.state.activeRun = { runId: run.id, jobs: run.jobs.map(jobKey) }
    await this.save()
    const startedAt = this.deps.now().toISOString()
    let log: RunLog
    try {
      log = await this.deps.execute(run, signal, (r) => this.onJobEnd(run, r))
    } catch (err) {
      console.error(`run ${run.id} failed`, err)
      const error = (err as Error).message
      log = {
        id: run.id,
        trigger: run.trigger,
        startedAt,
        endedAt: this.deps.now().toISOString(),
        status: 'failed',
        jobs: run.jobs.map((j) => ({
          ...j,
          status: 'failed',
          reason: 'error',
          error,
          counts: {
            copied: 0,
            updated: 0,
            zipped: 0,
            trashed: 0,
            deleted: 0,
            pruned: 0,
            skipped: 0
          },
          bytesWritten: 0,
          warnings: []
        }))
      }
    }
    this.state.activeRun = null
    await this.save()
    this.changed()
    this.deps.onRunFinished?.(log)
  }

  private onJobEnd(run: QueuedRun, r: JobResult): void {
    const key = jobKey(r)
    const js = this.job(key)
    const now = this.deps.now().toISOString()
    js.lastAttemptAt = now
    if (r.status === 'completed' || r.status === 'completed-with-warnings') {
      js.lastSuccessAt = now
      clearRetry(js)
    } else if (r.reason && RETRY_REASONS.has(r.reason) && run.trigger !== 'manual') {
      const source = this.deps.getConfig().sources.find((s) => s.id === r.sourceId)
      if (source?.retryWhenAvailable && !js.pendingRetry) {
        js.pendingRetry = true
        js.retryAttempts = 0
        js.nextRetryAt = new Date(this.deps.now().getTime() + RETRY_STEP_MS).toISOString()
      }
    }
    if (this.state.activeRun) {
      this.state.activeRun.jobs = this.state.activeRun.jobs.filter((k) => k !== key)
    }
    void this.save()
    this.changed()
  }
}

function clearRetry(js: JobState): void {
  js.pendingRetry = false
  js.retryAttempts = 0
  js.nextRetryAt = null
}
