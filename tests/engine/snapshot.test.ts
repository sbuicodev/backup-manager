import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { newSource, type Source } from '@shared/schema'
import { FsDestination } from '../../src/main/engine/destination'
import { JobAbort } from '../../src/main/engine/errors'
import { formatTimestamp } from '../../src/main/engine/naming'
import { readZipEntryCount } from '../../src/main/engine/packaging/zip'
import { prepareSnapshot } from '../../src/main/engine/snapshot'
import { makeTree, readTree, tmpDir } from '../helpers/fs'
import { FailingDest, ctxFor, exec } from '../helpers/job'

const NOW = new Date(2026, 9, 25, 10, 0, 0)
const TS = formatTimestamp(NOW)

async function setup(
  packaging: Source['packaging']
): Promise<{ src: string; root: string; source: Source }> {
  const src = await tmpDir()
  const root = await tmpDir()
  await makeTree(src, { 'A/x.txt': 'x', 'B/y.txt': 'y', 'top.txt': 't' })
  const source = { ...newSource(src, 'S', []), mode: 'snapshot' as const, packaging }
  return { src, root, source }
}

describe('snapshot', () => {
  test('copy layout: S/<TS>/<files>', async () => {
    const { root, source } = await setup('copy')
    const dest = new FsDestination(root)
    const prepared = await prepareSnapshot(await ctxFor(source, dest, NOW))
    expect(prepared.plan).toMatchObject({ kind: 'snapshot-copy', counts: { copy: 3 }, bytes: 3 })
    const r = await prepared.execute(exec())
    expect(r).toMatchObject({ status: 'completed', counts: { copied: 3 } })
    expect(await readTree(root)).toEqual({
      [`S/${TS}/A/x.txt`]: 'x',
      [`S/${TS}/B/y.txt`]: 'y',
      [`S/${TS}/top.txt`]: 't'
    })
  })

  test('zip-whole layout: S/<TS>.zip', async () => {
    const { root, source } = await setup('zip-whole')
    const dest = new FsDestination(root)
    const prepared = await prepareSnapshot(await ctxFor(source, dest, NOW))
    expect(prepared.plan).toMatchObject({ kind: 'snapshot-zip', counts: { zip: 1 } })
    const r = await prepared.execute(exec())
    expect(r.counts.zipped).toBe(1)
    expect(Object.keys(await readTree(root))).toEqual([`S/${TS}.zip`])
    expect(await readZipEntryCount(join(root, `S/${TS}.zip`))).toBe(3)
  })

  test('zip-children layout: S/<TS>/<child>.zip', async () => {
    const { root, source } = await setup('zip-children')
    const dest = new FsDestination(root)
    const r = await (await prepareSnapshot(await ctxFor(source, dest, NOW))).execute(exec())
    expect(r.counts.zipped).toBe(3)
    expect(Object.keys(await readTree(root)).sort()).toEqual([
      `S/${TS}/A.zip`,
      `S/${TS}/B.zip`,
      `S/${TS}/top.txt.zip`
    ])
  })

  test('two runs in the same second → second named TS-2', async () => {
    for (const packaging of ['copy', 'zip-whole'] as const) {
      const { root, source } = await setup(packaging)
      const dest = new FsDestination(root)
      await (await prepareSnapshot(await ctxFor(source, dest, NOW))).execute(exec())
      await (await prepareSnapshot(await ctxFor(source, dest, NOW))).execute(exec())
      const names = (await dest.list('S')).map((e) => e.name).sort()
      expect(names).toEqual(packaging === 'copy' ? [TS, `${TS}-2`] : [`${TS}-2.zip`, `${TS}.zip`])
    }
  })

  test('disk full mid-copy → JobAbort disk-full, nothing left behind', async () => {
    const { root, source } = await setup('copy')
    const dest = new FailingDest(root, 2, 'ENOSPC')
    const prepared = await prepareSnapshot(await ctxFor(source, dest, NOW))
    await expect(prepared.execute(exec())).rejects.toSatisfy(
      (e: unknown) => e instanceof JobAbort && e.reason === 'disk-full'
    )
    expect(await dest.list('S')).toEqual([])
  })

  test('abort mid-run → JobAbort cancelled, partial removed', async () => {
    const { src, root, source } = await setup('copy')
    await writeFile(join(src, 'big.bin'), Buffer.alloc(4 * 1024 * 1024, 1))
    const dest = new FsDestination(root)
    const prepared = await prepareSnapshot(await ctxFor(source, dest, NOW))
    const ac = new AbortController()
    const events: Parameters<typeof exec>[0] = []
    const x = exec(events, ac.signal)
    const emit = x.emit
    x.emit = (e) => {
      emit(e)
      if (e.type === 'file') ac.abort()
    }
    await expect(prepared.execute(x)).rejects.toSatisfy(
      (e: unknown) => e instanceof JobAbort && e.reason === 'cancelled'
    )
    expect(await dest.list('S')).toEqual([])
  })

  test('file vanished before execute → warning, snapshot still finalized', async () => {
    const { src, root, source } = await setup('copy')
    const dest = new FsDestination(root)
    const prepared = await prepareSnapshot(await ctxFor(source, dest, NOW))
    await rm(join(src, 'top.txt'))
    const r = await prepared.execute(exec())
    expect(r.status).toBe('completed-with-warnings')
    expect(Object.keys(await readTree(root)).sort()).toEqual([`S/${TS}/A/x.txt`, `S/${TS}/B/y.txt`])
  })

  test('stale partial snapshot from a crash is removed', async () => {
    const { root, source } = await setup('zip-whole')
    await makeTree(root, {
      'S/.0a1b2c3d4e5f.bm-partial': 'junk',
      'S/2020-01-01_000000.bm-partial/x': 'junk'
    })
    const dest = new FsDestination(root)
    await (await prepareSnapshot(await ctxFor(source, dest, NOW))).execute(exec())
    expect(Object.keys(await readTree(root))).toEqual([`S/${TS}.zip`])
  })
})

test('user files named *.partial survive inside finalized snapshots', async () => {
  const { src, root, source } = await setup('copy')
  await makeTree(src, { 'report.partial': 'mine' })
  const dest = new FsDestination(root)
  await (await prepareSnapshot(await ctxFor(source, dest, NOW))).execute(exec())
  const later = new Date(NOW.getTime() + 60_000)
  await (await prepareSnapshot(await ctxFor(source, dest, later))).execute(exec())
  const tree = await readTree(root)
  expect(tree[`S/${TS}/report.partial`]).toBe('mine')
  expect(tree[`S/${formatTimestamp(later)}/report.partial`]).toBe('mine')
})
