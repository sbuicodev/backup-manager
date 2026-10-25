import type { Source } from '@shared/schema'
import type {
  Counts,
  FileEntry,
  JobPlan,
  JobResult,
  ProgressEvent,
  SkippedEntry,
  Warning
} from '@shared/types'
import type { Destination } from './destination'
import { JobAbort, classifyError } from './errors'

export type JobContext = {
  source: Source
  destId: string
  dest: Destination
  globalExcludes: string[]
  srcFiles: FileEntry[]
  srcSkipped: SkippedEntry[]
  now: Date
}
export type ExecContext = { runId: string; signal: AbortSignal; emit: (e: ProgressEvent) => void }
export type PreparedJob = { plan: JobPlan; execute(x: ExecContext): Promise<JobResult> }

export function effectiveExcludes(source: Source, globalExcludes: string[]): string[] {
  return [...source.excludes, ...(source.useGlobalExcludes ? globalExcludes : [])]
}

export function newCounts(): Counts {
  return { copied: 0, updated: 0, zipped: 0, trashed: 0, deleted: 0, pruned: 0, skipped: 0 }
}

const PROGRESS_STEP = 1024 * 1024

/** Shared bookkeeping for one job execution: counts, warnings, progress, error triage. */
export class JobRun {
  readonly counts = newCounts()
  readonly warnings: Warning[] = []
  bytesWritten = 0
  private lastEmitted = 0

  constructor(
    private ctx: JobContext,
    private x: ExecContext,
    private bytesTotal: number
  ) {
    for (const s of ctx.srcSkipped) {
      this.warn({
        path: s.rel,
        code: s.reason === 'symlink' ? 'SYMLINK' : 'UNREADABLE',
        message: s.reason === 'symlink' ? 'symbolic link not backed up' : 'could not be read'
      })
    }
  }

  warn(w: Warning): void {
    this.warnings.push(w)
    this.counts.skipped++
    this.x.emit({ type: 'warning', runId: this.x.runId, warning: w })
  }

  /** Accounts bytes; emits a progress event at most every MiB unless `force`. */
  progress(path: string, n: number, force = false): void {
    this.bytesWritten += n
    if (force || this.bytesWritten - this.lastEmitted >= PROGRESS_STEP) {
      this.lastEmitted = this.bytesWritten
      this.x.emit({
        type: 'file',
        runId: this.x.runId,
        path,
        bytesDone: this.bytesWritten,
        bytesTotal: this.bytesTotal
      })
    }
  }

  /** Runs a per-file operation; file-level errors become warnings, others abort the job. */
  async guard<T>(path: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.x.signal.throwIfAborted()
    try {
      return await fn()
    } catch (err) {
      const kind = await classifyError(err, this.ctx.dest)
      const e = err as NodeJS.ErrnoException
      if (kind === 'file') {
        this.warn({ path, code: e.code ?? 'ERROR', message: e.message })
        return undefined
      }
      throw new JobAbort(kind, `${path}: ${e.message}`)
    }
  }

  result(): JobResult {
    return {
      sourceId: this.ctx.source.id,
      destId: this.ctx.destId,
      status: this.warnings.length > 0 ? 'completed-with-warnings' : 'completed',
      counts: this.counts,
      bytesWritten: this.bytesWritten,
      warnings: this.warnings
    }
  }
}

/** Wraps an execute body so any non-JobAbort failure is classified into a JobAbort. */
export async function asJobAbort<T>(dest: Destination, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof JobAbort) throw err
    const kind = await classifyError(err, dest)
    throw new JobAbort(kind === 'file' ? 'error' : kind, (err as Error).message)
  }
}
