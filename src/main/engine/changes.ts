import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createGunzip, createGzip, type Gzip } from 'node:zlib'
import type { ChangeAction, ChangeEntry, ChangePage, ChangeQuery } from '@shared/types'
import { PARTIAL_SUFFIX } from './fsutil'

export const CHANGE_ACTIONS: ChangeAction[] = [
  'added',
  'updated',
  'removed',
  'trashed',
  'deleted',
  'skipped'
]
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

export function changeFileName(runId: string): string {
  return `${runId}.changes.ndjson.gz`
}

const zeroCounts = (): Record<ChangeAction, number> =>
  Object.fromEntries(CHANGE_ACTIONS.map((a) => [a, 0])) as Record<ChangeAction, number>

/** Streams a run's change entries to `<runId>.changes.ndjson.gz` so memory stays flat. */
export class ChangeRecorder {
  private counts = new Map<string, number>()
  private total = 0
  private failed: Error | null = null

  private constructor(
    private readonly file: string,
    private readonly partial: string,
    private readonly gzip: Gzip,
    private readonly out: WriteStream
  ) {
    const fail = (err: Error): void => {
      this.failed ??= err
    }
    gzip.on('error', fail)
    out.on('error', fail)
  }

  static async open(historyDir: string, runId: string): Promise<ChangeRecorder> {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(historyDir, { recursive: true })
    const file = join(historyDir, changeFileName(runId))
    const partial = `${file}${PARTIAL_SUFFIX}`
    const gzip = createGzip()
    const out = createWriteStream(partial)
    gzip.pipe(out)
    return new ChangeRecorder(file, partial, gzip, out)
  }

  record(e: ChangeEntry): void {
    const key = `${e.sourceId}:${e.destId}`
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    this.total++
    if (!this.failed) this.gzip.write(`${JSON.stringify(e)}\n`)
  }

  countFor(sourceId: string, destId: string): number {
    return this.counts.get(`${sourceId}:${destId}`) ?? 0
  }

  /** Finishes the file; an empty or failed recording leaves nothing behind. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.out.once('close', resolve)
      this.gzip.end()
    })
    if (this.total === 0 || this.failed) {
      if (this.failed) console.error('change history could not be written', this.failed)
      await rm(this.partial, { force: true })
      return
    }
    await rename(this.partial, this.file)
  }
}

/** Reads one job's changes from a run's change file, filtering and paging as it streams. */
export async function readChanges(
  historyDir: string,
  runId: string,
  q: ChangeQuery
): Promise<ChangePage> {
  const counts = zeroCounts()
  const items: ChangeEntry[] = []
  const offset = Math.max(0, q.offset ?? 0)
  const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT))
  const actions = q.actions ? new Set(q.actions) : null
  const search = q.search?.toLowerCase() ?? ''
  let total = 0
  const input = createReadStream(join(historyDir, changeFileName(runId)))
  try {
    await new Promise<void>((resolve, reject) => {
      input.once('open', () => resolve())
      input.once('error', reject)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { total: 0, counts, items }
    throw err
  }
  const lines = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    const e = JSON.parse(line) as ChangeEntry
    if (e.sourceId !== q.sourceId || e.destId !== q.destId) continue
    counts[e.action]++
    if (actions && !actions.has(e.action)) continue
    if (search && !e.path.toLowerCase().includes(search)) continue
    if (total >= offset && items.length < limit) items.push(e)
    total++
  }
  return { total, counts, items }
}
