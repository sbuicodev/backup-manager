import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { Config } from '@shared/schema'
import type { JobRequest } from '@shared/types'
import type { Scheduler } from './scheduler/scheduler'
import { trayStatusLine } from './os-helpers'

export type TrayDeps = {
  scheduler: Scheduler
  getConfig(): Config
  currentJob(): JobRequest | null
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

  const refresh = (): void => {
    const status = deps.scheduler.status()
    const paused = status.pausedUntil !== null
    const line = trayStatusLine(status, deps.getConfig(), new Date(), deps.currentJob())
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: line, enabled: false },
        { type: 'separator' },
        { label: 'Run all now', click: () => deps.scheduler.runNow() },
        ...(paused
          ? [{ label: 'Resume schedules', click: () => void deps.scheduler.resume() }]
          : [
              {
                label: 'Pause for 1 hour',
                click: () => void deps.scheduler.pause(new Date(Date.now() + 3_600_000))
              },
              { label: 'Pause until resumed', click: () => void deps.scheduler.pause('forever') }
            ]),
        { type: 'separator' },
        { label: 'Open Backup Manager', click: deps.open },
        { label: 'Quit', click: deps.quit }
      ])
    )
  }
  refresh()
  return { refresh, destroy: () => tray.destroy() }
}
