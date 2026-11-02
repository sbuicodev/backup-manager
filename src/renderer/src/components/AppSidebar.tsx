import { useState } from 'react'
import { Archive, HardDrive, History, Pause, Plus, Settings } from 'lucide-react'
import { toast } from 'sonner'
import type { Config, Destination, Source } from '@shared/schema'
import type { PairResult, SchedulerStatus } from '@shared/types'
import { DestinationDialog } from '@/components/DestinationDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { UseConfig } from '@/hooks/useConfig'
import { api } from '@/lib/api'
import { duplicateSource, type Selection } from '@/lib/selection'
import { backupTone, type BackupTone } from '@/lib/summary'
import { cn } from '@/lib/utils'

const DOT: Record<BackupTone, string> = {
  ok: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  failed: 'bg-red-500',
  running: 'bg-sky-500 animate-pulse',
  idle: 'bg-muted-foreground/40',
  paused: 'bg-muted-foreground/40',
  notSetUp: 'border border-muted-foreground/60 bg-transparent'
}

const TONE_LABEL: Record<BackupTone, string> = {
  ok: 'Backed up',
  waiting: 'Waiting',
  failed: 'Failed',
  running: 'Backing up',
  idle: 'Not backed up yet',
  paused: 'Paused',
  notSetUp: 'Not set up'
}

/** The OS file browser's name, for "Show in …". */
export const SHOW_IN =
  api.app.platform === 'darwin'
    ? 'Show in Finder'
    : api.app.platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in folder'

