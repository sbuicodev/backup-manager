import { t } from '@/i18n'
import type { Config, Destination, Source } from '@shared/schema'

/** A backup being edited: nothing is saved until `buildNextConfig` is used on Save. */
export type Draft = {
  source: Source
  /** Drives that belong to this backup only, edited along with it. */
  own: Destination[]
  /** Exclusions as typed, one pattern per line. */
  excludes: string
}

export function draftFrom(config: Config, source: Source): Draft {
  return {
    source: structuredClone(source),
    own: config.destinations.filter((d) => d.ownerSourceId === source.id).map((d) => ({ ...d })),
    excludes: source.excludes.join('\n')
  }
}

/** Whether the draft differs from what is saved (a new backup is always unsaved). */
export function isDirty(config: Config, draft: Draft): boolean {
  const saved = config.sources.find((s) => s.id === draft.source.id)
  if (!saved) return true
  return JSON.stringify(draftFrom(config, saved)) !== JSON.stringify(draft)
}

/** Drives the draft would back up to: its own ones and the shared ones it selects. */
function drivesOf(config: Config, draft: Draft): Destination[] {
  const ids = draft.source.destinationIds
  return [
    ...draft.own,
    ...config.destinations.filter(
      (d) => d.ownerSourceId === null && (ids === 'all' || ids.includes(d.id))
    )
  ]
}

/**
 * The configuration with this draft saved: name trimmed, exclusions parsed, the backup's own
 * drives replaced, and setup finished. Refuses when no drive would be used.
 */
export function buildNextConfig(
  config: Config,
  draft: Draft
): { next: Config } | { error: string } {
  if (drivesOf(config, draft).length === 0) return { error: t('draft.addDrive') }
  const source: Source = {
    ...draft.source,
    name: draft.source.name.trim(),
    excludes: draft.excludes
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    setupComplete: true
  }
  const exists = config.sources.some((s) => s.id === source.id)
  return {
    next: {
      ...config,
      destinations: [
        ...config.destinations.filter((d) => d.ownerSourceId !== source.id),
        ...draft.own
      ],
      sources: exists
        ? config.sources.map((s) => (s.id === source.id ? source : s))
        : [...config.sources, source]
    }
  }
}

/** Which form section a config field belongs to. */
const GROUP_OF: Record<string, string> = {
  name: 'general',
  slug: 'general',
  items: 'items',
  destinationIds: 'where',
  schedule: 'schedule',
  snapshot: 'versions',
  mirror: 'deletions',
  excludes: 'exclusions',
  zip: 'zip'
}

/**
 * Validation errors keyed by form section ("sources.0.zip.level: …" → zip). Errors that don't
 * concern this backup's fields go to "general"; the missing-drive error goes to "where".
 */
export function errorsByGroup(errors: string[]): Record<string, string> {
  const out: Record<string, string[]> = {}
  for (const e of errors) {
    const m = /^sources\.\d+\.(\w+)[^:]*: (.*)$/s.exec(e)
    const group =
      e === t('draft.addDrive') ? 'where' : m && GROUP_OF[m[1]] ? GROUP_OF[m[1]] : 'general'
    ;(out[group] ??= []).push(m && GROUP_OF[m[1]] ? m[2] : e)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join(' · ')]))
}
