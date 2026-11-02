import { slugify, type Config, type Source } from '@shared/schema'
import type { Plan } from '@shared/types'
import { formatBytes } from './format'

/** What the detail pane shows. */
export type Selection =
  { kind: 'backup' | 'drive'; id: string } | { kind: 'activity' | 'settings' | 'new' | 'empty' }

/**
 * A selection that still exists: a removed backup or drive falls back to the first backup, a
 * drive that belongs to one backup shows that backup, and with no backups there is the empty state.
 */
export function resolveSelection(sel: Selection | null, config: Config): Selection {
  const first: Selection = config.sources[0]
    ? { kind: 'backup', id: config.sources[0].id }
    : { kind: 'empty' }
  if (!sel || sel.kind === 'empty') return first
  if (sel.kind === 'backup') return config.sources.some((s) => s.id === sel.id) ? sel : first
  if (sel.kind === 'drive') {
    const d = config.destinations.find((x) => x.id === sel.id)
    if (!d) return first
    if (d.ownerSourceId) return { kind: 'backup', id: d.ownerSourceId }
    return sel
  }
  return sel
}

/** A copy of a backup under a new id, with " copy" added to its name and folder name. */
export function duplicateSource(source: Source, existingSlugs: string[]): Source {
  const copy = structuredClone(source)
  return {
    ...copy,
    id: crypto.randomUUID(),
    name: `${source.name} copy`,
    slug: slugify(`${source.slug} copy`, existingSlugs)
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What Back up now would do, for its tooltip. */
export function planPreview(plan: Plan): string {
  if (plan.jobs.length === 0) return 'Nothing to back up'
  const ready = plan.jobs.filter((j) => j.status === 'ready')
  const files = ready.reduce((n, j) => n + j.counts.copy + j.counts.update, 0)
  const zips = ready.reduce((n, j) => n + j.counts.zip, 0)
  const bytes = ready.reduce((n, j) => n + j.bytes, 0)
  const missing = new Set(
    plan.jobs.filter((j) => j.reason === 'destination-missing').map((j) => j.destId)
  ).size
  const work = [
    files > 0 && `copy ${plural(files, 'file', 'files')}`,
    zips > 0 && `write ${plural(zips, 'archive', 'archives')}`
  ].filter(Boolean)
  const parts = [
    work.length > 0
      ? `Will ${work.join(' and ')} (${formatBytes(bytes)})`
      : 'Everything is up to date',
    missing > 0 && `${plural(missing, 'drive', 'drives')} not connected`
  ].filter(Boolean)
  return parts.join(' · ')
}

/** Backups that go to a drive: its owner for a drive of one backup, else those that select it. */
export function backupsOn(config: Config, destId: string): Source[] {
  const d = config.destinations.find((x) => x.id === destId)
  if (!d) return []
  if (d.ownerSourceId) return config.sources.filter((s) => s.id === d.ownerSourceId)
  return config.sources.filter(
    (s) => s.destinationIds === 'all' || s.destinationIds.includes(destId)
  )
}

/** The configuration with one more backup going to a shared drive. */
export function sendBackupTo(config: Config, sourceId: string, destId: string): Config {
  return {
    ...config,
    sources: config.sources.map((s) =>
      s.id !== sourceId || s.destinationIds === 'all' || s.destinationIds.includes(destId)
        ? s
        : { ...s, destinationIds: [...s.destinationIds, destId] }
    )
  }
}
