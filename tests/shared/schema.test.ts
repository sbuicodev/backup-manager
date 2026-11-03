import { describe, expect, test } from 'vitest'
import {
  type SourceItem,
  defaultConfig,
  defaultModeFor,
  newDestination,
  newSource,
  slugify,
  validateConfig,
  effectiveZipSettings,
  type Config,
  type Destination,
  type Source
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
      skipScheduledOnBattery: false,
      glass: true,
      theme: 'system'
    })
  })

  test('slugify keeps spaces, strips characters illegal on Windows and dedupes', () => {
    expect(slugify('Logic Projects', [])).toBe('Logic Projects')
    expect(slugify('My: Docs/"2024"?', [])).toBe('My Docs 2024')
    expect(slugify('  Photos. ', [])).toBe('Photos')
    expect(slugify('Docs', ['Docs'])).toBe('Docs-2')
    expect(slugify('docs', ['Docs', 'docs-2'])).toBe('docs-3')
    expect(slugify('CON', [])).toBe('CON-1')
    expect(slugify('...', [])).toBe('source')
  })

  test('newSource uses spec defaults', () => {
    const s = newSource('/p', 'Docs', [])
    expect(s).toMatchObject({
      name: 'Docs',
      items: [{ path: '/p', kind: 'folder' }],
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

describe('slug and path safety', () => {
  test.each([
    '.',
    '..',
    'a/b',
    'a\\b',
    'trailing.',
    'trailing ',
    ' lead',
    'CON',
    'nul',
    'x.bm-partial',
    'a:b'
  ])('rejects slug %j', (slug) => {
    const cfg = cfgWith((c) => c.sources.push({ ...newSource('/a', 'A', []), slug }))
    expect(errorsOf(cfg).join('\n')).toMatch(/slug/)
  })

  test.each([
    'Docs',
    'Docs-2',
    'My-Documents',
    'CON-1',
    'photos.2024',
    'Logic Projects',
    'My Docs (2024)'
  ])('accepts slug %j', (slug) => {
    const cfg = cfgWith((c) => c.sources.push({ ...newSource('/a', 'A', []), slug }))
    expect(errorsOf(cfg)).toEqual([])
  })

  test.each(['relative/dir', './x', '~/Documents', 'C:relative'])(
    'rejects relative path %j',
    (p) => {
      const cfg = cfgWith((c) => {
        c.sources.push(newSource(p, 'A', []))
        c.destinations.push(newDestination(`${p}-dest`, 'D'))
      })
      const errs = errorsOf(cfg).join('\n')
      expect(errs).toMatch(/sources\.0\.items\.0\.path/)
      expect(errs).toMatch(/destinations\.0\.path/)
    }
  )

  test.each(['/Users/me/Docs', 'C:\\Users\\me', 'D:/Backups', '\\\\nas\\share'])(
    'accepts absolute path %j',
    (p) => {
      const cfg = cfgWith((c) => c.sources.push(newSource(p, 'A', [])))
      expect(errorsOf(cfg)).toEqual([])
    }
  )
})

describe('zip part limits', () => {
  const MB = 1024 ** 2
  const GB = 1024 ** 3

  test('a config written before zip limits existed still loads, with defaults', () => {
    const old = defaultConfig() as unknown as {
      destinations: unknown[]
      sources: Record<string, unknown>[]
    }
    old.destinations.push({ id: 'd', name: 'D', path: '/d', enabled: true })
    const s = { ...newSource('/a', 'A', []) } as Record<string, unknown>
    s.zip = { level: 6, looseFiles: 'individual' }
    old.sources.push(s)
    const r = validateConfig(old)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.sources[0].zip).toEqual({
        level: 6,
        looseFiles: 'individual',
        partLimitBytes: null,
        oversized: 'own-part',
        chunkBytes: null
      })
      expect(r.config.destinations[0]).toMatchObject({
        zipPartLimitBytes: null,
        forceChunkOversized: false
      })
    }
  })

  test('newSource and newDestination carry the defaults', () => {
    expect(newSource('/a', 'A', []).zip).toMatchObject({
      partLimitBytes: null,
      oversized: 'own-part',
      chunkBytes: null
    })
    expect(newDestination('/d', 'D')).toMatchObject({
      zipPartLimitBytes: null,
      forceChunkOversized: false
    })
  })

  test.each([0, 1024, MB - 1])('rejects sizes below 1 MiB (%i)', (n) => {
    const a = cfgWith((c) => {
      const s = newSource('/a', 'A', [])
      s.zip.partLimitBytes = n
      c.sources.push(s)
    })
    const b = cfgWith((c) => {
      const s = newSource('/a', 'A', [])
      s.zip.chunkBytes = n
      c.sources.push(s)
    })
    const d = cfgWith((c) =>
      c.destinations.push({ ...newDestination('/d', 'D'), zipPartLimitBytes: n })
    )
    expect(errorsOf(a).length).toBeGreaterThan(0)
    expect(errorsOf(b).length).toBeGreaterThan(0)
    expect(errorsOf(d).length).toBeGreaterThan(0)
  })

  test('effectiveZipSettings combines source and destination', () => {
    const base = newSource('/a', 'A', [])
    const src = (p: Partial<Source['zip']>): Source => ({ ...base, zip: { ...base.zip, ...p } })
    const dst = (p: Partial<Destination>): Destination => ({ ...newDestination('/d', 'D'), ...p })
    expect(effectiveZipSettings(src({}), dst({}))).toEqual({
      limit: null,
      chunk: false,
      chunkSize: null
    })
    expect(
      effectiveZipSettings(src({ partLimitBytes: 2 * GB }), dst({ zipPartLimitBytes: GB }))
    ).toEqual({
      limit: GB,
      chunk: false,
      chunkSize: GB
    })
    expect(
      effectiveZipSettings(
        src({ partLimitBytes: 2 * GB, oversized: 'chunk', chunkBytes: 3 * GB }),
        dst({})
      )
    ).toEqual({ limit: 2 * GB, chunk: true, chunkSize: 2 * GB })
    expect(
      effectiveZipSettings(
        src({ partLimitBytes: 2 * GB, chunkBytes: 100 * MB }),
        dst({ forceChunkOversized: true })
      )
    ).toEqual({ limit: 2 * GB, chunk: true, chunkSize: 100 * MB })
    expect(
      effectiveZipSettings(src({}), dst({ zipPartLimitBytes: GB, forceChunkOversized: true }))
    ).toEqual({
      limit: GB,
      chunk: true,
      chunkSize: GB
    })
  })
})

describe('source-exclusive destinations', () => {
  test('destinations are shared by default; an old config loads with no owner', () => {
    expect(newDestination('/d', 'D').ownerSourceId).toBeNull()
    const old = defaultConfig() as unknown as { destinations: unknown[] }
    old.destinations.push({ id: 'd1', name: 'D', path: '/d', enabled: true })
    const r = validateConfig(old)
    expect(r.ok && r.config.destinations[0].ownerSourceId).toBeNull()
  })

  test('the owner must be an existing source', () => {
    const cfg = cfgWith((c) =>
      c.destinations.push({ ...newDestination('/d', 'D'), ownerSourceId: 'gone' })
    )
    expect(errorsOf(cfg).join('\n')).toMatch(/owner/i)
  })

  test("a source cannot select another source's exclusive destination", () => {
    const cfg = cfgWith((c) => {
      const a = newSource('/a', 'A', [])
      const b = newSource('/b', 'B', ['A'])
      const own = { ...newDestination('/d', 'D'), ownerSourceId: a.id }
      c.sources.push(a, { ...b, destinationIds: [own.id] })
      c.destinations.push(own)
    })
    expect(errorsOf(cfg).join('\n')).toMatch(/only for "A"/)
  })
})

describe('source items', () => {
  const withItems = (items: Source['items']): Source => ({ ...newSource('', 'Mixed', []), items })
  const oldSource = (fields: Record<string, unknown>): unknown => {
    const { items: _i, legacyFlatName: _l, ...rest } = newSource('/x', 'Old', [])
    return { ...defaultConfig(), sources: [{ ...rest, ...fields }] }
  }
  const loaded = (cfg: unknown): Source => {
    const r = validateConfig(cfg)
    if (!r.ok) throw new Error(r.errors.join('\n'))
    return r.config.sources[0]
  }

  test('an old one-folder source becomes one folder item and remembers its flat layout', () => {
    expect(loaded(oldSource({ kind: 'folder', path: '/Users/me/Documents' }))).toMatchObject({
      items: [{ path: '/Users/me/Documents', kind: 'folder' }],
      legacyFlatName: 'Documents'
    })
    // configs from before "kind" existed were folders too
    expect(loaded(oldSource({ path: '/Users/me/Music' })).items).toEqual([
      { path: '/Users/me/Music', kind: 'folder' }
    ])
  })

  test('an old Files source becomes file items with nothing to move', () => {
    expect(
      loaded(oldSource({ kind: 'files', path: '', files: ['/a/tax.pdf', '/b/vault.kdbx'] }))
    ).toMatchObject({
      items: [
        { path: '/a/tax.pdf', kind: 'file' },
        { path: '/b/vault.kdbx', kind: 'file' }
      ],
      legacyFlatName: null
    })
  })

  test('files and folders mix; at least one item is needed', () => {
    const mixed = withItems([
      { path: '/Users/me/Documents', kind: 'folder' },
      { path: '/Users/me/Desktop/tax.pdf', kind: 'file' }
    ])
    expect(errorsOf(cfgWith((c) => c.sources.push(mixed)))).toEqual([])
    expect(errorsOf(cfgWith((c) => c.sources.push(withItems([]))))).not.toEqual([])
  })

  test('two items with the same name (ignoring case) are rejected', () => {
    const cfg = cfgWith((c) =>
      c.sources.push(
        withItems([
          { path: '/a/config', kind: 'file' },
          { path: '/b/CONFIG', kind: 'folder' }
        ])
      )
    )
    expect(errorsOf(cfg).join('\n')).toMatch(/same name.*config/i)
  })

  test('an item inside another listed folder is rejected', () => {
    const cfg = cfgWith((c) =>
      c.sources.push(
        withItems([
          { path: '/Users/me/Documents', kind: 'folder' },
          { path: '/Users/me/Documents/tax.pdf', kind: 'file' }
        ])
      )
    )
    expect(errorsOf(cfg).join('\n')).toMatch(/already inside/)
  })

  test('an item inside a destination, or a destination inside a folder item, is rejected', () => {
    const inside = cfgWith((c) => {
      c.destinations.push(newDestination('/backup', 'B'))
      c.sources.push(withItems([{ path: '/backup/x.txt', kind: 'file' }]))
    })
    expect(errorsOf(inside).join('\n')).toMatch(/inside destination/)
    const around = cfgWith((c) => {
      c.destinations.push(newDestination('/data/backup', 'B'))
      c.sources.push(withItems([{ path: '/data', kind: 'folder' }]))
    })
    expect(errorsOf(around).join('\n')).toMatch(/destination "B" is inside/)
  })
})

test('glass is on by default; old settings, and the earlier level names, still load', () => {
  expect(defaultConfig().settings.glass).toBe(true)
  const withGlass = (glass: unknown): unknown => ({
    ...defaultConfig(),
    settings: { ...defaultConfig().settings, glass }
  })
  const old = defaultConfig() as unknown as { settings: Record<string, unknown> }
  delete old.settings.glass
  const glassOf = (c: unknown): unknown => {
    const r = validateConfig(c)
    return r.ok ? r.config.settings.glass : r.errors
  }
  expect(glassOf(old)).toBe(true)
  expect(glassOf(withGlass('liquid'))).toBe(true)
  expect(glassOf(withGlass('off'))).toBe(false)
})

describe('not set up', () => {
  test('old configs load as set up', () => {
    expect(newSource('/a', 'A', []).setupComplete).toBe(true)
    const old = cfgWith((c) => c.sources.push(newSource('/a', 'A', []))) as unknown as {
      sources: Record<string, unknown>[]
    }
    delete old.sources[0].setupComplete
    const r = validateConfig(old)
    expect(r.ok && r.config.sources[0].setupComplete).toBe(true)
  })
  test('a backup that is not set up may have no items; a set-up one may not', () => {
    const draft = { ...newSource('', 'Draft', []), setupComplete: false }
    expect(errorsOf(cfgWith((c) => c.sources.push(draft)))).toEqual([])
    expect(errorsOf(cfgWith((c) => c.sources.push({ ...draft, setupComplete: true })))).not.toEqual(
      []
    )
  })
})

describe('item subfolders', () => {
  const withItems = (items: SourceItem[]) => {
    const c = defaultConfig()
    c.destinations.push({ ...newDestination('/d', 'D'), id: 'd1' })
    c.sources.push({ ...newSource('/a', 'A', []), items })
    return validateConfig(c)
  }
  const errors = (r: ReturnType<typeof validateConfig>): string =>
    r.ok ? '' : r.errors.join(' | ')
  test('a nested subfolder is fine', () => {
    expect(withItems([{ path: '/x/Logic', kind: 'folder', folder: 'Music/Projects' }]).ok).toBe(
      true
    )
  })
  test.each(['.hidden', '../up', 'a/../b', 'a//b', '/abs', 'a\\b'])('"%s" is refused', (folder) => {
    expect(errors(withItems([{ path: '/x/a.txt', kind: 'file', folder }]))).toMatch(/subfolder/)
  })
  test('an item can’t sit where another item’s contents go', () => {
    expect(
      errors(
        withItems([
          { path: '/x/Prefs', kind: 'folder' },
          { path: '/y/a.txt', kind: 'file', folder: 'Prefs' }
        ])
      )
    ).toMatch(/inside/)
  })
  test('the same name is fine in different subfolders', () => {
    expect(
      withItems([
        { path: '/x/a.txt', kind: 'file', folder: 'One' },
        { path: '/y/a.txt', kind: 'file', folder: 'Two' }
      ]).ok
    ).toBe(true)
  })
})

describe('item aliases', () => {
  const withItems = (items: SourceItem[]) => {
    const c = defaultConfig()
    c.destinations.push({ ...newDestination('/d', 'D'), id: 'd1' })
    c.sources.push({ ...newSource('/a', 'A', []), items })
    return validateConfig(c)
  }
  test('an alias may contain spaces', () => {
    expect(withItems([{ path: '/x/Logic', kind: 'folder', alias: 'My Projects' }]).ok).toBe(true)
  })
  test.each(['', '.x', 'a/b', '..'])('"%s" is refused', (alias) => {
    const r = withItems([{ path: '/x/Logic', kind: 'folder', alias }])
    expect(r.ok ? '' : r.errors.join()).toMatch(/name/)
  })
  test('two items can’t share a name through an alias', () => {
    expect(
      withItems([
        { path: '/x/Logic', kind: 'folder', alias: 'a.txt' },
        { path: '/y/a.txt', kind: 'file' }
      ]).ok
    ).toBe(false)
  })
})

test('the theme follows the system by default; older settings without it still load', () => {
  expect(defaultConfig().settings.theme).toBe('system')
  const c = defaultConfig() as unknown as { settings: Record<string, unknown> }
  delete c.settings.theme
  const r = validateConfig(c)
  expect(r.ok && r.config.settings.theme).toBe('system')
  const dark = defaultConfig()
  dark.settings.theme = 'dark'
  expect(validateConfig(dark).ok).toBe(true)
})
