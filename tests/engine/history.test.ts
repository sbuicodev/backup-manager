import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { RunLog } from '@shared/types'
import { changeFileName } from '../../src/main/engine/changes'
import { getRun, listRuns, newRunId, writeRunLog } from '../../src/main/engine/history'
import { tmpDir } from '../helpers/fs'

const log = (id: string, startedAt = '2026-10-25T10:00:00.000Z'): RunLog => ({
  id,
  trigger: 'manual',
  startedAt,
  endedAt: startedAt,
  status: 'completed',
  jobs: []
})

test('write, list newest first, get', async () => {
  const dir = await tmpDir()
  await writeRunLog(dir, log('2026-10-25_100000'))
  await writeRunLog(dir, log('2026-10-25_110000', '2026-10-25T11:00:00.000Z'))
  const runs = await listRuns(dir)
  expect(runs.map((r) => r.id)).toEqual(['2026-10-25_110000', '2026-10-25_100000'])
  expect(runs[0]).toMatchObject({ jobCount: 0, status: 'completed' })
  expect(runs[0]).not.toHaveProperty('jobs')
  expect(await getRun(dir, '2026-10-25_100000')).toEqual(log('2026-10-25_100000'))
})

test('getRun returns null for unknown or unsafe id', async () => {
  const dir = await tmpDir()
  expect(await getRun(dir, 'nope')).toBeNull()
  expect(await getRun(dir, '../etc/passwd')).toBeNull()
})

test('listRuns on a missing dir is empty', async () => {
  expect(await listRuns('/definitely/not/here')).toEqual([])
})

test('history keeps the last 200 logs', async () => {
  const dir = await tmpDir()
  for (let i = 0; i < 205; i++) {
    const d = new Date(2026, 0, 1, 0, 0, i)
    await writeRunLog(dir, log(newRunId(d, new Set()), d.toISOString()))
  }
  const files = await readdir(dir)
  expect(files).toHaveLength(200)
  expect(files).not.toContain('2026-01-01_000000.json')
  expect(files).toContain('2026-01-01_000324.json')
})

test('newRunId dedupes', () => {
  const d = new Date(2026, 0, 1, 0, 0, 0)
  expect(newRunId(d, new Set(['2026-01-01_000000']))).toBe('2026-01-01_000000-2')
})

test('history retention also deletes change files', async () => {
  const dir = await tmpDir()
  for (let i = 0; i < 202; i++) {
    const d = new Date(2026, 0, 1, 0, 0, i)
    const id = newRunId(d, new Set())
    await writeFile(join(dir, changeFileName(id)), 'x')
    await writeRunLog(dir, log(id, d.toISOString()))
  }
  const files = await readdir(dir)
  expect(files.filter((f) => f.endsWith('.changes.ndjson.gz'))).toHaveLength(200)
  expect(files).not.toContain(changeFileName('2026-01-01_000000'))
})
