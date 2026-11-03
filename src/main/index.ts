import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  shell
} from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { CH, type Screen } from '@shared/ipc'
import type { JobRequest, PairResult, ProgressEvent } from '@shared/types'
import icon from '../../resources/icon.png?asset'
import { createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { notifyRunFinished, setLaunchAtLogin, startedHidden } from './os'
import { titleBarOptions, titleBarOverlay, windowMaterial } from './os-helpers'
import { createServices, type Services } from './services'
import { createTray } from './tray'

let mainWindow: BrowserWindow | null = null
let quitting = false
let services: Services | null = null
let blockerId: number | null = null
let currentJob: JobRequest | null = null
let latest: PairResult[] = []

function send(channel: string, ...payload: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...payload)
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else mainWindow.show()
  mainWindow?.focus()
  if (process.platform === 'darwin') void app.dock?.show()
}

/**
 * Window native dialogs attach to (a sheet on macOS). Without a parent the panel can open while
 * the app window keeps keyboard focus, so it shows the wrong cursor and ignores ⌘/⇧-clicks.
 */
function dialogParent(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  return mainWindow!
}

/** Shows the window with one backup selected (from the tray). */
function select(id: string): void {
  showWindow()
  const go = (): void => send(CH.select, { kind: 'backup', id })
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', go)
  else go()
}

/** macOS app menu: the usual items plus Settings… (⌘,). */
function appMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => navigate('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ])
}

function navigate(screen: Screen, arg?: string): void {
  showWindow()
  const go = (): void => send(CH.navigate, screen, arg)
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', go)
  else go()
}

/** Native material for the current glass setting (applied at creation and on change). */
function material(): ReturnType<typeof windowMaterial> {
  return windowMaterial(process.platform, services?.config().settings.glass ?? false)
}

