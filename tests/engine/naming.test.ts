import { expect, test } from 'vitest'
import {
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
  expect(uniqueTimestampName('T', new Set())).toBe('T')
  expect(uniqueTimestampName('T', new Set(['T.zip']))).toBe('T-2')
  expect(uniqueTimestampName('T', new Set(['T', 'T-2.bm-partial']))).toBe('T-3')
})
