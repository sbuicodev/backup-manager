import { t } from '@/i18n'
import { Fragment } from 'react'
import {
  CalendarClock,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Copy,
  File,
  FileArchive,
  Files,
  Filter,
  Folders,
  Gauge,
  Hand,
  Layers,
  Folder,
  FolderInput,
  FolderOpen,
  History,
  Loader2,
  Pause,
  Play,
  Square,
  Trash2
} from 'lucide-react'
import type { Config, Destination, Source, SourceItem } from '@shared/schema'
import { fileName } from '@shared/schema'
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
import { formatBytes, formatRelativeTime } from '@/lib/format'
import {
  backupTone,
  formatAgo,
  pairStatus,
  settingsTiles,
  shortPath,
  type BackupTone,
  type Pill,
  type SettingsTile,
  type Tone
} from '@/lib/summary'
import { cn } from '@/lib/utils'

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  failed: 'bg-red-500',
  idle: 'bg-muted-foreground/40',
  off: 'bg-muted-foreground/40'
}

/** The big status icon, by how the backup is doing overall. */
const STATE_ICON: Record<BackupTone, { icon: typeof CircleCheck; className: string }> = {
  ok: { icon: CircleCheck, className: 'text-emerald-500' },
  waiting: { icon: Clock, className: 'text-amber-500' },
  failed: { icon: CircleAlert, className: 'text-red-500' },
  running: { icon: Loader2, className: 'text-sky-500 animate-spin' },
  idle: { icon: CircleDashed, className: 'text-muted-foreground' },
  paused: { icon: Pause, className: 'text-muted-foreground' },
  notSetUp: { icon: CircleDashed, className: 'text-muted-foreground' }
}

/** Each tile's icon and the colour of its icon square. */
const TILE_LOOK: Record<SettingsTile['id'], { icon: typeof CircleCheck; className: string }> = {
  schedule: { icon: CalendarClock, className: 'bg-sky-500/15 text-sky-500' },
  versions: { icon: Copy, className: 'bg-emerald-500/15 text-emerald-500' },
  zip: { icon: FileArchive, className: 'bg-amber-500/15 text-amber-500' },
  general: { icon: FolderOpen, className: 'bg-violet-500/15 text-violet-500' }
}

const DETAIL_ICON: Record<SettingsTile['details'][number]['icon'], typeof CircleCheck> = {
  hand: Hand,
  trash: Trash2,
  layers: Layers,
  filter: Filter,
  gauge: Gauge,
  folders: Folders,
  files: Files
}

const PILL: Record<Pill['tone'], string> = {
  accent: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  neutral: 'bg-muted text-muted-foreground',
  pro: 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
}

