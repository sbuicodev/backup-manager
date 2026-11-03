import { t } from '@/i18n'
import type { JobResult } from '@shared/types'
import { failure } from './summary'

/** "Today", "Yesterday" or the date, like "Wednesday, 28 October" (in the app's language). */
export function dayLabel(at: Date, now: Date): string {
  if (at.toDateString() === now.toDateString()) return t('activity.today')
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (at.toDateString() === y.toDateString()) return t('activity.yesterday')
  return at.toLocaleDateString(t('activity.dateLocale'), {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  })
}

/** Runs grouped by the day they started, newest first. */
export function groupByDay<T extends { startedAt: string }>(
  runs: T[],
  now: Date
): Array<{ label: string; runs: T[] }> {
  const groups: Array<{ label: string; runs: T[] }> = []
  for (const r of [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
    const label = dayLabel(new Date(r.startedAt), now)
    const last = groups.at(-1)
    if (last?.label === label) last.runs.push(r)
    else groups.push({ label, runs: [r] })
  }
  return groups
}

/** What one job did, in a few words, for an Activity row. */
export function jobResultText(j: JobResult): string {
  if (j.status === 'failed') return t('activity.failed', { reason: failure(j) })
  if (j.status === 'cancelled') return t('activity.stopped')
  if (j.status === 'skipped') {
    if (j.reason === 'destination-missing') return t('activity.driveMissing')
    if (j.reason === 'source-missing') return t('activity.filesMissing')
    return t('activity.skipped')
  }
  const changes = j.changeCount
    ? t('activity.changes', { count: j.changeCount })
    : t('activity.noChanges')
  return j.warnings.length > 0
    ? `${changes} · ${t('activity.warnings', { count: j.warnings.length })}`
    : changes
}
