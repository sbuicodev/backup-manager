import { expect, test } from 'vitest'
import type { Schedule } from '@shared/schema'
import { clampLast, isDue, latestSlot, nextRunAt } from '../../src/main/scheduler/schedule'

const H = 3_600_000
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s)

test('runs in Europe/Rome', () => {
  expect(process.env.TZ).toBe('Europe/Rome')
})

test('interval due after N hours, not before', () => {
  const last = at(2026, 10, 20, 8)
  const s = { kind: 'interval', everyHours: 4 } as const
  expect(isDue(s, last, new Date(last.getTime() + 4 * H - 1000)).due).toBe(false)
  const r = isDue(s, last, new Date(last.getTime() + 4 * H))
  expect(r.due).toBe(true)
  expect(r.slot).toEqual(new Date(last.getTime() + 4 * H))
})

test('daily: before today’s time → yesterday’s slot; after → today’s', () => {
  const s = { kind: 'daily', time: '14:30' } as const
  expect(latestSlot(s, at(2026, 10, 20, 9))).toEqual(at(2026, 10, 19, 14, 30))
  expect(latestSlot(s, at(2026, 10, 20, 15))).toEqual(at(2026, 10, 20, 14, 30))
  expect(latestSlot(s, at(2026, 10, 20, 14, 30))).toEqual(at(2026, 10, 20, 14, 30))
})

test('weekly on mon,thu at 09:00 from a Sunday → previous Thursday', () => {
  const s: Schedule = { kind: 'weekly', days: ['mon', 'thu'], time: '09:00' }
  // 2026-10-25 is a Sunday
  expect(latestSlot(s, at(2026, 10, 25, 12))).toEqual(at(2026, 10, 22, 9))
  expect(latestSlot(s, at(2026, 10, 26, 8))).toEqual(at(2026, 10, 22, 9))
  expect(latestSlot(s, at(2026, 10, 26, 9, 1))).toEqual(at(2026, 10, 26, 9))
})

test('missed several daily slots → due once; after setting last=slot, not due', () => {
  const s = { kind: 'daily', time: '02:00' } as const
  const now = at(2026, 10, 20, 10)
  const r = isDue(s, at(2026, 10, 15, 2), now)
  expect(r.due).toBe(true)
  expect(r.slot).toEqual(at(2026, 10, 20, 2))
  expect(isDue(s, r.slot, now).due).toBe(false)
})

test('late flag: slot 3 minutes ago → late; 30 s ago → not late', () => {
  const s = { kind: 'daily', time: '02:00' } as const
  expect(isDue(s, at(2026, 10, 19, 2), at(2026, 10, 20, 2, 3)).late).toBe(true)
  expect(isDue(s, at(2026, 10, 19, 2), at(2026, 10, 20, 2, 0, 30)).late).toBe(false)
  const iv = { kind: 'interval', everyHours: 1 } as const
  expect(isDue(iv, at(2026, 10, 20, 1), at(2026, 10, 20, 2, 5)).late).toBe(true)
  expect(isDue(iv, at(2026, 10, 20, 1), at(2026, 10, 20, 2, 0, 30)).late).toBe(false)
})

test('spring forward 2026-03-29 daily 02:30 → slot at 03:30 local that day', () => {
  const slot = latestSlot({ kind: 'daily', time: '02:30' }, at(2026, 3, 29, 12))
  expect(slot.getDate()).toBe(29)
  expect(slot.getHours()).toBe(3)
  expect(slot.getMinutes()).toBe(30)
})

test('fall back 2026-10-25 daily 02:30 → after the first 02:30 run, not due at the second', () => {
  const s = { kind: 'daily', time: '02:30' } as const
  const first = at(2026, 10, 25, 2, 30)
  expect(isDue(s, at(2026, 10, 24, 2, 30), first)).toMatchObject({ due: true, slot: first })
  const second = new Date(first.getTime() + H) // wall clock reads 02:30 again
  expect(second.getHours()).toBe(2)
  expect(isDue(s, first, second).due).toBe(false)
})

test('clock moved backwards: lastScheduledAt in the future is clamped to now', () => {
  const s = { kind: 'daily', time: '02:00' } as const
  const now = at(2026, 10, 20, 10)
  const future = at(2026, 10, 25, 2)
  expect(isDue(s, future, now).due).toBe(false)
  const last = clampLast(future, now)
  expect(last).toEqual(now)
  expect(isDue(s, last, at(2026, 10, 21, 2, 0, 5)).due).toBe(true)
  const iv = { kind: 'interval', everyHours: 4 } as const
  expect(isDue(iv, last, new Date(now.getTime() + 4 * H)).due).toBe(true)
  expect(clampLast(at(2026, 10, 19), now)).toEqual(at(2026, 10, 19))
})

test('nextRunAt for each kind', () => {
  const now = at(2026, 10, 20, 10)
  expect(nextRunAt({ kind: 'interval', everyHours: 4 }, at(2026, 10, 20, 8), now)).toEqual(
    at(2026, 10, 20, 12)
  )
  expect(nextRunAt({ kind: 'daily', time: '02:00' }, at(2026, 10, 20, 2), now)).toEqual(
    at(2026, 10, 21, 2)
  )
  expect(nextRunAt({ kind: 'daily', time: '02:00' }, at(2026, 10, 18, 2), now)).toEqual(now)
  expect(
    nextRunAt({ kind: 'weekly', days: ['mon', 'thu'], time: '09:00' }, at(2026, 10, 19, 9), now)
  ).toEqual(at(2026, 10, 22, 9))
})
