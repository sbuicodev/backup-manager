import type { EffectiveZip, Source } from '@shared/schema'
import type {
  ChangeAction,
  ChangeEntry,
  Counts,
  FileEntry,
  JobPlan,
  JobResult,
  ProgressEvent,
  SkippedEntry,
  Warning
} from '@shared/types'
import { join } from 'node:path'
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
  /** Effective zip part settings for this source × destination. */
  zip: EffectiveZip
  /** Folder of snapshot file-list indexes; when unset, snapshots record no change diff. */
  indexDir?: string
  /** Absolute path of a source file; when unset, `rel` is under the source folder. */
  absOf?: (rel: string) => string
}

/** Where a source file named `rel` lives on disk (folder sources and Files sources alike). */
export function sourceAbs(ctx: JobContext, rel: string): string {
  return ctx.absOf ? ctx.absOf(rel) : join(ctx.source.path, ...rel.split('/'))
}
export type ExecContext = {
  runId: string
  signal: AbortSignal
  emit: (e: ProgressEvent) => void
  /** Records one per-file change; false means the history buffer is full (call `drain`). */
  record: (e: ChangeEntry) => boolean
  /** Waits until buffered change entries have been written out. */
  drain: () => Promise<void>
}
/** Source files a warning about an archive concerns, and the archive's shown name. */
export type Affected = { rels: string[]; archive: string }
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
  private mustDrain = false

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

  /**
   * Records a warning. `affected` names the source files it concerns when its path is an archive
   * rather than a source path; each is logged as skipped, with the archive, instead of the path.
   */
  warn(w: Warning, affected?: Affected): void {
    this.warnings.push(w)
    this.counts.skipped++
    this.x.emit({ type: 'warning', runId: this.x.runId, warning: w })
    if (affected) {
      for (const rel of affected.rels) {
        this.change('skipped', rel, { code: w.code, archive: affected.archive })
      }
    } else if (w.path !== '') this.change('skipped', w.path, { code: w.code })
  }

  change(
    action: ChangeAction,
    path: string,
    extra: { size?: number; archive?: string; code?: string } = {}
  ): void {
    const ok = this.x.record({
      sourceId: this.ctx.source.id,
      destId: this.ctx.destId,
      action,
      path,
      ...extra
    })
    this.mustDrain ||= !ok
  }

  /** Lets the change history catch up when its buffer is full; call between batches of work. */
  async settle(): Promise<void> {
    if (!this.mustDrain) return
    this.mustDrain = false
    await this.x.drain()
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
  async guard<T>(path: string, fn: () => Promise<T>, affected?: Affected): Promise<T | undefined> {
    this.x.signal.throwIfAborted()
    try {
      return await fn()
    } catch (err) {
      const kind = await classifyError(err, this.ctx.dest)
      const e = err as NodeJS.ErrnoException
      if (kind === 'file') {
        this.warn({ path, code: e.code ?? 'ERROR', message: e.message }, affected)
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

/** Rels that collide, ignoring case, with an earlier rel in the (sorted) list. */
export function caseDuplicates(files: FileEntry[]): Set<string> {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const f of files) {
    const key = f.rel.toLowerCase()
    if (seen.has(key)) dups.add(f.rel)
    seen.add(key)
  }
  return dups
}

/** Probes whether the existing directory `rel` resolves under a different letter case. */
export async function isCaseInsensitive(dest: Destination, rel: string): Promise<boolean> {
  const slash = rel.lastIndexOf('/')
  const last = rel.slice(slash + 1)
  const flipped = [...last]
    .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    .join('')
  if (flipped === last) return false
  return (await dest.stat(rel.slice(0, slash + 1) + flipped)) !== null
}

/**
 * Files to skip because they differ only by case from an earlier file and `dir` is on a
 * case-insensitive filesystem (copying both would silently overwrite one with the other).
 */
export async function caseConflicts(
  dest: Destination,
  dir: string,
  files: FileEntry[]
): Promise<Set<string>> {
  const dups = caseDuplicates(files)
  if (dups.size === 0 || !(await isCaseInsensitive(dest, dir))) return new Set()
  return dups
}

export function warnCaseConflict(run: JobRun, rel: string): void {
  run.warn({
    path: rel,
    code: 'CASE_CONFLICT',
    message: 'skipped: another file differs only by letter case and the destination ignores case'
  })
}
