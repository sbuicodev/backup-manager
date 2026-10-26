import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource } from '@shared/schema'
import {
  emptyState,
  jobKey,
  loadState,
  parseJobKey,
  saveState,
  type State
} from '../../src/main/scheduler/state'
import { tmpDir } from '../helpers/fs'

function config(): ReturnType<typeof defaultConfig> {
  const c = defaultConfig()
  c.sources.push({ ...newSource('/a', 'A', []), id: 's1' })
  c.destinations.push({ ...newDestination('/d', 'D'), id: 'd1' })
  return c
}

const sample = (): State => ({
  version: 1,
  jobs: {
    's1:d1': {
      lastSuccessAt: '2026-10-25T10:00:00.000Z',
      lastAttemptAt: null,
      pendingRetry: true,
      retryAttempts: 0,
      nextRetryAt: null
    }
  },
  sources: { s1: { lastScheduledAt: '2026-10-25T02:00:00.000Z' } },
  pausedUntil: 'forever',
  activeRun: { runId: 'r1', jobs: ['s1:d1'] }
})

test('jobKey round trip', () => {
  expect(jobKey({ sourceId: 's1', destId: 'd1' })).toBe('s1:d1')
  expect(parseJobKey('s1:d1')).toEqual({ sourceId: 's1', destId: 'd1' })
})

test('missing file → empty state', async () => {
  const dir = await tmpDir()
  expect(await loadState(join(dir, 'state.json'), config())).toEqual(emptyState())
})

test('save/load round trip', async () => {
  const file = join(await tmpDir(), 'state.json')
  await saveState(file, sample())
  expect(await loadState(file, config())).toEqual(sample())
})

test('invalid JSON → empty state, bad file kept as state.json.bad', async () => {
  const file = join(await tmpDir(), 'state.json')
  await writeFile(file, '{oops')
  expect(await loadState(file, config())).toEqual(emptyState())
  expect(await readFile(`${file}.bad`, 'utf8')).toBe('{oops')
  expect(existsSync(file)).toBe(false)
})

test('unknown source/destination ids are dropped', async () => {
  const file = join(await tmpDir(), 'state.json')
  const s = sample()
  s.jobs['s1:gone'] = {
    lastSuccessAt: null,
    lastAttemptAt: null,
    pendingRetry: false,
    retryAttempts: 0,
    nextRetryAt: null
  }
  s.jobs['gone:d1'] = {
    lastSuccessAt: null,
    lastAttemptAt: null,
    pendingRetry: false,
    retryAttempts: 0,
    nextRetryAt: null
  }
  s.sources.gone = { lastScheduledAt: null }
  s.activeRun = { runId: 'r1', jobs: ['s1:d1', 'gone:d1'] }
  await saveState(file, s)
  const loaded = await loadState(file, config())
  expect(Object.keys(loaded.jobs)).toEqual(['s1:d1'])
  expect(Object.keys(loaded.sources)).toEqual(['s1'])
  expect(loaded.activeRun).toEqual({ runId: 'r1', jobs: ['s1:d1'] })
})
