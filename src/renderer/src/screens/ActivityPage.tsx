import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Square } from 'lucide-react'
import type { Config } from '@shared/schema'
import type { JobStatus, RunLog, RunTrigger, SchedulerStatus } from '@shared/types'
import { ChangeList } from '@/components/ChangeList'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { RunProgress } from '@/hooks/useRunProgress'
import { useNow } from '@/hooks/useSchedulerStatus'
import { groupByDay, jobResultText } from '@/lib/activity'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

const PAGE = 30

const TRIGGER: Partial<Record<RunTrigger, string>> = {
  scheduled: 'Scheduled',
  'catch-up': 'Catch-up',
  retry: 'Retry',
  recovery: 'Recovery'
}

const DOT: Record<JobStatus, string> = {
  completed: 'bg-emerald-500',
  'completed-with-warnings': 'bg-amber-500',
  skipped: 'bg-amber-500',
  failed: 'bg-red-500',
  cancelled: 'bg-muted-foreground/40'
}

const hm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Every run, grouped by day; each job opens to its changed files. */
export function ActivityPage({
  config,
  status,
  progress,
  openRunId
}: {
  config: Config
  status: SchedulerStatus | null
  progress: RunProgress
  openRunId?: string
}): React.JSX.Element {
  const now = useNow()
  const [ids, setIds] = useState<string[]>([])
  const [logs, setLogs] = useState<RunLog[]>([])
  const [shown, setShown] = useState(PAGE)
  const [filter, setFilter] = useState('all')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const target = useRef<HTMLDivElement | null>(null)
  const refreshKey = progress.lastLog?.id ?? null

  useEffect(() => {
    void api.history.list().then((r) => setIds(r.map((x) => x.id)))
  }, [refreshKey])
  useEffect(() => {
    let alive = true
    void Promise.all(ids.slice(0, shown).map((id) => api.history.get(id))).then(
      (r) => alive && setLogs(r.filter((x): x is RunLog => x !== null))
    )
    return () => {
      alive = false
    }
  }, [ids, shown])
  useEffect(() => {
    if (!openRunId) return
    const run = logs.find((l) => l.id === openRunId)
    if (!run) return
    setOpen(new Set(run.jobs.map((j) => `${run.id}:${j.sourceId}:${j.destId}`)))
    requestAnimationFrame(() => target.current?.scrollIntoView({ block: 'start' }))
  }, [openRunId, logs])

  const name = {
    source: (id: string) => config.sources.find((s) => s.id === id)?.name ?? 'Removed backup',
    dest: (id: string) => config.destinations.find((d) => d.id === id)?.name ?? 'Removed drive'
  }
  const [kind, id] = filter.split(':')
  const matches = (j: RunLog['jobs'][number]): boolean =>
    filter === 'all' || (kind === 'backup' ? j.sourceId === id : j.destId === id)
  const visible = logs
    .map((l) => ({ ...l, jobs: l.jobs.filter(matches) }))
    .filter((l) => l.jobs.length > 0)
  const toggle = (key: string): void => {
    const next = new Set(open)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpen(next)
  }
  const pct =
    progress.jobBytesTotal > 0
      ? Math.min(100, (progress.jobBytesDone / progress.jobBytesTotal) * 100)
      : 0

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Activity</h1>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All backups and drives</SelectItem>
            <SelectGroup>
              <SelectLabel>Backups</SelectLabel>
              {config.sources.map((s) => (
                <SelectItem key={s.id} value={`backup:${s.id}`}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Drives</SelectLabel>
              {config.destinations.map((d) => (
                <SelectItem key={d.id} value={`drive:${d.id}`}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </header>

      {status?.active && progress.currentJob && (
        <div className="bg-card grid gap-2 rounded-lg border p-3 text-sm">
          <div className="flex items-center gap-3">
            <span className="font-medium">
              Backing up {name.source(progress.currentJob.sourceId)} →{' '}
              {name.dest(progress.currentJob.destId)}
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
              {progress.currentFile ?? ''}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {formatBytes(progress.jobBytesDone)} of {formatBytes(progress.jobBytesTotal)}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => void api.run.cancel()}
            >
              <Square /> Stop
            </Button>
          </div>
          <Progress value={pct} />
        </div>
      )}

      {visible.length === 0 && (
        <p className="text-muted-foreground text-sm">No backups have run yet.</p>
      )}
      {groupByDay(visible, now).map((g) => (
        <section key={g.label} className="grid gap-2">
          <h2 className="text-muted-foreground px-1 text-xs font-medium">{g.label}</h2>
          <div className="bg-card divide-y overflow-hidden rounded-lg border">
            {g.runs.map((run) => (
              <div key={run.id} ref={run.id === openRunId ? target : undefined}>
                {run.jobs.map((j) => {
                  const key = `${run.id}:${j.sourceId}:${j.destId}`
                  const canOpen = (j.changeCount ?? 0) > 0
                  return (
                    <div key={key} className="border-b last:border-0">
                      <button
                        disabled={!canOpen}
                        onClick={() => toggle(key)}
                        className="hover:bg-accent/50 flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <ChevronRight
                          className={cn(
                            'text-muted-foreground size-4 shrink-0 transition-transform',
                            !canOpen && 'invisible',
                            open.has(key) && 'rotate-90'
                          )}
                        />
                        <span className={cn('size-2 shrink-0 rounded-full', DOT[j.status])} />
                        <span className="truncate font-medium">
                          {name.source(j.sourceId)} → {name.dest(j.destId)}
                        </span>
                        <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                          {jobResultText(j)}
                        </span>
                        <span className="text-muted-foreground w-32 shrink-0 text-right text-xs whitespace-nowrap tabular-nums">
                          {TRIGGER[run.trigger] ? `${TRIGGER[run.trigger]} · ` : ''}
                          {hm(run.startedAt)}
                        </span>
                      </button>
                      {open.has(key) && (
                        <div className="px-3 pb-3 pl-9">
                          <ChangeList runId={run.id} sourceId={j.sourceId} destId={j.destId} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </section>
      ))}
      {ids.length > shown && (
        <Button
          variant="outline"
          className="justify-self-center"
          onClick={() => setShown(shown + PAGE)}
        >
          Show earlier runs
        </Button>
      )}
    </div>
  )
}
