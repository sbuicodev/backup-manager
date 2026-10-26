import { useState } from 'react'
import { Eye, Loader2, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import type { Config } from '@shared/schema'
import type { JobPlan, Plan, SchedulerStatus } from '@shared/types'
import { PageHeader } from '@/components/PageHeader'
import { REASONS, StatusBadge, TriggerBadge } from '@/components/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import type { RunProgress } from '@/hooks/useRunProgress'
import { api } from '@/lib/api'
import { formatBytes, formatDuration } from '@/lib/format'
import { jobOutcomeText, nextCheckIn, retryFor } from '@/lib/retry'
import { useNow } from '@/hooks/useSchedulerStatus'

function names(config: Config): {
  source: (id: string) => string
  dest: (id: string) => string
} {
  return {
    source: (id) => config.sources.find((s) => s.id === id)?.name ?? 'Removed source',
    dest: (id) => config.destinations.find((d) => d.id === id)?.name ?? 'Removed destination'
  }
}

function describeCounts(j: JobPlan): string {
  const c = j.counts
  const parts: string[] = []
  if (c.copy) parts.push(`${c.copy} new`)
  if (c.update) parts.push(`${c.update} changed`)
  if (c.zip) parts.push(`${c.zip} archive${c.zip === 1 ? '' : 's'}`)
  if (c.trash) parts.push(`${c.trash} to trash`)
  if (c.delete) parts.push(`${c.delete} to delete`)
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`)
  return parts.join(' · ') || 'Nothing to do'
}

function PlanView({ plan, config }: { plan: Plan; config: Config }): React.JSX.Element {
  const n = names(config)
  if (plan.jobs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing to back up: no enabled source has an enabled destination.
      </p>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Destination</TableHead>
          <TableHead>What will happen</TableHead>
          <TableHead className="text-right">To write</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plan.jobs.map((j) => (
          <TableRow key={`${j.sourceId}:${j.destId}`}>
            <TableCell className="font-medium">{n.source(j.sourceId)}</TableCell>
            <TableCell>{n.dest(j.destId)}</TableCell>
            <TableCell>
              {j.status === 'skipped' ? (
                <span className="flex items-center gap-2">
                  <StatusBadge status="skipped" />
                  <span className="text-muted-foreground text-sm">
                    {REASONS[j.reason ?? '']}
                    {j.error && `: ${j.error}`}
                  </span>
                </span>
              ) : (
                <span className="text-sm">
                  {describeCounts(j)}
                  {j.skippedEntries.length > 0 && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {j.skippedEntries.length} skipped (links/unreadable)
                    </span>
                  )}
                </span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatBytes(j.bytes)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function Run({
  config,
  status,
  progress
}: {
  config: Config
  status: SchedulerStatus | null
  progress: RunProgress
}): React.JSX.Element {
  const now = useNow(15_000)
  const enabled = config.sources.filter((s) => s.enabled)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(enabled.map((s) => s.id)))
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planning, setPlanning] = useState(false)
  const n = names(config)
  const ids = enabled.filter((s) => selected.has(s.id)).map((s) => s.id)
  const running = status?.active != null

  const preview = async (): Promise<void> => {
    setPlanning(true)
    try {
      setPlan(await api.run.plan(ids))
    } finally {
      setPlanning(false)
    }
  }
  const start = async (): Promise<void> => {
    const id = await api.run.start(ids)
    if (!id) toast.info('Those backups are already queued')
    setPlan(null)
  }
  const jobPct =
    progress.jobBytesTotal > 0
      ? Math.min(100, (progress.jobBytesDone / progress.jobBytesTotal) * 100)
      : 0
  const overallPct =
    progress.totalJobs > 0
      ? Math.min(100, ((progress.jobsDone + jobPct / 100) / progress.totalJobs) * 100)
      : 0
  const log = progress.lastLog

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Run"
        description="Preview what a backup will do, then run it."
        actions={
          <>
            <Button variant="outline" onClick={preview} disabled={ids.length === 0 || planning}>
              {planning ? <Loader2 className="animate-spin" /> : <Eye />} Preview
            </Button>
            <Button onClick={start} disabled={ids.length === 0}>
              <Play /> Run {ids.length === enabled.length ? 'all' : `${ids.length}`}
            </Button>
          </>
        }
      />

      {enabled.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {enabled.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.has(s.id)}
                onCheckedChange={(c) => {
                  const next = new Set(selected)
                  if (c === true) next.add(s.id)
                  else next.delete(s.id)
                  setSelected(next)
                  setPlan(null)
                }}
              />
              {s.name}
            </label>
          ))}
        </div>
      )}

      {running && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Backing up
              {progress.trigger && <TriggerBadge trigger={progress.trigger} />}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={() => void api.run.cancel()}>
              <Square /> Cancel
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <div className="text-muted-foreground flex justify-between text-xs">
                <span>Overall</span>
                <span>
                  {progress.jobsDone} of {progress.totalJobs} jobs
                </span>
              </div>
              <Progress value={overallPct} />
            </div>
            {progress.currentJob && (
              <div className="grid gap-1.5">
                <div className="flex justify-between text-sm">
                  <span>
                    {n.source(progress.currentJob.sourceId)} → {n.dest(progress.currentJob.destId)}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatBytes(progress.jobBytesDone)} / {formatBytes(progress.jobBytesTotal)}
                  </span>
                </div>
                <Progress value={jobPct} />
                <div className="text-muted-foreground truncate font-mono text-xs">
                  {progress.currentFile ?? ' '}
                </div>
              </div>
            )}
            {progress.warnings.length > 0 && (
              <div className="max-h-40 overflow-auto rounded-md border p-2 text-xs">
                {progress.warnings.map((w, i) => (
                  <div key={i} className="font-mono">
                    <span className="text-amber-500">{w.code}</span> {w.path} — {w.message}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {plan && !running && (
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <PlanView plan={plan} config={config} />
          </CardContent>
        </Card>
      )}

      {log && !running && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <CardTitle>Last run</CardTitle>
            <StatusBadge status={log.status} />
            <span className="text-muted-foreground ml-auto text-xs">
              {formatDuration(new Date(log.endedAt).getTime() - new Date(log.startedAt).getTime())}
            </span>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            {log.jobs.map((j) => (
              <div key={`${j.sourceId}:${j.destId}`} className="flex items-center gap-2">
                <StatusBadge status={j.status} />
                <span>
                  {n.source(j.sourceId)} → {n.dest(j.destId)}
                </span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {j.reason
                    ? (jobOutcomeText(
                        j.reason,
                        n.dest(j.destId),
                        retryFor(status, j.sourceId, j.destId),
                        now
                      ) ?? REASONS[j.reason])
                    : formatBytes(j.bytesWritten)}
                  {j.warnings.length > 0 && ` · ${j.warnings.length} warnings`}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {status && (status.pending.length > 0 || status.pendingRetries.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {status.pending.map((r) => (
              <div key={r.id} className="flex items-center gap-2">
                <TriggerBadge trigger={r.trigger} />
                {r.jobs.map((j) => `${n.source(j.sourceId)} → ${n.dest(j.destId)}`).join(', ')}
              </div>
            ))}
            {status.pendingRetries.map((j) => (
              <div key={`${j.sourceId}:${j.destId}`} className="flex items-center gap-2">
                <Badge variant="outline">Retry when available</Badge>
                {n.source(j.sourceId)} → {n.dest(j.destId)}
                <span className="text-muted-foreground ml-auto text-xs">
                  {nextCheckIn(j.nextRetryAt, now)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
