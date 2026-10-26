import { expect, test } from 'vitest'
import {
  snapshotKey,
  formatTimestamp,
  parseSnapshotName,
  uniqueTimestampName
} from '../../src/main/engine/naming'

test('formatTimestamp uses local time YYYY-MM-DD_HHmmss', () => {
  expect(formatTimestamp(new Date(2026, 9, 25, 16, 52, 0))).toBe('2026-10-25_165200')
  expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02_030405')
})

test('format/parse round-trip with suffix and zip', () => {
  const d = new Date(2026, 9, 25, 16, 52, 7)
  const ts = formatTimestamp(d)
  expect(parseSnapshotName(ts)).toEqual(d)
  expect(parseSnapshotName(ts + '-3')).toEqual(d)
  expect(parseSnapshotName(ts + '.zip')).toEqual(d)
  expect(parseSnapshotName(ts + '-3.zip')).toEqual(d)
})

test.each([
  '2026-10-25_165200.partial',
  '2026-10-25_165200.bm-partial',
  'current',
  '.trash',
  '2026-13-45_999999',
  'x.zip'
])('parseSnapshotName rejects %s', (name) => {
  expect(parseSnapshotName(name)).toBeNull()
})

test('uniqueTimestampName skips names taken as dir, zip or partial', () => {
  const T = '2026-10-25_165200'
  expect(uniqueTimestampName(T, new Set())).toBe(T)
  expect(uniqueTimestampName(T, new Set([`${T}.zip`]))).toBe(`${T}-2`)
  expect(uniqueTimestampName(T, new Set([T, `${T}-2.bm-partial`]))).toBe(`${T}-3`)
})

test('snapshotKey groups every file of a snapshot under one key', () => {
  const d = new Date(2026, 9, 25, 16, 52, 0)
  for (const name of [
    '2026-10-25_165200-2',
    '2026-10-25_165200-2.zip',
    '2026-10-25_165200-2.part3.zip',
    '2026-10-25_165200-2.part3.zip.007'
  ]) {
    expect(snapshotKey(name)).toEqual({ key: '2026-10-25_165200-2', date: d })
  }
  expect(snapshotKey('2026-10-25_165200.part1.zip')?.key).toBe('2026-10-25_165200')
  for (const bad of [
    '2026-10-25_165200.part.zip',
    '2026-10-25_165200.zip.001',
    '2026-10-25_165200.bm-partial',
    '2026-10-25_165200.part1.zip.1'
  ]) {
    expect(snapshotKey(bad)).toBeNull()
  }
})

test('uniqueTimestampName treats a split snapshot as taken', () => {
  const T = '2026-10-25_165200'
  expect(uniqueTimestampName(T, new Set([`${T}.part1.zip`, `${T}.part2.zip.001`]))).toBe(`${T}-2`)
})

test('snapshotKey accepts piece numbers of 1000 and more', () => {
  expect(snapshotKey('2026-10-25_165200.part1.zip.1000')?.key).toBe('2026-10-25_165200')
})
