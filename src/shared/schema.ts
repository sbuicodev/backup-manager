import { z } from 'zod'

export const DEFAULT_GLOBAL_EXCLUDES = ['.DS_Store', 'Thumbs.db', 'desktop.ini']

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** POSIX absolute, Windows drive-absolute (C:\ or C:/) or UNC (\\server\share). */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/
const AbsolutePath = z.string().regex(ABSOLUTE_PATH, 'must be an absolute path')

/** A slug is used as a folder name on every destination: it must already be in slugify's safe form. */
const Slug = z
  .string()
  .min(1)
  .refine((s) => slugify(s, []) === s && !s.toLowerCase().endsWith('.bm-partial'), {
    message:
      'slug must be a plain folder name (letters, digits, - _ .; no separators or reserved names)'
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
  skipScheduledOnBattery: z.boolean()
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
  forceChunkOversized: z.boolean().default(false)
})

export const SourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: Slug,
  path: AbsolutePath,
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

/** Normalizes a path for nesting checks: '/' separators, no trailing slash, lower case. */
function normPath(p: string): string {
  let n = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n.toLowerCase()
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
    const destIds = new Set(cfg.destinations.map((d) => d.id))
    cfg.sources.forEach((s, i) => {
      if (s.destinationIds !== 'all') {
        for (const id of s.destinationIds) {
          if (!destIds.has(id)) {
            ctx.addIssue({
              code: 'custom',
              path: ['sources', i, 'destinationIds'],
              message: `unknown destination "${id}"`
            })
          }
        }
      }
      for (const d of cfg.destinations) {
        if (isSameOrInside(s.path, d.path)) {
          ctx.addIssue({
            code: 'custom',
            path: ['sources', i, 'path'],
            message: `source "${s.name}" is inside destination "${d.name}"`
          })
        } else if (isSameOrInside(d.path, s.path)) {
          ctx.addIssue({
            code: 'custom',
            path: ['sources', i, 'path'],
            message: `destination "${d.name}" is inside source "${s.name}"`
          })
        }
      }
    })
  })

export type Weekday = z.infer<typeof WeekdaySchema>
export type Schedule = z.infer<typeof ScheduleSchema>
export type Settings = z.infer<typeof SettingsSchema>
export type Destination = z.infer<typeof DestinationSchema>
export type Source = z.infer<typeof SourceSchema>
export type Config = z.infer<typeof ConfigSchema>

export function defaultConfig(): Config {
  return {
    version: 1,
    globalExcludes: [...DEFAULT_GLOBAL_EXCLUDES],
    settings: { launchAtLogin: true, notifications: 'problems', skipScheduledOnBattery: false },
    destinations: [],
    sources: []
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function slugify(name: string, existing: string[]): string {
  let base = name.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
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
    path,
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
    forceChunkOversized: false
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
