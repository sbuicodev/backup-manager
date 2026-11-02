import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CH, type Api } from '@shared/ipc'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: Api = {
  config: {
    get: () => invoke(CH.configGet),
    save: (c) => invoke(CH.configSave, c),
    export: () => invoke(CH.configExport),
    import: () => invoke(CH.configImport),
    reset: () => invoke(CH.configReset),
    onChange: (cb) => subscribe(CH.configChanged, cb)
  },
  dialog: {
    pickFolder: (startAt) => invoke(CH.pickFolder, startAt),
    pickItems: (mode, startAt) => invoke(CH.pickItems, mode, startAt),
    statItems: (paths) => invoke(CH.statItems, paths)
  },
  destinations: {
    availability: () => invoke(CH.availability),
    info: (id) => invoke(CH.destinationInfo, id)
  },
  shell: { showInFolder: (path) => invoke(CH.showInFolder, path) },
  files: { pathOf: (file) => webUtils.getPathForFile(file) },
  run: {
    plan: (ids) => invoke(CH.runPlan, ids),
    start: (ids) => invoke(CH.runStart, ids),
    cancel: () => invoke(CH.runCancel),
    onProgress: (cb) => subscribe(CH.progress, cb)
  },
  scheduler: {
    status: () => invoke(CH.schedulerStatus),
    pause: (until) => invoke(CH.schedulerPause, until),
    resume: () => invoke(CH.schedulerResume),
    checkNow: (sourceId, destId) => invoke(CH.checkNow, sourceId, destId),
    onStatus: (cb) => subscribe(CH.status, cb)
  },
  history: {
    list: () => invoke(CH.historyList),
    get: (id) => invoke(CH.historyGet, id),
    changes: (runId, q) => invoke(CH.historyChanges, runId, q),
    latest: () => invoke(CH.historyLatest)
  },
  app: {
    platform: process.platform,
    onNavigate: (cb) => subscribe(CH.navigate, cb),
    onSelect: (cb) => subscribe(CH.select, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
