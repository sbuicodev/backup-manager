import { readdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { CH, type ConfigState, type SaveResult } from '@shared/ipc'
import { defaultConfig, type Config } from '@shared/schema'
import type { ChangePage, ChangeQuery, PairResult, Plan, RunLog, RunSummary } from '@shared/types'
import { loadConfig, saveConfig } from './engine/config'
import { FsDestination } from './engine/destination'
import { runBackup } from './engine/executor'
import { getRun, latestResults, listRuns, newRunId } from './engine/history'
import { readChanges } from './engine/changes'
import { planRun, targets } from './engine/planner'
import { pruneSnapshotIndexes } from './engine/snapshot-index'
import { Scheduler, type SchedulerDeps } from './scheduler/scheduler'

export type Platform = {
  now(): Date
  setInterval: SchedulerDeps['setInterval']
  isOnBattery(): boolean
}

export type ServicesOptions = {
  userDataDir: string
  platform: Platform
  broadcast: (channel: string, payload: unknown) => void
  onRunFinished: (log: RunLog) => void
}

export type Services = {
  paths: { config: string; state: string; history: string; snapshotIndex: string }
  configState(): ConfigState
  /** The current valid config, or an empty default while the file on disk is invalid. */
  config(): Config
  saveConfig(c: unknown): Promise<SaveResult>
  resetConfig(): Promise<void>
  onConfigChange(cb: (c: Config) => void): () => void
  plan(sourceIds?: string[]): Promise<Plan>
  availability(): Promise<Record<string, boolean>>
  listRuns(): Promise<RunSummary[]>
  getRun(id: string): Promise<RunLog | null>
  readChanges(runId: string, q: ChangeQuery): Promise<ChangePage>
  latestResults(): Promise<PairResult[]>
  destinationInfo(id: string): Promise<{ available: boolean; freeBytes: number | null }>
  scheduler: Scheduler
  start(): Promise<void>
  stop(): void
}

export async function createServices(opts: ServicesOptions): Promise<Services> {
  const { userDataDir, platform, broadcast } = opts
  const paths = {
    config: join(userDataDir, 'config.json'),
    state: join(userDataDir, 'state.json'),
    history: join(userDataDir, 'history'),
    snapshotIndex: join(userDataDir, 'snapshot-index')
  }
  const loaded = await loadConfig(paths.config)
  let state: ConfigState = loaded.ok
    ? { ok: true, config: loaded.config, path: paths.config }
    : { ok: false, errors: loaded.errors, path: paths.config }
  const listeners = new Set<(c: Config) => void>()
  const current = (): Config => (state.ok ? state.config : defaultConfig())

  const issued = new Set<string>()
  try {
    for (const f of await readdir(paths.history)) issued.add(f.replace(/\.json$/, ''))
  } catch {
    // no history yet
  }

  const scheduler = new Scheduler({
    now: platform.now,
    setInterval: platform.setInterval,
    getConfig: current,
    stateFile: paths.state,
    isOnBattery: platform.isOnBattery,
    isDestinationAvailable: async (destId) => {
      const d = current().destinations.find((x) => x.id === destId)
      return d ? new FsDestination(d.path).isAvailable() : false
    },
    newRunId: () => {
      const id = newRunId(platform.now(), issued)
      issued.add(id)
      return id
    },
    execute: (run, signal, onJobEnd) =>
      runBackup(
        current(),
        { jobs: run.jobs },
        {
          runId: run.id,
          trigger: run.trigger,
          signal,
          historyDir: paths.history,
          indexDir: paths.snapshotIndex,
          now: platform.now,
          emit: (e) => {
            broadcast(CH.progress, e)
            if (e.type === 'job-end') onJobEnd(e.result)
          }
        }
      ),
    onRunFinished: opts.onRunFinished
  })
  scheduler.onChange(() => broadcast(CH.status, scheduler.status()))

  const apply = async (c: unknown): Promise<SaveResult> => {
    const r = await saveConfig(paths.config, c as Config)
    if (!r.ok) return r
    const saved = c as Config
    state = { ok: true, config: saved, path: paths.config }
    for (const cb of listeners) cb(saved)
    broadcast(CH.configChanged, state)
    broadcast(CH.status, scheduler.status())
    return r
  }

  return {
    paths,
    configState: () => state,
    config: current,
    saveConfig: apply,
    resetConfig: async () => {
      await apply(defaultConfig())
    },
    onConfigChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    plan: async (sourceIds) =>
      (
        await planRun(current(), sourceIds ? { sourceIds } : {}, {
          now: platform.now,
          indexDir: paths.snapshotIndex
        })
      ).plan,
    availability: async () => {
      const entries = await Promise.all(
        current().destinations.map(
          async (d) => [d.id, await new FsDestination(d.path).isAvailable()] as const
        )
      )
      return Object.fromEntries(entries)
    },
    listRuns: () => listRuns(paths.history),
    getRun: (id) => getRun(paths.history, id),
    readChanges: (runId, q) => readChanges(paths.history, runId, q),
    latestResults: () => latestResults(paths.history),
    destinationInfo: async (id) => {
      const d = current().destinations.find((x) => x.id === id)
      if (!d || !(await new FsDestination(d.path).isAvailable())) {
        return { available: false, freeBytes: null }
      }
      try {
        const s = await statfs(d.path)
        return { available: true, freeBytes: s.bavail * s.bsize }
      } catch {
        return { available: true, freeBytes: null }
      }
    },
    scheduler,
    start: async () => {
      // An unreadable config is not "no sources": keep every index until it is fixed.
      if (!state.ok) return scheduler.start()
      // Disabled sources/destinations keep their index: they may be switched back on.
      const cfg = current()
      const pairs = new Set(
        cfg.sources.flatMap((s) =>
          cfg.destinations.filter((d) => targets(s, d)).map((d) => `${s.id}__${d.id}`)
        )
      )
      await pruneSnapshotIndexes(paths.snapshotIndex, pairs)
      await scheduler.start()
    },
    stop: () => scheduler.stop()
  }
}
