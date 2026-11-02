import { useState } from 'react'
import { FilePlus, FolderOpen, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  defaultModeFor,
  fileName,
  newSource,
  slugify,
  validateConfig,
  type Config,
  type Destination,
  type Schedule,
  type Source,
  type Weekday
} from '@shared/schema'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { DestinationDialog } from '@/components/DestinationDialog'
import { SizeInput } from '@/components/SizeInput'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const DAYS: { id: Weekday; label: string }[] = [
  { id: 'mon', label: 'Mon' },
  { id: 'tue', label: 'Tue' },
  { id: 'wed', label: 'Wed' },
  { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' },
  { id: 'sat', label: 'Sat' },
  { id: 'sun', label: 'Sun' }
]

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

/** Integer input where an unchecked "limit" box means null (forever / never). */
function OptionalDays({
  value,
  onChange,
  noneLabel
}: {
  value: number | null
  onChange: (v: number | null) => void
  noneLabel: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <Input
        type="number"
        min={0}
        className="w-24"
        disabled={value === null}
        value={value ?? ''}
        onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      />
      <span className="text-muted-foreground text-sm">days</span>
      <label className="ml-2 flex items-center gap-2 text-sm">
        <Checkbox
          checked={value === null}
          onCheckedChange={(c) => onChange(c === true ? null : 30)}
        />
        {noneLabel}
      </label>
    </div>
  )
}

function ChoiceButtons<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { id: T; label: string; hint: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-md border p-3 text-left text-sm transition-colors',
            value === o.id ? 'border-primary bg-accent' : 'hover:bg-accent/50'
          )}
        >
          <div className="font-medium">{o.label}</div>
          <div className="text-muted-foreground mt-1 text-xs">{o.hint}</div>
        </button>
      ))}
    </div>
  )
}

function defaultSchedule(kind: Schedule['kind']): Schedule {
  if (kind === 'interval') return { kind, everyHours: 4 }
  if (kind === 'daily') return { kind, time: '02:00' }
  return { kind, days: ['mon'], time: '02:00' }
}

