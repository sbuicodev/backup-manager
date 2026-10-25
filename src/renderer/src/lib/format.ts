import type { Schedule, Weekday } from '@shared/schema'

const WEEK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)

export function describeSchedule(s: Schedule | null): string {
  if (!s) return 'Manual'
  if (s.kind === 'interval')
    return s.everyHours === 1 ? 'Every hour' : `Every ${s.everyHours} hours`
  if (s.kind === 'daily') return `Daily at ${s.time}`
  const days = WEEK.filter((d) => s.days.includes(d)).map(cap)
  return `${days.join(', ')} at ${s.time}`
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`
}

export function formatRelativeTime(at: Date, now: Date): string {
  const diff = at.getTime() - now.getTime()
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (diff >= 0 && diff < 60_000) return 'now'
  if (diff >= 0 && diff < 3_600_000) return `in ${Math.round(diff / 60_000)} min`
  if (at.toDateString() === now.toDateString()) return `today ${hm}`
  if (Math.abs(diff) < 6 * 86_400_000) return `${DAY_NAMES[at.getDay()]} ${hm}`
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hm}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1 s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${s % 60} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
