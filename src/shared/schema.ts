import { z } from 'zod'

export const DEFAULT_GLOBAL_EXCLUDES = ['.DS_Store', 'Thumbs.db', 'desktop.ini']

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** POSIX absolute, Windows drive-absolute (C:\ or C:/) or UNC (\\server\share). */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/
const AbsolutePath = z.string().regex(ABSOLUTE_PATH, 'must be an absolute path')

/**
 * The source's folder name on every destination. Spaces are fine; it must already be in
 * slugify's safe form (no characters Windows forbids, no leading/trailing space or dot).
 */
const Slug = z
  .string()
  .min(1)
  .refine((s) => slugify(s, []) === s && !s.toLowerCase().endsWith('.bm-partial'), {
    message:
      'can\'t contain < > : " / \\ | ? *, start or end with a space or dot, or be a reserved name'
  })

export const WeekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

export const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), everyHours: z.number().int().min(1) }),
  z.object({ kind: z.literal('daily'), time: z.string().regex(TIME, 'expected HH:MM') }),
  z.object({
    kind: z.literal('weekly'),
    days: z.array(WeekdaySchema).min(1, 'pick at least one day'),
    time: z.string().regex(TIME, 'expected HH:MM')
  })
])

export const SettingsSchema = z.object({
  launchAtLogin: z.boolean(),
  notifications: z.enum(['problems', 'always', 'never']),
  skipScheduledOnBattery: z.boolean(),
  /** Frosted glass appearance. Earlier builds stored a level name: any level but 'off' means on. */
  glass: z.preprocess((v) => (typeof v === 'string' ? v !== 'off' : v), z.boolean().default(true))
})

/** Smallest allowed zip part limit or chunk size: 1 MiB. */
export const MIN_PART_BYTES = 1_048_576
const PartBytes = z.number().int().min(MIN_PART_BYTES).nullable()

export const DestinationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: AbsolutePath,
  enabled: z.boolean(),
  zipPartLimitBytes: PartBytes.default(null),
  forceChunkOversized: z.boolean().default(false),
  /** The source this destination belongs to exclusively; null = shared by every source. */
  ownerSourceId: z.string().nullable().default(null)
})

/** One file or folder a source backs up; at the destination it is stored under its own name. */
export const SourceItemSchema = z.object({
  path: AbsolutePath,
  kind: z.enum(['file', 'folder'])
})

/**
 * Configs written before sources became item lists had either `kind: 'folder'` + `path` (the
 * folder's contents stored directly in the backup folder) or `kind: 'files'` + `files`.
 */
function itemsFromLegacySource(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || 'items' in raw) return raw
  const { kind, path, files, ...rest } = raw as Record<string, unknown>
  if (kind === 'files') {
    const list = Array.isArray(files) ? files : []
    return { ...rest, items: list.map((f) => ({ path: f, kind: 'file' })) }
  }
  const p = typeof path === 'string' ? path : ''
  return {
    ...rest,
    items: p ? [{ path: p, kind: 'folder' }] : [],
    // Its backups still hold the folder's contents directly; a mirror run moves them down.
    legacyFlatName: p ? fileName(p) : null
  }
}

export const SourceSchema = z.preprocess(
  itemsFromLegacySource,
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: Slug,
    items: z.array(SourceItemSchema),
    /**
     * Set for sources converted from a one-folder config: the name of the folder whose contents a
     * mirror made before this change holds directly in the backup folder (moved down on its next run).
     */
    legacyFlatName: z.string().nullable().default(null),
    enabled: z.boolean(),
    mode: z.enum(['mirror', 'snapshot']),
    packaging: z.enum(['copy', 'zip-whole', 'zip-children']),
    zip: z.object({
      level: z.number().int().min(0).max(9),
      looseFiles: z.enum(['individual', 'bundle']),
      partLimitBytes: PartBytes.default(null),
      oversized: z.enum(['own-part', 'chunk']).default('own-part'),
      chunkBytes: PartBytes.default(null)
    }),
    mirror: z.object({
      deletion: z.enum(['trash', 'exact', 'never']),
      trashRetentionDays: z.number().int().min(0).nullable()
    }),
    snapshot: z.object({
      keepMin: z.number().int().min(1),
      maxAgeDays: z.number().int().min(0).nullable()
    }),
    excludes: z.array(z.string()),
    useGlobalExcludes: z.boolean(),
    destinationIds: z.union([z.literal('all'), z.array(z.string())]),
    schedule: ScheduleSchema.nullable(),
    retryWhenAvailable: z.boolean()
  })
)

/** Normalizes a path for nesting checks: '/' separators, no trailing slash, lower case. */
function normPath(p: string): string {
  let n = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n.toLowerCase()
}

