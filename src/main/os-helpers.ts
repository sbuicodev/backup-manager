import type { Config, Settings } from '@shared/schema'
import type { JobRequest, RunStatus, SchedulerStatus } from '@shared/types'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')

/** "HH:MM" when `d` is today, otherwise "Ddd HH:MM". */
export function shortTime(d: Date, now: Date): string {
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`
}

export function trayStatusLine(
  status: SchedulerStatus,
  config: Config,
  now: Date,
  currentJob: JobRequest | null = null
): string {
  if (status.active) {
    if (!currentJob) return 'Running…'
    const s = config.sources.find((x) => x.id === currentJob.sourceId)?.name ?? '?'
    const d = config.destinations.find((x) => x.id === currentJob.destId)?.name ?? '?'
    return `Running: ${s} → ${d}`
  }
  if (status.pausedUntil === 'forever') return 'Paused'
  if (status.pausedUntil) return `Paused until ${shortTime(new Date(status.pausedUntil), now)}`
  const next = status.nextRuns
    .filter((n): n is { sourceId: string; at: string } => n.at !== null)
    .sort((a, b) => (a.at < b.at ? -1 : 1))[0]
  const n = status.pendingRetries.length
  const retries = n === 0 ? '' : ` · ${n} ${n === 1 ? 'retry' : 'retries'} pending`
  if (!next) return `Idle · no schedules${retries}`
  const name = config.sources.find((s) => s.id === next.sourceId)?.name ?? '?'
  return `Idle · next: ${name} at ${shortTime(new Date(next.at), now)}${retries}`
}

export type TrayAction = 'run-all' | 'cancel' | 'pause-hour' | 'pause-forever' | 'resume'

/** Tray menu actions for the current state, between the status line and Open/Quit. */
export function trayActions(status: SchedulerStatus): TrayAction[] {
  return [
    'run-all',
    ...(status.active ? (['cancel'] as const) : []),
    ...(status.pausedUntil !== null
      ? (['resume'] as const)
      : (['pause-hour', 'pause-forever'] as const))
  ]
}

export function shouldNotify(setting: Settings['notifications'], status: RunStatus): boolean {
  if (setting === 'always') return true
  if (setting === 'never') return false
  return status === 'failed' || status === 'completed-with-warnings'
}

export function linuxAutostartEntry(execPath: string): string {
  return (
    '[Desktop Entry]\nType=Application\nName=Backup Manager\n' +
    `Exec="${execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`
  )
}

/** Height of the app's own top bar, which replaces the OS title bar (px). */
export const TOP_BAR_HEIGHT = 44

type Overlay = { color: string; symbolColor: string; height: number }

/** Colours of the native window controls drawn over the top bar (Windows/Linux), per theme. */
export function titleBarOverlay(dark: boolean): Overlay {
  // The top bar uses the sidebar colour; symbols use the foreground colour (main.css).
  return dark
    ? { color: '#171717', symbolColor: '#fafafa', height: TOP_BAR_HEIGHT }
    : { color: '#fafafa', symbolColor: '#0a0a0a', height: TOP_BAR_HEIGHT }
}

/** BrowserWindow options that hide the OS title bar but keep the native window controls. */
export function titleBarOptions(
  platform: NodeJS.Platform,
  dark: boolean
): {
  titleBarStyle: 'hidden' | 'hiddenInset'
  trafficLightPosition?: { x: number; y: number }
  titleBarOverlay?: Overlay
} {
  if (platform === 'darwin') {
    // Traffic lights are 12 px tall: centre them vertically in the top bar.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(dark) }
}

/**
 * Native window material behind the glass look: macOS vibrancy, Windows 11 acrylic. Linux has
 * none, so there the glass is drawn by the page alone.
 */
export function windowMaterial(
  platform: NodeJS.Platform,
  glass: boolean
): { vibrancy?: 'under-window' | null; backgroundMaterial?: 'acrylic' | 'none' } {
  if (platform === 'darwin') return { vibrancy: glass ? 'under-window' : null }
  if (platform === 'win32') return { backgroundMaterial: glass ? 'acrylic' : 'none' }
  return {}
}
