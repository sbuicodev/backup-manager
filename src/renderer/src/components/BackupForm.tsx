import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  defaultModeFor,
  fileName,
  slugify,
  type Config,
  type Destination,
  type Schedule,
  type Source,
  type Weekday
} from '@shared/schema'
import { DestinationDialog } from '@/components/DestinationDialog'
import { ItemsEditor } from '@/components/ItemsEditor'
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
import { t } from '@/i18n'
import type { Draft } from '@/lib/backup-draft'
import { shortPath } from '@/lib/summary'
import { cn } from '@/lib/utils'

const DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

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
      <span className="text-muted-foreground">{t('form.days')}</span>
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

/** A small subheading inside the drives list. */
function DriveHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-muted-foreground bg-muted/30 px-3 pt-2 pb-1 text-[11px] font-medium">
      {children}
    </div>
  )
}

/** One drive in the Where list: its checkbox, name and path. */
function DriveRow({
  dest,
  children,
  actions
}: {
  dest: Destination
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        {children}
        <span className="truncate font-medium">{dest.name}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs">
          {shortPath(dest.path)}
        </span>
      </label>
      {actions}
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
  isNew = false,
  addShared
}: {
  config: Config
  draft: Draft
  onChange: (d: Draft) => void
  /** Saves a new shared destination to the configuration. */
  addShared: (d: Destination) => Promise<boolean>
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
  const sharedOn = (id: string): boolean =>
    s.destinationIds === 'all' || s.destinationIds.includes(id)
  const drivesOn = [...shared.map((d) => sharedOn(d.id)), ...draft.own.map((d) => d.enabled)]
  const allOn = drivesOn.length > 0 && drivesOn.every(Boolean)
  const someOn = drivesOn.some(Boolean)
  const zip = s.packaging !== 'copy'
  const hasFolder = s.items.some((i) => i.kind === 'folder')

  return (
    <div className="grid gap-6">
      <Group title={t('form.general')} id="general" error={errors.general}>
        <Row label={t('form.name')}>
          <Input className="w-64" value={s.name} onChange={(e) => setName(e.target.value)} />
        </Row>
        <Row label={t('form.folderName')}>
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

      <Group title={t('form.what')} id="items" error={errors.items}>
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

      <Group title={t('form.where')} id="where" error={errors.where}>
        <label className="flex min-w-0 items-center gap-2 px-3 py-2.5 text-sm font-medium">
          <Checkbox
            checked={allOn ? true : someOn ? 'indeterminate' : false}
            onCheckedChange={() =>
              onChange({
                ...draft,
                source: { ...s, destinationIds: allOn ? [] : 'all' },
                own: draft.own.map((x) => ({ ...x, enabled: !allOn }))
              })
            }
          />
          {t('form.selectAll')}
        </label>
        {shared.length > 0 && <DriveHeading>{t('form.shared')}</DriveHeading>}
        {shared.map((d) => (
          <DriveRow key={d.id} dest={d}>
            <Checkbox
              checked={sharedOn(d.id)}
              onCheckedChange={(c) => {
                const ids = shared.filter((x) => sharedOn(x.id)).map((x) => x.id)
                patch({
                  destinationIds: c === true ? [...ids, d.id] : ids.filter((id) => id !== d.id)
                })
              }}
            />
          </DriveRow>
        ))}
        {draft.own.length > 0 && <DriveHeading>{t('form.custom')}</DriveHeading>}
        {draft.own.map((d) => (
          <DriveRow
            key={d.id}
            dest={d}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('form.edit', { name: d.name })}
                  onClick={() => setEditingDest(d)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('form.remove', { name: d.name })}
                  onClick={() =>
                    onChange({ ...draft, own: draft.own.filter((x) => x.id !== d.id) })
                  }
                >
                  <Trash2 />
                </Button>
              </>
            }
          >
            <Checkbox
              checked={d.enabled}
              onCheckedChange={(c) =>
                onChange({
                  ...draft,
                  own: draft.own.map((x) => (x.id === d.id ? { ...x, enabled: c === true } : x))
                })
              }
            />
          </DriveRow>
        ))}
        <div className="px-3 py-2">
          <Button variant="outline" size="sm" onClick={() => setEditingDest('new')}>
            <Plus /> {t('form.addCustom')}
          </Button>
        </div>
      </Group>

      <Group title={t('form.schedule')} id="schedule">
        <Row label={t('form.backUp')}>
          <Menu
            value={s.schedule?.kind ?? 'none'}
            onChange={(v) =>
              patch({ schedule: v === 'none' ? null : defaultSchedule(v as Schedule['kind']) })
            }
            options={[
              { id: 'interval', label: t('form.interval') },
              { id: 'daily', label: t('form.daily') },
              { id: 'weekly', label: t('form.weekly') },
              { id: 'none', label: t('form.manual') }
            ]}
          />
        </Row>
        {s.schedule?.kind === 'interval' && (
          <Row label={t('form.every')}>
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
              <span className="text-muted-foreground">{t('form.hours')}</span>
            </div>
          </Row>
        )}
        {s.schedule?.kind === 'weekly' && (
          <Row label={t('form.on')}>
            <div className="flex gap-1">
              {DAYS.map((d) => {
                const sched = s.schedule as Extract<Schedule, { kind: 'weekly' }>
                return (
                  <Toggle
                    key={d}
                    size="sm"
                    variant="outline"
                    pressed={sched.days.includes(d)}
                    onPressedChange={(on) =>
                      patch({
                        schedule: {
                          ...sched,
                          days: on ? [...sched.days, d] : sched.days.filter((x) => x !== d)
                        }
                      })
                    }
                  >
                    {t(`days.${d}`)}
                  </Toggle>
                )
              })}
            </div>
          </Row>
        )}
        {s.schedule && s.schedule.kind !== 'interval' && (
          <Row label={t('form.at')}>
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
          <Row label={t('form.retry')}>
            <Switch
              checked={s.retryWhenAvailable}
              onCheckedChange={(retryWhenAvailable) => patch({ retryWhenAvailable })}
            />
          </Row>
        )}
      </Group>

      <Group title={t('form.versions')} id="versions">
        <Row label={t('form.keep')}>
          <Menu
            value={s.mode}
            onChange={(mode) => {
              setModeTouched(true)
              patch({ mode })
            }}
            options={[
              { id: 'mirror', label: t('form.mirror') },
              { id: 'snapshot', label: t('form.snapshot') }
            ]}
          />
        </Row>
        {s.mode === 'snapshot' && (
          <>
            <Row label={t('form.keepAtLeast')}>
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
                <span className="text-muted-foreground">{t('form.versionsUnit')}</span>
              </div>
            </Row>
            <Row label={t('form.deleteAfter')}>
              <Days
                value={s.snapshot.maxAgeDays}
                noneLabel={t('form.never')}
                onChange={(maxAgeDays) => patch({ snapshot: { ...s.snapshot, maxAgeDays } })}
              />
            </Row>
          </>
        )}
      </Group>

      {s.mode === 'mirror' && (
        <Group title={t('form.deletions')} id="deletions">
          <Row label={t('form.deletedItems')}>
            <Menu
              value={s.mirror.deletion}
              onChange={(deletion) => patch({ mirror: { ...s.mirror, deletion } })}
              options={[
                { id: 'trash', label: t('form.trash') },
                { id: 'exact', label: t('form.exact') },
                { id: 'never', label: t('form.keepDeleted') }
              ]}
            />
          </Row>
          {s.mirror.deletion === 'trash' && (
            <Row label={t('form.emptyTrash')}>
              <Days
                value={s.mirror.trashRetentionDays}
                noneLabel={t('form.never')}
                onChange={(trashRetentionDays) =>
                  patch({ mirror: { ...s.mirror, trashRetentionDays } })
                }
              />
            </Row>
          )}
        </Group>
      )}

      {hasFolder && (
        <Group title={t('form.exclusions')} id="exclusions">
          <Row label={t('form.skip')} hint={t('form.skipHint')} stack>
            <Textarea
              rows={3}
              className="font-mono text-xs"
              placeholder={'node_modules/\n*.tmp'}
              value={draft.excludes}
              onChange={(e) => onChange({ ...draft, excludes: e.target.value })}
            />
          </Row>
          <Row label={t('form.global')} hint={config.globalExcludes.join(', ') || t('form.none')}>
            <Switch
              checked={s.useGlobalExcludes}
              onCheckedChange={(useGlobalExcludes) => patch({ useGlobalExcludes })}
            />
          </Row>
        </Group>
      )}

      <Group title={t('form.zip')} id="zip">
        <Row label={t('form.saveAs')}>
          <Menu
            value={s.packaging}
            onChange={(packaging) =>
              patch(modeTouched ? { packaging } : { packaging, mode: defaultModeFor(packaging) })
            }
            options={[
              { id: 'copy', label: t('packaging.copy') },
              { id: 'zip-whole', label: t('packaging.zip-whole') },
              { id: 'zip-children', label: t('packaging.zip-children') }
            ]}
          />
        </Row>
        {zip && (
          <Row
            label={t('form.compression', { level: s.zip.level })}
            hint={t('form.compressionHint')}
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
          <Row label={t('form.looseFiles')}>
            <Menu
              value={s.zip.looseFiles}
              onChange={(looseFiles) => patch({ zip: { ...s.zip, looseFiles } })}
              options={[
                { id: 'individual', label: t('form.individual') },
                { id: 'bundle', label: t('form.bundle') }
              ]}
            />
          </Row>
        )}
        {zip && (
          <Row label={t('form.splitAt')} hint={t('form.splitHint')}>
            <SizeInput
              value={s.zip.partLimitBytes}
              onChange={(partLimitBytes) => patch({ zip: { ...s.zip, partLimitBytes } })}
              offLabel={t('form.neverSplit')}
              defaultBytes={2 * 1024 ** 3}
            />
          </Row>
        )}
        {zip && s.zip.partLimitBytes !== null && (
          <Row label={t('form.larger')}>
            <Menu
              value={s.zip.oversized}
              onChange={(oversized) => patch({ zip: { ...s.zip, oversized } })}
              options={[
                { id: 'own-part', label: t('form.ownPart') },
                { id: 'chunk', label: t('form.chunk') }
              ]}
            />
          </Row>
        )}
        {zip && s.zip.partLimitBytes !== null && s.zip.oversized === 'chunk' && (
          <Row label={t('form.chunkSize')}>
            <SizeInput
              value={s.zip.chunkBytes}
              onChange={(chunkBytes) => patch({ zip: { ...s.zip, chunkBytes } })}
              offLabel={t('form.sameAsParts')}
              defaultBytes={s.zip.partLimitBytes}
            />
          </Row>
        )}
      </Group>

      {editingDest && (
        <DestinationDialog
          initial={editingDest === 'new' ? null : editingDest}
          owner={{ id: s.id, name: s.name.trim() || t('common.newBackup') }}
          onSave={async (d) => {
            if (d.ownerSourceId === null) {
              // A shared destination is saved right away, like one made from the sidebar.
              if (!(await addShared(d))) return false
              if (s.destinationIds !== 'all') patch({ destinationIds: [...s.destinationIds, d.id] })
              return true
            }
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
