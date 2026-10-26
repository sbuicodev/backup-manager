import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
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

/**
 * Streams a run's change entries to `<runId>.changes.ndjson.gz` so memory stays flat. Any I/O
 * failure disables recording for the run; it never blocks or fails the backup itself.
 */
export class ChangeRecorder {
  private counts = new Map<string, number>()
  private total = 0
  private failed: Error | null = null

  private constructor(
    private readonly file: string,
    private readonly partial: string,
    private readonly gzip: Gzip | null,
    private readonly out: WriteStream | null
  ) {
    const fail = (err: Error): void => {
      this.failed ??= err
    }
    gzip?.on('error', fail)
    out?.on('error', fail)
  }

  static async open(historyDir: string, runId: string): Promise<ChangeRecorder> {
    const file = join(historyDir, changeFileName(runId))
    const partial = `${file}${PARTIAL_SUFFIX}`
    try {
      await mkdir(historyDir, { recursive: true })
    } catch (err) {
      const rec = new ChangeRecorder(file, partial, null, null)
      rec.failed = err as Error
      return rec
    }
    const gzip = createGzip()
    const out = createWriteStream(partial)
    gzip.pipe(out)
    return new ChangeRecorder(file, partial, gzip, out)
  }

  /** Records an entry; false means the buffer is full and the caller should `drain()`. */
  record(e: ChangeEntry): boolean {
    const key = `${e.sourceId}:${e.destId}`
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    this.total++
    if (this.failed || !this.gzip) return true
    return this.gzip.write(`${JSON.stringify(e)}\n`)
  }

  /** Resolves once buffered entries have been flushed (or recording has failed). */
  async drain(): Promise<void> {
    const gzip = this.gzip
    if (this.failed || !gzip || !gzip.writableNeedDrain) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        gzip.off('drain', done)
        gzip.off('error', done)
        gzip.off('close', done)
        resolve()
      }
      gzip.on('drain', done)
      gzip.on('error', done)
      gzip.on('close', done)
    })
  }

  bufferedBytes(): number {
    return (this.gzip?.writableLength ?? 0) + (this.out?.writableLength ?? 0)
  }

  countFor(sourceId: string, destId: string): number {
    return this.counts.get(`${sourceId}:${destId}`) ?? 0
  }

  /** Finishes the file; an empty or failed recording leaves nothing behind. Never hangs. */
  async close(): Promise<void> {
    if (this.gzip && this.out && !this.failed && !this.out.destroyed) {
      this.gzip.end()
      await finished(this.out).catch((err: Error) => {
        this.failed ??= err
      })
    } else {
      this.gzip?.destroy()
      this.out?.destroy()
    }
    if (this.total === 0 || this.failed) {
      if (this.failed) console.error('change history could not be written', this.failed)
      await rm(this.partial, { force: true }).catch(() => {})
      return
    }
    await rename(this.partial, this.file).catch((err) => {
      console.error('change history could not be saved', err)
    })
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
