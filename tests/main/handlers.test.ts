import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CH } from '@shared/ipc'
import { defaultConfig, newDestination, newSource } from '@shared/schema'
import type { ChangePage, ProgressEvent, SchedulerStatus } from '@shared/types'
import { writeRunLog } from '../../src/main/engine/history'
import { writeSnapshotIndex } from '../../src/main/engine/snapshot-index'
import { createHandlers } from '../../src/main/handlers'
import { createServices } from '../../src/main/services'
import { makeTree, tmpDir } from '../helpers/fs'

async function setup(): Promise<{
  base: string
  handlers: ReturnType<typeof createHandlers>
  revealed: string[]
  broadcasts: [string, unknown][]
  files: { save: string | null; open: string | null }
  stop: () => Promise<void>
}> {
  const base = await tmpDir()
  await makeTree(base, { 'src/a.txt': 'a', 'dest/': '', 'user/': '' })
  const broadcasts: [string, unknown][] = []
  const services = await createServices({
    userDataDir: join(base, 'user'),
    platform: { now: () => new Date(), setInterval: () => () => {}, isOnBattery: () => false },
    broadcast: (ch, p) => broadcasts.push([ch, p]),
    onRunFinished: () => {}
  })
  await services.start()
  const files = { save: null as string | null, open: null as string | null }
  const revealed: string[] = []
  const handlers = createHandlers(services, {
    // Echo where the picker was asked to start, so tests can see it was passed through.
    pickFolder: async (startAt?: string) => startAt ?? '/picked',
    reveal: async (path: string) => void revealed.push(path),
    pickItems: async (mode: string, startAt?: string) => [
      { path: startAt ?? '/picked/a.txt', kind: mode === 'folders' ? 'folder' : 'file' } as const
    ],
    saveFile: async () => files.save,
    openFile: async () => files.open
  })
  return {
    base,
    handlers,
    revealed,
    broadcasts,
    files,
    // Let pending state writes finish before the temp dir is removed.
    stop: async () => {
      await services.scheduler.whenIdle()
      services.stop()
    }
  }
}

function validConfig(base: string): ReturnType<typeof defaultConfig> {
  const c = defaultConfig()
  c.destinations.push(newDestination(join(base, 'dest'), 'D'))
  c.sources.push(newSource(join(base, 'src'), 'S', []))
  return c
}

test('config:get returns defaults and the config path on first launch', async () => {
  const { handlers, base, stop } = await setup()
  expect(await handlers[CH.configGet]()).toEqual({
    ok: true,
    config: defaultConfig(),
    path: join(base, 'user', 'config.json')
  })
  await stop()
})

test('config:save with an invalid config returns errors and leaves the file unchanged', async () => {
  const { handlers, base, stop } = await setup()
  const file = join(base, 'user', 'config.json')
  const before = await readFile(file, 'utf8')
  const bad = { ...defaultConfig(), version: 5 }
  expect(await handlers[CH.configSave](bad)).toMatchObject({ ok: false })
  expect(await readFile(file, 'utf8')).toBe(before)
  await stop()
})

test('config:save persists, config:get reflects it, and the change is broadcast', async () => {
  const { handlers, base, broadcasts, stop } = await setup()
  const cfg = validConfig(base)
  expect(await handlers[CH.configSave](cfg)).toEqual({ ok: true })
  expect(await handlers[CH.configGet]()).toMatchObject({ ok: true, config: cfg })
  expect(broadcasts.filter(([ch]) => ch === CH.configChanged).at(-1)?.[1]).toMatchObject({
    ok: true,
    config: cfg
  })
  await stop()
})

test('invalid argument types throw "invalid arguments"', async () => {
  const { handlers, stop } = await setup()
  await expect(handlers[CH.runPlan]([123])).rejects.toThrow('invalid arguments')
  await expect(handlers[CH.historyGet](42)).rejects.toThrow('invalid arguments')
  await expect(handlers[CH.schedulerPause]('tomorrow')).rejects.toThrow('invalid arguments')
  await stop()
})

test('run:plan returns a plan for the configured sources', async () => {
  const { handlers, base, stop } = await setup()
  await handlers[CH.configSave](validConfig(base))
  const plan = (await handlers[CH.runPlan]()) as { jobs: { counts: { copy: number } }[] }
  expect(plan.jobs).toHaveLength(1)
  expect(plan.jobs[0].counts.copy).toBe(1)
  await stop()
})

