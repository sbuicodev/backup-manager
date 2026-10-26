import { useEffect, useState } from 'react'
import {
  FolderInput,
  HardDrive,
  History as HistoryIcon,
  Pause,
  Play,
  Settings as SettingsIcon,
  type LucideIcon
} from 'lucide-react'
import type { Screen } from '@shared/ipc'
import type { Config } from '@shared/schema'
import type { SchedulerStatus } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useConfig } from '@/hooks/useConfig'
import { useNow, useSchedulerStatus } from '@/hooks/useSchedulerStatus'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { headerRetryText } from '@/lib/retry'
import { cn } from '@/lib/utils'
import { useRunProgress } from '@/hooks/useRunProgress'
import { Destinations } from '@/screens/Destinations'
import { History } from '@/screens/History'
import { Run } from '@/screens/Run'
import { Settings } from '@/screens/Settings'
import { Sources } from '@/screens/Sources'

const NAV: { id: Screen; label: string; icon: LucideIcon }[] = [
  { id: 'sources', label: 'Sources', icon: FolderInput },
  { id: 'destinations', label: 'Destinations', icon: HardDrive },
  { id: 'run', label: 'Run', icon: Play },
  { id: 'history', label: 'History', icon: HistoryIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
]

function statusText(status: SchedulerStatus | null, config: Config, now: Date): string {
  if (!status) return ''
  if (status.active) return 'Backup running…'
  if (status.pausedUntil === 'forever') return 'Schedules paused'
  if (status.pausedUntil) {
    return `Schedules paused until ${formatRelativeTime(new Date(status.pausedUntil), now)}`
  }
  const waiting = headerRetryText(status, config, now)
  if (waiting) return waiting
  const next = status.nextRuns
    .filter((n): n is { sourceId: string; at: string } => n.at !== null)
    .sort((a, b) => (a.at < b.at ? -1 : 1))[0]
  if (!next) return 'No scheduled backups'
  const name = config.sources.find((s) => s.id === next.sourceId)?.name ?? ''
  return `Next: ${name} ${formatRelativeTime(new Date(next.at), now)}`
}

function SchedulerStrip({
  status,
  config
}: {
  status: SchedulerStatus | null
  config: Config
}): React.JSX.Element {
  const now = useNow()
  const paused = status?.pausedUntil != null
  return (
    <div className="flex items-center gap-3 border-b px-6 py-2.5 text-sm">
      <span
        className={cn(
          'size-2 rounded-full',
          status?.active ? 'animate-pulse bg-sky-500' : paused ? 'bg-amber-500' : 'bg-emerald-500'
        )}
      />
      <span className="text-muted-foreground">{statusText(status, config, now)}</span>
      <div className="ml-auto">
        {paused ? (
          <Button size="sm" variant="outline" onClick={() => void api.scheduler.resume()}>
            <Play /> Resume
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Pause /> Pause
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  void api.scheduler.pause(new Date(Date.now() + 3_600_000).toISOString())
                }
              >
                For 1 hour
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void api.scheduler.pause('forever')}>
                Until resumed
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}

function ConfigError({
  errors,
  path,
  onReload
}: {
  errors: string[]
  path: string
  onReload: () => Promise<void>
}): React.JSX.Element {
  const doImport = async (): Promise<void> => {
    if (await api.config.import()) await onReload()
  }
  const reset = async (): Promise<void> => {
    await api.config.reset()
    await onReload()
  }
  return (
    <div className="mx-auto mt-20 max-w-xl p-6">
      <h1 className="text-xl font-semibold">The configuration file could not be loaded</h1>
      <p className="text-muted-foreground mt-2 text-sm break-all">{path}</p>
      <pre className="bg-muted mt-4 max-h-60 overflow-auto rounded-md p-3 text-xs">
        {errors.join('\n')}
      </pre>
      <p className="text-muted-foreground mt-4 text-sm">
        Scheduled backups are paused until this is fixed. Fix the file by hand and restart, import
        another configuration, or start over.
      </p>
      <div className="mt-4 flex gap-2">
        <Button onClick={doImport}>Import configuration…</Button>
        <Button variant="outline" onClick={reset}>
          Reset to defaults
        </Button>
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  const cfg = useConfig()
  const status = useSchedulerStatus()
  const progress = useRunProgress()
  const [screen, setScreen] = useState<Screen>('sources')
  const [screenArg, setScreenArg] = useState<string | undefined>()

  useEffect(
    () =>
      api.app.onNavigate((s, arg) => {
        setScreen(s)
        setScreenArg(arg)
      }),
    []
  )

  if (!cfg.state) return <div />
  if (!cfg.state.ok) {
    return <ConfigError errors={cfg.state.errors} path={cfg.state.path} onReload={cfg.reload} />
  }
  const config = cfg.state.config

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <aside className="bg-sidebar text-sidebar-foreground flex w-56 shrink-0 flex-col border-r p-3">
          <div className="px-3 pt-2 pb-5 text-sm font-semibold">Backup Manager</div>
          <nav className="grid gap-1">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  setScreen(id)
                  setScreenArg(undefined)
                }}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm',
                  screen === id
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60'
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </nav>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <SchedulerStrip status={status} config={config} />
          <div className="flex-1 overflow-auto p-6">
            {screen === 'destinations' && <Destinations cfg={cfg} config={config} />}
            {screen === 'settings' && <Settings cfg={cfg} config={config} path={cfg.state.path} />}
            {screen === 'sources' && <Sources cfg={cfg} config={config} status={status} />}
            {screen === 'run' && <Run config={config} status={status} progress={progress} />}
            {screen === 'history' && (
              <History
                config={config}
                status={status}
                openId={screenArg}
                refreshKey={progress.lastLog?.id ?? null}
              />
            )}
          </div>
        </main>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}

export default App
