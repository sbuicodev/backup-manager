import { t } from '@/i18n'
import type { Config } from '@shared/schema'
import type { SchedulerStatus } from '@shared/types'

export function retryFor(
  status: SchedulerStatus | null,
  sourceId: string,
  destId: string
): { nextRetryAt: string | null } | null {
  const r = status?.pendingRetries.find((p) => p.sourceId === sourceId && p.destId === destId)
  return r ? { nextRetryAt: r.nextRetryAt } : null
}

export function nextCheckIn(nextRetryAt: string | null, now: Date): string {
  const ms = nextRetryAt === null ? 0 : new Date(nextRetryAt).getTime() - now.getTime()
  return ms <= 0
    ? t('retry.checkNow')
    : t('retry.checkIn', { count: Math.max(1, Math.round(ms / 60_000)) })
}

export function waitingText(destName: string, nextRetryAt: string | null, now: Date): string {
  return t('retry.waitingFor', { name: destName, check: nextCheckIn(nextRetryAt, now) })
}

const time = (iso: string | null, now: Date): number =>
  iso === null ? now.getTime() : new Date(iso).getTime()

/** Header strip text for the earliest pending retry, if it comes before the next scheduled run. */
export function headerRetryText(
  status: SchedulerStatus | null,
  config: Config,
  now: Date
): string | null {
  if (!status || status.pendingRetries.length === 0) return null
  const [first, ...rest] = [...status.pendingRetries].sort(
    (a, b) => time(a.nextRetryAt, now) - time(b.nextRetryAt, now)
  )
  const nextRun = status.nextRuns
    .flatMap((n) => (n.at ? [new Date(n.at).getTime()] : []))
    .sort((a, b) => a - b)[0]
  if (nextRun !== undefined && nextRun <= time(first.nextRetryAt, now)) return null
  const name =
    config.destinations.find((d) => d.id === first.destId)?.name ?? t('retry.destination')
  const text = waitingText(name, first.nextRetryAt, now)
  return rest.length > 0 ? t('retry.more', { text, count: rest.length }) : text
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "HH:MM" of a retry check, or "now" when it is already due. */
export function checkClock(nextRetryAt: string | null, now: Date): string {
  if (nextRetryAt === null || new Date(nextRetryAt).getTime() <= now.getTime()) return t('pair.now')
  const d = new Date(nextRetryAt)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
