import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, validateConfig } from '@shared/schema'
import { assistantConfig, type AssistantState } from '../../src/renderer/src/lib/assistant'

const world = (): ReturnType<typeof defaultConfig> => {
  const c = defaultConfig()
  c.sources.push({ ...newSource('/Users/me/Music', 'Documents', []), id: 's0' })
  c.destinations.push({ ...newDestination('/Volumes/NAS', 'NAS'), id: 'd1' })
  return c
}
const state = (extra: Partial<AssistantState> = {}): AssistantState => ({
  items: [{ path: '/Users/me/Documents', kind: 'folder' }],
  driveIds: ['d1'],
  newDrives: [],
  mode: 'mirror',
  run: 'daily',
  ...extra
})

test('create: named after the first item, the chosen drives, mirror every day at 22:00', () => {
  const { next, sourceId } = assistantConfig(world(), state())
  const s = next.sources.find((x) => x.id === sourceId)!
  expect(s).toMatchObject({
    name: 'Documents',
    slug: 'Documents-2',
    destinationIds: ['d1'],
    mode: 'mirror',
    packaging: 'copy',
    schedule: { kind: 'daily', time: '22:00' },
    setupComplete: true
  })
  expect(validateConfig(next).ok).toBe(true)
})

test('versions every 4 hours; manual only; a new folder becomes a drive for this backup only', () => {
  const own = { ...newDestination('/Volumes/SSD/backups', 'backups'), id: 'd9' }
  const a = assistantConfig(world(), state({ mode: 'snapshot', run: 'interval', newDrives: [own] }))
  const s = a.next.sources.find((x) => x.id === a.sourceId)!
  expect(s.mode).toBe('snapshot')
  expect(s.schedule).toEqual({ kind: 'interval', everyHours: 4 })
  expect(a.next.destinations.find((d) => d.id === 'd9')?.ownerSourceId).toBe(a.sourceId)
  const b = assistantConfig(world(), state({ run: 'manual' }))
  expect(b.next.sources.find((x) => x.id === b.sourceId)!.schedule).toBeNull()
})
