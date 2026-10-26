import { Fragment, useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, History as HistoryIcon } from 'lucide-react'
import type { Config } from '@shared/schema'
import type { RunLog, RunSummary, SchedulerStatus } from '@shared/types'
import { ChangeList } from '@/components/ChangeList'
import { PageHeader } from '@/components/PageHeader'
import { REASONS, StatusBadge, TriggerBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { useNow } from '@/hooks/useSchedulerStatus'
import { api } from '@/lib/api'
import { formatBytes, formatDuration, formatRelativeTime } from '@/lib/format'
import { retryFor } from '@/lib/retry'

const duration = (r: { startedAt: string; endedAt: string }): string =>
  formatDuration(new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime())

function RunDetail({
  log,
  config,
  status,
  onBack
}: {
  log: RunLog
  config: Config
  status: SchedulerStatus | null
  onBack: () => void
}): React.JSX.Element {
  const source = (id: string): string =>
    config.sources.find((s) => s.id === id)?.name ?? 'Removed source'
  const dest = (id: string): string =>
    config.destinations.find((d) => d.id === id)?.name ?? 'Removed destination'
  const warnings = log.jobs.flatMap((j) => j.warnings.map((w) => ({ ...w, job: j })))
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (key: string): void => {
    const next = new Set(open)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpen(next)
  }
  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <h1 className="text-xl font-semibold">{new Date(log.startedAt).toLocaleString()}</h1>
        <StatusBadge status={log.status} />
        <TriggerBadge trigger={log.trigger} />
        <span className="text-muted-foreground ml-auto text-sm">{duration(log)}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Source → destination</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Changes</TableHead>
            <TableHead className="text-right">Written</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {log.jobs.map((j) => {
            const c = j.counts
            const changes = [
              c.copied && `${c.copied} copied`,
              c.updated && `${c.updated} updated`,
              c.zipped && `${c.zipped} zipped`,
              c.trashed && `${c.trashed} trashed`,
              c.deleted && `${c.deleted} deleted`,
              c.pruned && `${c.pruned} pruned`,
              c.skipped && `${c.skipped} skipped`
            ].filter(Boolean)
            const key = `${j.sourceId}:${j.destId}`
            const expandable = (j.changeCount ?? 0) > 0
            return (
              <Fragment key={key}>
                <TableRow
                  className={expandable ? 'cursor-pointer' : undefined}
                  onClick={() => expandable && toggle(key)}
                >
                  <TableCell>
                    {expandable && (
                      <ChevronRight
                        className={`size-4 transition-transform ${open.has(key) ? 'rotate-90' : ''}`}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {source(j.sourceId)} → {dest(j.destId)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={j.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {j.reason ? (
                      <span className="text-muted-foreground">
                        {REASONS[j.reason]}
                        {j.error && ` (${j.error})`}
                        {retryFor(status, j.sourceId, j.destId) && ' · retry pending'}
                      </span>
                    ) : (
                      changes.join(' · ') || 'No changes'
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(j.bytesWritten)}
                  </TableCell>
                </TableRow>
                {open.has(key) && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="whitespace-normal">
                      <ChangeList runId={log.id} sourceId={j.sourceId} destId={j.destId} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
      {warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Warnings ({warnings.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {warnings.map((w, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs text-amber-500">{w.code}</TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-xs">{w.path}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{w.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export function History({
  config,
  status,
  openId,
  refreshKey
}: {
  config: Config
  status: SchedulerStatus | null
  openId?: string
  refreshKey: string | null
}): React.JSX.Element {
  const now = useNow()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<RunLog | null>(null)

  useEffect(() => {
    void api.history.list().then(setRuns)
  }, [refreshKey])
  useEffect(() => {
    if (openId) void api.history.get(openId).then(setSelected)
  }, [openId])

  if (selected)
    return (
      <RunDetail log={selected} config={config} status={status} onBack={() => setSelected(null)} />
    )

  return (
    <div>
      <PageHeader title="History" description="The last 200 backup runs." />
      {runs.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-sm">
          <HistoryIcon className="size-8" />
          No backups have run yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Jobs</TableHead>
              <TableHead className="text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() => void api.history.get(r.id).then(setSelected)}
              >
                <TableCell>{formatRelativeTime(new Date(r.startedAt), now)}</TableCell>
                <TableCell>
                  <TriggerBadge trigger={r.trigger} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell>{r.jobCount}</TableCell>
                <TableCell className="text-right">{duration(r)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
