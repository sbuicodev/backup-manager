import type { JobStatus, RunTrigger } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const STYLES: Record<JobStatus, { label: string; className: string }> = {
  completed: {
    label: 'Completed',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  },
  'completed-with-warnings': {
    label: 'Warnings',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
  },
  skipped: { label: 'Skipped', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  failed: { label: 'Failed', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' }
}

export function StatusBadge({ status }: { status: JobStatus }): React.JSX.Element {
  const s = STYLES[status]
  return <Badge className={cn('border-transparent', s.className)}>{s.label}</Badge>
}

const TRIGGERS: Record<RunTrigger, string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  'catch-up': 'Catch-up',
  retry: 'Retry',
  recovery: 'Recovery'
}

export function TriggerBadge({ trigger }: { trigger: RunTrigger }): React.JSX.Element {
  return <Badge variant="outline">{TRIGGERS[trigger]}</Badge>
}

export const REASONS: Record<string, string> = {
  'source-missing': 'Source folder not found',
  'destination-missing': 'Destination not available',
  'destination-lost': 'Destination disconnected during backup',
  'disk-full': 'Destination is full',
  cancelled: 'Cancelled',
  error: 'Unexpected error'
}
