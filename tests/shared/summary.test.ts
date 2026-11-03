import { describe, expect, test } from 'vitest'
import { newDestination, newSource, type Source } from '@shared/schema'
import type { PairResult, SchedulerStatus } from '@shared/types'
import {
  backupTone,
  formatAgo,
  settingsTiles,
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
      text: 'Waiting · next check 15:40',
      canCheckNow: true
    })
  })
  test('failed, with a readable reason', () => {
    const r = result({
      status: 'failed',
      reason: 'error',
      error: 'ENOSPC: no space left on device'
    })
    expect(pairStatus(src(), dest, r, status(), true, now).text).toBe('Failed · disk full')
    expect(pairStatus(src(), dest, r, status(), true, now).tone).toBe('failed')
    const lost = result({ status: 'failed', reason: 'destination-lost' })
    expect(pairStatus(src(), dest, lost, status(), true, now).text).toBe(
      'Failed · drive disconnected'
    )
  })
  test('never run, not connected, turned off', () => {
    expect(pairStatus(src(), dest, null, status(), true, now)).toMatchObject({
      tone: 'idle',
      text: 'Never'
    })
    expect(pairStatus(src(), dest, null, status(), false, now)).toMatchObject({
      tone: 'idle',
      text: 'Not connected'
    })
    expect(
      pairStatus(src(), { ...dest, enabled: false }, result(), status(), true, now)
    ).toMatchObject({
      tone: 'off',
      text: 'Off'
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

describe('settingsTiles', () => {
  const tiles = (s: Source) =>
    Object.fromEntries(
      settingsTiles(s).map((x) => [
        x.id,
        { value: x.value, details: x.details.map((d) => d.text), pills: x.pills.map((p) => p.text) }
      ])
    )
  test('a copy of one folder, every day, trash and exclusions', () => {
    const s = src({
      excludes: ['*.tmp', 'node_modules/'],
      schedule: { kind: 'daily', time: '22:00' }
    })
    s.mirror = { deletion: 'trash', trashRetentionDays: 30 }
    expect(tiles(s)).toEqual({
      schedule: { value: 'Every day at 22:00', details: [], pills: ['Retries when reconnected'] },
      versions: {
        value: 'One up-to-date copy',
        details: ['Deleted items move to Trash'],
        pills: ['Trash: 30 days']
      },
      zip: {
        value: 'Plain files',
        details: ['Copied as they are', 'Skips *.tmp, node_modules/'],
        pills: ['2 exclusions']
      },
      general: { value: 'Documents/', details: ['Contents of Documents'], pills: [] }
    })
  })
  test('versions of several items, zipped and split, by hand, with subfolders and an alias', () => {
    const s = src({
      mode: 'snapshot',
      packaging: 'zip-whole',
      schedule: null,
      items: [
        { path: '/Users/me/Documents', kind: 'folder', folder: 'Work', alias: 'Docs' },
        { path: '/Users/me/notes.txt', kind: 'file' }
      ]
    })
    s.snapshot = { keepMin: 5, maxAgeDays: 30 }
    s.zip = { ...s.zip, level: 6, partLimitBytes: 4 * 1024 ** 3 }
    expect(tiles(s)).toEqual({
      schedule: { value: 'Manually', details: ['Runs when you click Back Up Now'], pills: [] },
      versions: {
        value: 'Dated versions',
        details: ['Keeps at least 5 versions'],
        pills: ['Older than 30 days removed']
      },
      zip: { value: 'One zip', details: ['Compression 6 of 9'], pills: ['Split at 4 GB'] },
      general: {
        value: 'Documents/',
        details: ['Each item by name'],
        pills: ['1 subfolder', '1 alias']
      }
    })
  })
})
