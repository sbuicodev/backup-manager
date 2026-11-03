import { t } from '@/i18n'
import { itemName, storesFlat, type Destination, type Schedule, type Source } from '@shared/schema'
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

export type Pill = { text: string; tone: 'accent' | 'success' | 'warning' | 'neutral' | 'pro' }

export type SettingsTile = {
  /** The configuration section it opens (a BackupForm group id). */
  id: 'schedule' | 'versions' | 'zip' | 'general'
  label: string
  value: string
  /** Extra lines, each with an icon name the page maps to a picture. */
  details: Array<{
    icon: 'hand' | 'trash' | 'layers' | 'filter' | 'gauge' | 'folders' | 'files'
    text: string
  }>
  pills: Pill[]
}

/** A backup's settings as four tiles: a headline value, detail lines and pills. */
export function settingsTiles(source: Source): SettingsTile[] {
  const snapshot = source.mode === 'snapshot'
  const zip = source.packaging !== 'copy'
  const hasFolder = source.items.some((i) => i.kind === 'folder')
  const subfolders = new Set(source.items.flatMap((i) => (i.folder ? [i.folder] : []))).size
  const aliases = source.items.filter((i) => i.alias !== undefined).length
  const { deletion, trashRetentionDays: days } = source.mirror
  return [
    {
      id: 'schedule',
      label: t('tiles.schedule'),
      value: schedulePhrase(source.schedule),
      details: source.schedule ? [] : [{ icon: 'hand', text: t('tiles.manualHint') }],
      pills:
        source.schedule && source.retryWhenAvailable
          ? [{ text: t('tiles.retries'), tone: 'accent' }]
          : []
    },
    {
      id: 'versions',
      label: t('tiles.versions'),
      value: t(snapshot ? 'tiles.snapshot' : 'tiles.mirror'),
      details: snapshot
        ? [{ icon: 'layers', text: t('tiles.keepAtLeast', { count: source.snapshot.keepMin }) }]
        : [{ icon: 'trash', text: t(`tiles.deleted.${deletion}`) }],
      pills: snapshot
        ? source.snapshot.maxAgeDays === null
          ? []
          : [{ text: t('tiles.maxAge', { count: source.snapshot.maxAgeDays }), tone: 'warning' }]
        : deletion === 'trash'
          ? [
              {
                text:
                  days === null ? t('tiles.trashForever') : t('tiles.trashDays', { count: days }),
                tone: 'success'
              }
            ]
          : []
    },
    {
      id: 'zip',
      label: t('tiles.storage'),
      value: t(`packaging.${source.packaging}`),
      details: [
        ...(zip
          ? [{ icon: 'gauge' as const, text: t('tiles.compression', { level: source.zip.level }) }]
          : [{ icon: 'files' as const, text: t('tiles.asIs') }]),
        ...(hasFolder && source.excludes.length > 0
          ? [
              {
                icon: 'filter' as const,
                text: t('tiles.skips', { list: source.excludes.join(', ') })
              }
            ]
          : [])
      ],
      pills: [
        ...(zip && source.zip.partLimitBytes !== null
          ? [
              {
                text: t('tiles.splitAt', { size: sizeText(source.zip.partLimitBytes) }),
                tone: 'warning' as const
              }
            ]
          : []),
        ...(hasFolder && source.excludes.length > 0
          ? [
              {
                text: t('tiles.exclusions', { count: source.excludes.length }),
                tone: 'neutral' as const
              }
            ]
          : [])
      ]
    },
    {
      id: 'general',
      label: t('tiles.destination'),
      value: `${source.slug}/`,
      details: [
        {
          icon: 'folders',
          text: storesFlat(source)
            ? t('tiles.flat', { name: itemName(source.items[0]) })
            : t('tiles.byName')
        }
      ],
      pills: [
        ...(subfolders > 0
          ? [{ text: t('tiles.subfolders', { count: subfolders }), tone: 'pro' as const }]
          : []),
        ...(aliases > 0
          ? [{ text: t('tiles.aliases', { count: aliases }), tone: 'pro' as const }]
          : [])
      ]
    }
  ]
}
