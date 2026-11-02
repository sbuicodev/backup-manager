import { useEffect, useState } from 'react'
import { ChevronDown, FolderOpen, HardDrive, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { Config, Destination } from '@shared/schema'
import type { PairResult, SchedulerStatus } from '@shared/types'
import { SHOW_IN } from '@/components/AppSidebar'
import { DestinationDialog } from '@/components/DestinationDialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { UseConfig } from '@/hooks/useConfig'
import { useNow } from '@/hooks/useSchedulerStatus'
import { api } from '@/lib/api'
import { describeSchedule, formatBytes } from '@/lib/format'
import { backupsOn, sendBackupTo, type Selection } from '@/lib/selection'
import { pairStatus, shortPath, type Tone } from '@/lib/summary'
import { cn } from '@/lib/utils'

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  failed: 'bg-red-500',
  idle: 'bg-muted-foreground/40',
  off: 'bg-muted-foreground/40'
}

/** A drive at a glance: is it there, how much room is left, and what goes to it. */
export function DrivePage({
  cfg,
  config,
  dest,
  results,
  status,
  onSelect
}: {
  cfg: UseConfig
  config: Config
  dest: Destination
  results: PairResult[]
  status: SchedulerStatus | null
  onSelect: (s: Selection) => void
}): React.JSX.Element {
  const now = useNow()
  const [info, setInfo] = useState<{ available: boolean; freeBytes: number | null } | null>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.destinations.info(dest.id).then((i) => alive && setInfo(i))
    }
    load()
    const h = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [dest.id, dest.path])
  const going = backupsOn(config, dest.id)
  const others = config.sources.filter((s) => !going.includes(s))
  const save = async (next: Config): Promise<boolean> => {
    const errors = await cfg.save(next)
    if (errors) toast.error('Couldn’t save', { description: errors.join('\n') })
    return !errors
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-xl font-semibold">
            <HardDrive className="text-muted-foreground size-5 shrink-0" /> {dest.name}
          </h1>
          <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
            {shortPath(dest.path)}
          </p>
          <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
            <span
              className={cn(
                'size-2 rounded-full',
                info === null
                  ? 'bg-muted-foreground/40'
                  : info.available
                    ? 'bg-emerald-500'
                    : 'bg-red-500'
              )}
            />
            {info === null
              ? 'Checking…'
              : info.available
                ? `Connected${info.freeBytes !== null ? ` · ${formatBytes(info.freeBytes)} free` : ''}`
                : 'Not connected'}
            {!dest.enabled && ' · turned off'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="ghost"
            disabled={!info?.available}
            onClick={() => void api.shell.showInFolder(dest.path)}
          >
            <FolderOpen /> {SHOW_IN}
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      </header>

      <section className="grid gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium">Backups going here</h2>
        <div className="bg-card divide-y overflow-hidden rounded-lg border">
          {going.length === 0 && (
            <p className="text-muted-foreground px-3 py-2.5 text-sm">No backup goes here yet.</p>
          )}
          {going.map((s) => {
            const st = pairStatus(
              s,
              dest,
              results.find((r) => r.sourceId === s.id && r.destId === dest.id) ?? null,
              status,
              info?.available,
              now
            )
            return (
              <button
                key={s.id}
                onClick={() => onSelect({ kind: 'backup', id: s.id })}
                className="hover:bg-accent/50 flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm"
              >
                <span className={cn('size-2 shrink-0 rounded-full', TONE_DOT[st.tone])} />
                <span className="truncate font-medium">{s.name}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                  {s.setupComplete ? `${describeSchedule(s.schedule)} · ${st.text}` : 'Not set up'}
                </span>
              </button>
            )
          })}
          {others.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="hover:bg-accent/50 text-muted-foreground flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm">
                  <Plus className="size-4" /> Send another backup here
                  <ChevronDown className="ml-auto size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {others.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={() => void save(sendBackupTo(config, s.id, dest.id))}
                  >
                    {s.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </section>

      {editing && (
        <DestinationDialog
          initial={dest}
          onSave={(d) =>
            save({
              ...config,
              destinations: config.destinations.map((x) => (x.id === d.id ? d : x))
            })
          }
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}