/** Applies the glass setting to an open window. */
function applyMaterial(win: BrowserWindow): void {
  const m = material()
  if (m.vibrancy !== undefined) win.setVibrancy(m.vibrancy)
  if (m.backgroundMaterial !== undefined) win.setBackgroundMaterial(m.backgroundMaterial)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Backup Manager',
    // The app draws its own top bar; the OS keeps its native window controls in it.
    ...titleBarOptions(process.platform, nativeTheme.shouldUseDarkColors),
    // Glass: the page is see-through where the native material should show.
    ...(material().vibrancy ? { vibrancy: material().vibrancy! } : {}),
    ...(material().backgroundMaterial ? { backgroundMaterial: material().backgroundMaterial } : {}),
    ...(process.platform !== 'linux' ? { backgroundColor: '#00000000' } : {}),
    ...(process.platform === 'darwin' ? { visualEffectState: 'active' as const } : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // The page blocks unloading while a backup has unsaved edits (quitting); ask before losing them.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes',
      detail: 'Quitting now discards the changes you made to this backup.'
    })
    if (choice === 0) e.preventDefault()
    else quitting = false // staying: closing the window hides it again, as usual
  })
  mainWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    mainWindow?.hide()
    if (process.platform === 'darwin') app.dock?.hide()
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function onProgress(e: ProgressEvent): void {
  if (e.type === 'run-start' && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (e.type === 'run-end' && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
  if (e.type === 'job-start') currentJob = { sourceId: e.sourceId, destId: e.destId }
  if (e.type === 'run-end') currentJob = null
}

// Lets a dev/test run use a throwaway profile instead of the real one.
if (process.env.BM_USER_DATA) app.setPath('userData', process.env.BM_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.stefano.backupmanager')
    // Packaged builds take the icon from build/; in development the Dock would show Electron's.
    if (is.dev && process.platform === 'darwin') app.dock?.setIcon(icon)
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    let tray: ReturnType<typeof createTray> | null = null
    const svc = await createServices({
      userDataDir: app.getPath('userData'),
      platform: {
        now: () => new Date(),
        setInterval: (fn, ms) => {
          const h = setInterval(fn, ms)
          return () => clearInterval(h)
        },
        isOnBattery: () => powerMonitor.isOnBatteryPower()
      },
      broadcast: (channel, payload) => {
        if (channel === CH.progress) onProgress(payload as ProgressEvent)
        send(channel, payload)
        if (channel === CH.status || channel === CH.progress) tray?.refresh()
        if (channel === CH.progress && (payload as ProgressEvent).type === 'run-end') {
          void svc.latestResults().then((r) => {
            latest = r
            tray?.refresh()
          })
        }
      },
      onRunFinished: (log) =>
        notifyRunFinished(svc.config().settings.notifications, log, () =>
          navigate('history', log.id)
        )
    })
    services = svc

    registerIpc(
      createHandlers(svc, {
        reveal: async (path) => {
          // openPath shows the folder itself; showItemInFolder would show its parent.
          await shell.openPath(path)
        },
        pickItems: async (mode, startAt) => {
          const kinds: Array<'openFile' | 'openDirectory'> =
            mode === 'files'
              ? ['openFile']
              : mode === 'folders'
                ? ['openDirectory']
                : ['openFile', 'openDirectory']
          const r = await dialog.showOpenDialog(dialogParent(), {
            ...(startAt ? { defaultPath: startAt } : {}),
            properties: [...kinds, 'multiSelections']
          })
          if (r.canceled) return []
          // The picker does not say which picks are folders; ask the file system.
          return Promise.all(
            r.filePaths.map(async (path) => ({
              path,
              kind: (await stat(path)).isDirectory() ? ('folder' as const) : ('file' as const)
            }))
          )
        },
        pickFolder: async (startAt) => {
          const r = await dialog.showOpenDialog(dialogParent(), {
            ...(startAt ? { defaultPath: startAt } : {}),
            properties: ['openDirectory', 'createDirectory']
          })
          return r.canceled ? null : (r.filePaths[0] ?? null)
        },
        saveFile: async (defaultName) => {
          const r = await dialog.showSaveDialog(dialogParent(), {
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
          return r.canceled ? null : (r.filePath ?? null)
        },
        openFile: async () => {
          const r = await dialog.showOpenDialog(dialogParent(), {
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
          return r.canceled ? null : (r.filePaths[0] ?? null)
        }
      })
    )

    let launchAtLogin = svc.config().settings.launchAtLogin
    void setLaunchAtLogin(launchAtLogin)
    let glass = svc.config().settings.glass
    svc.onConfigChange((c) => {
      if (c.settings.glass !== glass) {
        glass = c.settings.glass
        if (mainWindow && !mainWindow.isDestroyed()) applyMaterial(mainWindow)
      }
      if (c.settings.launchAtLogin !== launchAtLogin) {
        launchAtLogin = c.settings.launchAtLogin
        void setLaunchAtLogin(launchAtLogin)
      }
      tray?.refresh()
    })

    // Windows/Linux draw their window controls in our colours: keep them in step with the theme.
    nativeTheme.on('updated', () => {
      if (process.platform === 'darwin' || !mainWindow || mainWindow.isDestroyed()) return
      mainWindow.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors))
    })

    powerMonitor.on('resume', () => void svc.scheduler.onResume())
    powerMonitor.on('on-ac', () => void svc.scheduler.onPowerChange())

    tray = createTray({
      scheduler: svc.scheduler,
      getConfig: () => svc.config(),
      currentJob: () => currentJob,
      results: () => latest,
      showBackup: (id) => select(id),
      open: showWindow,
      quit: () => app.quit()
    })

    await svc.start()
    latest = await svc.latestResults()
    tray.refresh()
    if (process.platform === 'darwin') Menu.setApplicationMenu(appMenu())

    if (startedHidden()) {
      if (process.platform === 'darwin') app.dock?.hide()
    } else {
      createWindow()
    }

    app.on('activate', showWindow)
  })

  app.on('before-quit', () => {
    quitting = true
    services?.stop()
  })

  // Stay alive in the tray when the window is closed.
  app.on('window-all-closed', () => {})
}