test('run:start enqueues a run, broadcasts progress, and history records it', async () => {
  const { handlers, base, broadcasts, stop } = await setup()
  await handlers[CH.configSave](validConfig(base))
  const id = await handlers[CH.runStart]()
  expect(typeof id).toBe('string')
  for (let i = 0; i < 100; i++) {
    if (broadcasts.some(([ch, e]) => ch === CH.progress && (e as ProgressEvent).type === 'run-end'))
      break
    await new Promise((r) => setTimeout(r, 20))
  }
  const types = broadcasts
    .filter(([ch]) => ch === CH.progress)
    .map(([, e]) => (e as ProgressEvent).type)
  expect(types).toContain('run-start')
  expect(types).toContain('run-end')
  expect(broadcasts.some(([ch]) => ch === CH.status)).toBe(true)
  const list = (await handlers[CH.historyList]()) as { id: string }[]
  expect(list.map((r) => r.id)).toEqual([id])
  expect(await handlers[CH.historyGet](id)).toMatchObject({ id, status: 'completed' })
  await stop()
})

test('config:import of a valid file replaces config; invalid keeps current', async () => {
  const { handlers, base, files, stop } = await setup()
  const good = join(base, 'good.json')
  const bad = join(base, 'bad.json')
  await writeFile(good, JSON.stringify(validConfig(base)))
  await writeFile(bad, '{"nope":true}')
  files.open = bad
  expect(await handlers[CH.configImport]()).toMatchObject({ ok: false })
  expect(await handlers[CH.configGet]()).toMatchObject({ config: defaultConfig() })
  files.open = good
  expect(await handlers[CH.configImport]()).toEqual({ ok: true })
  expect(
    ((await handlers[CH.configGet]()) as { config: { sources: unknown[] } }).config.sources
  ).toHaveLength(1)
  files.open = null
  expect(await handlers[CH.configImport]()).toBeNull()
  await stop()
})

test('config:export writes the current config to the chosen file', async () => {
  const { handlers, base, files, stop } = await setup()
  files.save = join(base, 'out.json')
  expect(await handlers[CH.configExport]()).toBe(true)
  expect(JSON.parse(await readFile(files.save, 'utf8'))).toEqual(defaultConfig())
  files.save = null
  expect(await handlers[CH.configExport]()).toBe(false)
  await stop()
})

test('scheduler:pause forever shows in status; resume clears it', async () => {
  const { handlers, stop } = await setup()
  await handlers[CH.schedulerPause]('forever')
  expect(((await handlers[CH.schedulerStatus]()) as SchedulerStatus).pausedUntil).toBe('forever')
  await handlers[CH.schedulerResume]()
  expect(((await handlers[CH.schedulerStatus]()) as SchedulerStatus).pausedUntil).toBeNull()
  await stop()
})

test('destinations:availability and dialog:pickFolder', async () => {
  const { handlers, base, stop } = await setup()
  const cfg = validConfig(base)
  cfg.destinations.push(newDestination(join(base, 'unplugged'), 'U'))
  await handlers[CH.configSave](cfg)
  expect(await handlers[CH.availability]()).toEqual({
    [cfg.destinations[0].id]: true,
    [cfg.destinations[1].id]: false
  })
  expect(await handlers[CH.pickFolder]()).toBe('/picked')
  await stop()
})

test('the pickers start at the path already set, and reject anything that is not a path', async () => {
  const { handlers, stop } = await setup()
  expect(await handlers[CH.pickFolder]('/Users/me/Music')).toBe('/Users/me/Music')
  expect(await handlers[CH.pickItems]('any', '/Users/me/tax.pdf')).toEqual([
    { path: '/Users/me/tax.pdf', kind: 'file' }
  ])
  await expect(handlers[CH.pickItems]('everything')).rejects.toThrow('invalid arguments')
  await expect(handlers[CH.pickFolder](42)).rejects.toThrow('invalid arguments')
  await expect(handlers[CH.pickItems]('files', {})).rejects.toThrow('invalid arguments')
  await stop()
})

test('invalid config file on disk → config:get reports errors; reset restores defaults', async () => {
  const base = await tmpDir()
  await makeTree(base, { 'user/config.json': '{broken' })
  const services = await createServices({
    userDataDir: join(base, 'user'),
    platform: { now: () => new Date(), setInterval: () => () => {}, isOnBattery: () => false },
    broadcast: () => {},
    onRunFinished: () => {}
  })
  await services.start()
  const handlers = createHandlers(services, {
    pickFolder: async () => null,
    reveal: async () => {},
    pickItems: async () => [],
    saveFile: async () => null,
    openFile: async () => null
  })
  expect(await handlers[CH.configGet]()).toMatchObject({ ok: false })
  await handlers[CH.configReset]()
  expect(await handlers[CH.configGet]()).toMatchObject({ ok: true, config: defaultConfig() })
  services.stop()
})

