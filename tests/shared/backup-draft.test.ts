import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Config } from '@shared/schema'
import {
  buildNextConfig,
  draftFrom,
  errorsByGroup,
  isDirty
} from '../../src/renderer/src/lib/backup-draft'

function world(): Config {
  const c = defaultConfig()
  const s = { ...newSource('/Users/me/Docs', 'Docs', []), id: 's1', excludes: ['*.tmp'] }
  c.sources.push(s)
  c.destinations.push(
    { ...newDestination('/Volumes/NAS', 'NAS'), id: 'd1' },
    { ...newDestination('/Volumes/SSD', 'SSD'), id: 'd2', ownerSourceId: 's1' }
  )
  return c
}

test('a draft starts equal to the saved backup', () => {
  const c = world()
  const d = draftFrom(c, c.sources[0])
  expect(d.excludes).toBe('*.tmp')
  expect(d.own.map((x) => x.id)).toEqual(['d2'])
  expect(isDirty(c, d)).toBe(false)
  expect(isDirty(c, { ...d, source: { ...d.source, name: 'Documents' } })).toBe(true)
  expect(isDirty(c, { ...d, excludes: '*.tmp\nnode_modules/' })).toBe(true)
})

test('saving trims the name, parses exclusions and replaces the backup’s own drives', () => {
  const c = world()
  const d = draftFrom(c, c.sources[0])
  const ssd = { ...d.own[0], name: 'Fast SSD' }
  const r = buildNextConfig(c, {
    ...d,
    source: { ...d.source, name: '  Docs 2 ' },
    excludes: '*.tmp\n\n  node_modules/  ',
    own: [ssd]
  })
  if (!('next' in r)) throw new Error(r.error)
  expect(r.next.sources[0]).toMatchObject({ name: 'Docs 2', excludes: ['*.tmp', 'node_modules/'] })
  expect(r.next.destinations.map((x) => x.name)).toEqual(['NAS', 'Fast SSD'])
})

test('saving finishes setup, but not without a drive', () => {
  const c = world()
  c.sources[0] = { ...c.sources[0], setupComplete: false, destinationIds: [] }
  const d = draftFrom(c, c.sources[0])
  const r = buildNextConfig(c, d)
  expect('next' in r && r.next.sources[0].setupComplete).toBe(true)
  expect(buildNextConfig(c, { ...d, own: [] })).toEqual({ error: 'Add at least one drive' })
})

test('errorsByGroup puts each validation error beside its section', () => {
  expect(
    errorsByGroup([
      'sources.0.slug: duplicate slug "Docs"',
      'sources.0.items: add at least one file or folder',
      'sources.0.zip.partLimitBytes: Too small',
      'sources.0.snapshot.keepMin: Too small',
      'sources.0.destinationIds: unknown destination "x"',
      'Add at least one drive',
      'destinations.1.path: must be an absolute path'
    ])
  ).toEqual({
    general: 'duplicate slug "Docs" · destinations.1.path: must be an absolute path',
    items: 'add at least one file or folder',
    zip: 'Too small',
    versions: 'Too small',
    where: 'unknown destination "x" · Add at least one drive'
  })
})
