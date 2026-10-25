import { useEffect, useReducer } from 'react'
import type { JobRequest, ProgressEvent, RunLog, RunTrigger, Warning } from '@shared/types'
import { api } from '@/lib/api'

export type RunProgress = {
  runId: string | null
  trigger: RunTrigger | null
  currentJob: JobRequest | null
  currentFile: string | null
  jobBytesDone: number
  jobBytesTotal: number
  jobsDone: number
  totalJobs: number
  warnings: Warning[]
  lastLog: RunLog | null
}

const MAX_WARNINGS = 500

const initial: RunProgress = {
  runId: null,
  trigger: null,
  currentJob: null,
  currentFile: null,
  jobBytesDone: 0,
  jobBytesTotal: 0,
  jobsDone: 0,
  totalJobs: 0,
  warnings: [],
  lastLog: null
}

export function reduceProgress(s: RunProgress, e: ProgressEvent): RunProgress {
  switch (e.type) {
    case 'run-start':
      return {
        ...initial,
        lastLog: s.lastLog,
        runId: e.runId,
        trigger: e.trigger,
        totalJobs: e.totalJobs
      }
    case 'job-start':
      return {
        ...s,
        currentJob: { sourceId: e.sourceId, destId: e.destId },
        currentFile: null,
        jobBytesDone: 0,
        jobBytesTotal: e.bytesTotal
      }
    case 'file':
      return { ...s, currentFile: e.path, jobBytesDone: e.bytesDone }
    case 'warning':
      return s.warnings.length >= MAX_WARNINGS ? s : { ...s, warnings: [...s.warnings, e.warning] }
    case 'job-end':
      return { ...s, jobsDone: s.jobsDone + 1, currentJob: null, currentFile: null }
    case 'run-end':
      return { ...s, runId: null, currentJob: null, currentFile: null, lastLog: e.log }
  }
}

export function useRunProgress(): RunProgress {
  const [state, dispatch] = useReducer(reduceProgress, initial)
  useEffect(() => api.run.onProgress(dispatch), [])
  return state
}