async function waitForRunEnd(broadcasts: [string, unknown][], count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const ends = broadcasts.filter(
      ([ch, e]) => ch === CH.progress && (e as ProgressEvent).type === 'run-end'
    )
    if (ends.length >= count) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('run did not finish')
}

test("history:changes returns the run's file changes, filtered and paged", async () => {
  const { handlers, base, broadcasts, stop } = await setup()
  const cfg = validConfig(base)
  await handlers[CH.configSave](cfg)
  const id = (await handlers[CH.runStart]()) as string
  await waitForRunEnd(broadcasts, 1)
  const page = (await handlers[CH.historyChanges](id, {
    sourceId: cfg.sources[0].id,
    destId: cfg.destinations[0].id
  })) as ChangePage
  expect(page.total).toBe(1)
  expect(page.items[0]).toMatchObject({ action: 'added', path: 'src/a.txt', size: 1 })
  const none = (await handlers[CH.historyChanges](id, {
    sourceId: cfg.sources[0].id,
    destId: cfg.destinations[0].id,
    actions: ['deleted']
  })) as ChangePage
  expect(none.total).toBe(0)
  await stop()
})

test('history:changes for a run without a change file (older run) returns an empty page', async () => {
  const { handlers, base, stop } = await setup()
  await writeRunLog(join(base, 'user', 'history'), {
    id: '2026-01-01_000000',
    trigger: 'manual',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    status: 'completed',
    jobs: [
      {
        sourceId: 's',
        destId: 'd',
        status: 'completed',
        counts: { copied: 1, updated: 0, zipped: 0, trashed: 0, deleted: 0, pruned: 0, skipped: 0 },
        bytesWritten: 1,
        warnings: []
      }
    ]
  })
  expect(await handlers[CH.historyGet]('2026-01-01_000000')).toMatchObject({ status: 'completed' })
  expect(
    await handlers[CH.historyChanges]('2026-01-01_000000', { sourceId: 's', destId: 'd' })
  ).toEqual({
    total: 0,
    counts: { added: 0, updated: 0, removed: 0, trashed: 0, deleted: 0, skipped: 0 },
    items: []
  })
  await stop()
})

test('history:changes rejects invalid queries', async () => {
  const { handlers, stop } = await setup()
  const q = { sourceId: 's', destId: 'd' }
  await expect(handlers[CH.historyChanges]('x', { ...q, limit: 5000 })).rejects.toThrow(
    'invalid arguments'
  )
  await expect(handlers[CH.historyChanges]('x', { ...q, actions: ['bogus'] })).rejects.toThrow(
    'invalid arguments'
  )
  await expect(handlers[CH.historyChanges]('x', { ...q, offset: -1 })).rejects.toThrow(
    'invalid arguments'
  )
  await expect(handlers[CH.historyChanges](42, q)).rejects.toThrow('invalid arguments')
  await stop()
})

test('start prunes snapshot indexes of pairs no longer in the config', async () => {
  const base = await tmpDir()
  await writeSnapshotIndex(join(base, 'user', 'snapshot-index'), 'gone', 'x', [])
  const services = await createServices({
    userDataDir: join(base, 'user'),
    platform: { now: () => new Date(), setInterval: () => () => {}, isOnBattery: () => false },
    broadcast: () => {},
    onRunFinished: () => {}
  })
  expect(services.paths.snapshotIndex).toBe(join(base, 'user', 'snapshot-index'))
  await services.start()
  expect(await readdir(services.paths.snapshotIndex)).toEqual([])
  services.stop()
})

test('snapshot runs through services record a diff against the previous snapshot', async () => {
  const { handlers, base, broadcasts, stop } = await setup()
  const cfg = validConfig(base)
  cfg.sources[0] = { ...cfg.sources[0], mode: 'snapshot' }
  await handlers[CH.configSave](cfg)
  await handlers[CH.runStart]()
  await waitForRunEnd(broadcasts, 1)
  await writeFile(join(base, 'src', 'b.txt'), 'b')
  const id2 = (await handlers[CH.runStart]()) as string
  await waitForRunEnd(broadcasts, 2)
  const page = (await handlers[CH.historyChanges](id2, {
    sourceId: cfg.sources[0].id,
    destId: cfg.destinations[0].id
  })) as ChangePage
  expect(page.items.map((i) => [i.action, i.path])).toEqual([['added', 'src/b.txt']])
  await stop()
})

