import { useState } from 'react'
import {
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import {
  defaultModeFor,
  fileName,
  slugify,
  type Config,
  type Destination,
  type Schedule,
  type Source,
  type SourceItem,
  type Weekday
} from '@shared/schema'
import { DestinationDialog } from '@/components/DestinationDialog'
import { SizeInput } from '@/components/SizeInput'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import { api } from '@/lib/api'
import type { Draft } from '@/lib/backup-draft'
import { shortPath } from '@/lib/summary'
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

function defaultSchedule(kind: Schedule['kind']): Schedule {
  if (kind === 'interval') return { kind, everyHours: 4 }
  if (kind === 'daily') return { kind, time: '22:00' }
  return { kind, days: ['mon'], time: '22:00' }
}

/** A titled group of rows, System Settings style. */
export function Group({
  title,
  id,
  error,
  children
}: {
  title: string
  id?: string
  error?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section id={id} className="grid gap-2">
      <h2 className="text-muted-foreground px-1 text-xs font-medium">{title}</h2>
      <div
        className={cn(
          'bg-card divide-y overflow-hidden rounded-lg border',
          error && 'border-destructive/60'
        )}
      >
        {children}
      </div>
      {error && <p className="text-destructive px-1 text-xs">{error}</p>}
    </section>
  )
}

/** One row: a label on the left, its control on the right (or below when `stack`). */
export function Row({
  label,
  hint,
  stack,
  children
}: {
  label: string
  hint?: string
  stack?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 gap-3 px-3 py-2.5 text-sm',
        stack ? 'flex-col' : 'items-center justify-between'
      )}
    >
      <div className="min-w-0">
        <div>{label}</div>
        {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
      </div>
      <div className={cn('min-w-0', !stack && 'shrink-0')}>{children}</div>
    </div>
  )
}

