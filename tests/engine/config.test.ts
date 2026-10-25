import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { defaultConfig, newSource } from '@shared/schema'
import { loadConfig, saveConfig } from '../../src/main/engine/config'
import { joinRel, isPartialName, toPosix } from '../../src/main/engine/fsutil'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bm-config-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('loadConfig on missing file creates it with defaults', async () => {
  const file = join(dir, 'config.json')
  const r = await loadConfig(file)
  expect(r).toEqual({ ok: true, config: defaultConfig(), created: true })
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(defaultConfig())
})

test('loadConfig on invalid JSON returns errors and leaves the file untouched', async () => {
  const file = join(dir, 'config.json')
  await writeFile(file, '{bad')
  const r = await loadConfig(file)
  expect(r.ok).toBe(false)
  expect(await readFile(file, 'utf8')).toBe('{bad')
})

test('loadConfig on schema violation returns errors', async () => {
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ ...defaultConfig(), version: 9 }))
  const r = await loadConfig(file)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.errors[0]).toMatch(/^version/)
})

test('saveConfig with invalid config returns errors and does not change the file', async () => {
  const file = join(dir, 'config.json')
  await loadConfig(file)
  const before = await readFile(file, 'utf8')
  const bad = defaultConfig()
  bad.sources.push({ ...newSource('/a', 'A', []), destinationIds: ['missing'] })
  const r = await saveConfig(file, bad)
  expect(r.ok).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(before)
})

test('save then load round-trips', async () => {
  const file = join(dir, 'config.json')
  const cfg = defaultConfig()
  cfg.sources.push(newSource('/a', 'A', []))
  expect(await saveConfig(file, cfg)).toEqual({ ok: true })
  expect(await loadConfig(file)).toEqual({ ok: true, config: cfg, created: false })
})

test('joinRel joins posix and rejects escapes', () => {
  expect(joinRel('a', 'b/c', 'd.txt')).toBe('a/b/c/d.txt')
  expect(joinRel('a', '')).toBe('a')
  expect(() => joinRel('a', '../b')).toThrow()
  expect(() => joinRel('/abs')).toThrow()
  expect(() => joinRel('C:\\x')).toThrow()
})

test('toPosix and isPartialName', () => {
  expect(toPosix('a\\b\\c')).toBe('a/b/c')
  expect(isPartialName('.0a1b2c3d4e5f.bm-partial')).toBe(true)
  expect(isPartialName('report.partial')).toBe(false)
  expect(isPartialName('x.zip')).toBe(false)
})