test('an invalid config at startup keeps every snapshot index', async () => {
  const base = await tmpDir()
  await makeTree(base, { 'user/config.json': '{broken' })
  await writeSnapshotIndex(join(base, 'user', 'snapshot-index'), 's', 'd', [])
  const services = await createServices({
    userDataDir: join(base, 'user'),
    platform: { now: () => new Date(), setInterval: () => () => {}, isOnBattery: () => false },
    broadcast: () => {},
    onRunFinished: () => {}
  })
  await services.start()
  expect(await readdir(services.paths.snapshotIndex)).toHaveLength(1)
  services.stop()
})

test("start keeps the snapshot index of a source's exclusive destination", async () => {
  const base = await tmpDir()
  const cfg = defaultConfig()
  const s = { ...newSource(join(base, 'src'), 'S', []), destinationIds: [] as string[] }
  const d = { ...newDestination(join(base, 'own'), 'Own'), ownerSourceId: s.id }
  cfg.sources.push(s)
  cfg.destinations.push(d)
  await makeTree(base, { 'user/config.json': JSON.stringify(cfg) })
  await writeSnapshotIndex(join(base, 'user', 'snapshot-index'), s.id, d.id, [])
  const services = await createServices({
    userDataDir: join(base, 'user'),
    platform: { now: () => new Date(), setInterval: () => () => {}, isOnBattery: () => false },
    broadcast: () => {},
    onRunFinished: () => {}
  })
  await services.start()
  expect(await readdir(services.paths.snapshotIndex)).toHaveLength(1)
  services.stop()
})

test('destinations:info reports availability and free space', async () => {
  const { handlers, base, stop } = await setup()
  const cfg = validConfig(base)
  cfg.destinations.push(newDestination(join(base, 'unplugged'), 'U'))
  await handlers[CH.configSave](cfg)
  const here = (await handlers[CH.destinationInfo](cfg.destinations[0].id)) as {
    available: boolean
    freeBytes: number | null
  }
  expect(here.available).toBe(true)
  expect(here.freeBytes).toBeGreaterThan(0)
  expect(await handlers[CH.destinationInfo](cfg.destinations[1].id)).toEqual({
    available: false,
    freeBytes: null
  })
  await expect(handlers[CH.destinationInfo](7)).rejects.toThrow('invalid arguments')
  await stop()
})

test('shell:showInFolder only reveals folders inside a configured destination', async () => {
  const { handlers, base, revealed, stop } = await setup()
  await handlers[CH.configSave](validConfig(base))
  expect(await handlers[CH.showInFolder](join(base, 'dest', 'S', 'src'))).toBe(true)
  expect(await handlers[CH.showInFolder](join(base, 'dest'))).toBe(true)
  expect(await handlers[CH.showInFolder](join(base, 'dest', '..', 'src'))).toBe(false)
  expect(await handlers[CH.showInFolder](join(base, 'dest-other'))).toBe(false)
  expect(await handlers[CH.showInFolder]('relative/dest')).toBe(false)
  expect(revealed).toEqual([join(base, 'dest', 'S', 'src'), join(base, 'dest')])
  await stop()
})

test('dialog:statItems tells files from folders and rejects relative paths', async () => {
  const { handlers, base, stop } = await setup()
  expect(await handlers[CH.statItems]([join(base, 'src'), join(base, 'src', 'a.txt')])).toEqual([
    { path: join(base, 'src'), kind: 'folder' },
    { path: join(base, 'src', 'a.txt'), kind: 'file' }
  ])
  await expect(handlers[CH.statItems](['src/a.txt'])).rejects.toThrow('invalid arguments')
  await stop()
})

test('history:latest returns the newest result per backup and drive', async () => {
  const { handlers, base, broadcasts, stop } = await setup()
  const cfg = validConfig(base)
  await handlers[CH.configSave](cfg)
  await handlers[CH.runStart]()
  await waitForRunEnd(broadcasts, 1)
  expect(await handlers[CH.historyLatest]()).toEqual([
    expect.objectContaining({
      sourceId: cfg.sources[0].id,
      destId: cfg.destinations[0].id,
      status: 'completed'
    })
  ])
  await stop()
})
