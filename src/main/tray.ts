import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { Config } from '@shared/schema'
import type { JobRequest, PairResult } from '@shared/types'
import type { Scheduler } from './scheduler/scheduler'
import { trayActions, trayAttention, trayStatusLine, type TrayAction } from './os-helpers'

export type TrayDeps = {
  scheduler: Scheduler
  getConfig(): Config
  currentJob(): JobRequest | null
  /** Newest result per backup × drive, kept current by the caller. */
  results(): PairResult[]
  /** Shows the window with this backup selected. */
  showBackup(id: string): void
  open(): void
  quit(): void
}

function iconPath(name: string): string {
  return join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), name)
}

export function createTray(deps: TrayDeps): { refresh(): void; destroy(): void } {
  const mac = process.platform === 'darwin'
  const image = nativeImage.createFromPath(iconPath(mac ? 'trayTemplate.png' : 'tray.png'))
  if (mac) image.setTemplateImage(true)
  const tray = new Tray(image)
  tray.setToolTip('Backup Manager')
  if (!mac) tray.on('click', deps.open)

  const items: Record<TrayAction, Electron.MenuItemConstructorOptions> = {
    'run-all': { label: 'Run all now', click: () => deps.scheduler.runNow() },
    cancel: { label: 'Cancel running backup', click: () => deps.scheduler.cancel() },
    'pause-hour': {
      label: 'Pause for 1 hour',
      click: () => void deps.scheduler.pause(new Date(Date.now() + 3_600_000))
    },
    'pause-forever': {
      label: 'Pause until resumed',
      click: () => void deps.scheduler.pause('forever')
    },
    resume: { label: 'Resume schedules', click: () => void deps.scheduler.resume() }
  }

  const refresh = (): void => {
    const status = deps.scheduler.status()
    const line = trayStatusLine(status, deps.getConfig(), new Date(), deps.currentJob())
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: line, enabled: false },
        { type: 'separator' },
        ...((): Electron.MenuItemConstructorOptions[] => {
          const a = trayAttention(deps.getConfig(), deps.results(), status)
          if (!a) return []
          const open = a.id
          return [
            { label: a.label, click: () => (open ? deps.showBackup(open) : deps.open()) },
            { type: 'separator' }
          ]
        })(),
        ...trayActions(status).map((a) => items[a]),
        { type: 'separator' },
        { label: 'Open Backup Manager', click: deps.open },
        { label: 'Quit', click: deps.quit }
      ])
    )
  }
  refresh()
  return { refresh, destroy: () => tray.destroy() }
}