export function SourceEditor({
  config,
  initial,
  kind,
  onSave,
  onClose
}: {
  config: Config
  initial: Source | null
  /** Folder or Files, chosen before the editor opens; it does not change while editing. */
  kind: Source['kind']
  onSave: (next: Config) => Promise<string[] | null>
  onClose: () => void
}): React.JSX.Element {
  const otherSlugs = config.sources.filter((s) => s.id !== initial?.id).map((s) => s.slug)
  const [s, setS] = useState<Source>(() => initial ?? { ...newSource('', '', otherSlugs), kind })
  const [slugTouched, setSlugTouched] = useState(initial !== null)
  const [modeTouched, setModeTouched] = useState(initial !== null)
  const [excludes, setExcludes] = useState(s.excludes.join('\n'))
  const [errors, setErrors] = useState<string[]>([])
  // Destinations only this source uses: edited here, saved with the source, dropped on Cancel.
  const [own, setOwn] = useState<Destination[]>(() =>
    config.destinations.filter((d) => d.ownerSourceId !== null && d.ownerSourceId === s.id)
  )
  const [editingDest, setEditingDest] = useState<Destination | 'new' | null>(null)
  const shared = config.destinations.filter((d) => d.ownerSourceId === null)
  const patch = (p: Partial<Source>): void => setS((prev) => ({ ...prev, ...p }))

  const setName = (name: string): void =>
    patch(slugTouched ? { name } : { name, slug: slugify(name, otherSlugs) })
  const browse = async (): Promise<void> => {
    const p = await api.dialog.pickFolder()
    if (!p) return
    const base = p.split(/[\\/]/).filter(Boolean).pop() ?? ''
    patch({
      path: p,
      ...(s.name ? {} : { name: base, ...(slugTouched ? {} : { slug: slugify(base, otherSlugs) }) })
    })
  }
  const addFiles = async (): Promise<void> => {
    const picked = (await api.dialog.pickFiles()).filter((f) => !s.files.includes(f))
    if (picked.length === 0) return
    const first = fileName(picked[0])
    patch({
      files: [...s.files, ...picked],
      ...(s.name
        ? {}
        : { name: first, ...(slugTouched ? {} : { slug: slugify(first, otherSlugs) }) })
    })
  }
  const files = s.kind === 'files'
  const setPackaging = (packaging: Source['packaging']): void =>
    patch(modeTouched ? { packaging } : { packaging, mode: defaultModeFor(packaging) })

  const submit = async (): Promise<void> => {
    const source: Source = {
      ...s,
      name: s.name.trim(),
      excludes: excludes
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    }
    const next: Config = {
      ...config,
      destinations: [...config.destinations.filter((d) => d.ownerSourceId !== source.id), ...own],
      sources: initial
        ? config.sources.map((x) => (x.id === source.id ? source : x))
        : [...config.sources, source]
    }
    const v = validateConfig(next)
    if (!v.ok) return setErrors(v.errors)
    const saveErrors = await onSave(next)
    if (saveErrors) setErrors(saveErrors)
    else onClose()
  }

  const zip = s.packaging !== 'copy'
  const explicitDests = s.destinationIds === 'all' ? null : s.destinationIds

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>
            {initial ? `Edit “${initial.name}”` : files ? 'Add files' : 'Add folder'}
          </SheetTitle>
          <SheetDescription>What to back up and how to store it.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 gap-6 overflow-y-auto p-4">
          {errors.length > 0 && (
            <div className="border-destructive/50 text-destructive rounded-md border p-3 text-sm">
              {errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}

          <Section title={files ? 'Files' : 'Folder'}>
            {files ? (
              <div className="grid min-w-0 gap-1 overflow-hidden">
                {s.files.map((f) => (
                  <div key={f} className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="font-medium">{fileName(f)}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                      {f}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${fileName(f)}`}
                      onClick={() => patch({ files: s.files.filter((x) => x !== f) })}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={addFiles}
                >
                  <FilePlus /> Add files…
                </Button>
                <p className="text-muted-foreground text-xs">
                  Each file is stored by its name, so two files can&apos;t share a name.
                </p>
              </div>
            ) : (
              <Field label="Path">
                <div className="flex gap-2">
                  <Input value={s.path} onChange={(e) => patch({ path: e.target.value })} />
                  <Button variant="outline" onClick={browse}>
                    <FolderOpen /> Browse…
                  </Button>
                </div>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={s.name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Folder name at destination">
                <Input
                  value={s.slug}
                  onChange={(e) => {
                    setSlugTouched(true)
                    patch({ slug: e.target.value })
                  }}
                />
              </Field>
            </div>
          </Section>

          <Separator />
          <Section title="Packaging">
            <ChoiceButtons
              value={s.packaging}
              onChange={setPackaging}
              options={[
                { id: 'copy', label: 'Copy files', hint: 'Plain files, easy to browse' },
                {
                  id: 'zip-whole',
                  label: 'One zip',
                  hint: files ? 'All the files in one archive' : 'The whole folder in one archive'
                },
                {
                  id: 'zip-children',
                  label: 'Zip each item',
                  hint: files ? 'One archive per file' : 'One archive per top-level folder/file'
                }
              ]}
            />
            {zip && (
              <Field
                label={`Compression level: ${s.zip.level}`}
                hint="0 stores files uncompressed (fastest), 9 compresses most."
              >
                <Slider
                  min={0}
                  max={9}
                  step={1}
                  value={[s.zip.level]}
                  onValueChange={([level]) => patch({ zip: { ...s.zip, level } })}
                />
              </Field>
            )}
            {s.packaging === 'zip-children' && (
              <Field label="Loose top-level files">
                <Select
                  value={s.zip.looseFiles}
                  onValueChange={(v) =>
                    patch({ zip: { ...s.zip, looseFiles: v as Source['zip']['looseFiles'] } })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="individual">One zip per file</SelectItem>
                    <SelectItem value="bundle">All together in _files.zip</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {zip && (
              <Field
                label="Split archives larger than"
                hint="Each part is a complete zip that opens on its own. Destinations can set a smaller limit."
              >
                <SizeInput
                  value={s.zip.partLimitBytes}
                  onChange={(partLimitBytes) => patch({ zip: { ...s.zip, partLimitBytes } })}
                  offLabel="Never split"
                  defaultBytes={2 * 1024 ** 3}
                />
              </Field>
            )}
            {zip && s.zip.partLimitBytes !== null && (
              <Field label="Files larger than the limit">
                <Select
                  value={s.zip.oversized}
                  onValueChange={(v) =>
                    patch({ zip: { ...s.zip, oversized: v as Source['zip']['oversized'] } })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="own-part">Keep whole in their own part</SelectItem>
                    <SelectItem value="chunk">
                      Split into raw chunks (.001, .002… — open with 7-Zip or join)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {zip && s.zip.partLimitBytes !== null && s.zip.oversized === 'chunk' && (
              <Field label="Chunk size">
                <SizeInput
                  value={s.zip.chunkBytes}
                  onChange={(chunkBytes) => patch({ zip: { ...s.zip, chunkBytes } })}
                  offLabel="Same as the limit"
                  defaultBytes={s.zip.partLimitBytes}
                />
              </Field>
            )}
          </Section>

          <Separator />
          <Section title="Mode">
            <ChoiceButtons
              value={s.mode}
              onChange={(mode) => {
                setModeTouched(true)
                patch({ mode })
              }}
              options={[
                {
                  id: 'mirror',
                  label: 'Mirror',
                  hint: 'One up-to-date copy, only changes are written'
                },
                { id: 'snapshot', label: 'Snapshots', hint: 'A new dated copy on every run' }
              ]}
            />
            {s.mode === 'mirror' ? (
              <>
                <Field label="When a file is deleted from the source">
                  <Select
                    value={s.mirror.deletion}
                    onValueChange={(v) =>
                      patch({
                        mirror: { ...s.mirror, deletion: v as Source['mirror']['deletion'] }
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="trash">Move it to the backup’s .trash folder</SelectItem>
                      <SelectItem value="exact">
                        Delete it from the backup (exact mirror)
                      </SelectItem>
                      <SelectItem value="never">Keep it in the backup</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {s.mirror.deletion === 'trash' && (
                  <Field label="Empty trash after">
                    <OptionalDays
                      value={s.mirror.trashRetentionDays}
                      noneLabel="Keep forever"
                      onChange={(trashRetentionDays) =>
                        patch({ mirror: { ...s.mirror, trashRetentionDays } })
                      }
                    />
                  </Field>
                )}
              </>
            ) : (
              <div className="grid grid-cols-[auto_1fr] items-end gap-6">
                <Field label="Always keep at least">
                  <div className="flex items-center gap-3">
                    <Input
                      type="number"
                      min={1}
                      className="w-24"
                      value={s.snapshot.keepMin}
                      onChange={(e) =>
                        patch({
                          snapshot: {
                            ...s.snapshot,
                            keepMin: Math.max(1, Math.floor(Number(e.target.value) || 1))
                          }
                        })
                      }
                    />
                    <span className="text-muted-foreground text-sm">snapshots</span>
                  </div>
                </Field>
                <Field label="Delete older snapshots after">
                  <OptionalDays
                    value={s.snapshot.maxAgeDays}
                    noneLabel="Never"
                    onChange={(maxAgeDays) => patch({ snapshot: { ...s.snapshot, maxAgeDays } })}
                  />
                </Field>
              </div>
            )}
          </Section>

          {!files && <Separator />}
          {!files && (
            <Section title="Exclusions">
              <Textarea
                rows={3}
                className="font-mono text-xs"
                placeholder={'node_modules/\n*.tmp'}
                value={excludes}
                onChange={(e) => setExcludes(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={s.useGlobalExcludes}
                  onCheckedChange={(useGlobalExcludes) => patch({ useGlobalExcludes })}
                />
                Also apply global exclusions ({config.globalExcludes.join(', ') || 'none'})
              </label>
            </Section>
          )}

          <Separator />
          <Section title="Destinations">
            {/* min-w-0 + overflow-hidden: a long path truncates instead of widening the sheet. */}
            <div className="grid min-w-0 gap-2 overflow-hidden">
              <Label>Only for this source</Label>
              {own.map((d) => (
                <div key={d.id} className="flex min-w-0 items-center gap-2 text-sm">
                  <Switch
                    checked={d.enabled}
                    aria-label={`Use ${d.name}`}
                    onCheckedChange={(enabled) =>
                      setOwn((o) => o.map((x) => (x.id === d.id ? { ...x, enabled } : x)))
                    }
                  />
                  <span className="font-medium">{d.name}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                    {d.path}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${d.name}`}
                    onClick={() => setEditingDest(d)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${d.name}`}
                    onClick={() => setOwn((o) => o.filter((x) => x.id !== d.id))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() => setEditingDest('new')}
              >
                <Plus /> Add destination for this source
              </Button>
              <p className="text-muted-foreground text-xs">
                Always used by this source and never by others.
              </p>
            </div>
            <Label className="mt-2">Shared destinations</Label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={explicitDests === null}
                onCheckedChange={(c) =>
                  patch({
                    destinationIds: c === true ? 'all' : shared.map((d) => d.id)
                  })
                }
              />
              All shared destinations
            </label>
            {explicitDests !== null && (
              <div className="grid gap-2 pl-6">
                {shared.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={explicitDests.includes(d.id)}
                      onCheckedChange={(c) =>
                        patch({
                          destinationIds:
                            c === true
                              ? [...explicitDests, d.id]
                              : explicitDests.filter((id) => id !== d.id)
                        })
                      }
                    />
                    {d.name}
                    <span className="text-muted-foreground truncate font-mono text-xs">
                      {d.path}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Section>

          <Separator />
          <Section title="Schedule">
            <Select
              value={s.schedule?.kind ?? 'none'}
              onValueChange={(v) =>
                patch({ schedule: v === 'none' ? null : defaultSchedule(v as Schedule['kind']) })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Manual only</SelectItem>
                <SelectItem value="interval">Every few hours</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
            {s.schedule?.kind === 'interval' && (
              <div className="flex items-center gap-3">
                <span className="text-sm">Every</span>
                <Input
                  type="number"
                  min={1}
                  className="w-24"
                  value={s.schedule.everyHours}
                  onChange={(e) =>
                    patch({
                      schedule: {
                        kind: 'interval',
                        everyHours: Math.max(1, Math.floor(Number(e.target.value) || 1))
                      }
                    })
                  }
                />
                <span className="text-sm">hours</span>
              </div>
            )}
            {s.schedule && s.schedule.kind !== 'interval' && (
              <div className="flex flex-wrap items-center gap-3">
                {s.schedule.kind === 'weekly' && (
                  <div className="flex gap-1">
                    {DAYS.map((d) => {
                      const sched = s.schedule as Extract<Schedule, { kind: 'weekly' }>
                      return (
                        <Toggle
                          key={d.id}
                          size="sm"
                          variant="outline"
                          pressed={sched.days.includes(d.id)}
                          onPressedChange={(on) =>
                            patch({
                              schedule: {
                                ...sched,
                                days: on
                                  ? [...sched.days, d.id]
                                  : sched.days.filter((x) => x !== d.id)
                              }
                            })
                          }
                        >
                          {d.label}
                        </Toggle>
                      )
                    })}
                  </div>
                )}
                <span className="text-sm">at</span>
                <Input
                  type="time"
                  className="w-32"
                  value={s.schedule.time}
                  onChange={(e) =>
                    patch({
                      schedule: { ...(s.schedule as Schedule), time: e.target.value } as Schedule
                    })
                  }
                />
              </div>
            )}
            {s.schedule && (
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={s.retryWhenAvailable}
                  onCheckedChange={(retryWhenAvailable) => patch({ retryWhenAvailable })}
                />
                Retry when an unplugged destination becomes available
              </label>
            )}
          </Section>
        </div>
        <SheetFooter className="flex-row justify-end border-t">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={(files ? s.files.length === 0 : !s.path) || !s.name.trim()}
          >
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
      {editingDest && (
        <DestinationDialog
          initial={editingDest === 'new' ? null : editingDest}
          ownerName={s.name.trim() || 'this source'}
          ownerSourceId={s.id}
          onSave={async (d) => {
            setOwn((o) =>
              o.some((x) => x.id === d.id) ? o.map((x) => (x.id === d.id ? d : x)) : [...o, d]
            )
            return true
          }}
          onClose={() => setEditingDest(null)}
        />
      )}
    </Sheet>
  )
}
