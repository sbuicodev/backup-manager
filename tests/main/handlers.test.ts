import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CH } from '@shared/ipc'
import { defaultConfig, newDestination, newSource } from '@shared/schema'
import type { ProgressEvent, SchedulerStatus } from '@shared/types'
import { createHandlers } from '../../src/main/handlers'
import { createServices } from '../../src/main/services'
import { makeTree, tmpDir } from '../helpers/fs'

async function setup(): Promise<{
  base: string
  handlers: ReturnType<typeof createHandlers>
  broadcasts: [string, unknown][]
  files: { save: string | null; open: string | null }
  stop: () => void
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
  const handlers = createHandlers(services, {
    pickFolder: async () => '/picked',
    saveFile: async () => files.save,
    openFile: async () => files.open
  })
  return { base, handlers, broadcasts, files, stop: () => services.stop() }
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
  stop()
})

test('config:save with an invalid config returns errors and leaves the file unchanged', async () => {
  const { handlers, base, stop } = await setup()
  const file = join(base, 'user', 'config.json')
  const before = await readFile(file, 'utf8')
  const bad = { ...defaultConfig(), version: 5 }
  expect(await handlers[CH.configSave](bad)).toMatchObject({ ok: false })
  expect(await readFile(file, 'utf8')).toBe(before)
  stop()
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
  stop()
})

test('invalid argument types throw "invalid arguments"', async () => {
  const { handlers, stop } = await setup()
  await expect(handlers[CH.runPlan]([123])).rejects.toThrow('invalid arguments')
  await expect(handlers[CH.historyGet](42)).rejects.toThrow('invalid arguments')
  await expect(handlers[CH.schedulerPause]('tomorrow')).rejects.toThrow('invalid arguments')
  stop()
})

test('run:plan returns a plan for the configured sources', async () => {
  const { handlers, base, stop } = await setup()
  await handlers[CH.configSave](validConfig(base))
  const plan = (await handlers[CH.runPlan]()) as { jobs: { counts: { copy: number } }[] }
  expect(plan.jobs).toHaveLength(1)
  expect(plan.jobs[0].counts.copy).toBe(1)
  stop()
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
  stop()
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
  stop()
})

test('config:export writes the current config to the chosen file', async () => {
  const { handlers, base, files, stop } = await setup()
  files.save = join(base, 'out.json')
  expect(await handlers[CH.configExport]()).toBe(true)
  expect(JSON.parse(await readFile(files.save, 'utf8'))).toEqual(defaultConfig())
  files.save = null
  expect(await handlers[CH.configExport]()).toBe(false)
  stop()
})

test('scheduler:pause forever shows in status; resume clears it', async () => {
  const { handlers, stop } = await setup()
  await handlers[CH.schedulerPause]('forever')
  expect(((await handlers[CH.schedulerStatus]()) as SchedulerStatus).pausedUntil).toBe('forever')
  await handlers[CH.schedulerResume]()
  expect(((await handlers[CH.schedulerStatus]()) as SchedulerStatus).pausedUntil).toBeNull()
  stop()
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
  stop()
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
    saveFile: async () => null,
    openFile: async () => null
  })
  expect(await handlers[CH.configGet]()).toMatchObject({ ok: false })
  await handlers[CH.configReset]()
  expect(await handlers[CH.configGet]()).toMatchObject({ ok: true, config: defaultConfig() })
  services.stop()
})
