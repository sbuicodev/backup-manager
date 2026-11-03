import type { Destination, Schedule, Source } from '@shared/schema'
import type { PairResult, SchedulerStatus } from '@shared/types'
import { formatAgo } from '@shared/time'
import { checkClock, retryFor } from './retry'

export { formatAgo }

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

function schedulePhrase(s: Schedule | null): string {
  if (!s) return 'runs only when you click Back up now'
  if (s.kind === 'interval')
    return s.everyHours === 1 ? 'every hour' : `every ${s.everyHours} hours`
  if (s.kind === 'daily') return `every day at ${s.time}`
  const days = WEEK.filter((d) => s.days.includes(d)).map((d) => d[0].toUpperCase() + d.slice(1))
  return `every ${days.join(', ')} at ${s.time}`
}

const PACKAGING: Record<Source['packaging'], string> = {
  copy: 'plain files',
  'zip-whole': 'one zip',
  'zip-children': 'a zip per item'
}

/** The one-line description under a backup's name. `last`: when it last finished on any drive. */
export function backupSummary(source: Source, last: string | null, now: Date): string {
  if (!source.setupComplete) return 'Not set up'
  return [
    source.mode === 'mirror' ? 'Mirror' : 'Versions',
    PACKAGING[source.packaging],
    schedulePhrase(source.schedule),
    last ? `last backed up ${formatAgo(new Date(last), now)}` : 'not backed up yet'
  ].join(' · ')
}

export type Tone = 'ok' | 'waiting' | 'failed' | 'idle' | 'off'

/** A short, readable cause for a failed job. */
export function failure(r: { reason?: string; error?: string }): string {
  if (r.reason === 'destination-lost') return 'drive disconnected'
  if (/ENOSPC/.test(r.error ?? '')) return 'disk full'
  if (/EACCES|EPERM/.test(r.error ?? '')) return 'no permission'
  return 'error'
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
  if (!dest.enabled) return { tone: 'off', text: 'turned off', ...quiet }
  const retry = retryFor(status, source.id, dest.id)
  if (retry) {
    return {
      tone: 'waiting',
      text: `waiting · next check ${checkClock(retry.nextRetryAt, now)}`,
      canCheckNow: true
    }
  }
  if (result?.status === 'failed')
    return { tone: 'failed', text: `failed · ${failure(result)}`, ...quiet }
  if (result && (result.status === 'completed' || result.status === 'completed-with-warnings')) {
    const ago = formatAgo(new Date(result.endedAt), now)
    return result.status === 'completed'
      ? { tone: 'ok', text: ago, ...quiet }
      : { tone: 'waiting', text: `${ago} · with warnings`, ...quiet }
  }
  if (available === false) return { tone: 'idle', text: 'not connected', ...quiet }
  if (result?.status === 'cancelled') return { tone: 'idle', text: 'cancelled', ...quiet }
  return { tone: 'idle', text: 'never', ...quiet }
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

/** The settings not shown elsewhere on a backup's page, in one line. */
export function optionsSummary(source: Source): string {
  const parts: string[] = []
  if (source.mode === 'snapshot') {
    const { keepMin, maxAgeDays } = source.snapshot
    parts.push(
      `Keeps at least ${keepMin} versions` +
        (maxAgeDays !== null ? `, deletes those older than ${maxAgeDays} days` : '')
    )
  } else if (source.mirror.deletion === 'trash') {
    const days = source.mirror.trashRetentionDays
    parts.push(`Deleted files kept in the trash ${days === null ? 'forever' : `for ${days} days`}`)
  } else {
    parts.push(
      source.mirror.deletion === 'exact'
        ? 'Deleted files removed from the backup'
        : 'Deleted files stay in the backup'
    )
  }
  if (source.excludes.length > 0) {
    parts.push(
      source.excludes.length === 1 ? '1 exclusion' : `${source.excludes.length} exclusions`
    )
  }
  if (source.packaging !== 'copy' && source.zip.partLimitBytes !== null) {
    parts.push(`zips split at ${sizeText(source.zip.partLimitBytes)}`)
  }
  if (!source.retryWhenAvailable) parts.push('no retries')
  return parts.join(' · ')
}
