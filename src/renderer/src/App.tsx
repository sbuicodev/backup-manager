import { t } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import { Archive, Pause, Play, Plus, Square } from 'lucide-react'
import type { Config, Destination } from '@shared/schema'
import { toast } from 'sonner'
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
import { leaveTo, planPreview, resolveSelection, type Selection } from '@/lib/selection'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useConfig } from '@/hooks/useConfig'
import { useNow, useSchedulerStatus } from '@/hooks/useSchedulerStatus'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { headerRetryText } from '@/lib/retry'
import { cn } from '@/lib/utils'
import { useRunProgress } from '@/hooks/useRunProgress'
import { DrivePage } from '@/screens/DrivePage'
import { ActivityPage } from '@/screens/ActivityPage'
import { BackupPage } from '@/screens/BackupPage'
import { BackupConfigDialog } from '@/components/BackupConfigDialog'
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
import { buildNextConfig, draftFrom, errorsByGroup, isDirty, type Draft } from '@/lib/backup-draft'
import { Settings } from '@/screens/Settings'
import { NewBackupAssistant } from '@/screens/NewBackupAssistant'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

/** Back up now, or Stop while a run is active; hovering previews what a run would do. */
function BackUpNowButton({ running }: { running: boolean }): React.JSX.Element {
  const [preview, setPreview] = useState(t('app.checking'))
  if (running) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="app-no-drag"
        onClick={() => void api.run.cancel()}
      >
        <Square /> {t('common.stop')}
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
            setPreview(t('app.checking'))
            void api.run.plan().then((p) => setPreview(planPreview(p)))
          }}
          onClick={() => void api.run.start()}
        >
          <Play /> {t('app.backUpNow')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{preview}</TooltipContent>
    </Tooltip>
  )
}

