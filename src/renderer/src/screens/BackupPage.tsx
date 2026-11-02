import { ChevronRight, File, Folder, Square } from 'lucide-react'
import type { Config, Destination, Source } from '@shared/schema'
import type { PairResult, SchedulerStatus } from '@shared/types'
import { destinationsOf, SHOW_IN } from '@/components/AppSidebar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Progress } from '@/components/ui/progress'
import type { RunProgress } from '@/hooks/useRunProgress'
import { useNow } from '@/hooks/useSchedulerStatus'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import {
  backupSummary,
  formatAgo,
  optionsSummary,
  pairStatus,
  shortPath,
  type Tone
} from '@/lib/summary'
import { fileName } from '@shared/schema'
import { cn } from '@/lib/utils'
import { BackupForm } from '@/components/BackupForm'
import type { Draft } from '@/lib/backup-draft'

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  failed: 'bg-red-500',
  idle: 'bg-muted-foreground/40',
  off: 'bg-muted-foreground/40'
}

const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`

function Block({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="grid content-start gap-2">
      <h2 className="text-muted-foreground px-1 text-xs font-medium">{title}</h2>
      <div className="bg-card divide-y overflow-hidden rounded-lg border">{children}</div>
    </section>
  )
}

/** One drive in a backup's Where list: status, Check now, and Show in Finder on right-click. */
function WhereRow({
  source,
  dest,
  result,
  status,
  available,
  now
}: {
  source: Source
  dest: Destination
  result: PairResult | null
  status: SchedulerStatus | null
  available: boolean | undefined
  now: Date
}): React.JSX.Element {
  const st = pairStatus(source, dest, result, status, available, now)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex min-w-0 items-center gap-2 px-3 py-2.5 text-sm">
          <span className={cn('size-2 shrink-0 rounded-full', TONE_DOT[st.tone])} />
          <span className="truncate font-medium">{dest.name}</span>
          {dest.ownerSourceId && (
            <Badge variant="secondary" className="shrink-0">
              only this backup
            </Badge>
          )}
          <span className="text-muted-foreground ml-auto shrink-0 text-xs">{st.text}</span>
          {st.canCheckNow && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0"
              onClick={() => void api.scheduler.checkNow(source.id, dest.id)}
            >
              Check now
            </Button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!available}
          onSelect={() => void api.shell.showInFolder(joinPath(dest.path, source.slug))}
        >
          {SHOW_IN}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** A backup at a glance: what it holds, where it goes and how each drive is doing. */
export function BackupPage({
  config,
  source,
  status,
  results,
  availability,
  progress,
  running,
  onEdit,
  onOpenRun
}: {
  config: Config
  source: Source
  status: SchedulerStatus | null
  results: PairResult[]
  availability: Record<string, boolean>
  progress: RunProgress
  running: boolean
  onEdit: () => void
  onOpenRun: (runId: string) => void
}): React.JSX.Element {
  const now = useNow()
  const dests = destinationsOf(config, source)
  const mine = results
    .filter((r) => r.sourceId === source.id && dests.some((d) => d.id === r.destId))
    .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1))
  const lastOk = mine.find(
    (r) => r.status === 'completed' || r.status === 'completed-with-warnings'
  )
  const last = mine[0]
  const pct =
    progress.jobBytesTotal > 0
      ? Math.min(100, (progress.jobBytesDone / progress.jobBytesTotal) * 100)
      : 0

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{source.name}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {backupSummary(source, lastOk?.endedAt ?? null, now)}
          </p>
        </div>
        <Button variant={source.setupComplete ? 'outline' : 'default'} onClick={onEdit}>
          {source.setupComplete ? 'Edit' : 'Finish setting up'}
        </Button>
      </header>

      {running && (
        <div className="bg-card grid gap-2 rounded-lg border p-3 text-sm">
          <div className="flex items-center gap-3">
            <span className="font-medium">Backing up</span>
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

      <div className="grid gap-6 md:grid-cols-2">
        <Block title="What">
          {source.items.length === 0 && (
            <p className="text-muted-foreground px-3 py-2.5 text-sm">Nothing chosen yet.</p>
          )}
          {source.items.map((it) => {
            const Icon = it.kind === 'folder' ? Folder : File
            return (
              <div key={it.path} className="flex min-w-0 items-center gap-2 px-3 py-2.5 text-sm">
                <Icon className="text-muted-foreground size-4 shrink-0" />
                <span className="max-w-[60%] shrink-0 truncate font-medium">
                  {fileName(it.path)}
                </span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate pl-2 text-right font-mono text-xs">
                  {shortPath(it.path)}
                </span>
              </div>
            )
          })}
        </Block>
        <Block title="Where">
          {dests.length === 0 && (
            <p className="text-muted-foreground px-3 py-2.5 text-sm">No drive chosen yet.</p>
          )}
          {dests.map((d) => (
            <WhereRow
              key={d.id}
              source={source}
              dest={d}
              result={mine.find((r) => r.destId === d.id) ?? null}
              status={status}
              available={availability[d.id]}
              now={now}
            />
          ))}
        </Block>
      </div>

      {source.setupComplete && (
        <div className="bg-card divide-y overflow-hidden rounded-lg border text-sm">
          <button
            className="hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2.5 text-left disabled:cursor-default disabled:hover:bg-transparent"
            disabled={!last}
            onClick={() => last && onOpenRun(last.runId)}
          >
            <span className="text-muted-foreground w-20 shrink-0">Last run</span>
            <span className="min-w-0 flex-1 truncate">
              {last
                ? `${formatAgo(new Date(last.endedAt), now)}${
                    last.changeCount ? ` · ${last.changeCount} changed` : ''
                  }`
                : 'Not backed up yet'}
            </span>
            {last && <ChevronRight className="text-muted-foreground size-4" />}
          </button>
          <button
            className="hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2.5 text-left"
            onClick={onEdit}
          >
            <span className="text-muted-foreground w-20 shrink-0">Options</span>
            <span className="min-w-0 flex-1 truncate">{optionsSummary(source)}</span>
            <ChevronRight className="text-muted-foreground size-4" />
          </button>
        </div>
      )}
    </div>
  )
}

/** A backup's page while editing: every setting, saved only by Save. */
export function BackupEditPage({
  config,
  draft,
  onChange,
  dirty,
  errors,
  onSave,
  onCancel
}: {
  config: Config
  draft: Draft
  onChange: (d: Draft) => void
  dirty: boolean
  errors: Record<string, string>
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="grid gap-6 pb-20">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="truncate text-xl font-semibold">
          {draft.source.name.trim() || 'New backup'}
        </h1>
        {dirty && (
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span className="size-1.5 rounded-full bg-amber-500" /> Unsaved changes
          </span>
        )}
      </header>
      <BackupForm config={config} draft={draft} onChange={onChange} errors={errors} />
      <div className="bg-background/90 sticky bottom-0 -mx-1 flex justify-end gap-2 border-t px-1 py-3 backdrop-blur">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSave}>Save</Button>
      </div>
    </div>
  )
}
