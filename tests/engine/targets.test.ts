import { expect, test } from 'vitest'
import { newSource, type Source } from '@shared/schema'
import type { FileEntry } from '@shared/types'
import { computeZipTargets, fingerprint } from '../../src/main/engine/packaging/targets'

const f = (rel: string, size = 1, mtimeMs = 1000): FileEntry => ({ rel, size, mtimeMs })
const src = (
  packaging: Source['packaging'],
  looseFiles: 'individual' | 'bundle' = 'individual'
): Source => {
  const s = newSource('/s', 'Stuff', [])
  return { ...s, packaging, zip: { ...s.zip, level: 6, looseFiles } }
}
const shape = (targets: ReturnType<typeof computeZipTargets>): Record<string, string[]> =>
  Object.fromEntries(targets.map((t) => [t.name, t.files.map((x) => x.rel)]))

const files = [
  f('Photos/a.jpg'),
  f('Photos/2024/b.jpg'),
  f('Docs/c.pdf'),
  f('notes.txt'),
  f('todo.md')
]

test('zip-whole: one archive named after the slug, with every file', () => {
  expect(shape(computeZipTargets(src('zip-whole'), files))).toEqual({
    'Stuff.zip': ['Photos/a.jpg', 'Photos/2024/b.jpg', 'Docs/c.pdf', 'notes.txt', 'todo.md']
  })
})

test('zip-whole of an empty source still yields one target', () => {
  expect(shape(computeZipTargets(src('zip-whole'), []))).toEqual({ 'Stuff.zip': [] })
})

test('zip-children individual: one per top-level dir and per loose file', () => {
  expect(shape(computeZipTargets(src('zip-children'), files))).toEqual({
    'Photos.zip': ['Photos/a.jpg', 'Photos/2024/b.jpg'],
    'Docs.zip': ['Docs/c.pdf'],
    'notes.txt.zip': ['notes.txt'],
    'todo.md.zip': ['todo.md']
  })
})

test('zip-children bundle: loose files go into _files.zip', () => {
  expect(shape(computeZipTargets(src('zip-children', 'bundle'), files))).toEqual({
    'Photos.zip': ['Photos/a.jpg', 'Photos/2024/b.jpg'],
    'Docs.zip': ['Docs/c.pdf'],
    '_files.zip': ['notes.txt', 'todo.md']
  })
})

test('empty top-level dir produces no archive (walk yields no files for it)', () => {
  expect(shape(computeZipTargets(src('zip-children'), [f('Docs/c.pdf')]))).toEqual({
    'Docs.zip': ['Docs/c.pdf']
  })
})

test('dir named _files plus bundle: bundle becomes _files-2.zip', () => {
  const t = computeZipTargets(src('zip-children', 'bundle'), [f('_files/x'), f('loose.txt')])
  expect(shape(t)).toEqual({ '_files.zip': ['_files/x'], '_files-2.zip': ['loose.txt'] })
})

test('dir "a.txt" and loose file collisions resolve with -2', () => {
  // dir "notes.txt.zip"? unrealistic; a dir "a" and a loose file "a.zip" → "a.zip" and "a.zip.zip"
  const t = computeZipTargets(src('zip-children'), [f('a/x'), f('a.zip')])
  expect(Object.keys(shape(t)).sort()).toEqual(['a.zip', 'a.zip.zip'])
})

test('names that collide case-insensitively get -2', () => {
  const t = computeZipTargets(
    src('zip-children'),
    [f('Docs/x'), f('docs.zip-like/y')].concat([f('DOCS/z')])
  )
  expect(Object.keys(shape(t)).sort()).toEqual(['DOCS-2.zip', 'Docs.zip', 'docs.zip-like.zip'])
})

test('fingerprint changes with size, mtime or level and is order-independent', () => {
  const a = [f('x', 1, 1000), f('y', 2, 2000)]
  const base = fingerprint(a, 6)
  expect(fingerprint([...a].reverse(), 6)).toBe(base)
  expect(fingerprint([f('x', 9, 1000), f('y', 2, 2000)], 6)).not.toBe(base)
  expect(fingerprint([f('x', 1, 5000), f('y', 2, 2000)], 6)).not.toBe(base)
  expect(fingerprint(a, 0)).not.toBe(base)
  expect(fingerprint([f('x', 1, 1000.7), f('y', 2, 2000)], 6)).toBe(base)
})

test('targets carry their fingerprint', () => {
  const [t] = computeZipTargets(src('zip-whole'), files)
  expect(t.fingerprint).toBe(fingerprint(files, 6))
})

test("names that look like part names never collide with another archive's parts", () => {
  const t = computeZipTargets(src('zip-children'), [f('x/a'), f('x.part1/only'), f('x.part12')])
  expect(Object.keys(shape(t)).sort()).toEqual(['x.part1-2.zip', 'x.part12-2.zip', 'x.zip'])
  expect(t.find((x) => x.name === 'x.part1-2.zip')?.base).toBe('x.part1-2')
})
