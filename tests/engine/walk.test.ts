import { chmod, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildMatcher, statFiles, walkTree } from '../../src/main/engine/walk'
import { makeTree, tmpDir } from '../helpers/fs'

const posixOnly = process.platform === 'win32' ? test.skip : test
const notRoot = process.getuid?.() === 0 ? test.skip : posixOnly

test('lists files with posix rel, size, mtime, sorted', async () => {
  const root = await tmpDir()
  const mtime = new Date(2026, 0, 2, 3, 4, 5)
  await makeTree(root, { 'b.txt': 'bb', 'a/c.txt': { content: 'ccc', mtime } })
  const { files, skipped } = await walkTree(root, { excludes: [] })
  expect(files.map((f) => f.rel)).toEqual(['a/c.txt', 'b.txt'])
  expect(files[0].size).toBe(3)
  expect(files[0].mtimeMs).toBe(mtime.getTime())
  expect(skipped).toEqual([])
})

test('excludes by basename at any depth', async () => {
  const root = await tmpDir()
  await makeTree(root, { 'x/.DS_Store': '', 'x/keep.txt': '', '.DS_Store': '' })
  const { files } = await walkTree(root, { excludes: ['.DS_Store'] })
  expect(files.map((f) => f.rel)).toEqual(['x/keep.txt'])
})

notRoot('directory pattern prunes subtree without descending', async () => {
  const root = await tmpDir()
  await makeTree(root, { 'p/node_modules/m/i.js': '', 'p/src/a.js': '' })
  const locked = join(root, 'p/node_modules/locked')
  await mkdir(locked)
  await chmod(locked, 0o000)
  try {
    const { files, skipped } = await walkTree(root, { excludes: ['node_modules/'] })
    expect(files.map((f) => f.rel)).toEqual(['p/src/a.js'])
    expect(skipped).toEqual([])
  } finally {
    await chmod(locked, 0o755)
  }
})

test('directory-only pattern does not match files', async () => {
  const root = await tmpDir()
  await makeTree(root, { cache: 'file named cache', 'd/cache/x': '' })
  const { files } = await walkTree(root, { excludes: ['cache/'] })
  expect(files.map((f) => f.rel)).toEqual(['cache'])
})

test('glob with slash is relative to root', async () => {
  const root = await tmpDir()
  await makeTree(root, { 'build/x.tmp': '', 'src/build/x.tmp': '' })
  const { files } = await walkTree(root, { excludes: ['build/*.tmp'] })
  expect(files.map((f) => f.rel)).toEqual(['src/build/x.tmp'])
})

test('skipNames hides matching names', async () => {
  const root = await tmpDir()
  await makeTree(root, { 'a.partial': '', 'b.txt': '' })
  const { files } = await walkTree(root, { excludes: [], skipNames: (n) => n.endsWith('.partial') })
  expect(files.map((f) => f.rel)).toEqual(['b.txt'])
})

posixOnly('symlinks are skipped and reported', async () => {
  const root = await tmpDir()
  await makeTree(root, { 'real.txt': 'x' })
  await symlink(join(root, 'real.txt'), join(root, 'link'))
  const { files, skipped } = await walkTree(root, { excludes: [] })
  expect(files.map((f) => f.rel)).toEqual(['real.txt'])
  expect(skipped).toEqual([{ rel: 'link', reason: 'symlink' }])
})

notRoot('unreadable directory is reported, walk continues', async () => {
  const root = await tmpDir()
  await makeTree(root, { 'ok/a.txt': '', 'locked/b.txt': '' })
  await chmod(join(root, 'locked'), 0o000)
  try {
    const { files, skipped } = await walkTree(root, { excludes: [] })
    expect(files.map((f) => f.rel)).toEqual(['ok/a.txt'])
    expect(skipped).toEqual([{ rel: 'locked', reason: 'unreadable' }])
  } finally {
    await chmod(join(root, 'locked'), 0o755)
  }
})

test('walking a missing root rejects with ENOENT', async () => {
  const root = await tmpDir()
  await expect(walkTree(join(root, 'nope'), { excludes: [] })).rejects.toMatchObject({
    code: 'ENOENT'
  })
})

test('buildMatcher', () => {
  const m = buildMatcher(['*.tmp', 'node_modules/', 'docs/private/**'])
  expect(m('a/b/x.tmp', false)).toBe(true)
  expect(m('a/node_modules', true)).toBe(true)
  expect(m('a/node_modules', false)).toBe(false)
  expect(m('docs/private/x/y.txt', false)).toBe(true)
  expect(m('docs/public/y.txt', false)).toBe(false)
})

test('statFiles lists files by name; missing ones and folders are skipped as unreadable', async () => {
  const root = await tmpDir()
  await makeTree(root, { 'a/tax.pdf': 'tax', 'b/vault.kdbx': 'vault!', 'dir/x': '' })
  const r = await statFiles([
    join(root, 'a/tax.pdf'),
    join(root, 'b/vault.kdbx'),
    join(root, 'gone.txt'),
    join(root, 'dir')
  ])
  expect(r.files.map((f) => [f.rel, f.size])).toEqual([
    ['tax.pdf', 3],
    ['vault.kdbx', 6]
  ])
  expect(r.skipped).toEqual([
    { rel: 'gone.txt', reason: 'unreadable' },
    { rel: 'dir', reason: 'unreadable' }
  ])
  expect(r.abs.get('vault.kdbx')).toBe(join(root, 'b/vault.kdbx'))
})
