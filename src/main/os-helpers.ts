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
  if (!next) return 'Idle · no schedules'
  const name = config.sources.find((s) => s.id === next.sourceId)?.name ?? '?'
  return `Idle · next: ${name} at ${shortTime(new Date(next.at), now)}`
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
