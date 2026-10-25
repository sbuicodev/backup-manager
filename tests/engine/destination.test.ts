import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DestinationUnavailable, FsDestination } from '../../src/main/engine/destination'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

describe('FsDestination', () => {
  test('isAvailable reflects whether the root exists', async () => {
    const root = await tmpDir()
    expect(await new FsDestination(root).isAvailable()).toBe(true)
    expect(await new FsDestination(join(root, 'missing')).isAvailable()).toBe(false)
  })

  test('mkdirp throws DestinationUnavailable when root is missing and does not create it', async () => {
    const root = join(await tmpDir(), 'usb')
    const d = new FsDestination(root)
    await expect(d.mkdirp('S/current')).rejects.toBeInstanceOf(DestinationUnavailable)
    expect(existsSync(root)).toBe(false)
  })

  test('copyFileIn copies content, preserves mtime, leaves no partial', async () => {
    const src = await tmpDir()
    const root = await tmpDir()
    const mtime = new Date(2025, 4, 6, 7, 8, 9)
    await makeTree(src, { 'a.txt': { content: 'hello', mtime } })
    const d = new FsDestination(root)
    const r = await d.copyFileIn(join(src, 'a.txt'), 'S/current/a.txt')
    expect(r.bytes).toBe(5)
    expect(await readTree(root)).toEqual({ 'S/current/a.txt': 'hello' })
    const s = await stat(join(root, 'S/current/a.txt'))
    expect(Math.abs(s.mtimeMs - mtime.getTime())).toBeLessThanOrEqual(1)
  })

  test('copyFileIn overwrites an existing target', async () => {
    const src = await tmpDir()
    const root = await tmpDir()
    await makeTree(src, { 'a.txt': 'new' })
    await makeTree(root, { 'a.txt': 'old content' })
    await new FsDestination(root).copyFileIn(join(src, 'a.txt'), 'a.txt')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new')
  })

  test('aborting mid-copy rejects and leaves neither target nor partial', async () => {
    const src = await tmpDir()
    const root = await tmpDir()
    await writeFile(join(src, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 1))
    const ac = new AbortController()
    const d = new FsDestination(root)
    await expect(
      d.copyFileIn(join(src, 'big.bin'), 'big.bin', ac.signal, () => ac.abort())
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readTree(root)).toEqual({})
  })

  test('copyFileIn of a vanished source rejects with ENOENT', async () => {
    const src = await tmpDir()
    const root = await tmpDir()
    const d = new FsDestination(root)
    await expect(d.copyFileIn(join(src, 'gone.txt'), 'gone.txt')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readTree(root)).toEqual({})
  })

  test('walk hides partials and the manifest, returns [] for a missing dir', async () => {
    const root = await tmpDir()
    await makeTree(root, {
      'S/current/a.txt': '',
      'S/current/.0a1b2c3d4e5f.bm-partial': '',
      'S/current/user.partial': 'u',
      'S/current/.backup-manager.json': '{}'
    })
    const d = new FsDestination(root)
    expect((await d.walk('S/current', [])).map((f) => f.rel)).toEqual(['a.txt', 'user.partial'])
    expect(await d.walk('S/nothing', [])).toEqual([])
  })

  test('list returns entries, [] when missing', async () => {
    const root = await tmpDir()
    await makeTree(root, { 'S/a.zip': '', 'S/d/x': '' })
    const d = new FsDestination(root)
    const names = (await d.list('S')).sort((a, b) => a.name.localeCompare(b.name))
    expect(names).toEqual([
      { name: 'a.zip', isDir: false },
      { name: 'd', isDir: true }
    ])
    expect(await d.list('none')).toEqual([])
  })

  test('rename creates parent dirs; remove is recursive and tolerates missing', async () => {
    const root = await tmpDir()
    await makeTree(root, { 'S/current/a/b.txt': 'b' })
    const d = new FsDestination(root)
    await d.rename('S/current/a/b.txt', 'S/.trash/T/a/b.txt')
    expect(await readTree(root)).toEqual({ 'S/.trash/T/a/b.txt': 'b' })
    await d.remove('S/.trash')
    await d.remove('S/.trash')
    expect(await readTree(root)).toEqual({})
  })

  test('removeEmptyDirs removes nested empty dirs but keeps non-empty ones and the base', async () => {
    const root = await tmpDir()
    await makeTree(root, { 'S/current/e1/e2/': '', 'S/current/f/x.txt': 'x' })
    const d = new FsDestination(root)
    await d.removeEmptyDirs('S/current')
    expect(existsSync(join(root, 'S/current/e1'))).toBe(false)
    expect(existsSync(join(root, 'S/current/f/x.txt'))).toBe(true)
    expect(existsSync(join(root, 'S/current'))).toBe(true)
  })

  test('removePartials sweeps one level, or recursively when asked; user *.partial files are kept', async () => {
    const root = await tmpDir()
    await makeTree(root, {
      'S/T.bm-partial/a.txt': '',
      'S/T2/.aaaa.bm-partial': 'inside finalized snapshot',
      'S/current/d/.bbbb.bm-partial': '',
      'S/current/keep.txt': 'k',
      'S/current/user.partial': 'u'
    })
    const d = new FsDestination(root)
    expect(await d.removePartials('S', false)).toBe(1)
    expect(await d.removePartials('S/current', true)).toBe(1)
    expect(await readTree(root)).toEqual({
      'S/T2/.aaaa.bm-partial': 'inside finalized snapshot',
      'S/current/keep.txt': 'k',
      'S/current/user.partial': 'u'
    })
  })

  test('readText / writeTextAtomic', async () => {
    const root = await tmpDir()
    const d = new FsDestination(root)
    expect(await d.readText('S/m.json')).toBeNull()
    await d.writeTextAtomic('S/m.json', '{"a":1}')
    expect(await d.readText('S/m.json')).toBe('{"a":1}')
  })

  test('stat returns size/mtime/isDir or null', async () => {
    const root = await tmpDir()
    await makeTree(root, { 'a.txt': 'abc' })
    const d = new FsDestination(root)
    expect(await d.stat('a.txt')).toMatchObject({ size: 3, isDir: false })
    expect(await d.stat('')).toMatchObject({ isDir: true })
    expect(await d.stat('nope')).toBeNull()
  })

  test('relative paths escaping the root are rejected', async () => {
    const root = await tmpDir()
    const d = new FsDestination(root)
    await expect(d.remove('../x')).rejects.toThrow()
    await expect(d.mkdirp('../x')).rejects.toThrow()
    await expect(d.readText('../x')).rejects.toThrow()
    expect(() => d.abs('../x')).toThrow()
  })
})
