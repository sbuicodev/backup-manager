// src/shared/types.ts
export type FileEntry = { rel: string; size: number; mtimeMs: number } // rel uses '/'
export type SkippedEntry = { rel: string; reason: 'symlink' | 'unreadable' }
export type JobRequest = { sourceId: string; destId: string }
export type RunTrigger = 'manual' | 'scheduled' | 'catch-up' | 'retry' | 'recovery'
export type JobStatus = 'completed' | 'completed-with-warnings' | 'failed' | 'cancelled' | 'skipped'
export type RunStatus = 'completed' | 'completed-with-warnings' | 'failed' | 'cancelled'
export type JobReason =
  | 'source-missing'
  | 'destination-missing'
  | 'destination-lost'
  | 'disk-full'
  | 'error'
  | 'cancelled'
export type JobKind = 'mirror-copy' | 'mirror-zip' | 'snapshot-copy' | 'snapshot-zip'
export type PlanCounts = {
  copy: number
  update: number
  zip: number
  trash: number
  delete: number
  unchanged: number
}
export type JobPlan = {
  sourceId: string
  destId: string
  kind: JobKind
  status: 'ready' | 'skipped'
  reason?: 'source-missing' | 'destination-missing' | 'error'
  error?: string
  counts: PlanCounts
  bytes: number
  skippedEntries: SkippedEntry[]
}
export type Plan = { createdAt: string; jobs: JobPlan[] }
export type Counts = {
  copied: number
  updated: number
  zipped: number
  trashed: number
  deleted: number
  pruned: number
  skipped: number
}
export type Warning = { path: string; code: string; message: string }
export type JobResult = {
  sourceId: string
  destId: string
  status: JobStatus
  reason?: JobReason
  counts: Counts
  bytesWritten: number
  warnings: Warning[]
  error?: string
  /** Change entries recorded for this job; absent in logs written before change history. */
  changeCount?: number
}
export type RunLog = {
  id: string
  trigger: RunTrigger
  startedAt: string
  endedAt: string
  status: RunStatus
  jobs: JobResult[]
}
export type ProgressEvent =
  | { type: 'run-start'; runId: string; trigger: RunTrigger; totalJobs: number }
  | { type: 'job-start'; runId: string; sourceId: string; destId: string; bytesTotal: number }
  | { type: 'file'; runId: string; path: string; bytesDone: number; bytesTotal: number }
  | { type: 'warning'; runId: string; warning: Warning }
  | { type: 'job-end'; runId: string; result: JobResult }
  | { type: 'run-end'; runId: string; log: RunLog }
export type QueuedRun = { id: string; trigger: RunTrigger; jobs: JobRequest[] }
export type SchedulerStatus = {
  active: QueuedRun | null
  pending: QueuedRun[]
  pausedUntil: string | null // ISO or "forever"
  nextRuns: Array<{ sourceId: string; at: string | null }> // null = manual only
  pendingRetries: JobRequest[]
}

export type RunSummary = Omit<RunLog, 'jobs'> & { jobCount: number }

export type ChangeAction = 'added' | 'updated' | 'removed' | 'trashed' | 'deleted' | 'skipped'
export type ChangeEntry = {
  sourceId: string
  destId: string
  action: ChangeAction
  path: string
  size?: number
  archive?: string
  code?: string
}
export type ChangeQuery = {
  sourceId: string
  destId: string
  actions?: ChangeAction[]
  search?: string
  offset?: number
  limit?: number
}
export type ChangePage = {
  total: number
  counts: Record<ChangeAction, number>
  items: ChangeEntry[]
}
