import { existsSync, readdirSync } from 'node:fs'
import { utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Source } from '@shared/schema'
import type { ChangeEntry } from '@shared/types'
import { readChanges } from '../../src/main/engine/changes'
import { runBackup } from '../../src/main/engine/executor'
import { planRun } from '../../src/main/engine/planner'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

/** One folder source "S" mirrored to one destination; `run` performs a real backup. */
async function world(
  tree: Record<string, string>,
  extra: Partial<Source> = {},
  { withFile = false } = {}
) {
  const base = await tmpDir()
  const spec: Record<string, string> = { 'dest/': '' }
  for (const [k, v] of Object.entries(tree)) spec[`src/${k}`] = v
  if (withFile) spec['loose/note.txt'] = 'n'
  await makeTree(base, spec)
  const cfg = defaultConfig()
  cfg.destinations.push(newDestination(join(base, 'dest'), 'D'))
  // One folder item named "src", as a source converted from a one-folder config would be;
  // `withFile` adds a file item, so the backup is stored by item.
  cfg.sources.push({ ...newSource(join(base, 'src'), 'S', []), legacyFlatName: 'src', ...extra })
  if (withFile) cfg.sources[0].items.push({ path: join(base, 'loose/note.txt'), kind: 'file' })
  let n = 0
  const run = async () => {
    const id = `run-${++n}`
    const log = await runBackup(
      cfg,
      {},
      {
        runId: id,
        trigger: 'manual',
        signal: new AbortController().signal,
        emit: () => {},
        historyDir: join(base, 'history'),
        now: () => new Date(2026, 10, 2, 10, 0, n)
      }
    )
    const changes: ChangeEntry[] = (
      await readChanges(join(base, 'history'), id, {
        sourceId: cfg.sources[0].id,
        destId: cfg.destinations[0].id
      })
    ).items
    return { log, job: log.jobs[0], changes }
  }
  return { base, cfg, run, S: join(base, 'dest/S') }
}

const visible = (dir: string): string[] =>
  readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .sort()
const MARKER_2 = 'mirror layout 2: files directly in this folder\n'
const MARKER_3 = 'mirror layout 3: each file or folder under its own name\n'

/** Gives a backed-up file and its source the same mtime, so the mirror sees them as unchanged. */
async function sameTime(...files: string[]): Promise<void> {
  const t = new Date(2026, 0, 1)
  for (const f of files) await utimes(f, t, t)
}

test('a mirror of one folder stores its contents directly in the backup folder', async () => {
  const w = await world({ 'a.txt': 'a', 'docs/b.txt': 'b' }, { legacyFlatName: null })
  await w.run()
  expect(await readTree(w.S, { hidden: false })).toEqual({ 'a.txt': 'a', 'docs/b.txt': 'b' })
  const { rmSync } = await import('node:fs')
  rmSync(join(w.base, 'src/a.txt'))
  const second = await w.run()
  expect(second.changes.map((c) => [c.action, c.path])).toEqual([['trashed', 'a.txt']])
})

test('one folder backed up by item before moves up into the backup folder, copying nothing', async () => {
  const w = await world({ 'a.txt': 'a', 'src/inner.txt': 'i' }, { legacyFlatName: null })
  await makeTree(w.S, { 'src/a.txt': 'a', 'src/src/inner.txt': 'i', '.trash/T/old.txt': 't' })
  await writeFile(join(w.S, '.backup-manager-layout'), MARKER_3)
  await sameTime(
    join(w.S, 'src/a.txt'),
    join(w.S, 'src/src/inner.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/src/inner.txt')
  )
  const plan = (await planRun(w.cfg, {})).plan.jobs[0]
  expect(plan.counts).toMatchObject({ copy: 0, update: 0, trash: 0, unchanged: 2 })
  const { changes, job } = await w.run()
  expect(job.status).toBe('completed')
  expect(changes).toEqual([])
  expect(await readTree(w.S, { hidden: false })).toEqual({ 'a.txt': 'a', 'src/inner.txt': 'i' })
  expect(existsSync(join(w.S, '.trash/T/old.txt'))).toBe(true)
  expect((await w.run()).changes).toEqual([])
})

test('adding a second item moves the folder contents back under its name', async () => {
  const w = await world({ 'a.txt': 'a' }, { legacyFlatName: null })
  await w.run()
  await makeTree(w.base, { 'loose/note.txt': 'n' })
  w.cfg.sources[0].items.push({ path: join(w.base, 'loose/note.txt'), kind: 'file' })
  const { changes } = await w.run()
  expect(changes.map((c) => [c.action, c.path])).toEqual([['added', 'note.txt']])
  expect(await readTree(w.S, { hidden: false })).toEqual({ 'note.txt': 'n', 'src/a.txt': 'a' })
})

