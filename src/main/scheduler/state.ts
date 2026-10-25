import { readFile, rename } from 'node:fs/promises'
import { z } from 'zod'
import type { Config } from '@shared/schema'
import type { JobRequest } from '@shared/types'
import { atomicWriteText } from '../engine/fsutil'

export const StateSchema = z.object({
  version: z.literal(1),
  jobs: z.record(
    z.string(),
    z.object({
      lastSuccessAt: z.string().nullable(),
      lastAttemptAt: z.string().nullable(),
      pendingRetry: z.boolean()
    })
  ),
  sources: z.record(z.string(), z.object({ lastScheduledAt: z.string().nullable() })),
  pausedUntil: z.string().nullable(),
  activeRun: z.object({ runId: z.string(), jobs: z.array(z.string()) }).nullable()
})

export type State = z.infer<typeof StateSchema>
export type JobState = State['jobs'][string]

export function jobKey(j: JobRequest): string {
  return `${j.sourceId}:${j.destId}`
}

export function parseJobKey(k: string): JobRequest {
  const i = k.indexOf(':')
  return { sourceId: k.slice(0, i), destId: k.slice(i + 1) }
}

export function emptyState(): State {
  return { version: 1, jobs: {}, sources: {}, pausedUntil: null, activeRun: null }
}

/** Loads state; missing → empty; invalid → empty (bad file renamed to `.bad`). Drops unknown ids. */
export async function loadState(file: string, config: Config): Promise<State> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw err
  }
  let state: State
  try {
    state = StateSchema.parse(JSON.parse(text))
  } catch {
    await rename(file, `${file}.bad`)
    return emptyState()
  }
  const sourceIds = new Set(config.sources.map((s) => s.id))
  const destIds = new Set(config.destinations.map((d) => d.id))
  const known = (k: string): boolean => {
    const { sourceId, destId } = parseJobKey(k)
    return sourceIds.has(sourceId) && destIds.has(destId)
  }
  return {
    ...state,
    jobs: Object.fromEntries(Object.entries(state.jobs).filter(([k]) => known(k))),
    sources: Object.fromEntries(Object.entries(state.sources).filter(([id]) => sourceIds.has(id))),
    activeRun: state.activeRun && { ...state.activeRun, jobs: state.activeRun.jobs.filter(known) }
  }
}

export async function saveState(file: string, s: State): Promise<void> {
  await atomicWriteText(file, JSON.stringify(s, null, 2))
}
