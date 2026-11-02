import { useEffect, useState } from 'react'
import { Archive, Pause, Play, Plus, Square } from 'lucide-react'
import type { Config } from '@shared/schema'
import type { SchedulerStatus } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AppSidebar } from '@/components/AppSidebar'
import { TopBar } from '@/components/TopBar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAvailability } from '@/hooks/useAvailability'
import { useLatestResults } from '@/hooks/useLatestResults'
import { planPreview, resolveSelection, type Selection } from '@/lib/selection'
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
import { BackupPage } from '@/screens/BackupPage'
import { Settings } from '@/screens/Settings'
import { SourceEditor } from '@/screens/SourceEditor'
import { Sources } from '@/screens/Sources'

/** Back up now, or Stop while a run is active; hovering previews what a run would do. */
function BackUpNowButton({ running }: { running: boolean }): React.JSX.Element {
  const [preview, setPreview] = useState('Checking what to back up…')
  if (running) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="app-no-drag"
        onClick={() => void api.run.cancel()}
      >
        <Square /> Stop
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          className="app-no-drag"
          onMouseEnter={() => {
            setPreview('Checking what to back up…')
            void api.run.plan().then((p) => setPreview(planPreview(p)))
          }}
          onClick={() => void api.run.start()}
        >
          <Play /> Back up now
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{preview}</TooltipContent>
    </Tooltip>
  )
}

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
      <div className="app-no-drag flex shrink-0 gap-2">
        {paused ? (
          <Button size="sm" variant="outline" onClick={() => void api.scheduler.resume()}>
            <Play /> Resume
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
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
        <BackUpNowButton running={status?.active != null} />
      </div>
    </>
  )
}

/** First launch: nothing to back up yet. */
function EmptyState({ onNew }: { onNew: () => void }): React.JSX.Element {
  return (
    <div className="mx-auto mt-24 grid max-w-sm justify-items-center gap-3 text-center">
      <Archive className="text-muted-foreground size-10" />
      <h1 className="text-lg font-semibold">Choose what to back up</h1>
      <p className="text-muted-foreground text-sm">
        Pick files and folders, then where they should go. It takes a minute.
      </p>
      <Button onClick={onNew}>
        <Plus /> New backup
      </Button>
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

/**
 * Puts `glass` on <html> while the glass appearance is on, plus `glass-native` where the window
 * has a native material behind a see-through page (macOS vibrancy, Windows acrylic).
 */
function useGlassClasses(glass: boolean): void {
  useEffect(() => {
    const html = document.documentElement
    html.classList.toggle('glass', glass)
    html.classList.toggle('glass-native', glass && ['darwin', 'win32'].includes(api.app.platform))
  }, [glass])
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
  const results = useLatestResults()
  const availability = useAvailability()
  const [picked, setPicked] = useState<Selection | null>(null)
  const [runId, setRunId] = useState<string | undefined>()
  // Until editing moves onto the page (Task 6), Edit opens the previous editor sheet.
  const [editing, setEditing] = useState<string | null>(null)
  const [collapsed, toggleSidebar] = useSidebarCollapsed()
  const glass = cfg.state?.ok ? cfg.state.config.settings.glass : false
  useGlassClasses(glass)

  useEffect(
    () =>
      // Notifications open a run in Activity; anything else goes to its new home.
      api.app.onNavigate((s, arg) => {
        setPicked(s === 'settings' ? { kind: 'settings' } : { kind: 'activity' })
        setRunId(s === 'history' ? arg : undefined)
      }),
    []
  )
  useEffect(() => api.app.onSelect((sel) => setPicked(sel)), [])

  if (!cfg.state) return <div />
  if (!cfg.state.ok) {
    return <ConfigError errors={cfg.state.errors} path={cfg.state.path} onReload={cfg.reload} />
  }
  const config = cfg.state.config
  const selection = resolveSelection(picked, config)
  const select = (s: Selection): void => {
    setPicked(s)
    setRunId(undefined)
  }
  const runningSourceId = status?.active ? (progress.currentJob?.sourceId ?? null) : null

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TopBar sidebar={{ collapsed, onToggle: toggleSidebar }}>
          <SchedulerStatusControls status={status} config={config} />
        </TopBar>
        <div className="flex min-h-0 flex-1">
          <AppSidebar
            cfg={cfg}
            config={config}
            selection={selection}
            onSelect={select}
            collapsed={collapsed}
            status={status}
            results={results}
            availability={availability}
            runningSourceId={runningSourceId}
          />
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-auto p-6">
              {/* Pages sit in one centred column so wide windows don't leave them on the left. */}
              <div className="mx-auto w-full max-w-5xl">
                {selection.kind === 'empty' && <EmptyState onNew={() => select({ kind: 'new' })} />}
                {/* Until their new pages land, these show the previous screens. */}
                {selection.kind === 'backup' && (
                  <BackupPage
                    config={config}
                    source={config.sources.find((x) => x.id === selection.id)!}
                    status={status}
                    results={results}
                    availability={availability}
                    progress={progress}
                    running={runningSourceId === selection.id}
                    onEdit={() => setEditing(selection.id)}
                    onOpenRun={(id) => {
                      setPicked({ kind: 'activity' })
                      setRunId(id)
                    }}
                  />
                )}
                {selection.kind === 'new' && <Sources cfg={cfg} config={config} status={status} />}
                {selection.kind === 'drive' && <Destinations cfg={cfg} config={config} />}
                {selection.kind === 'activity' && (
                  <History
                    config={config}
                    status={status}
                    openId={runId}
                    refreshKey={progress.lastLog?.id ?? null}
                  />
                )}
                {selection.kind === 'settings' && (
                  <Settings cfg={cfg} config={config} path={cfg.state.path} />
                )}
              </div>
            </div>
          </main>
        </div>
      </div>
      {editing && config.sources.some((x) => x.id === editing) && (
        <SourceEditor
          config={config}
          initial={config.sources.find((x) => x.id === editing)!}
          onSave={cfg.save}
          onClose={() => setEditing(null)}
        />
      )}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}

export default App