/** Joins a destination folder and a name with that folder's own separator. */
const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`

/** Destinations a backup goes to: its own ones and the shared ones it selects. */
export function destinationsOf(config: Config, s: Source): Destination[] {
  return config.destinations.filter((d) =>
    d.ownerSourceId !== null
      ? d.ownerSourceId === s.id
      : s.destinationIds === 'all' || s.destinationIds.includes(d.id)
  )
}

function Row({
  selected,
  collapsed,
  label,
  icon,
  muted,
  onClick
}: {
  selected: boolean
  collapsed: boolean
  label: string
  icon: React.ReactNode
  muted?: boolean
  onClick: () => void
}): React.JSX.Element {
  const button = (
    <button
      aria-label={label}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left text-sm whitespace-nowrap',
        selected
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
          : 'hover:bg-sidebar-accent/60',
        muted && !selected && 'text-muted-foreground'
      )}
    >
      {icon}
      <span className={cn('truncate transition-opacity', collapsed && 'opacity-0')}>{label}</span>
    </button>
  )
  if (!collapsed) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function Heading({
  collapsed,
  children,
  action
}: {
  collapsed: boolean
  children: string
  action?: React.ReactNode
}): React.JSX.Element {
  if (collapsed) return <div className="bg-border mx-2 my-2 h-px" />
  return (
    <div className="text-muted-foreground mt-3 mb-1 flex h-6 items-center justify-between px-2.5 text-xs font-medium">
      {children}
      {action}
    </div>
  )
}

/** Backups, drives and Activity, with the actions people expect on a right-click. */
export function AppSidebar({
  cfg,
  config,
  selection,
  onSelect,
  collapsed,
  status,
  results,
  availability,
  runningSourceId
}: {
  cfg: UseConfig
  config: Config
  selection: Selection
  onSelect: (s: Selection) => void
  collapsed: boolean
  status: SchedulerStatus | null
  results: PairResult[]
  availability: Record<string, boolean>
  runningSourceId: string | null
}): React.JSX.Element {
  const [editingDrive, setEditingDrive] = useState<Destination | 'new' | null>(null)
  const [deletingBackup, setDeletingBackup] = useState<Source | null>(null)
  const [removingDrive, setRemovingDrive] = useState<Destination | null>(null)
  const shared = config.destinations.filter((d) => d.ownerSourceId === null)

  const save = async (next: Config): Promise<boolean> => {
    const errors = await cfg.save(next)
    if (errors) toast.error('Couldn’t save', { description: errors.join('\n') })
    return !errors
  }
  const patchSource = (s: Source): Promise<boolean> =>
    save({ ...config, sources: config.sources.map((x) => (x.id === s.id ? s : x)) })
  const upsertDrive = (d: Destination): Promise<boolean> =>
    save({
      ...config,
      destinations: config.destinations.some((x) => x.id === d.id)
        ? config.destinations.map((x) => (x.id === d.id ? d : x))
        : [...config.destinations, d]
    })
  const showBackupInFinder = async (s: Source): Promise<void> => {
    const d = destinationsOf(config, s).find((x) => availability[x.id])
    if (!d || !(await api.shell.showInFolder(joinPath(d.path, s.slug)))) {
      toast.error('No connected drive holds this backup yet')
    }
  }
  const sel = (kind: 'backup' | 'drive', id: string): boolean =>
    selection.kind === kind && 'id' in selection && selection.id === id
  const ownedByDeleting = deletingBackup
    ? config.destinations.filter((d) => d.ownerSourceId === deletingBackup.id)
    : []
  const usingRemoved = removingDrive
    ? config.sources.filter(
        (s) => s.destinationIds !== 'all' && s.destinationIds.includes(removingDrive.id)
      )
    : []

  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200',
        collapsed ? 'w-[60px]' : 'w-60'
      )}
    >
      <nav className="grid flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] gap-0.5 overflow-y-auto p-3">
        <Heading collapsed={collapsed}>Backups</Heading>
        {config.sources.map((s) => {
          const tone = backupTone(
            s,
            destinationsOf(config, s),
            results,
            status,
            runningSourceId === s.id
          )
          return (
            <ContextMenu key={s.id}>
              <ContextMenuTrigger asChild>
                <div>
                  <Row
                    selected={sel('backup', s.id)}
                    collapsed={collapsed}
                    label={collapsed ? `${s.name} — ${TONE_LABEL[tone]}` : s.name}
                    muted={tone === 'notSetUp' || tone === 'paused'}
                    onClick={() => onSelect({ kind: 'backup', id: s.id })}
                    icon={
                      <span className="relative flex size-4 shrink-0 items-center justify-center">
                        {collapsed && <Archive className="size-4" />}
                        {tone === 'paused' && !collapsed ? (
                          <Pause className="text-muted-foreground size-3" />
                        ) : (
                          <span
                            aria-label={TONE_LABEL[tone]}
                            className={cn(
                              'rounded-full',
                              collapsed ? 'absolute -right-0.5 -bottom-0.5 size-2' : 'size-2',
                              DOT[tone]
                            )}
                          />
                        )}
                      </span>
                    }
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  disabled={!s.setupComplete || !s.enabled}
                  onSelect={() => void api.run.start([s.id])}
                >
                  Back up now
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void patchSource({ ...s, enabled: !s.enabled })}>
                  {s.enabled ? 'Pause this backup' : 'Resume this backup'}
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() =>
                    void save({
                      ...config,
                      sources: [
                        ...config.sources,
                        duplicateSource(
                          s,
                          config.sources.map((x) => x.slug)
                        )
                      ]
                    })
                  }
                >
                  Duplicate
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void showBackupInFinder(s)}>
                  {SHOW_IN}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => setDeletingBackup(s)}>
                  Delete…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}

        <Heading
          collapsed={collapsed}
          action={
            <button
              aria-label="Add drive"
              className="hover:text-foreground rounded p-0.5"
              onClick={() => setEditingDrive('new')}
            >
              <Plus className="size-3.5" />
            </button>
          }
        >
          Drives
        </Heading>
        {shared.map((d) => (
          <ContextMenu key={d.id}>
            <ContextMenuTrigger asChild>
              <div>
                <Row
                  selected={sel('drive', d.id)}
                  collapsed={collapsed}
                  label={availability[d.id] === false ? `${d.name} (not connected)` : d.name}
                  muted={availability[d.id] === false || !d.enabled}
                  onClick={() => onSelect({ kind: 'drive', id: d.id })}
                  icon={<HardDrive className="size-4 shrink-0" />}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={!availability[d.id]}
                onSelect={() => void api.shell.showInFolder(d.path)}
              >
                {SHOW_IN}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => setEditingDrive(d)}>Edit…</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => setRemovingDrive(d)}>
                Remove…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}

        <Heading collapsed={collapsed}> </Heading>
        <Row
          selected={selection.kind === 'activity'}
          collapsed={collapsed}
          label="Activity"
          onClick={() => onSelect({ kind: 'activity' })}
          icon={<History className="size-4 shrink-0" />}
        />
      </nav>

      <div className={cn('flex gap-1 border-t p-2', collapsed && 'flex-col')}>
        <Row
          selected={selection.kind === 'new'}
          collapsed={collapsed}
          label="New backup"
          onClick={() => onSelect({ kind: 'new' })}
          icon={<Plus className="size-4 shrink-0" />}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="Settings"
              onClick={() => onSelect({ kind: 'settings' })}
              className={cn(
                'hover:bg-sidebar-accent/60 flex size-8 shrink-0 items-center justify-center rounded-md',
                selection.kind === 'settings' && 'bg-sidebar-accent'
              )}
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </div>

      {editingDrive && (
        <DestinationDialog
          initial={editingDrive === 'new' ? null : editingDrive}
          onSave={upsertDrive}
          onClose={() => setEditingDrive(null)}
        />
      )}
      <AlertDialog
        open={deletingBackup !== null}
        onOpenChange={(o) => !o && setDeletingBackup(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deletingBackup?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It won’t be backed up any more. Existing backups on your drives aren’t deleted.
              {ownedByDeleting.length > 0 &&
                ` Its own drives are removed too: ${ownedByDeleting.map((d) => d.name).join(', ')}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deletingBackup &&
                void save({
                  ...config,
                  destinations: config.destinations.filter(
                    (d) => d.ownerSourceId !== deletingBackup.id
                  ),
                  sources: config.sources.filter((x) => x.id !== deletingBackup.id)
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removingDrive !== null} onOpenChange={(o) => !o && setRemovingDrive(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removingDrive?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Backups already on it aren’t deleted.
              {usingRemoved.length > 0 &&
                ` It’s also removed from: ${usingRemoved.map((s) => s.name).join(', ')}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                removingDrive &&
                void save({
                  ...config,
                  destinations: config.destinations.filter((x) => x.id !== removingDrive.id),
                  sources: config.sources.map((s) =>
                    s.destinationIds === 'all'
                      ? s
                      : {
                          ...s,
                          destinationIds: s.destinationIds.filter((id) => id !== removingDrive.id)
                        }
                  )
                })
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}