function statusText(status: SchedulerStatus | null, config: Config, now: Date): string {
  if (!status) return ''
  if (status.active) return t('app.running')
  if (status.pausedUntil === 'forever') return t('app.paused')
  if (status.pausedUntil) {
    return t('app.pausedUntil', { time: formatRelativeTime(new Date(status.pausedUntil), now) })
  }
  const waiting = headerRetryText(status, config, now)
  if (waiting) return waiting
  const next = status.nextRuns
    .filter((n): n is { sourceId: string; at: string } => n.at !== null)
    .sort((a, b) => (a.at < b.at ? -1 : 1))[0]
  if (!next) return t('app.noSchedules')
  const name = config.sources.find((s) => s.id === next.sourceId)?.name ?? ''
  return t('app.next', { name, time: formatRelativeTime(new Date(next.at), now) })
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
            <Play /> {t('app.resume')}
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <Pause /> {t('app.pause')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  void api.scheduler.pause(new Date(Date.now() + 3_600_000).toISOString())
                }
              >
                {t('app.forHour')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void api.scheduler.pause('forever')}>
                {t('app.untilResumed')}
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
      <h1 className="text-lg font-semibold">{t('app.emptyTitle')}</h1>
      <p className="text-muted-foreground text-sm">{t('app.emptyBody')}</p>
      <Button onClick={onNew}>
        <Plus /> {t('common.newBackup')}
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
        <h1 className="text-xl font-semibold">{t('app.configError')}</h1>
        <p className="text-muted-foreground mt-2 text-sm break-all">{path}</p>
        <pre className="bg-muted mt-4 max-h-60 overflow-auto rounded-md p-3 text-xs">
          {errors.join('\n')}
        </pre>
        <p className="text-muted-foreground mt-4 text-sm">{t('app.configErrorBody')}</p>
        <div className="mt-4 flex gap-2">
          <Button onClick={doImport}>{t('app.import')}</Button>
          <Button variant="outline" onClick={reset}>
            {t('app.reset')}
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

function App(): React.JSX.Element {
  const cfg = useConfig()
  const status = useSchedulerStatus()
  const progress = useRunProgress()
  const results = useLatestResults()
  const availability = useAvailability()
  const [picked, setPicked] = useState<Selection | null>(null)
  const [runId, setRunId] = useState<string | undefined>()
  // The backup being edited, if any; nothing is saved until Save.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  // Where leaving with unsaved edits was headed: another page, or just closing the configuration.
  const [pendingSel, setPendingSel] = useState<Selection | 'close' | null>(null)
  const [editSection, setEditSection] = useState<string | undefined>()
  const configNow = cfg.state?.ok ? cfg.state.config : null
  const dirty = draft !== null && configNow !== null && isDirty(configNow, draft)
  // Main-process events subscribe once, so they reach the current state through refs.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const selectRef = useRef<(s: Selection) => void>(() => {})
  const runIdAfterLeave = useRef<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    if (!dirty) return
    // Quitting with unsaved edits: main shows a Discard / Cancel prompt.
    const guard = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  const glass = cfg.state?.ok ? cfg.state.config.settings.glass : false
  useGlassClasses(glass)

  useEffect(
    () =>
      // Notifications open a run in Activity; anything else goes to its new home.
      api.app.onNavigate((s, arg) => {
        if (s === 'settings') return setSettingsOpen(true)
        runIdAfterLeave.current = s === 'history' ? arg : undefined
        selectRef.current({ kind: 'activity' })
      }),
    []
  )
  useEffect(() => api.app.onSelect((sel) => selectRef.current(sel)), [])

  if (!cfg.state) return <div />
  if (!cfg.state.ok) {
    return <ConfigError errors={cfg.state.errors} path={cfg.state.path} onReload={cfg.reload} />
  }
  const config = cfg.state.config
  const selection = resolveSelection(picked, config)
  const go = (s: Selection): void => {
    setDraft(null)
    setFormErrors({})
    setPicked(s)
    // A notification asks for one run; it opens once leaving is settled.
    setRunId(runIdAfterLeave.current)
    runIdAfterLeave.current = undefined
  }
  // Leaving a backup with unsaved edits asks first, whether from the sidebar, tray or a notification.
  const select = (s: Selection): void => {
    const r = leaveTo(dirtyRef.current, s)
    if ('ask' in r) setPendingSel(r.ask)
    else go(r.go)
  }
  selectRef.current = select
  const addShared = async (d: Destination): Promise<boolean> => {
    const errors = await cfg.save({ ...config, destinations: [...config.destinations, d] })
    if (errors) toast.error(t('common.couldNotSave'), { description: errors.join('\n') })
    return !errors
  }
  const closeDraft = (): void => {
    setDraft(null)
    setFormErrors({})
  }
  const saveDraft = async (): Promise<boolean> => {
    if (!draft) return true
    const r = buildNextConfig(config, draft)
    if ('error' in r) {
      setFormErrors(errorsByGroup([r.error]))
      return false
    }
    const errors = await cfg.save(r.next)
    if (errors) {
      setFormErrors(errorsByGroup(errors))
      return false
    }
    setDraft(null)
    setFormErrors({})
    return true
  }
  const runningSourceId = status?.active ? (progress.currentJob?.sourceId ?? null) : null

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TopBar>
          <SchedulerStatusControls status={status} config={config} />
        </TopBar>
        <div className="flex min-h-0 flex-1">
          <AppSidebar
            cfg={cfg}
            config={config}
            selection={selection}
            onSelect={select}
            status={status}
            results={results}
            availability={availability}
            runningSourceId={runningSourceId}
            onNewBackup={() => setCreating(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-auto p-6">
              {/* Pages sit in one centred column so wide windows don't leave them on the left. */}
              <div className="mx-auto w-full max-w-5xl">
                {selection.kind === 'empty' && <EmptyState onNew={() => setCreating(true)} />}
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
                    onEdit={(section) => {
                      setEditSection(section)
                      setDraft(
                        draftFrom(
                          config,
                          config.sources.find((x) => x.id === selection.id)!
                        )
                      )
                    }}
                    onOpenRun={(id) => {
                      go({ kind: 'activity' })
                      setRunId(id)
                    }}
                  />
                )}
                {selection.kind === 'drive' && (
                  <DrivePage
                    cfg={cfg}
                    config={config}
                    dest={config.destinations.find((x) => x.id === selection.id)!}
                    results={results}
                    status={status}
                    onSelect={select}
                  />
                )}
                {selection.kind === 'activity' && (
                  <ActivityPage
                    config={config}
                    status={status}
                    progress={progress}
                    openRunId={runId}
                  />
                )}
              </div>
            </div>
          </main>
        </div>
      </div>
      {settingsOpen && (
        <Settings
          cfg={cfg}
          config={config}
          path={cfg.state.path}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {creating && (
        <Dialog open onOpenChange={(o) => !o && setCreating(false)}>
          <DialogContent className="sm:max-w-xl">
            <DialogTitle className="sr-only">{t('common.newBackup')}</DialogTitle>
            <NewBackupAssistant
              cfg={cfg}
              config={config}
              availability={availability}
              onDone={(id) => {
                setCreating(false)
                select({ kind: 'backup', id })
              }}
              onCancel={() => setCreating(false)}
            />
          </DialogContent>
        </Dialog>
      )}
      {selection.kind === 'backup' && draft?.source.id === selection.id && (
        <BackupConfigDialog
          config={config}
          draft={draft}
          onChange={setDraft}
          dirty={dirty}
          errors={formErrors}
          section={editSection}
          onSave={() => void saveDraft()}
          onClose={() => (dirty ? setPendingSel('close') : closeDraft())}
          addShared={addShared}
        />
      )}
      <AlertDialog
        open={pendingSel !== null}
        onOpenChange={(o) => {
          if (o) return
          setPendingSel(null)
          runIdAfterLeave.current = undefined
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('app.saveChanges', { name: draft?.source.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('app.lose')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                const s = pendingSel
                setPendingSel(null)
                if (s === 'close') closeDraft()
                else if (s) go(s)
              }}
            >
              {t('common.dontSave')}
            </Button>
            <AlertDialogAction
              onClick={() => {
                const s = pendingSel
                const run = runIdAfterLeave.current // the dialog closing clears it
                setPendingSel(null)
                void saveDraft().then((ok) => {
                  if (!ok || !s || s === 'close') return
                  runIdAfterLeave.current = run
                  go(s)
                })
              }}
            >
              {t('common.save')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}

export default App
