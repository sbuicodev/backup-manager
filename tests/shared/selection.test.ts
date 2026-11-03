import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource } from '@shared/schema'
import type { Plan } from '@shared/types'
import {
  backupsOn,
  leaveTo,
  duplicateSource,
  planPreview,
  resolveSelection,
  sendBackupTo
} from '../../src/renderer/src/lib/selection'

const cfg = (): ReturnType<typeof defaultConfig> => {
  const c = defaultConfig()
  c.sources.push(
    { ...newSource('/a', 'Docs', []), id: 's1' },
    { ...newSource('/b', 'Photos', ['Docs']), id: 's2' }
  )
  c.destinations.push({ ...newDestination('/d', 'NAS'), id: 'd1' })
  return c
}

test('resolveSelection keeps a valid selection and falls back to the first backup', () => {
  const c = cfg()
  expect(resolveSelection({ kind: 'backup', id: 's2' }, c)).toEqual({ kind: 'backup', id: 's2' })
  expect(resolveSelection({ kind: 'backup', id: 'gone' }, c)).toEqual({ kind: 'backup', id: 's1' })
  expect(resolveSelection({ kind: 'drive', id: 'gone' }, c)).toEqual({ kind: 'backup', id: 's1' })
  expect(resolveSelection(null, c)).toEqual({ kind: 'backup', id: 's1' })
  expect(resolveSelection({ kind: 'activity' }, c)).toEqual({ kind: 'activity' })
  expect(resolveSelection(null, defaultConfig())).toEqual({ kind: 'empty' })
  // a drive that belongs to one backup is not a sidebar page: its backup is shown instead
  c.destinations.push({ ...newDestination('/own', 'Own'), id: 'd2', ownerSourceId: 's2' })
  expect(resolveSelection({ kind: 'drive', id: 'd2' }, c)).toEqual({ kind: 'backup', id: 's2' })
})

test('duplicateSource copies everything under a new id, name and folder name', () => {
  const c = cfg()
  const copy = duplicateSource(
    c.sources[0],
    c.sources.map((s) => s.slug)
  )
  expect(copy.id).not.toBe('s1')
  expect(copy.name).toBe('Docs copy')
  expect(copy.slug).toBe('Docs copy')
  expect(copy.items).toEqual(c.sources[0].items)
  expect(copy.items).not.toBe(c.sources[0].items)
})

test('planPreview summarises what Back up now would do', () => {
  const job = (extra: Partial<Plan['jobs'][number]>): Plan['jobs'][number] => ({
    sourceId: 's1',
    destId: 'd1',
    kind: 'mirror-copy',
    status: 'ready',
    counts: { copy: 2, update: 1, zip: 0, trash: 0, delete: 0, unchanged: 5 },
    bytes: 160_000,
    skippedEntries: [],
    ...extra
  })
  expect(planPreview({ createdAt: '', jobs: [job({})] })).toBe('Will copy 3 files (156.3 KB)')
  expect(
    planPreview({
      createdAt: '',
      jobs: [
        job({ counts: { copy: 0, update: 0, zip: 2, trash: 0, delete: 0, unchanged: 0 } }),
        job({ status: 'skipped', reason: 'destination-missing' })
      ]
    })
  ).toBe('Will write 2 archives (156.3 KB) · 1 drive not connected')
  expect(
    planPreview({
      createdAt: '',
      jobs: [
        job({ counts: { copy: 0, update: 0, zip: 0, trash: 0, delete: 0, unchanged: 5 }, bytes: 0 })
      ]
    })
  ).toBe('Everything is up to date')
  expect(planPreview({ createdAt: '', jobs: [] })).toBe('Nothing to back up')
})

test('backupsOn lists the backups that go to a drive; sendBackupTo adds one', () => {
  const c = cfg()
  c.destinations.push({ ...newDestination('/e', 'USB'), id: 'd2' })
  c.sources[0] = { ...c.sources[0], destinationIds: ['d1'] }
  // s2 keeps 'all' → goes to both
  expect(backupsOn(c, 'd1').map((s) => s.id)).toEqual(['s1', 's2'])
  expect(backupsOn(c, 'd2').map((s) => s.id)).toEqual(['s2'])
  const next = sendBackupTo(c, 's1', 'd2')
  expect(next.sources[0].destinationIds).toEqual(['d1', 'd2'])
  expect(backupsOn(next, 'd2').map((s) => s.id)).toEqual(['s1', 's2'])
})

test('leaveTo asks first when there are unsaved edits, whoever asked to leave', () => {
  expect(leaveTo(true, { kind: 'activity' })).toEqual({ ask: { kind: 'activity' } })
  expect(leaveTo(false, { kind: 'backup', id: 's2' })).toEqual({ go: { kind: 'backup', id: 's2' } })
})
