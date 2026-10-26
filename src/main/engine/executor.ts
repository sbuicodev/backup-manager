import type { Config } from '@shared/schema'
import type {
  JobPlan,
  JobResult,
  JobStatus,
  ProgressEvent,
  RunLog,
  RunStatus,
  RunTrigger
} from '@shared/types'
import { FsDestination, type Destination } from './destination'
import { JobAbort } from './errors'
import { ChangeRecorder } from './changes'
import { writeRunLog } from './history'
import { newCounts } from './job'
import { planRun, type RunRequest } from './planner'
import { applyRetention } from './retention'

export type RunOptions = {
  runId: string
  trigger: RunTrigger
  signal: AbortSignal
  emit: (e: ProgressEvent) => void
  historyDir: string
  now?: () => Date
  makeDestination?: (root: string) => Destination
  /** Snapshot file-list index folder (enables snapshot change diffs). */
  indexDir?: string
}

const RANK: Record<JobStatus, number> = {
  completed: 0,
  'completed-with-warnings': 1,
  skipped: 1,
  failed: 2,
  cancelled: 3
}

export function runStatus(jobs: JobResult[]): RunStatus {
  const worst = jobs.reduce<JobStatus>(
    (w, j) => (RANK[j.status] > RANK[w] ? j.status : w),
    'completed'
  )
  return worst === 'skipped' ? 'completed-with-warnings' : (worst as RunStatus)
}

function emptyResult(plan: JobPlan, status: JobStatus, extra: Partial<JobResult> = {}): JobResult {
  return {
    sourceId: plan.sourceId,
    destId: plan.destId,
    status,
    counts: newCounts(),
    bytesWritten: 0,
    warnings: [],
    ...extra
  }
}

export async function runBackup(
  config: Config,
  request: RunRequest,
  opts: RunOptions
): Promise<RunLog> {
  const now = opts.now ?? (() => new Date())
  const makeDestination = opts.makeDestination ?? ((root: string) => new FsDestination(root))
  const startedAt = now()
  const { runId, emit, signal } = opts
  const results: JobResult[] = []
  const recorder = await ChangeRecorder.open(opts.historyDir, runId)
  const record = recorder.record.bind(recorder)

  let prepared: Awaited<ReturnType<typeof planRun>>['prepared'] = []
  try {
    prepared = (
      await planRun(config, request, {
        now: () => startedAt,
        makeDestination,
        signal,
        indexDir: opts.indexDir
      })
    ).prepared
  } catch (err) {
    if (!signal.aborted) throw err
  }
  emit({ type: 'run-start', runId, trigger: opts.trigger, totalJobs: prepared.length })

  for (const p of prepared) {
    const { plan } = p
    if (signal.aborted) {
      results.push(emptyResult(plan, 'cancelled', { reason: 'cancelled' }))
      continue
    }
    if (plan.reason === 'error') {
      const r = emptyResult(plan, 'failed', { reason: 'error', error: plan.error })
      results.push(r)
      emit({ type: 'job-end', runId, result: r })
      continue
    }
    if (plan.status === 'skipped' || !p.execute) {
      const r = emptyResult(plan, 'skipped', { reason: plan.reason })
      emit({
        type: 'warning',
        runId,
        warning: {
          path: '',
          code: plan.reason ?? 'skipped',
          message: `job skipped: ${plan.reason}`
        }
      })
      results.push(r)
      emit({ type: 'job-end', runId, result: r })
      continue
    }
    emit({
      type: 'job-start',
      runId,
      sourceId: plan.sourceId,
      destId: plan.destId,
      bytesTotal: plan.bytes
    })
    let result: JobResult
    try {
      result = await p.execute({ runId, signal, emit, record })
      const source = config.sources.find((s) => s.id === plan.sourceId)
      const destCfg = config.destinations.find((d) => d.id === plan.destId)
      if (source && destCfg) {
        try {
          const { pruned } = await applyRetention(makeDestination(destCfg.path), source, startedAt)
          result.counts.pruned = pruned
        } catch (err) {
          result.warnings.push({
            path: source.slug,
            code: 'RETENTION',
            message: `retention failed: ${(err as Error).message}`
          })
          result.status = 'completed-with-warnings'
        }
      }
    } catch (err) {
      const reason = err instanceof JobAbort ? err.reason : 'error'
      result = emptyResult(plan, reason === 'cancelled' ? 'cancelled' : 'failed', {
        reason,
        error: (err as Error).message
      })
    }
    result.changeCount = recorder.countFor(plan.sourceId, plan.destId)
    results.push(result)
    emit({ type: 'job-end', runId, result })
  }
  await recorder.close()

  const log: RunLog = {
    id: runId,
    trigger: opts.trigger,
    startedAt: startedAt.toISOString(),
    endedAt: now().toISOString(),
    status: signal.aborted ? 'cancelled' : runStatus(results),
    jobs: results
  }
  await writeRunLog(opts.historyDir, log)
  emit({ type: 'run-end', runId, log })
  return log
}
