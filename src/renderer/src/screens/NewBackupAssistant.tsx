import { t } from '@/i18n'
import { useState } from 'react'
import { Check, FolderPlus, HardDrive } from 'lucide-react'
import { toast } from 'sonner'
import type { Config, Destination } from '@shared/schema'
import { ItemsEditor } from '@/components/ItemsEditor'
import { DestinationDialog } from '@/components/DestinationDialog'
import { Button } from '@/components/ui/button'
import type { UseConfig } from '@/hooks/useConfig'
import { api } from '@/lib/api'
import { assistantConfig, type AssistantState } from '@/lib/assistant'
import { shortPath } from '@/lib/summary'
import { cn } from '@/lib/utils'

/** Stand-in owner id for destinations made before the backup exists; replaced on create. */
const PENDING_OWNER = 'new-backup'

const STEPS = t('assistant.steps', { returnObjects: true }) as string[]

function Tile({
  selected,
  onClick,
  title,
  hint,
  icon
}: {
  selected: boolean
  onClick: () => void
  title: string
  hint?: string
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
        selected ? 'border-primary bg-accent' : 'hover:bg-accent/50'
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {hint && <span className="text-muted-foreground block truncate text-xs">{hint}</span>}
      </span>
      {selected && <Check className="size-4 shrink-0" />}
    </button>
  )
}

/** A new backup in three steps; Cancel leaves without creating anything. */
export function NewBackupAssistant({
  cfg,
  config,
  availability,
  onDone,
  onCancel
}: {
  cfg: UseConfig
  config: Config
  availability: Record<string, boolean>
  onDone: (sourceId: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [st, setSt] = useState<AssistantState>({
    items: [],
    driveIds: [],
    newDrives: [],
    mode: 'mirror',
    run: 'daily'
  })
  const shared = config.destinations.filter((d) => d.ownerSourceId === null)
  const canContinue =
    step === 0
      ? st.items.length > 0
      : step === 1
        ? st.driveIds.length + st.newDrives.length > 0
        : true

  const finish = async (): Promise<void> => {
    const { next, sourceId } = assistantConfig(config, st)
    const errors = await cfg.save(next)
    if (errors) {
      toast.error(t('assistant.createFailed'), { description: errors.join('\n') })
      return
    }
    onDone(sourceId)
    if (st.run !== 'manual') void api.run.start([sourceId])
  }
  const [addingDest, setAddingDest] = useState(false)
  // The same destination sheet as everywhere else: shared ones are saved right away.
  const addDestination = async (d: Destination): Promise<boolean> => {
    if (d.ownerSourceId !== null) {
      setSt({ ...st, newDrives: [...st.newDrives, d] })
      return true
    }
    const errors = await cfg.save({ ...config, destinations: [...config.destinations, d] })
    if (errors) {
      toast.error(t('common.couldNotSave'), { description: errors.join('\n') })
      return false
    }
    setSt({ ...st, driveIds: [...st.driveIds, d.id] })
    return true
  }

  return (
    <div className="grid w-full min-w-0 gap-5">
      <div>
        <div className="text-muted-foreground text-xs">
          {t('assistant.step', { n: step + 1, total: STEPS.length })}
        </div>
        <h1 className="text-xl font-semibold">{STEPS[step]}</h1>
      </div>

      {step === 0 && (
        <div className="bg-card overflow-hidden rounded-lg border">
          <ItemsEditor items={st.items} onChange={(items) => setSt({ ...st, items })} />
        </div>
      )}

      {step === 1 && (
        <div className="grid gap-2">
          {shared.map((d) => {
            const on = st.driveIds.includes(d.id)
            return (
              <Tile
                key={d.id}
                selected={on}
                icon={<HardDrive className="text-muted-foreground size-4 shrink-0" />}
                title={d.name}
                hint={
                  availability[d.id] === false ? t('assistant.notConnected') : shortPath(d.path)
                }
                onClick={() =>
                  setSt({
                    ...st,
                    driveIds: on ? st.driveIds.filter((x) => x !== d.id) : [...st.driveIds, d.id]
                  })
                }
              />
            )
          })}
          {st.newDrives.map((d) => (
            <Tile
              key={d.id}
              selected
              icon={<HardDrive className="text-muted-foreground size-4 shrink-0" />}
              title={d.name}
              hint={t('assistant.otherOnly', { path: shortPath(d.path) })}
              onClick={() => setSt({ ...st, newDrives: st.newDrives.filter((x) => x.id !== d.id) })}
            />
          ))}
          <Tile
            selected={false}
            icon={<FolderPlus className="text-muted-foreground size-4 shrink-0" />}
            title={t('assistant.otherFolder')}
            hint={t('assistant.otherFolderHint')}
            onClick={() => setAddingDest(true)}
          />
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Tile
              selected={st.mode === 'mirror'}
              title={t('assistant.mirror')}
              hint={t('assistant.mirrorHint')}
              onClick={() => setSt({ ...st, mode: 'mirror' })}
            />
            <Tile
              selected={st.mode === 'snapshot'}
              title={t('assistant.snapshot')}
              hint={t('assistant.snapshotHint')}
              onClick={() => setSt({ ...st, mode: 'snapshot' })}
            />
          </div>
          <div className="grid gap-2">
            <div className="text-muted-foreground px-1 text-xs font-medium">
              {t('assistant.run')}
            </div>
            <div className="bg-card divide-y overflow-hidden rounded-lg border">
              {(
                [
                  ['daily', t('assistant.daily')],
                  ['interval', t('assistant.interval')],
                  ['manual', t('assistant.manual')]
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={st.run === id}
                  onClick={() => setSt({ ...st, run: id })}
                  className="hover:bg-accent/50 flex w-full items-center justify-between px-3 py-2.5 text-left text-sm"
                >
                  {label}
                  {st.run === id && <Check className="size-4" />}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground px-1 text-xs">{t('assistant.later')}</p>
          </div>
        </div>
      )}

      {addingDest && (
        <DestinationDialog
          initial={null}
          owner={{ id: PENDING_OWNER, name: t('common.newBackup') }}
          onSave={addDestination}
          onClose={() => setAddingDest(false)}
        />
      )}
      <div className="flex items-center gap-2 border-t pt-4">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <div className="ml-auto flex gap-2">
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep(step - 1)}>
              {t('common.back')}
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button disabled={!canContinue} onClick={() => setStep(step + 1)}>
              {t('common.continue')}
            </Button>
          ) : (
            <Button onClick={() => void finish()}>{t('assistant.create')}</Button>
          )}
        </div>
      </div>
    </div>
  )
}