test('a mirror of several items stores each under its name, with the trash and marker hidden beside it', async () => {
  const w = await world(
    { 'a.txt': 'a', 'docs/b.txt': 'b' },
    { legacyFlatName: null },
    { withFile: true }
  )
  await w.run()
  expect(visible(w.S)).toEqual(['note.txt', 'src'])
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a', 'docs/b.txt': 'b' })
  const { rmSync } = await import('node:fs')
  rmSync(join(w.base, 'src/a.txt'))
  const second = await w.run()
  expect(second.changes.map((c) => [c.action, c.path])).toEqual([['trashed', 'src/a.txt']])
  expect(Object.keys(await readTree(join(w.S, '.trash')))).toEqual(['2026-11-02_100002/src/a.txt'])
})

test('snapshots left from an earlier snapshot mode are never trashed by the mirror', async () => {
  const w = await world({ 'a.txt': 'a' }, { legacyFlatName: null })
  await makeTree(w.S, { '2026-10-01_120000/old.txt': 'o', '2026-10-02_120000.zip': 'z' })
  const { changes } = await w.run()
  expect(changes.map((c) => c.action)).toEqual(['added'])
  expect(visible(w.S)).toEqual(['2026-10-01_120000', '2026-10-02_120000.zip', 'a.txt'])
})

test('a zip mirror keeps its manifest at the top and leaves snapshot zips alone', async () => {
  const w = await world(
    { 'A/x.txt': 'x', 'B/y.txt': 'y' },
    { packaging: 'zip-children', legacyFlatName: null },
    { withFile: true }
  )
  await makeTree(w.S, { '2026-10-02_120000.zip': 'z' })
  await w.run()
  expect(visible(w.S)).toEqual(['2026-10-02_120000.zip', 'note.txt.zip', 'src'])
  expect(visible(join(w.S, 'src'))).toEqual(['A.zip', 'B.zip'])
  expect(existsSync(join(w.S, '.backup-manager.json'))).toBe(true)
})

test('layout 1: S/current is renamed to S/<folder>, without copying anything again', async () => {
  const w = await world({ 'a.txt': 'a', 'docs/b.txt': 'b' }, {}, { withFile: true })
  await makeTree(w.S, { 'current/a.txt': 'a', 'current/docs/b.txt': 'b', '.trash/T/old.txt': 't' })
  await sameTime(
    join(w.S, 'current/a.txt'),
    join(w.S, 'current/docs/b.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/docs/b.txt')
  )
  const plan = (await planRun(w.cfg, {})).plan.jobs[0]
  expect(plan.counts).toMatchObject({ copy: 1, update: 0, trash: 0, unchanged: 2 })
  expect(existsSync(join(w.S, 'current/a.txt'))).toBe(true) // planning moves nothing
  const { changes, job } = await w.run()
  expect(job.status).toBe('completed')
  expect(changes.map((c) => c.path)).toEqual(['note.txt'])
  expect(visible(w.S)).toEqual(['note.txt', 'src'])
  expect(existsSync(join(w.S, '.trash/T/old.txt'))).toBe(true)
})

test('layout 2: the folder contents move down into S/<folder>, even an entry with its own name', async () => {
  const w = await world({ 'a.txt': 'a', 'src/inner.txt': 'i' }, {}, { withFile: true })
  await makeTree(w.S, {
    'a.txt': 'a',
    'src/inner.txt': 'i',
    '.trash/T/old.txt': 't',
    '2026-10-01_120000/snap.txt': 's'
  })
  await writeFile(join(w.S, '.backup-manager-layout'), MARKER_2)
  await sameTime(
    join(w.S, 'a.txt'),
    join(w.S, 'src/inner.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/src/inner.txt')
  )
  const { changes, job } = await w.run()
  expect(job.status).toBe('completed')
  expect(changes.map((c) => c.path)).toEqual(['note.txt'])
  expect(visible(w.S)).toEqual(['2026-10-01_120000', 'note.txt', 'src'])
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a', 'src/inner.txt': 'i' })
})

test('layout 2: a move interrupted part-way finishes on the next run', async () => {
  const w = await world({ 'a.txt': 'a', 'b.txt': 'b' }, {}, { withFile: true })
  // a crash left a.txt already in the staging folder and b.txt still at the top
  await makeTree(w.S, { '.backup-manager-nesting/a.txt': 'a', 'b.txt': 'b' })
  await writeFile(join(w.S, '.backup-manager-layout'), MARKER_2)
  await sameTime(
    join(w.S, '.backup-manager-nesting/a.txt'),
    join(w.S, 'b.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/b.txt')
  )
  const { changes } = await w.run()
  expect(changes.map((c) => c.path)).toEqual(['note.txt'])
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a', 'b.txt': 'b' })
  expect(existsSync(join(w.S, '.backup-manager-nesting'))).toBe(false)
})

