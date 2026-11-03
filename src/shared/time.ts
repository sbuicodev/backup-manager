const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

/** Past time in words: "just now", "5 minutes ago", "2 hours ago", "yesterday", "Sun", a date. */
export function formatAgo(at: Date, now: Date): string {
  const diff = now.getTime() - at.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${plural(Math.floor(diff / 60_000), 'minute')} ago`
  if (at.toDateString() === now.toDateString()) {
    return `${plural(Math.floor(diff / 3_600_000), 'hour')} ago`
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (at.toDateString() === yesterday.toDateString()) return 'yesterday'
  if (diff < 6 * 86_400_000) return DAY_NAMES[at.getDay()]
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}
