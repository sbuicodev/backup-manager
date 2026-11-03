import { expect, test } from 'vitest'
import type { JobResult } from '@shared/types'
import { dayLabel, groupByDay, jobResultText } from '../../src/renderer/src/lib/activity'

const now = new Date(2026, 10, 3, 15, 0)

test('dayLabel and groupByDay, newest first', () => {
  expect(dayLabel(new Date(2026, 10, 3, 9, 0), now)).toBe('Today')
  expect(dayLabel(new Date(2026, 10, 2, 23, 0), now)).toBe('Yesterday')
  expect(dayLabel(new Date(2026, 9, 28, 9, 0), now)).toBe('Wednesday 28 October')
  const runs = [
    { id: 'a', startedAt: new Date(2026, 10, 3, 14, 0).toISOString() },
    { id: 'b', startedAt: new Date(2026, 10, 3, 9, 0).toISOString() },
    { id: 'c', startedAt: new Date(2026, 10, 2, 22, 0).toISOString() }
  ]
  expect(groupByDay(runs, now).map((g) => [g.label, g.runs.map((r) => r.id)])).toEqual([
    ['Today', ['a', 'b']],
    ['Yesterday', ['c']]
  ])
})

test('jobResultText says what a job did in a few words', () => {
  const job = (extra: Partial<JobResult>): JobResult => ({
    sourceId: 's',
    destId: 'd',
    status: 'completed',
    counts: { copied: 0, updated: 0, zipped: 0, trashed: 0, deleted: 0, pruned: 0, skipped: 0 },
    bytesWritten: 0,
    warnings: [],
    ...extra
  })
  expect(jobResultText(job({ changeCount: 3 }))).toBe('3 changes')
  expect(jobResultText(job({ changeCount: 1 }))).toBe('1 change')
  expect(jobResultText(job({ changeCount: 0 }))).toBe('No changes')
  expect(jobResultText(job({ status: 'skipped', reason: 'destination-missing' }))).toBe(
    'Drive not connected'
  )
  expect(jobResultText(job({ status: 'skipped', reason: 'source-missing' }))).toBe(
    'Files not found'
  )
  expect(jobResultText(job({ status: 'failed', reason: 'error', error: 'ENOSPC: no space' }))).toBe(
    'Failed · disk full'
  )
  expect(jobResultText(job({ status: 'cancelled', reason: 'cancelled' }))).toBe('Stopped')
  expect(
    jobResultText(
      job({
        status: 'completed-with-warnings',
        changeCount: 2,
        warnings: [{ path: 'a', code: 'X', message: 'm' }]
      })
    )
  ).toBe('2 changes · 1 warning')
})
