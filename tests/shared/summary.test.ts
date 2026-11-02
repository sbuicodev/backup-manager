import { describe, expect, test } from 'vitest'
import { newDestination, newSource, type Source } from '@shared/schema'
import type { PairResult, SchedulerStatus } from '@shared/types'
import {
  backupSummary,
  backupTone,
  formatAgo,
  optionsSummary,
  pairStatus,
  shortPath
} from '../../src/renderer/src/lib/summary'

const now = new Date(2026, 10, 3, 15, 0)
const hoursAgo = (h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString()
const src = (extra: Partial<Source> = {}): Source => ({
  ...newSource('/Users/me/Documents', 'Documents', []),
  id: 's1',
  ...extra
})
const dest = { ...newDestination('/Volumes/USB', 'USB stick'), id: 'd1' }
const result = (extra: Partial<PairResult> = {}): PairResult => ({
  sourceId: 's1',
  destId: 'd1',
  runId: 'r1',
  endedAt: hoursAgo(2),
  status: 'completed',
  bytesWritten: 0,
  ...extra
})
const status = (extra: Partial<SchedulerStatus> = {}): SchedulerStatus => ({
  active: null,
  pending: [],
  pausedUntil: null,
  nextRuns: [],
  pendingRetries: [],
  ...extra
})

test('formatAgo', () => {
  expect(formatAgo(new Date(now.getTime() - 20_000), now)).toBe('just now')
  expect(formatAgo(new Date(now.getTime() - 60_000), now)).toBe('1 minute ago')
  expect(formatAgo(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 minutes ago')
  expect(formatAgo(new Date(hoursAgo(1)), now)).toBe('1 hour ago')
  expect(formatAgo(new Date(hoursAgo(2)), now)).toBe('2 hours ago')
  expect(formatAgo(new Date(2026, 10, 2, 22, 30), now)).toBe('yesterday')
  expect(formatAgo(new Date(2026, 10, 1, 9, 0), now)).toBe('Sun')
  expect(formatAgo(new Date(2026, 9, 1, 9, 0), now)).toBe('2026-10-01')
})

describe('backupSummary', () => {
  test('mirror, plain files, interval, backed up', () => {
    const s = src({ schedule: { kind: 'interval', everyHours: 4 } })
    expect(backupSummary(s, hoursAgo(2), now)).toBe(
      'Mirror · plain files · every 4 hours · last backed up 2 hours ago'
    )
  })
  test('versions, one zip, daily, never run', () => {
    const s = src({
      mode: 'snapshot',
      packaging: 'zip-whole',
      schedule: { kind: 'daily', time: '22:00' }
    })
    expect(backupSummary(s, null, now)).toBe(
      'Versions · one zip · every day at 22:00 · not backed up yet'
    )
  })
  test('manual only, a zip per item', () => {
    const s = src({ packaging: 'zip-children', schedule: null })
    expect(backupSummary(s, new Date(2026, 10, 2, 22, 30).toISOString(), now)).toBe(
      'Mirror · a zip per item · runs only when you click Back up now · last backed up yesterday'
    )
  })
  test('weekly', () => {
    const s = src({ schedule: { kind: 'weekly', days: ['thu', 'mon'], time: '09:00' } })
    expect(backupSummary(s, null, now)).toBe(
      'Mirror · plain files · every Mon, Thu at 09:00 · not backed up yet'
    )
  })
  test('not set up', () => {
    expect(backupSummary(src({ setupComplete: false }), null, now)).toBe('Not set up')
  })
})

describe('pairStatus', () => {
  test('backed up', () => {
    expect(pairStatus(src(), dest, result(), status(), true, now)).toEqual({
      tone: 'ok',
      text: '2 hours ago',
      canCheckNow: false
    })
  })
  test('waiting for a retry', () => {
    const st = status({
      pendingRetries: [
        { sourceId: 's1', destId: 'd1', nextRetryAt: new Date(2026, 10, 3, 15, 40).toISOString() }
      ]
    })
    expect(pairStatus(src(), dest, result({ status: 'skipped' }), st, false, now)).toEqual({
      tone: 'waiting',
      text: 'waiting · next check 15:40',
      canCheckNow: true
    })
  })
  test('failed, with a readable reason', () => {
    const r = result({
      status: 'failed',
      reason: 'error',
      error: 'ENOSPC: no space left on device'
    })
    expect(pairStatus(src(), dest, r, status(), true, now).text).toBe('failed · disk full')
    expect(pairStatus(src(), dest, r, status(), true, now).tone).toBe('failed')
    const lost = result({ status: 'failed', reason: 'destination-lost' })
    expect(pairStatus(src(), dest, lost, status(), true, now).text).toBe(
      'failed · drive disconnected'
    )
  })
  test('never run, not connected, turned off', () => {
    expect(pairStatus(src(), dest, null, status(), true, now)).toMatchObject({
      tone: 'idle',
      text: 'never'
    })
    expect(pairStatus(src(), dest, null, status(), false, now)).toMatchObject({
      tone: 'idle',
      text: 'not connected'
    })
    expect(
      pairStatus(src(), { ...dest, enabled: false }, result(), status(), true, now)
    ).toMatchObject({
      tone: 'off',
      text: 'turned off'
    })
  })
  test('finished with warnings', () => {
    expect(
      pairStatus(src(), dest, result({ status: 'completed-with-warnings' }), status(), true, now)
    ).toMatchObject({ tone: 'waiting', text: '2 hours ago · with warnings' })
  })
})

describe('backupTone', () => {
  const ok = result()
  const bad = result({ destId: 'd2', status: 'failed' })
  const dests = [dest, { ...newDestination('/Volumes/NAS', 'NAS'), id: 'd2' }]
  test('precedence: running > not set up > paused > failed > waiting > ok > idle', () => {
    expect(backupTone(src(), dests, [ok, bad], status(), true)).toBe('running')
    expect(backupTone(src({ setupComplete: false }), dests, [ok], status(), false)).toBe('notSetUp')
    expect(backupTone(src({ enabled: false }), dests, [bad], status(), false)).toBe('paused')
    expect(backupTone(src(), dests, [ok, bad], status(), false)).toBe('failed')
    const waiting = status({
      pendingRetries: [{ sourceId: 's1', destId: 'd1', nextRetryAt: null }]
    })
    expect(backupTone(src(), dests, [ok], waiting, false)).toBe('waiting')
    expect(backupTone(src(), dests, [ok], status(), false)).toBe('ok')
    expect(backupTone(src(), dests, [], status(), false)).toBe('idle')
  })
  test('results for a drive no longer used are ignored', () => {
    expect(backupTone(src(), [dest], [ok, bad], status(), false)).toBe('ok')
  })
})

test('shortPath shows home folders as ~', () => {
  expect(shortPath('/Users/me/Documents')).toBe('~/Documents')
  expect(shortPath('/home/me/notes.md')).toBe('~/notes.md')
  expect(shortPath('C:\\Users\\me\\Desktop\\tax.pdf')).toBe('~\\Desktop\\tax.pdf')
  expect(shortPath('/Volumes/NAS/backups')).toBe('/Volumes/NAS/backups')
})

describe('optionsSummary', () => {
  test('mirror with trash and exclusions', () => {
    const s = src({ excludes: ['*.tmp', 'node_modules/'] })
    s.mirror = { deletion: 'trash', trashRetentionDays: 30 }
    expect(optionsSummary(s)).toBe('Deleted files kept in the trash for 30 days · 2 exclusions')
  })
  test('versions, kept forever, zip split', () => {
    const s = src({ mode: 'snapshot', packaging: 'zip-whole' })
    s.zip = { ...s.zip, partLimitBytes: 4 * 1024 ** 3 }
    expect(optionsSummary(s)).toBe('Keeps at least 10 versions · zips split at 4 GB')
  })
  test('other deletion policies and retries off', () => {
    const exact = src({ retryWhenAvailable: false })
    exact.mirror = { deletion: 'exact', trashRetentionDays: null }
    expect(optionsSummary(exact)).toBe('Deleted files removed from the backup · no retries')
    const never = src()
    never.mirror = { deletion: 'never', trashRetentionDays: null }
    expect(optionsSummary(never)).toBe('Deleted files stay in the backup')
  })
})