/** Last segment of a path, with either separator. */
export function fileName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function isSameOrInside(child: string, parent: string): boolean {
  const c = normPath(child)
  const p = normPath(parent)
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
}

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    globalExcludes: z.array(z.string()),
    settings: SettingsSchema,
    destinations: z.array(DestinationSchema),
    sources: z.array(SourceSchema)
  })
  .superRefine((cfg, ctx) => {
    cfg.sources.forEach((s, i) => {
      const issue = (message: string): void =>
        ctx.addIssue({ code: 'custom', path: ['sources', i, 'items'], message })
      if (s.items.length === 0) issue('add at least one file or folder')
      const seen = new Map<string, string>()
      for (const it of s.items) {
        const name = fileName(it.path)
        const prev = seen.get(name.toLowerCase())
        if (prev !== undefined) issue(`"${prev}" and "${it.path}" have the same name "${name}"`)
        seen.set(name.toLowerCase(), it.path)
        const outer = s.items.find(
          (o) => o !== it && o.kind === 'folder' && isSameOrInside(it.path, o.path)
        )
        if (outer) issue(`"${it.path}" is already inside "${outer.path}"`)
      }
    })
    const slugs = new Map<string, number>()
    cfg.sources.forEach((s, i) => {
      const key = s.slug.toLowerCase()
      if (slugs.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', i, 'slug'],
          message: `duplicate slug "${s.slug}"`
        })
      }
      slugs.set(key, i)
    })
    const destById = new Map(cfg.destinations.map((d) => [d.id, d]))
    const sourceById = new Map(cfg.sources.map((s) => [s.id, s]))
    cfg.destinations.forEach((d, i) => {
      if (d.ownerSourceId !== null && !sourceById.has(d.ownerSourceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['destinations', i, 'ownerSourceId'],
          message: `owner source "${d.ownerSourceId}" does not exist`
        })
      }
    })
    cfg.sources.forEach((s, i) => {
      if (s.destinationIds !== 'all') {
        for (const id of s.destinationIds) {
          const d = destById.get(id)
          if (!d) {
            ctx.addIssue({
              code: 'custom',
              path: ['sources', i, 'destinationIds'],
              message: `unknown destination "${id}"`
            })
          } else if (d.ownerSourceId !== null && d.ownerSourceId !== s.id) {
            const owner = sourceById.get(d.ownerSourceId)?.name ?? d.ownerSourceId
            ctx.addIssue({
              code: 'custom',
              path: ['sources', i, 'destinationIds'],
              message: `destination "${d.name}" is only for "${owner}"`
            })
          }
        }
      }
      for (const d of cfg.destinations) {
        for (const it of s.items) {
          if (isSameOrInside(it.path, d.path)) {
            ctx.addIssue({
              code: 'custom',
              path: ['sources', i, 'items'],
              message: `"${it.path}" is inside destination "${d.name}"`
            })
          } else if (it.kind === 'folder' && isSameOrInside(d.path, it.path)) {
            ctx.addIssue({
              code: 'custom',
              path: ['sources', i, 'items'],
              message: `destination "${d.name}" is inside "${it.path}"`
            })
          }
        }
      }
    })
  })

export type Weekday = z.infer<typeof WeekdaySchema>
export type Schedule = z.infer<typeof ScheduleSchema>
export type Settings = z.infer<typeof SettingsSchema>
export type Destination = z.infer<typeof DestinationSchema>
export type Source = z.infer<typeof SourceSchema>
export type SourceItem = z.infer<typeof SourceItemSchema>
export type Config = z.infer<typeof ConfigSchema>

export function defaultConfig(): Config {
  return {
    version: 1,
    globalExcludes: [...DEFAULT_GLOBAL_EXCLUDES],
    settings: {
      launchAtLogin: true,
      notifications: 'problems',
      skipScheduledOnBattery: false,
      glass: true
    },
    destinations: [],
    sources: []
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function slugify(name: string, existing: string[]): string {
  // Characters Windows forbids become spaces; runs of whitespace collapse to one space.
  let base = name
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (base === '') base = 'source'
  if (RESERVED.test(base)) base = `${base}-1`
  const taken = new Set(existing.map((s) => s.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function defaultModeFor(packaging: Source['packaging']): Source['mode'] {
  return packaging === 'copy' ? 'mirror' : 'snapshot'
}

export function newSource(path: string, name: string, existingSlugs: string[]): Source {
  return {
    id: crypto.randomUUID(),
    name,
    slug: slugify(name, existingSlugs),
    items: path ? [{ path, kind: 'folder' }] : [],
    legacyFlatName: null,
    enabled: true,
    mode: 'mirror',
    packaging: 'copy',
    zip: {
      level: 6,
      looseFiles: 'individual',
      partLimitBytes: null,
      oversized: 'own-part',
      chunkBytes: null
    },
    mirror: { deletion: 'trash', trashRetentionDays: null },
    snapshot: { keepMin: 10, maxAgeDays: null },
    excludes: [],
    useGlobalExcludes: true,
    destinationIds: 'all',
    schedule: null,
    retryWhenAvailable: true
  }
}

export function newDestination(path: string, name: string): Destination {
  return {
    id: crypto.randomUUID(),
    name,
    path,
    enabled: true,
    zipPartLimitBytes: null,
    forceChunkOversized: false,
    ownerSourceId: null
  }
}

export function validateConfig(
  input: unknown
): { ok: true; config: Config } | { ok: false; errors: string[] } {
  const r = ConfigSchema.safeParse(input)
  if (r.success) return { ok: true, config: r.data }
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  }
}

export type EffectiveZip = { limit: number | null; chunk: boolean; chunkSize: number | null }

/** Part limit, chunking and chunk size for one source × destination job (smaller limit wins). */
export function effectiveZipSettings(source: Source, dest: Destination): EffectiveZip {
  const limits = [source.zip.partLimitBytes, dest.zipPartLimitBytes].filter(
    (n): n is number => n !== null
  )
  const limit = limits.length > 0 ? Math.min(...limits) : null
  return {
    limit,
    chunk: source.zip.oversized === 'chunk' || dest.forceChunkOversized,
    chunkSize: limit === null ? null : Math.min(source.zip.chunkBytes ?? limit, limit)
  }
}