function Menu<T extends string>({
  value,
  onChange,
  options,
  className
}: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string }[]
  className?: string
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className={cn('w-64', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Days input where "never" means null. */
function Days({
  value,
  onChange,
  noneLabel
}: {
  value: number | null
  onChange: (v: number | null) => void
  noneLabel: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={0}
        className="w-20"
        disabled={value === null}
        value={value ?? ''}
        onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      />
      <span className="text-muted-foreground">days</span>
      <label className="ml-2 flex items-center gap-2">
        <Checkbox
          checked={value === null}
          onCheckedChange={(c) => onChange(c === true ? null : 30)}
        />
        {noneLabel}
      </label>
    </div>
  )
}

/** The list of files and folders, with the per-OS Add buttons and a drop area. */
export function ItemsEditor({
  items,
  onChange
}: {
  items: SourceItem[]
  onChange: (items: SourceItem[]) => void
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  // macOS can pick files and folders in one dialog; Windows and Linux need one for each.
  const mixedPicker = api.app.platform === 'darwin'
  const add = (picked: SourceItem[]): void => {
    const fresh = picked.filter((p) => !items.some((i) => i.path === p.path))
    if (fresh.length > 0) onChange([...items, ...fresh])
  }
  const pick = async (mode: 'any' | 'files' | 'folders'): Promise<void> =>
    add(await api.dialog.pickItems(mode, items.at(-1)?.path))
  return (
    <div
      className={cn('grid min-w-0', over && 'bg-accent/40')}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const paths = [...e.dataTransfer.files].map((f) => api.files.pathOf(f)).filter(Boolean)
        if (paths.length > 0) void api.dialog.statItems(paths).then(add)
      }}
    >
      {items.map((it) => {
        const Icon = it.kind === 'folder' ? Folder : FileIcon
        const name = fileName(it.path)
        return (
          <div key={it.path} className="flex min-w-0 items-center gap-2 border-b px-3 py-2 text-sm">
            <Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="max-w-[60%] shrink-0 truncate font-medium">{name}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs">
              {shortPath(it.path)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Remove ${name}`}
              onClick={() => onChange(items.filter((x) => x.path !== it.path))}
            >
              <X />
            </Button>
          </div>
        )
      })}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {mixedPicker ? (
          <Button variant="outline" size="sm" onClick={() => void pick('any')}>
            <Plus /> Add…
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => void pick('folders')}>
              <FolderPlus /> Add folder…
            </Button>
            <Button variant="outline" size="sm" onClick={() => void pick('files')}>
              <FilePlus /> Add files…
            </Button>
          </>
        )}
        <span className="text-muted-foreground text-xs">or drop files and folders here</span>
      </div>
    </div>
  )
}

/**
 * Every setting of a backup, grouped like System Settings. Controlled: changes go to `onChange`
 * and nothing is saved here. `errors` maps a group id to its message.
 */
export function BackupForm({
  config,
  draft,
  onChange,
  errors = {},
  isNew = false
}: {
  config: Config
  draft: Draft
  onChange: (d: Draft) => void
  errors?: Record<string, string>
  isNew?: boolean
}): React.JSX.Element {
  // A new backup's name, folder name and mode follow its first item and packaging until edited.
  const [slugTouched, setSlugTouched] = useState(!isNew)
  const [modeTouched, setModeTouched] = useState(!isNew)
  const [editingDest, setEditingDest] = useState<Destination | 'new' | null>(null)
  const s = draft.source
  const otherSlugs = config.sources.filter((x) => x.id !== s.id).map((x) => x.slug)
  const patch = (p: Partial<Source>): void => onChange({ ...draft, source: { ...s, ...p } })
  const setName = (name: string): void =>
    patch(slugTouched ? { name } : { name, slug: slugify(name, otherSlugs) })
  const shared = config.destinations.filter((d) => d.ownerSourceId === null)
  const explicit = s.destinationIds === 'all' ? null : s.destinationIds
  const zip = s.packaging !== 'copy'
  const hasFolder = s.items.some((i) => i.kind === 'folder')

  return (
    <div className="grid gap-6">
      <Group title="General" id="general" error={errors.general}>
        <Row label="Name">
          <Input className="w-64" value={s.name} onChange={(e) => setName(e.target.value)} />
        </Row>
        <Row label="Folder name at destination">
          <Input
            className="w-64"
            value={s.slug}
            onChange={(e) => {
              setSlugTouched(true)
              patch({ slug: e.target.value })
            }}
          />
        </Row>
      </Group>

      <Group title="What" id="items" error={errors.items}>
        <ItemsEditor
          items={s.items}
          onChange={(items) => {
            const first = items[0] && !s.name ? fileName(items[0].path) : null
            patch({
              items,
              ...(first
                ? { name: first, ...(slugTouched ? {} : { slug: slugify(first, otherSlugs) }) }
                : {})
            })
          }}
        />
      </Group>

      <Group title="Where" id="where" error={errors.where}>
        <Row label="All shared drives">
          <Switch
            checked={explicit === null}
            onCheckedChange={(on) =>
              patch({ destinationIds: on ? 'all' : shared.map((d) => d.id) })
            }
          />
        </Row>
        {explicit !== null &&
          shared.map((d) => (
            <label key={d.id} className="flex min-w-0 items-center gap-2 px-3 py-2 pl-6 text-sm">
              <Checkbox
                checked={explicit.includes(d.id)}
                onCheckedChange={(c) =>
                  patch({
                    destinationIds:
                      c === true ? [...explicit, d.id] : explicit.filter((id) => id !== d.id)
                  })
                }
              />
              <span className="font-medium">{d.name}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs">
                {shortPath(d.path)}
              </span>
            </label>
          ))}
        {draft.own.map((d) => (
          <div key={d.id} className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
            <Switch
              checked={d.enabled}
              aria-label={`Use ${d.name}`}
              onCheckedChange={(enabled) =>
                onChange({
                  ...draft,
                  own: draft.own.map((x) => (x.id === d.id ? { ...x, enabled } : x))
                })
              }
            />
            <span className="font-medium">{d.name}</span>
            <span className="text-muted-foreground text-xs">only this backup</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs">
              {shortPath(d.path)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Edit ${d.name}`}
              onClick={() => setEditingDest(d)}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Remove ${d.name}`}
              onClick={() => onChange({ ...draft, own: draft.own.filter((x) => x.id !== d.id) })}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <div className="px-3 py-2">
          <Button variant="outline" size="sm" onClick={() => setEditingDest('new')}>
            <Plus /> Add a drive for this backup only…
          </Button>
        </div>
      </Group>

      <Group title="Schedule" id="schedule">
        <Row label="Run">
          <Menu
            value={s.schedule?.kind ?? 'none'}
            onChange={(v) =>
              patch({ schedule: v === 'none' ? null : defaultSchedule(v as Schedule['kind']) })
            }
            options={[
              { id: 'interval', label: 'Every few hours' },
              { id: 'daily', label: 'Every day' },
              { id: 'weekly', label: 'Every week' },
              { id: 'none', label: 'Only when I click Back up now' }
            ]}
          />
        </Row>
        {s.schedule?.kind === 'interval' && (
          <Row label="Every">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                className="w-20"
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
              <span className="text-muted-foreground">hours</span>
            </div>
          </Row>
        )}
        {s.schedule?.kind === 'weekly' && (
          <Row label="On">
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
                          days: on ? [...sched.days, d.id] : sched.days.filter((x) => x !== d.id)
                        }
                      })
                    }
                  >
                    {d.label}
                  </Toggle>
                )
              })}
            </div>
          </Row>
        )}
        {s.schedule && s.schedule.kind !== 'interval' && (
          <Row label="At">
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
          </Row>
        )}
        {s.schedule && (
          <Row label="Retry when a drive comes back">
            <Switch
              checked={s.retryWhenAvailable}
              onCheckedChange={(retryWhenAvailable) => patch({ retryWhenAvailable })}
            />
          </Row>
        )}
      </Group>

      <Group title="Versions" id="versions">
        <Row label="Keep">
          <Menu
            value={s.mode}
            onChange={(mode) => {
              setModeTouched(true)
              patch({ mode })
            }}
            options={[
              { id: 'mirror', label: 'An up-to-date copy' },
              { id: 'snapshot', label: 'Dated versions' }
            ]}
          />
        </Row>
        {s.mode === 'snapshot' && (
          <>
            <Row label="Always keep at least">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  className="w-20"
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
                <span className="text-muted-foreground">versions</span>
              </div>
            </Row>
            <Row label="Delete versions older than">
              <Days
                value={s.snapshot.maxAgeDays}
                noneLabel="Never"
                onChange={(maxAgeDays) => patch({ snapshot: { ...s.snapshot, maxAgeDays } })}
              />
            </Row>
          </>
        )}
      </Group>

      {s.mode === 'mirror' && (
        <Group title="Deletions" id="deletions">
          <Row label="When a file is deleted">
            <Menu
              value={s.mirror.deletion}
              onChange={(deletion) => patch({ mirror: { ...s.mirror, deletion } })}
              options={[
                { id: 'trash', label: 'Move it to the trash' },
                { id: 'exact', label: 'Delete it from the backup' },
                { id: 'never', label: 'Keep it in the backup' }
              ]}
            />
          </Row>
          {s.mirror.deletion === 'trash' && (
            <Row label="Empty the trash after">
              <Days
                value={s.mirror.trashRetentionDays}
                noneLabel="Never"
                onChange={(trashRetentionDays) =>
                  patch({ mirror: { ...s.mirror, trashRetentionDays } })
                }
              />
            </Row>
          )}
        </Group>
      )}

      {hasFolder && (
        <Group title="Exclusions" id="exclusions">
          <Row
            label="Skip files matching"
            hint="One pattern per line, like *.tmp or node_modules/"
            stack
          >
            <Textarea
              rows={3}
              className="font-mono text-xs"
              placeholder={'node_modules/\n*.tmp'}
              value={draft.excludes}
              onChange={(e) => onChange({ ...draft, excludes: e.target.value })}
            />
          </Row>
          <Row
            label="Also use the global exclusions"
            hint={config.globalExcludes.join(', ') || 'none'}
          >
            <Switch
              checked={s.useGlobalExcludes}
              onCheckedChange={(useGlobalExcludes) => patch({ useGlobalExcludes })}
            />
          </Row>
        </Group>
      )}

      <Group title="Zip" id="zip">
        <Row label="Store as">
          <Menu
            value={s.packaging}
            onChange={(packaging) =>
              patch(modeTouched ? { packaging } : { packaging, mode: defaultModeFor(packaging) })
            }
            options={[
              { id: 'copy', label: 'Plain files' },
              { id: 'zip-whole', label: 'One zip' },
              { id: 'zip-children', label: 'A zip per item' }
            ]}
          />
        </Row>
        {zip && (
          <Row
            label={`Compression: ${s.zip.level}`}
            hint="0 stores files as they are (fastest), 9 compresses most"
          >
            <Slider
              className="w-64"
              min={0}
              max={9}
              step={1}
              value={[s.zip.level]}
              onValueChange={([level]) => patch({ zip: { ...s.zip, level } })}
            />
          </Row>
        )}
        {s.packaging === 'zip-children' && (
          <Row label="Loose files in a folder">
            <Menu
              value={s.zip.looseFiles}
              onChange={(looseFiles) => patch({ zip: { ...s.zip, looseFiles } })}
              options={[
                { id: 'individual', label: 'One zip per file' },
                { id: 'bundle', label: 'All together in _files.zip' }
              ]}
            />
          </Row>
        )}
        {zip && (
          <Row label="Split archives larger than" hint="Each part opens on its own">
            <SizeInput
              value={s.zip.partLimitBytes}
              onChange={(partLimitBytes) => patch({ zip: { ...s.zip, partLimitBytes } })}
              offLabel="Never split"
              defaultBytes={2 * 1024 ** 3}
            />
          </Row>
        )}
        {zip && s.zip.partLimitBytes !== null && (
          <Row label="Files larger than the limit">
            <Menu
              value={s.zip.oversized}
              onChange={(oversized) => patch({ zip: { ...s.zip, oversized } })}
              options={[
                { id: 'own-part', label: 'Keep whole in their own part' },
                { id: 'chunk', label: 'Split into raw chunks' }
              ]}
            />
          </Row>
        )}
        {zip && s.zip.partLimitBytes !== null && s.zip.oversized === 'chunk' && (
          <Row label="Chunk size">
            <SizeInput
              value={s.zip.chunkBytes}
              onChange={(chunkBytes) => patch({ zip: { ...s.zip, chunkBytes } })}
              offLabel="Same as the limit"
              defaultBytes={s.zip.partLimitBytes}
            />
          </Row>
        )}
      </Group>

      {editingDest && (
        <DestinationDialog
          initial={editingDest === 'new' ? null : editingDest}
          ownerName={s.name.trim() || 'this backup'}
          ownerSourceId={s.id}
          onSave={async (d) => {
            onChange({
              ...draft,
              own: draft.own.some((x) => x.id === d.id)
                ? draft.own.map((x) => (x.id === d.id ? d : x))
                : [...draft.own, d]
            })
            return true
          }}
          onClose={() => setEditingDest(null)}
        />
      )}
    </div>
  )
}
