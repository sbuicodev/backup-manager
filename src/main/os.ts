import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, Notification } from 'electron'
import type { Settings } from '@shared/schema'
import type { RunLog } from '@shared/types'
import { linuxAutostartEntry, shouldNotify } from './os-helpers'

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  // Never register a dev binary or a throwaway test profile as a login item.
  if (!app.isPackaged || process.env.BM_USER_DATA) return
  if (process.platform === 'linux') {
    const dir = join(homedir(), '.config', 'autostart')
    const file = join(dir, 'backup-manager.desktop')
    if (enabled) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, linuxAutostartEntry(process.env.APPIMAGE ?? process.execPath))
    } else {
      await rm(file, { force: true })
    }
    return
  }
  // `args` is honoured on Windows; on macOS a login launch is detected via wasOpenedAtLogin.
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}

export function startedHidden(): boolean {
  return (
    process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
  )
}

const TITLES: Record<RunLog['status'], string> = {
  completed: 'Backup completed',
  'completed-with-warnings': 'Backup finished with warnings',
  failed: 'Backup failed',
  cancelled: 'Backup cancelled'
}

export function notifyRunFinished(
  setting: Settings['notifications'],
  log: RunLog,
  onClick: () => void
): void {
  if (!shouldNotify(setting, log.status) || !Notification.isSupported()) return
  const warnings = log.jobs.reduce((n, j) => n + j.warnings.length, 0)
  const failed = log.jobs.filter((j) => j.status === 'failed').length
  const parts = [`${log.jobs.length} job${log.jobs.length === 1 ? '' : 's'}`]
  if (failed) parts.push(`${failed} failed`)
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  const n = new Notification({ title: TITLES[log.status], body: parts.join(' · ') })
  n.on('click', onClick)
  n.show()
}
