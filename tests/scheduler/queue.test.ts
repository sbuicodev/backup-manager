import { expect, test, vi } from 'vitest'
import type { QueuedRun } from '@shared/types'
import { RunQueue } from '../../src/main/scheduler/queue'

type Deferred = {
  resolve: () => void
  reject: (e: unknown) => void
  signal: AbortSignal
  run: QueuedRun
}

function harness(): { queue: RunQueue; started: Deferred[] } {
  const started: Deferred[] = []
  let n = 0
  const queue = new RunQueue(
    (run, signal) =>
      new Promise<void>((resolve, reject) => {
        started.push({ resolve, reject, signal, run })
        signal.addEventListener('abort', () => resolve())
      }),
    () => `run-${++n}`
  )
  return { queue, started }
}

const job = (s: string, d = 'd'): { sourceId: string; destId: string } => ({
  sourceId: s,
  destId: d
})
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

test('runs execute sequentially in FIFO order', async () => {
  const { queue, started } = harness()
  const a = queue.enqueue([job('a')], 'manual')
  const b = queue.enqueue([job('b')], 'scheduled')
  await tick()
  expect(started.map((s) => s.run.id)).toEqual([a!.id])
  expect(queue.active?.id).toBe(a!.id)
  expect(queue.pending.map((r) => r.id)).toEqual([b!.id])
  started[0].resolve()
  await tick()
  expect(started.map((s) => s.run.id)).toEqual([a!.id, b!.id])
  started[1].resolve()
  await queue.whenIdle()
  expect(queue.active).toBeNull()
})

test('a job already pending is dropped; one only in the active run is accepted', async () => {
  const { queue } = harness()
  queue.enqueue([job('a')], 'manual')
  await tick()
  expect(queue.enqueue([job('b')], 'manual')).not.toBeNull()
  expect(queue.enqueue([job('b')], 'scheduled')).toBeNull()
  const r = queue.enqueue([job('a'), job('b')], 'retry')
  expect(r?.jobs).toEqual([job('a')])
})

test('cancelActive aborts the signal and the next pending run still starts', async () => {
  const { queue, started } = harness()
  queue.enqueue([job('a')], 'manual')
  queue.enqueue([job('b')], 'manual')
  await tick()
  queue.cancelActive()
  expect(started[0].signal.aborted).toBe(true)
  await tick()
  expect(started).toHaveLength(2)
  expect(started[1].signal.aborted).toBe(false)
})

test('a throwing runner does not stop the queue', async () => {
  const { queue, started } = harness()
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  queue.enqueue([job('a')], 'manual')
  queue.enqueue([job('b')], 'manual')
  await tick()
  started[0].reject(new Error('boom'))
  await tick()
  expect(started).toHaveLength(2)
  expect(spy).toHaveBeenCalled()
  spy.mockRestore()
})

test('onChange fires on enqueue, start and finish; unsubscribe works', async () => {
  const { queue, started } = harness()
  const cb = vi.fn()
  const off = queue.onChange(cb)
  queue.enqueue([job('a')], 'manual')
  await tick()
  const afterStart = cb.mock.calls.length
  expect(afterStart).toBeGreaterThanOrEqual(2)
  started[0].resolve()
  await queue.whenIdle()
  expect(cb.mock.calls.length).toBeGreaterThan(afterStart)
  off()
  const before = cb.mock.calls.length
  queue.enqueue([job('z')], 'manual')
  expect(cb.mock.calls.length).toBe(before)
})

test('empty job list returns null', () => {
  expect(harness().queue.enqueue([], 'manual')).toBeNull()
})

test('whenIdle resolves immediately when idle', async () => {
  await expect(harness().queue.whenIdle()).resolves.toBeUndefined()
})