test('layout 1 of one folder named "current": its contents move up into the backup folder', async () => {
  const w = await world({ 'c.txt': 'c' })
  const { renameSync } = await import('node:fs')
  renameSync(join(w.base, 'src'), join(w.base, 'current'))
  w.cfg.sources[0].items = [{ path: join(w.base, 'current'), kind: 'folder' }]
  w.cfg.sources[0].legacyFlatName = 'current'
  await makeTree(w.S, { 'current/c.txt': 'c' })
  await sameTime(join(w.S, 'current/c.txt'), join(w.base, 'current/c.txt'))
  expect((await w.run()).changes).toEqual([])
  expect((await w.run()).changes).toEqual([])
  expect(await readTree(w.S)).toEqual({ 'c.txt': 'c' })
})

test('a move blocked by an existing item fails the job and finishes on the next run', async () => {
  const w = await world({ 'a.txt': 'a' }, {}, { withFile: true })
  await makeTree(w.S, { 'current/a.txt': 'a', 'src/': '' })
  const first = await w.run()
  expect(first.job.status).toBe('failed')
  expect(existsSync(join(w.S, 'current/a.txt'))).toBe(true)
  const { rmSync } = await import('node:fs')
  rmSync(join(w.S, 'src'), { recursive: true })
  const second = await w.run()
  expect(second.job.status).toBe('completed')
  expect(await readTree(join(w.S, 'src'))).toEqual({ 'a.txt': 'a' })
})

test("an item named like one of the backup's own hidden files is skipped with a warning", async () => {
  const w = await world({ 'a.txt': 'a' }, { legacyFlatName: null })
  await makeTree(w.base, { 'other/.trash': 'mine' })
  w.cfg.sources[0].items.push({ path: join(w.base, 'other/.trash'), kind: 'file' })
  const { job } = await w.run()
  expect(job.warnings.map((x) => [x.path, x.code])).toEqual([['.trash', 'RESERVED']])
  expect(existsSync(join(w.S, '.trash'))).toBe(false)
})

test('a move up interrupted part-way finishes on the next run', async () => {
  const w = await world({ 'a.txt': 'a', 'b.txt': 'b' }, { legacyFlatName: null })
  // a crash left a.txt still in the staging folder and b.txt already at the top
  await makeTree(w.S, { '.backup-manager-unnesting/a.txt': 'a', 'b.txt': 'b' })
  await writeFile(join(w.S, '.backup-manager-layout'), MARKER_3)
  await sameTime(
    join(w.S, '.backup-manager-unnesting/a.txt'),
    join(w.S, 'b.txt'),
    join(w.base, 'src/a.txt'),
    join(w.base, 'src/b.txt')
  )
  const { changes } = await w.run()
  expect(changes).toEqual([])
  expect(await readTree(w.S, { hidden: false })).toEqual({ 'a.txt': 'a', 'b.txt': 'b' })
  expect(existsSync(join(w.S, '.backup-manager-unnesting'))).toBe(false)
})

test('items in subfolders are stored inside them, plain or zipped, and stay unchanged', async () => {
  for (const packaging of ['copy', 'zip-children'] as const) {
    const w = await world(
      { 'a.txt': 'a', 'docs/b.txt': 'b' },
      { legacyFlatName: null, packaging },
      { withFile: true }
    )
    w.cfg.sources[0].items = w.cfg.sources[0].items.map((it) => ({
      ...it,
      folder: it.kind === 'folder' ? 'Projects' : 'Prefs/Logic'
    }))
    expect((await w.run()).job.status).toBe('completed')
    const files = Object.keys(await readTree(w.S, { hidden: false }))
    expect(files).toEqual(
      packaging === 'copy'
        ? ['Prefs/Logic/note.txt', 'Projects/src/a.txt', 'Projects/src/docs/b.txt']
        : ['Prefs/Logic/note.txt.zip', 'Projects/src/a.txt.zip', 'Projects/src/docs.zip']
    )
    const again = await w.run()
    expect(again.changes).toEqual([])
    expect(again.job.counts).toMatchObject({ zipped: 0, copied: 0, trashed: 0 })
  }
})

test('one folder inside a subfolder is stored under its name there', async () => {
  const w = await world({ 'a.txt': 'a' }, { legacyFlatName: null })
  w.cfg.sources[0].items[0].folder = 'Projects'
  await w.run()
  expect(await readTree(w.S, { hidden: false })).toEqual({ 'Projects/src/a.txt': 'a' })
})

test('an alias names the item at the destination, also for a single folder', async () => {
  const w = await world({ 'a.txt': 'a' }, { legacyFlatName: null }, { withFile: true })
  w.cfg.sources[0].items[0] = { ...w.cfg.sources[0].items[0], alias: 'Projects' }
  w.cfg.sources[0].items[1] = { ...w.cfg.sources[0].items[1], folder: 'Prefs', alias: 'n.txt' }
  await w.run()
  expect(await readTree(w.S, { hidden: false })).toEqual({
    'Prefs/n.txt': 'n',
    'Projects/a.txt': 'a'
  })
  w.cfg.sources[0].items.pop()
  await w.run()
  expect(Object.keys(await readTree(w.S, { hidden: false }))).toContain('Projects/a.txt')
})
