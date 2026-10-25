import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Config } from '@shared/schema'
import { planRun } from '../../src/main/engine/planner'
import { makeTree, tmpDir } from '../helpers/fs'

async function world(): Promise<{
  cfg: Config
  ids: Record<string, string>
  dirs: Record<string, string>
}> {
  const base = await tmpDir()
  const dirs = {
    s1: join(base, 's1'),
    s2: join(base, 's2'),
    d1: join(base, 'd1'),
    d2: join(base, 'd2')
  }
  await makeTree(base, { 's1/a.txt': 'a', 's2/b.txt': 'bb', 'd1/': '', 'd2/': '' })
  const cfg = defaultConfig()
  const d1 = newDestination(dirs.d1, 'D1')
  const d2 = newDestination(dirs.d2, 'D2')
  const s1 = newSource(dirs.s1, 'S1', [])
  const s2 = { ...newSource(dirs.s2, 'S2', ['S1']), destinationIds: [d1.id] }
  cfg.destinations.push(d1, d2)
  cfg.sources.push(s1, s2)
  return { cfg, ids: { s1: s1.id, s2: s2.id, d1: d1.id, d2: d2.id }, dirs }
}

const pairs = (
  plan: Awaited<ReturnType<typeof planRun>>['plan'],
  ids: Record<string, string>
): string[] => {
  const name = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]))
  return plan.jobs.map((j) => `${name[j.sourceId]}:${name[j.destId]}`)
}

test('sources × their destinations, in config order', async () => {
  const { cfg, ids } = await world()
  const { plan, prepared } = await planRun(cfg, {})
  expect(pairs(plan, ids)).toEqual(['s1:d1', 's1:d2', 's2:d1'])
  expect(plan.jobs.every((j) => j.status === 'ready')).toBe(true)
  expect(prepared.every((p) => typeof p.execute === 'function')).toBe(true)
  expect(plan.jobs[2]).toMatchObject({ kind: 'mirror-copy', counts: { copy: 1 }, bytes: 2 })
})

test('sourceIds limits sources', async () => {
  const { cfg, ids } = await world()
  const { plan } = await planRun(cfg, { sourceIds: [ids.s2] })
  expect(pairs(plan, ids)).toEqual(['s2:d1'])
})

test('disabled source and destination are excluded', async () => {
  const { cfg, ids } = await world()
  cfg.sources[1].enabled = false
  cfg.destinations[1].enabled = false
  const { plan } = await planRun(cfg, {})
  expect(pairs(plan, ids)).toEqual(['s1:d1'])
})

test('missing source → skipped source-missing for each of its jobs', async () => {
  const { cfg, ids } = await world()
  cfg.sources[0].path = join(cfg.sources[0].path, 'gone')
  const { plan, prepared } = await planRun(cfg, {})
  expect(plan.jobs.slice(0, 2).map((j) => [j.status, j.reason])).toEqual([
    ['skipped', 'source-missing'],
    ['skipped', 'source-missing']
  ])
  expect(prepared[0].execute).toBeUndefined()
  expect(pairs(plan, ids)).toEqual(['s1:d1', 's1:d2', 's2:d1'])
})

test('missing destination root → skipped destination-missing and root not created', async () => {
  const { cfg, dirs } = await world()
  cfg.destinations[1].path = join(dirs.d2, 'unplugged')
  const { plan } = await planRun(cfg, {})
  expect(plan.jobs[1]).toMatchObject({ status: 'skipped', reason: 'destination-missing' })
  expect(existsSync(join(dirs.d2, 'unplugged'))).toBe(false)
})

test('{ jobs } request returns exactly those pairs, ignoring unknown or disabled ones', async () => {
  const { cfg, ids } = await world()
  cfg.destinations[0].enabled = false
  const { plan } = await planRun(cfg, {
    jobs: [
      { sourceId: ids.s1, destId: ids.d2 },
      { sourceId: ids.s2, destId: ids.d1 },
      { sourceId: 'nope', destId: ids.d1 }
    ]
  })
  expect(pairs(plan, ids)).toEqual(['s1:d2'])
})

test('unchanged mirror plans zero bytes', async () => {
  const { cfg } = await world()
  for (const p of (await planRun(cfg, {})).prepared)
    await p.execute?.({ runId: 'r', signal: new AbortController().signal, emit: () => {} })
  const { plan } = await planRun(cfg, {})
  expect(plan.jobs[0]).toMatchObject({ counts: { unchanged: 1, copy: 0 }, bytes: 0 })
})

test('kind reflects mode and packaging', async () => {
  const { cfg } = await world()
  cfg.sources[0] = { ...cfg.sources[0], mode: 'snapshot', packaging: 'zip-children' }
  const { plan } = await planRun(cfg, {})
  expect(plan.jobs[0].kind).toBe('snapshot-zip')
})

test('global excludes apply unless disabled', async () => {
  const { cfg, dirs } = await world()
  await makeTree(dirs.s1, { '.DS_Store': 'x' })
  expect((await planRun(cfg, {})).plan.jobs[0].counts.copy).toBe(1)
  cfg.sources[0].useGlobalExcludes = false
  expect((await planRun(cfg, {})).plan.jobs[0].counts.copy).toBe(2)
})
