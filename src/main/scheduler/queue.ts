import type { JobRequest, QueuedRun, RunTrigger } from '@shared/types'
import { jobKey } from './state'

export type Runner = (run: QueuedRun, signal: AbortSignal) => Promise<void>

/** FIFO queue that executes runs strictly one at a time. */
export class RunQueue {
  private queue: QueuedRun[] = []
  private current: { run: QueuedRun; controller: AbortController } | null = null
  private listeners = new Set<() => void>()
  private idleWaiters: (() => void)[] = []

  constructor(
    private runner: Runner,
    private newId: () => string
  ) {}

  get active(): QueuedRun | null {
    return this.current?.run ?? null
  }

  get pending(): readonly QueuedRun[] {
    return this.queue
  }

  /** Adds a run with the jobs not already in a pending run; null when nothing is left. */
  enqueue(jobs: JobRequest[], trigger: RunTrigger): QueuedRun | null {
    const queued = new Set(this.queue.flatMap((r) => r.jobs.map(jobKey)))
    const fresh = jobs.filter((j) => {
      const k = jobKey(j)
      if (queued.has(k)) return false
      queued.add(k)
      return true
    })
    if (fresh.length === 0) return null
    const run: QueuedRun = { id: this.newId(), trigger, jobs: fresh }
    this.queue.push(run)
    this.changed()
    void this.drain()
    return run
  }

  cancelActive(): void {
    this.current?.controller.abort()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  whenIdle(): Promise<void> {
    if (!this.current && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private changed(): void {
    for (const cb of this.listeners) cb()
  }

  private async drain(): Promise<void> {
    if (this.current) return
    while (this.queue.length > 0) {
      const run = this.queue.shift()!
      const controller = new AbortController()
      this.current = { run, controller }
      this.changed()
      try {
        await this.runner(run, controller.signal)
      } catch (err) {
        console.error(`run ${run.id} failed`, err)
      }
      this.current = null
      this.changed()
    }
    for (const w of this.idleWaiters.splice(0)) w()
  }
}
