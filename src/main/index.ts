import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  shell
} from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { CH, type Screen } from '@shared/ipc'
import type { JobRequest, ProgressEvent } from '@shared/types'
import icon from '../../resources/icon.png?asset'
import { createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { notifyRunFinished, setLaunchAtLogin, startedHidden } from './os'
import { titleBarOptions, titleBarOverlay } from './os-helpers'
import { createServices, type Services } from './services'
import { createTray } from './tray'

let mainWindow: BrowserWindow | null = null
let quitting = false
let services: Services | null = null
let blockerId: number | null = null
let currentJob: JobRequest | null = null

function send(channel: string, ...payload: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...payload)
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else mainWindow.show()
  mainWindow?.focus()
  if (process.platform === 'darwin') void app.dock?.show()
}

function navigate(screen: Screen, arg?: string): void {
  showWindow()
  const go = (): void => send(CH.navigate, screen, arg)
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', go)
  else go()
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
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
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
      },
      onRunFinished: (log) =>
        notifyRunFinished(svc.config().settings.notifications, log, () =>
          navigate('history', log.id)
        )
    })
    services = svc

    registerIpc(
      createHandlers(svc, {
        pickFolder: async () => {
          const r = await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory']
          })
          return r.canceled ? null : (r.filePaths[0] ?? null)
        },
        saveFile: async (defaultName) => {
          const r = await dialog.showSaveDialog({
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
          return r.canceled ? null : (r.filePath ?? null)
        },
        openFile: async () => {
          const r = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
          return r.canceled ? null : (r.filePaths[0] ?? null)
        }
      })
    )

    let launchAtLogin = svc.config().settings.launchAtLogin
    void setLaunchAtLogin(launchAtLogin)
    svc.onConfigChange((c) => {
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
      open: showWindow,
      quit: () => app.quit()
    })

    await svc.start()

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
