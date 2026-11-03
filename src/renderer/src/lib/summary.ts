import { t } from '@/i18n'
import { storesFlat, type Destination, type Schedule, type Source } from '@shared/schema'
import type { PairResult, SchedulerStatus } from '@shared/types'
import { formatAgo } from '@shared/time'
import { checkClock, retryFor } from './retry'

export { formatAgo }

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** "Every day at 22:00", "Manually", … */
export function schedulePhrase(s: Schedule | null): string {
  if (!s) return t('schedule.manual')
  if (s.kind === 'interval')
    return s.everyHours === 1
      ? t('schedule.everyHour')
      : t('schedule.everyHours', { count: s.everyHours })
  if (s.kind === 'daily') return t('schedule.daily', { time: s.time })
  const days = WEEK.filter((d) => s.days.includes(d)).map((d) => t(`days.${d}`))
  return t('schedule.weekly', { days: days.join(', '), time: s.time })
}

export type Tone = 'ok' | 'waiting' | 'failed' | 'idle' | 'off'

/** A short, readable cause for a failed job. */
export function failure(r: { reason?: string; error?: string }): string {
  if (r.reason === 'destination-lost') return t('failure.lost')
  if (/ENOSPC/.test(r.error ?? '')) return t('failure.full')
  if (/EACCES|EPERM/.test(r.error ?? '')) return t('failure.permission')
  return t('failure.error')
}

/** The status of one backup on one drive, as shown in its Where row. */
export function pairStatus(
  source: Source,
  dest: Destination,
  result: PairResult | null,
  status: SchedulerStatus | null,
  available: boolean | undefined,
  now: Date
): { tone: Tone; text: string; canCheckNow: boolean } {
  const quiet = { canCheckNow: false }
  if (!dest.enabled) return { tone: 'off', text: t('pair.off'), ...quiet }
  const retry = retryFor(status, source.id, dest.id)
  if (retry) {
    return {
      tone: 'waiting',
      text: t('pair.waiting', { time: checkClock(retry.nextRetryAt, now) }),
      canCheckNow: true
    }
  }
  if (result?.status === 'failed')
    return { tone: 'failed', text: t('pair.failed', { reason: failure(result) }), ...quiet }
  if (result && (result.status === 'completed' || result.status === 'completed-with-warnings')) {
    const ago = formatAgo(new Date(result.endedAt), now)
    return result.status === 'completed'
      ? { tone: 'ok', text: ago, ...quiet }
      : { tone: 'waiting', text: t('pair.warnings', { ago }), ...quiet }
  }
  if (available === false) return { tone: 'idle', text: t('pair.notConnected'), ...quiet }
  if (result?.status === 'cancelled') return { tone: 'idle', text: t('pair.cancelled'), ...quiet }
  return { tone: 'idle', text: t('pair.never'), ...quiet }
}

export type BackupTone = 'ok' | 'waiting' | 'failed' | 'notSetUp' | 'paused' | 'running' | 'idle'

/** The status dot of a backup in the sidebar, from its current drives only. */
export function backupTone(
  source: Source,
  dests: Destination[],
  results: PairResult[],
  status: SchedulerStatus | null,
  running: boolean
): BackupTone {
  if (running) return 'running'
  if (!source.setupComplete) return 'notSetUp'
  if (!source.enabled) return 'paused'
  const ids = new Set(dests.map((d) => d.id))
  const mine = results.filter((r) => r.sourceId === source.id && ids.has(r.destId))
  if (mine.some((r) => r.status === 'failed')) return 'failed'
  const waiting =
    dests.some((d) => retryFor(status, source.id, d.id)) ||
    mine.some((r) => r.status === 'completed-with-warnings')
  if (waiting) return 'waiting'
  if (mine.some((r) => r.status === 'completed')) return 'ok'
  return 'idle'
}

/** A path with the user's home folder shown as `~` (macOS, Linux and Windows layouts). */
export function shortPath(p: string): string {
  return p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, '~')
}

const GB = 1024 ** 3
const sizeText = (n: number): string =>
  n >= GB ? `${+(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`

export type SettingsLine = {
  /** The configuration section it opens (a BackupForm group id). */
  id: 'schedule' | 'versions' | 'zip' | 'general'
  text: string
}

/** A backup's settings in four short lines, for its page. */
export function settingsLines(source: Source): SettingsLine[] {
  const versions =
    source.mode === 'snapshot'
      ? [
          t('summary.snapshot'),
          t('page.keepVersions', { count: source.snapshot.keepMin }) +
            (source.snapshot.maxAgeDays === null
              ? ''
              : ` ${t('page.versionsFor', { count: source.snapshot.maxAgeDays })}`)
        ]
      : [
          t('summary.mirror'),
          source.mirror.deletion === 'trash'
            ? source.mirror.trashRetentionDays === null
              ? t('page.trashForever')
              : t('page.trashFor', { count: source.mirror.trashRetentionDays })
            : t(source.mirror.deletion === 'exact' ? 'page.removeDeleted' : 'page.keepDeleted')
        ]
  const zip = source.packaging !== 'copy'
  const storage = [
    t(`packaging.${source.packaging}`),
    ...(zip ? [t('page.compressed', { level: source.zip.level })] : []),
    ...(zip && source.zip.partLimitBytes !== null
      ? [t('page.splitAt', { size: sizeText(source.zip.partLimitBytes) })]
      : []),
    ...(source.excludes.length > 0 && source.items.some((i) => i.kind === 'folder')
      ? [t('page.skips', { count: source.excludes.length })]
      : [])
  ]
  const folder = t(storesFlat(source) ? 'page.flat' : 'page.byName', { folder: source.slug })
  return [
    { id: 'schedule', text: schedulePhrase(source.schedule) },
    { id: 'versions', text: versions.join(' · ') },
    { id: 'zip', text: storage.join(' · ') },
    { id: 'general', text: t('page.folderLine', { text: folder }) }
  ]
}
