import type { Config, SourceItem } from './schema'
import type {
  ChangePage,
  ChangeQuery,
  PairResult,
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
  /** `startAt`: open where the field already points (the folder, or the last file picked). */
  dialog: {
    pickFolder(startAt?: string): Promise<string | null>
    /**
     * Files and/or folders for a source, each with its kind. 'any' mixes both in one picker
     * (macOS only; Windows and Linux pickers take files or folders, not both).
     */
    pickItems(mode: 'any' | 'files' | 'folders', startAt?: string): Promise<SourceItem[]>
    /** File or folder kinds for dropped paths. */
    statItems(paths: string[]): Promise<SourceItem[]>
  }
  destinations: {
    availability(): Promise<Record<string, boolean>>
    /** Whether the drive is there, and its free space (null when it is not). */
    info(id: string): Promise<{ available: boolean; freeBytes: number | null }>
  }
  shell: {
    /** Reveals a folder in Finder/Explorer; only paths inside a configured destination. */
    showInFolder(path: string): Promise<boolean>
  }
  files: {
    /** Absolute path of a file dropped onto the window. */
    pathOf(file: File): string
  }
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
    /** Checks one waiting backup × drive now instead of at its next check time. */
    checkNow(sourceId: string, destId: string): Promise<void>
    onStatus(cb: (s: SchedulerStatus) => void): () => void
  }
  history: {
    list(): Promise<RunSummary[]>
    get(id: string): Promise<RunLog | null>
    changes(runId: string, q: ChangeQuery): Promise<ChangePage>
    /** The newest result of each backup × drive pair. */
    latest(): Promise<PairResult[]>
  }
  app: {
    /** `process.platform` of the app: the top bar leaves room for the native window controls. */
    platform: string
    onNavigate(cb: (screen: Screen, arg?: string) => void): () => void
    /** The tray asks the window to show a backup. */
    onSelect(cb: (sel: { kind: 'backup'; id: string }) => void): () => void
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
  pickItems: 'dialog:pickItems',
  statItems: 'dialog:statItems',
  availability: 'destinations:availability',
  destinationInfo: 'destinations:info',
  showInFolder: 'shell:showInFolder',
  checkNow: 'scheduler:checkNow',
  historyLatest: 'history:latest',
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
  navigate: 'app:navigate',
  select: 'app:select'
} as const
