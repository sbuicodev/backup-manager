import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource } from '@shared/schema'
import type { SchedulerStatus } from '@shared/types'
import { headerRetryText, retryFor, waitingText } from '../../src/renderer/src/lib/retry'

const now = new Date(2026, 9, 26, 10, 0)
const plus = (min: number): string => new Date(now.getTime() + min * 60_000).toISOString()
const cfg = (): ReturnType<typeof defaultConfig> => {
  const c = defaultConfig()
  c.sources.push({ ...newSource('/a', 'Docs', []), id: 's1' })
  c.destinations.push(
    { ...newDestination('/u', 'USB drive'), id: 'd1' },
    { ...newDestination('/n', 'NAS'), id: 'd2' }
  )
  return c
}
const status = (over: Partial<SchedulerStatus>): SchedulerStatus => ({
  active: null,
  pending: [],
  pausedUntil: null,
  nextRuns: [],
  pendingRetries: [],
  ...over
})

test('waitingText', () => {
  expect(waitingText('USB drive', plus(3), now)).toBe('Waiting for USB drive · next check in 3 min')
  expect(waitingText('USB drive', null, now)).toBe('Waiting for USB drive · next check now')
  expect(waitingText('USB drive', plus(-1), now)).toBe('Waiting for USB drive · next check now')
})

test('retryFor', () => {
  const st = status({ pendingRetries: [{ sourceId: 's1', destId: 'd1', nextRetryAt: plus(2) }] })
  expect(retryFor(st, 's1', 'd1')).toEqual({ nextRetryAt: plus(2) })
  expect(retryFor(st, 's1', 'd2')).toBeNull()
  expect(retryFor(null, 's1', 'd1')).toBeNull()
})

test('headerRetryText: earliest retry, +N more, only when due before the next scheduled run', () => {
  const two = status({
    pendingRetries: [
      { sourceId: 's1', destId: 'd2', nextRetryAt: plus(4) },
      { sourceId: 's1', destId: 'd1', nextRetryAt: plus(2) }
    ]
  })
  expect(headerRetryText(two, cfg(), now)).toBe(
    'Waiting for USB drive · next check in 2 min +1 more'
  )
  expect(
    headerRetryText({ ...two, nextRuns: [{ sourceId: 's1', at: plus(1) }] }, cfg(), now)
  ).toBeNull()
  expect(
    headerRetryText({ ...two, nextRuns: [{ sourceId: 's1', at: plus(30) }] }, cfg(), now)
  ).not.toBeNull()
  expect(headerRetryText(status({}), cfg(), now)).toBeNull()
})
