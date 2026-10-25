import { expect, test } from 'vitest'
import {
  describeSchedule,
  formatBytes,
  formatDuration,
  formatRelativeTime
} from '../../src/renderer/src/lib/format'

test('describeSchedule', () => {
  expect(describeSchedule(null)).toBe('Manual')
  expect(describeSchedule({ kind: 'interval', everyHours: 1 })).toBe('Every hour')
  expect(describeSchedule({ kind: 'interval', everyHours: 4 })).toBe('Every 4 hours')
  expect(describeSchedule({ kind: 'daily', time: '02:00' })).toBe('Daily at 02:00')
  expect(describeSchedule({ kind: 'weekly', days: ['thu', 'mon'], time: '09:00' })).toBe(
    'Mon, Thu at 09:00'
  )
})

test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(1023)).toBe('1023 B')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB')
})

test('formatRelativeTime', () => {
  const now = new Date(2026, 9, 26, 10, 0) // Monday
  expect(formatRelativeTime(new Date(2026, 9, 26, 10, 0, 20), now)).toBe('now')
  expect(formatRelativeTime(new Date(2026, 9, 26, 10, 5), now)).toBe('in 5 min')
  expect(formatRelativeTime(new Date(2026, 9, 26, 14, 0), now)).toBe('today 14:00')
  expect(formatRelativeTime(new Date(2026, 9, 26, 8, 0), now)).toBe('today 08:00')
  expect(formatRelativeTime(new Date(2026, 9, 27, 2, 0), now)).toBe('Tue 02:00')
  expect(formatRelativeTime(new Date(2026, 9, 22, 2, 0), now)).toBe('Thu 02:00')
  expect(formatRelativeTime(new Date(2026, 8, 1, 2, 0), now)).toBe('2026-09-01 02:00')
})

test('formatDuration', () => {
  expect(formatDuration(900)).toBe('<1 s')
  expect(formatDuration(42_000)).toBe('42 s')
  expect(formatDuration(125_000)).toBe('2 min 5 s')
  expect(formatDuration(3_725_000)).toBe('1 h 2 min')
})
