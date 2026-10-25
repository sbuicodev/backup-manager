import { describe, expect, test } from 'vitest'
import {
  defaultConfig,
  defaultModeFor,
  newDestination,
  newSource,
  slugify,
  validateConfig,
  type Config
} from '@shared/schema'

function errorsOf(cfg: unknown): string[] {
  const r = validateConfig(cfg)
  return r.ok ? [] : r.errors
}

function cfgWith(mut: (c: Config) => void): Config {
  const c = defaultConfig()
  mut(c)
  return c
}

describe('schema', () => {
  test('defaultConfig is valid', () => {
    expect(validateConfig(defaultConfig()).ok).toBe(true)
  })

  test('defaultConfig uses spec defaults', () => {
    const c = defaultConfig()
    expect(c.version).toBe(1)
    expect(c.globalExcludes).toEqual(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
    expect(c.settings).toEqual({
      launchAtLogin: true,
      notifications: 'problems',
      skipScheduledOnBattery: false
    })
  })

  test('slugify strips characters illegal on Windows and dedupes', () => {
    expect(slugify('My: Docs/"2024"?', [])).toBe('My-Docs-2024')
    expect(slugify('Docs', ['Docs'])).toBe('Docs-2')
    expect(slugify('docs', ['Docs', 'docs-2'])).toBe('docs-3')
    expect(slugify('CON', [])).toBe('CON-1')
    expect(slugify('...', [])).toBe('source')
  })

  test('newSource uses spec defaults', () => {
    const s = newSource('/p', 'Docs', [])
    expect(s).toMatchObject({
      name: 'Docs',
      path: '/p',
      enabled: true,
      mode: 'mirror',
      packaging: 'copy',
      zip: { level: 6, looseFiles: 'individual' },
      mirror: { deletion: 'trash', trashRetentionDays: null },
      snapshot: { keepMin: 10, maxAgeDays: null },
      excludes: [],
      useGlobalExcludes: true,
      destinationIds: 'all',
      schedule: null,
      retryWhenAvailable: true,
      slug: 'Docs'
    })
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('newSource dedupes slug', () => {
    expect(newSource('/p', 'Docs', ['Docs']).slug).toBe('Docs-2')
  })

  test('newDestination', () => {
    expect(newDestination('/d', 'NAS')).toMatchObject({ path: '/d', name: 'NAS', enabled: true })
  })

  test('defaultModeFor', () => {
    expect(defaultModeFor('copy')).toBe('mirror')
    expect(defaultModeFor('zip-whole')).toBe('snapshot')
    expect(defaultModeFor('zip-children')).toBe('snapshot')
  })

  test('rejects duplicate slugs (case-insensitive)', () => {
    const cfg = cfgWith((c) => {
      c.sources.push(newSource('/a', 'A', []), { ...newSource('/b', 'B', []), slug: 'a' })
    })
    expect(errorsOf(cfg)).toContainEqual(expect.stringContaining('slug'))
  })

  test('rejects source inside destination', () => {
    const cfg = cfgWith((c) => {
      c.destinations.push(newDestination('/x/backups', 'B'))
      c.sources.push(newSource('/x/backups/docs', 'Docs', []))
    })
    expect(errorsOf(cfg).join('\n')).toMatch(/inside/)
  })

  test('rejects destination inside source', () => {
    const cfg = cfgWith((c) => {
      c.destinations.push(newDestination('/x/out', 'B'))
      c.sources.push(newSource('/x', 'X', []))
    })
    expect(errorsOf(cfg).join('\n')).toMatch(/inside/)
  })

  test('sibling paths with common prefix are fine', () => {
    const cfg = cfgWith((c) => {
      c.destinations.push(newDestination('/x/docs-backup', 'B'))
      c.sources.push(newSource('/x/docs', 'Docs', []))
    })
    expect(errorsOf(cfg)).toEqual([])
  })

  test('rejects keepMin < 1', () => {
    const cfg = cfgWith((c) => {
      const s = newSource('/a', 'A', [])
      s.snapshot.keepMin = 0
      c.sources.push(s)
    })
    expect(errorsOf(cfg).length).toBeGreaterThan(0)
  })

  test.each([
    [{ kind: 'weekly', days: [], time: '09:00' }],
    [{ kind: 'daily', time: '24:00' }],
    [{ kind: 'daily', time: '9:00' }],
    [{ kind: 'interval', everyHours: 0 }],
    [{ kind: 'interval', everyHours: 1.5 }]
  ])('rejects bad schedule %j', (schedule) => {
    const cfg = cfgWith((c) => {
      c.sources.push({ ...newSource('/a', 'A', []), schedule: schedule as never })
    })
    expect(errorsOf(cfg).length).toBeGreaterThan(0)
  })

  test('accepts valid schedules', () => {
    const cfg = cfgWith((c) => {
      c.sources.push(
        { ...newSource('/a', 'A', []), schedule: { kind: 'interval', everyHours: 4 } },
        { ...newSource('/b', 'B', ['A']), schedule: { kind: 'daily', time: '02:00' } },
        {
          ...newSource('/c', 'C', ['A', 'B']),
          schedule: { kind: 'weekly', days: ['mon', 'thu'], time: '23:59' }
        }
      )
    })
    expect(errorsOf(cfg)).toEqual([])
  })

  test('rejects destinationIds referencing unknown destination', () => {
    const cfg = cfgWith((c) => {
      c.sources.push({ ...newSource('/a', 'A', []), destinationIds: ['nope'] })
    })
    expect(errorsOf(cfg).join('\n')).toMatch(/destination/i)
  })

  test('errors are "<path>: <message>"', () => {
    const errs = errorsOf({ ...defaultConfig(), version: 2 })
    expect(errs[0]).toMatch(/^version: /)
  })
})
