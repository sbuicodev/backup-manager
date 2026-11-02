import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PairResult, RunLog, RunSummary } from '@shared/types'
import { SAFE_ID, changeFileName } from './changes'
import { atomicWriteText } from './fsutil'
import { formatTimestamp, uniqueTimestampName } from './naming'

export const HISTORY_LIMIT = 200

export type { RunSummary }

export function newRunId(now: Date, existing: Set<string>): string {
  return uniqueTimestampName(formatTimestamp(now), existing)
}

async function logFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export async function writeRunLog(dir: string, log: RunLog): Promise<void> {
  if (!SAFE_ID.test(log.id)) throw new Error(`invalid run id: ${log.id}`)
  await mkdir(dir, { recursive: true })
  await atomicWriteText(join(dir, `${log.id}.json`), JSON.stringify(log, null, 2))
  const files = await logFiles(dir)
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
    await rm(join(dir, f), { force: true })
    await rm(join(dir, changeFileName(f.slice(0, -'.json'.length))), { force: true })
  }
}

export async function getRun(dir: string, id: string): Promise<RunLog | null> {
  if (!SAFE_ID.test(id)) return null
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as RunLog
  } catch {
    return null
  }
}

export async function listRuns(dir: string): Promise<RunSummary[]> {
  const out: RunSummary[] = []
  for (const f of await logFiles(dir)) {
    const log = await getRun(dir, f.slice(0, -'.json'.length))
    if (!log) continue
    const { jobs, ...rest } = log
    out.push({ ...rest, jobCount: jobs.length })
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
}

/** The newest result of each backup × drive pair across the kept run logs. */
export async function latestResults(dir: string): Promise<PairResult[]> {
  const seen = new Map<string, PairResult>()
  for (const run of await listRuns(dir)) {
    const log = await getRun(dir, run.id)
    for (const j of log?.jobs ?? []) {
      const key = `${j.sourceId}:${j.destId}`
      if (seen.has(key)) continue
      seen.set(key, {
        sourceId: j.sourceId,
        destId: j.destId,
        runId: run.id,
        endedAt: run.endedAt,
        status: j.status,
        ...(j.reason ? { reason: j.reason } : {}),
        ...(j.error ? { error: j.error } : {}),
        ...(j.changeCount !== undefined ? { changeCount: j.changeCount } : {}),
        bytesWritten: j.bytesWritten
      })
    }
  }
  return [...seen.values()]
}
