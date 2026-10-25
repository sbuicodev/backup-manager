import type { JobReason } from '@shared/types'
import { DestinationUnavailable, type Destination } from './destination'

/** A job-fatal error; the executor turns it into a failed/cancelled JobResult. */
export class JobAbort extends Error {
  constructor(
    readonly reason: JobReason,
    message: string
  ) {
    super(message)
    this.name = 'JobAbort'
  }
}

const FILE_LEVEL = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ELOOP'])

/** Decides whether an error only affects one file ("file") or aborts the job (a JobReason). */
export async function classifyError(err: unknown, dest: Destination): Promise<'file' | JobReason> {
  if (err instanceof JobAbort) return err.reason
  if ((err as Error)?.name === 'AbortError') return 'cancelled'
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk-full'
  if (code === 'EROFS' || err instanceof DestinationUnavailable) return 'destination-lost'
  if (!(await dest.isAvailable())) return 'destination-lost'
  if (code && FILE_LEVEL.has(code)) return 'file'
  return 'error'
}
