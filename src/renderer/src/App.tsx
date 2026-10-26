import { useEffect, useState } from 'react'
import {
  FolderInput,
  HardDrive,
  History as HistoryIcon,
  Pause,
  Play,
  Settings as SettingsIcon
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
import { Sidebar, type NavItem } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
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

const NAV: NavItem[] = [
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

/** Scheduler state and the pause/resume control, shown on the right of the top bar. */
function SchedulerStatusControls({
  status,
  config
}: {
  status: SchedulerStatus | null
  config: Config
}): React.JSX.Element {
  const now = useNow()
  const paused = status?.pausedUntil != null
  return (
    <>
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          status?.active ? 'animate-pulse bg-sky-500' : paused ? 'bg-amber-500' : 'bg-emerald-500'
        )}
      />
      <span className="text-muted-foreground truncate">{statusText(status, config, now)}</span>
      <div className="app-no-drag shrink-0">
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
    </>
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
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="mx-auto mt-20 max-w-xl overflow-auto p-6">
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
    </div>
  )
}

const COLLAPSED_KEY = 'sidebar-collapsed'

/** Sidebar collapsed state, remembered in this window's local storage when it is available. */
function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      // Collapsed unless the user last left it expanded.
      return localStorage.getItem(COLLAPSED_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggle = (): void =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        // not remembered; the toggle still works for this session
      }
      return !c
    })
  return [collapsed, toggle]
}

function App(): React.JSX.Element {
  const cfg = useConfig()
  const status = useSchedulerStatus()
  const progress = useRunProgress()
  const [screen, setScreen] = useState<Screen>('sources')
  const [screenArg, setScreenArg] = useState<string | undefined>()
  const [collapsed, toggleSidebar] = useSidebarCollapsed()

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
      <div className="flex h-full flex-col">
        <TopBar sidebar={{ collapsed, onToggle: toggleSidebar }}>
          <SchedulerStatusControls status={status} config={config} />
        </TopBar>
        <div className="flex min-h-0 flex-1">
          <Sidebar
            items={NAV}
            current={screen}
            collapsed={collapsed}
            onSelect={(id) => {
              setScreen(id)
              setScreenArg(undefined)
            }}
          />
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-auto p-6">
              {/* Pages sit in one centred column so wide windows don't leave them on the left. */}
              <div className="mx-auto w-full max-w-5xl">
                {screen === 'destinations' && <Destinations cfg={cfg} config={config} />}
                {screen === 'settings' && (
                  <Settings cfg={cfg} config={config} path={cfg.state.path} />
                )}
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
            </div>
          </main>
        </div>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}

export default App