/** One setting as a card: coloured icon, label and value, then details and pills. */
function SettingsTileCard({
  tile,
  onClick
}: {
  tile: SettingsTile
  onClick: () => void
}): React.JSX.Element {
  const look = TILE_LOOK[tile.id]
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-card hover:bg-accent/40 group grid content-start gap-2.5 rounded-lg border p-3.5 text-left text-sm transition-colors"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            look.className
          )}
        >
          <look.icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground block text-xs">{tile.label}</span>
          <span className="block truncate font-medium">{tile.value}</span>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {tile.details.map((d) => {
        const Icon = DETAIL_ICON[d.icon]
        return (
          <span
            key={d.text}
            className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs"
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate" title={d.text}>
              {d.text}
            </span>
          </span>
        )
      })}
      {tile.pills.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {tile.pills.map((p) => (
            <span
              key={p.text}
              className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', PILL[p.tone])}
            >
              {p.text}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

/** Items at the top level first, then one group per subfolder, by name. */
function groupBySubfolder(items: SourceItem[]): Array<[string, SourceItem[]]> {
  const groups = new Map<string, SourceItem[]>([['', []]])
  for (const it of items) groups.set(it.folder ?? '', [...(groups.get(it.folder ?? '') ?? []), it])
  return [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
}

const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`

/** A titled card whose rows open the configuration. */
function Card({
  title,
  children
}: {
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="grid content-start gap-2">
      {title && <h2 className="text-muted-foreground px-1 text-xs font-medium">{title}</h2>}
      <div className="bg-card divide-y overflow-hidden rounded-lg border">{children}</div>
    </section>
  )
}

/** A clickable row; hovering shows the chevron that says it opens something. */
function LinkRow({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group hover:bg-accent/50 flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left text-sm"
    >
      {children}
      <ChevronRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

/** One destination: status, Check now, and Show in Finder on right-click. */
function DestinationRow({
  source,
  dest,
  result,
  status,
  available,
  now,
  onEdit
}: {
  source: Source
  dest: Destination
  result: PairResult | null
  status: SchedulerStatus | null
  available: boolean | undefined
  now: Date
  onEdit: () => void
}): React.JSX.Element {
  const st = pairStatus(source, dest, result, status, available, now)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex min-w-0 items-center">
          <LinkRow onClick={onEdit}>
            <span className={cn('size-2 shrink-0 rounded-full', TONE_DOT[st.tone])} />
            <span className="truncate font-medium">{dest.name}</span>
            {dest.ownerSourceId && (
              <Badge variant="secondary" className="shrink-0">
                {t('form.custom')}
              </Badge>
            )}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs">{st.text}</span>
          </LinkRow>
          {st.canCheckNow && (
            <Button
              size="sm"
              variant="outline"
              className="mr-3 h-7 shrink-0"
              onClick={() => void api.scheduler.checkNow(source.id, dest.id)}
            >
              {t('page.checkNow')}
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

/** A backup at a glance: how it is doing, what it holds, where it goes, and how. */
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
  /** Opens the configuration, at a section when given. */
  onEdit: (section?: string) => void
  onOpenRun: (runId: string) => void
}): React.JSX.Element {
  const now = useNow()
  const dests = destinationsOf(config, source)
  const mine = results
    .filter((r) => r.sourceId === source.id && dests.some((d) => d.id === r.destId))
    .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1))
  const last = mine[0]
  const tone = backupTone(source, dests, results, status, running)
  const State = STATE_ICON[tone]
  const nextAt = status?.nextRuns.find((n) => n.sourceId === source.id)?.at ?? null
  const detail = [
    last ? t('page.lastBackup', { ago: formatAgo(new Date(last.endedAt), now) }) : null,
    last?.changeCount ? t('page.changedCount', { count: last.changeCount }) : null,
    nextAt && source.enabled
      ? t('page.nextAt', { time: formatRelativeTime(new Date(nextAt), now) })
      : null
  ].filter(Boolean)
  const pct =
    progress.jobBytesTotal > 0
      ? Math.min(100, (progress.jobBytesDone / progress.jobBytesTotal) * 100)
      : 0

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="truncate text-xl font-semibold">{source.name}</h1>
        <Button variant="outline" onClick={() => onEdit()}>
          {t('page.edit')}
        </Button>
      </header>

      <div className="bg-card grid gap-3 rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <State.icon className={cn('size-7 shrink-0', State.className)} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t(`page.state.${tone}`)}</div>
            <div className="text-muted-foreground truncate text-sm">
              {running ? (progress.currentFile ?? '') : detail.join(' · ')}
            </div>
          </div>
          {last && !running && (
            <Button variant="ghost" size="sm" onClick={() => onOpenRun(last.runId)}>
              <History /> {t('page.history')}
            </Button>
          )}
          {running ? (
            <Button variant="outline" size="sm" onClick={() => void api.run.cancel()}>
              <Square /> {t('common.stop')}
            </Button>
          ) : source.setupComplete ? (
            <Button
              size="sm"
              disabled={!source.enabled}
              onClick={() => void api.run.start([source.id])}
            >
              <Play /> {t('page.backUpNow')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => onEdit()}>
              {t('page.finishSetup')}
            </Button>
          )}
        </div>
        {running && (
          <div className="grid gap-1">
            <Progress value={pct} />
            <span className="text-muted-foreground text-right text-xs tabular-nums">
              {formatBytes(progress.jobBytesDone)} / {formatBytes(progress.jobBytesTotal)}
            </span>
          </div>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title={t('page.files')}>
          {source.items.length === 0 && (
            <LinkRow onClick={() => onEdit('items')}>
              <span className="text-muted-foreground flex-1">{t('page.noItems')}</span>
            </LinkRow>
          )}
          {groupBySubfolder(source.items).map(([folder, group]) => (
            <Fragment key={folder}>
              {folder && (
                <LinkRow onClick={() => onEdit('items')}>
                  <FolderInput className="size-4 shrink-0 text-sky-500" />
                  <span className="min-w-0 flex-1 truncate font-medium">{folder}</span>
                </LinkRow>
              )}
              {group.map((it) => {
                const Icon = it.kind === 'folder' ? Folder : File
                return (
                  <LinkRow key={it.path} onClick={() => onEdit('items')}>
                    {folder && <span className="w-4 shrink-0" />}
                    <Icon className="text-muted-foreground size-4 shrink-0" />
                    <span className="max-w-[60%] shrink-0 truncate font-medium">
                      {it.alias ? <em>{it.alias}</em> : fileName(it.path)}
                    </span>
                    {it.alias && (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {fileName(it.path)}
                      </span>
                    )}
                    <span
                      className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs"
                      title={it.path}
                    >
                      {shortPath(it.path)}
                    </span>
                  </LinkRow>
                )
              })}
            </Fragment>
          ))}
        </Card>
        <Card title={t('page.destinations')}>
          {dests.length === 0 && (
            <LinkRow onClick={() => onEdit('where')}>
              <span className="text-muted-foreground flex-1">{t('page.noDrives')}</span>
            </LinkRow>
          )}
          {dests.map((d) => (
            <DestinationRow
              key={d.id}
              source={source}
              dest={d}
              result={mine.find((r) => r.destId === d.id) ?? null}
              status={status}
              available={availability[d.id]}
              now={now}
              onEdit={() => onEdit('where')}
            />
          ))}
        </Card>
      </div>

      <section className="grid gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium">{t('page.settings')}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {settingsTiles(source).map((tile) => (
            <SettingsTileCard key={tile.id} tile={tile} onClick={() => onEdit(tile.id)} />
          ))}
        </div>
      </section>
    </div>
  )
}
