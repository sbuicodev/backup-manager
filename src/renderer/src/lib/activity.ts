import type { JobResult } from '@shared/types'
import { failure } from './summary'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/** "Today", "Yesterday" or "Wednesday, 28 October". */
export function dayLabel(at: Date, now: Date): string {
  if (at.toDateString() === now.toDateString()) return 'Today'
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (at.toDateString() === y.toDateString()) return 'Yesterday'
  return `${WEEKDAYS[at.getDay()]}, ${at.getDate()} ${MONTHS[at.getMonth()]}`
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

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** What one job did, in a few words, for an Activity row. */
export function jobResultText(j: JobResult): string {
  if (j.status === 'failed') return `failed · ${failure(j)}`
  if (j.status === 'cancelled') return 'stopped'
  if (j.status === 'skipped') {
    if (j.reason === 'destination-missing') return 'drive not connected'
    if (j.reason === 'source-missing') return 'files not found'
    return 'skipped'
  }
  const changes = j.changeCount ? plural(j.changeCount, 'change') : 'no changes'
  return j.warnings.length > 0 ? `${changes} · ${plural(j.warnings.length, 'warning')}` : changes
}
