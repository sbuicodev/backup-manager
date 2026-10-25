import type { Schedule, Weekday } from '@shared/schema'

const HOUR = 3_600_000
const LATE_MS = 120_000
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

type SlotSchedule = Exclude<Schedule, { kind: 'interval' }>

/** Local-time slot on the day `offset` days from `ref`'s date. DST is resolved by Date. */
function slotOn(s: SlotSchedule, ref: Date, offset: number): Date {
  const [hh, mm] = s.time.split(':').map(Number)
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + offset, hh, mm)
}

function dayMatches(s: SlotSchedule, d: Date): boolean {
  return s.kind === 'daily' || s.days.includes(WEEKDAYS[d.getDay()])
}

/** Most recent slot at or before `now`. */
export function latestSlot(s: SlotSchedule, now: Date): Date {
  for (let k = 0; k <= 7; k++) {
    const c = slotOn(s, now, -k)
    if (c.getTime() <= now.getTime() && dayMatches(s, c)) return c
  }
  throw new Error('no slot within a week') // unreachable: weekly days are non-empty
}

/** A lastScheduledAt in the future (clock moved back) counts as now; callers persist the result. */
export function clampLast(last: Date, now: Date): Date {
  return last.getTime() > now.getTime() ? now : last
}

export function isDue(
  s: Schedule,
  lastScheduledAt: Date,
  now: Date
): { due: boolean; slot: Date; late: boolean } {
  const last = clampLast(lastScheduledAt, now)
  if (s.kind === 'interval') {
    const dueAt = last.getTime() + s.everyHours * HOUR
    return { due: now.getTime() >= dueAt, slot: now, late: now.getTime() - dueAt > LATE_MS }
  }
  const slot = latestSlot(s, now)
  return {
    due: slot.getTime() > last.getTime(),
    slot,
    late: now.getTime() - slot.getTime() > LATE_MS
  }
}

export function nextRunAt(s: Schedule, lastScheduledAt: Date, now: Date): Date {
  if (isDue(s, lastScheduledAt, now).due) return now
  const last = clampLast(lastScheduledAt, now)
  if (s.kind === 'interval') return new Date(last.getTime() + s.everyHours * HOUR)
  const ref = Math.max(last.getTime(), now.getTime())
  for (let k = 0; k <= 8; k++) {
    const c = slotOn(s, now, k)
    if (c.getTime() > ref && dayMatches(s, c)) return c
  }
  throw new Error('no slot within a week')
}
