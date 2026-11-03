import { useState } from 'react'
import { Check, FolderPlus, HardDrive } from 'lucide-react'
import { toast } from 'sonner'
import { fileName, newDestination, type Config } from '@shared/schema'
import { ItemsEditor } from '@/components/BackupForm'
import { Button } from '@/components/ui/button'
import type { UseConfig } from '@/hooks/useConfig'
import { api } from '@/lib/api'
import { assistantConfig, type AssistantState } from '@/lib/assistant'
import { shortPath } from '@/lib/summary'
import { cn } from '@/lib/utils'

const STEPS = ['What to back up', 'Where it goes', 'How and when'] as const

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

/** A new backup in three steps; Set up later keeps what was entered without running it. */
export function NewBackupAssistant({
  cfg,
  config,
  availability,
  onDone
}: {
  cfg: UseConfig
  config: Config
  availability: Record<string, boolean>
  onDone: (sourceId: string) => void
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

  const finish = async (complete: boolean): Promise<void> => {
    const { next, sourceId } = assistantConfig(config, st, complete)
    const errors = await cfg.save(next)
    if (errors) {
      toast.error('Couldn’t create the backup', { description: errors.join('\n') })
      return
    }
    onDone(sourceId)
    if (complete && st.run !== 'manual') void api.run.start([sourceId])
  }
  const otherFolder = async (): Promise<void> => {
    const p = await api.dialog.pickFolder()
    if (!p) return
    setSt({ ...st, newDrives: [...st.newDrives, newDestination(p, fileName(p))] })
  }

  return (
    <div className="mx-auto grid w-full max-w-xl gap-5 pt-6">
      <div>
        <div className="text-muted-foreground text-xs">
          Step {step + 1} of {STEPS.length}
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
                hint={availability[d.id] === false ? 'not connected' : shortPath(d.path)}
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
              hint={`${shortPath(d.path)} · only this backup`}
              onClick={() => setSt({ ...st, newDrives: st.newDrives.filter((x) => x.id !== d.id) })}
            />
          ))}
          <Tile
            selected={false}
            icon={<FolderPlus className="text-muted-foreground size-4 shrink-0" />}
            title="Other folder…"
            hint="A folder on any drive, used by this backup only"
            onClick={() => void otherFolder()}
          />
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Tile
              selected={st.mode === 'mirror'}
              title="Keep an up-to-date copy"
              hint="A mirror of your files, updated with what changed"
              onClick={() => setSt({ ...st, mode: 'mirror' })}
            />
            <Tile
              selected={st.mode === 'snapshot'}
              title="Keep dated versions"
              hint="A new copy on each run; the last 10 are always kept"
              onClick={() => setSt({ ...st, mode: 'snapshot' })}
            />
          </div>
          <div className="grid gap-2">
            <div className="text-muted-foreground px-1 text-xs font-medium">Run it</div>
            <div className="bg-card divide-y overflow-hidden rounded-lg border">
              {(
                [
                  ['daily', 'Every day at 22:00'],
                  ['interval', 'Every 4 hours'],
                  ['manual', 'Only when I click Back up now']
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
            <p className="text-muted-foreground px-1 text-xs">You can change more options later.</p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t pt-4">
        <Button variant="ghost" onClick={() => void finish(false)}>
          Set up later
        </Button>
        <div className="ml-auto flex gap-2">
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button disabled={!canContinue} onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          ) : (
            <Button onClick={() => void finish(true)}>Create backup</Button>
          )}
        </div>
      </div>
    </div>
  )
}
