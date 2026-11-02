import type { Config } from './schema'
import type {
  ChangePage,
  ChangeQuery,
  Plan,
  ProgressEvent,
  RunLog,
  RunSummary,
  SchedulerStatus
} from './types'

export type ConfigState =
  { ok: true; config: Config; path: string } | { ok: false; errors: string[]; path: string }

export type SaveResult = { ok: true } | { ok: false; errors: string[] }

export type Screen = 'sources' | 'destinations' | 'run' | 'history' | 'settings'

export type Api = {
  config: {
    get(): Promise<ConfigState>
    save(c: Config): Promise<SaveResult>
    export(): Promise<boolean>
    import(): Promise<SaveResult | null>
    reset(): Promise<void>
    onChange(cb: (state: ConfigState) => void): () => void
  }
  dialog: { pickFolder(): Promise<string | null>; pickFiles(): Promise<string[]> }
  destinations: { availability(): Promise<Record<string, boolean>> }
  run: {
    plan(sourceIds?: string[]): Promise<Plan>
    start(sourceIds?: string[]): Promise<string | null>
    cancel(): Promise<void>
    onProgress(cb: (e: ProgressEvent) => void): () => void
  }
  scheduler: {
    status(): Promise<SchedulerStatus>
    pause(until: string | 'forever'): Promise<void>
    resume(): Promise<void>
    onStatus(cb: (s: SchedulerStatus) => void): () => void
  }
  history: {
    list(): Promise<RunSummary[]>
    get(id: string): Promise<RunLog | null>
    changes(runId: string, q: ChangeQuery): Promise<ChangePage>
  }
  app: {
    /** `process.platform` of the app: the top bar leaves room for the native window controls. */
    platform: string
    onNavigate(cb: (screen: Screen, arg?: string) => void): () => void
  }
}

/** IPC channel names: invoke channels mirror Api methods; the last four are main → renderer events. */
export const CH = {
  configGet: 'config:get',
  configSave: 'config:save',
  configExport: 'config:export',
  configImport: 'config:import',
  configReset: 'config:reset',
  pickFolder: 'dialog:pickFolder',
  pickFiles: 'dialog:pickFiles',
  availability: 'destinations:availability',
  runPlan: 'run:plan',
  runStart: 'run:start',
  runCancel: 'run:cancel',
  schedulerStatus: 'scheduler:status',
  schedulerPause: 'scheduler:pause',
  schedulerResume: 'scheduler:resume',
  historyList: 'history:list',
  historyGet: 'history:get',
  historyChanges: 'history:changes',
  progress: 'run:progress',
  status: 'scheduler:status-changed',
  configChanged: 'config:changed',
  navigate: 'app:navigate'
} as const
