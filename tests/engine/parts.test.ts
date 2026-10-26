import { describe, expect, test } from 'vitest'
import type { EffectiveZip } from '@shared/schema'
import type { FileEntry } from '@shared/types'
import {
  chunkName,
  isOversized,
  ownsFile,
  packFresh,
  packStable,
  partBaseName,
  partSize,
  type ManifestArchive,
  type PartPlan
} from '../../src/main/engine/packaging/parts'

const MB = 1024 ** 2
const f = (rel: string, size: number, mtimeMs = 1000): FileEntry => ({ rel, size, mtimeMs })
const zip = (limit: number | null, chunk = false): EffectiveZip => ({
  limit,
  chunk,
  chunkSize: limit
})
const rels = (parts: PartPlan[]): Record<number, string[]> =>
  Object.fromEntries(parts.map((p) => [p.n, p.files.map((x) => x.rel)]))
const asPrev = (parts: PartPlan[], limit: number | null): ManifestArchive => ({
  limit,
  parts: parts.map((p) => ({ ...p, fingerprint: 'x' }))
})

describe('partSize', () => {
  test('matches the spec formula', () => {
    expect(partSize([])).toBe(98)
    expect(partSize([f('ab', 100)])).toBe(98 + 100 + 5 + 6 + 170 + 4)
    expect(partSize([f('é', 16384 * 2)])).toBe(98 + 32768 + 10 + 6 + 170 + 4)
  })
  test('isOversized', () => {
    expect(isOversized(f('a', 10 * MB), 10 * MB)).toBe(true)
    expect(isOversized(f('a', 9 * MB), 10 * MB)).toBe(false)
  })
})

describe('packFresh', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((r) => f(r, 3 * MB))

  test('no limit → one unsplit part', () => {
    expect(packFresh(files, zip(null))).toEqual([{ n: 0, chunked: false, files }])
  })

  test('everything fits → unsplit n 0', () => {
    expect(rels(packFresh(files.slice(0, 3), zip(10 * MB)))).toEqual({ 0: ['a', 'b', 'c'] })
  })

  test('empty file list → one empty unsplit part', () => {
    expect(packFresh([], zip(10 * MB))).toEqual([{ n: 0, chunked: false, files: [] }])
  })

  test('fills parts in path order and never exceeds the limit', () => {
    const parts = packFresh([...files].reverse(), zip(10 * MB))
    expect(rels(parts)).toEqual({ 1: ['a', 'b', 'c'], 2: ['d', 'e', 'f'], 3: ['g'] })
    for (const p of parts) expect(partSize(p.files)).toBeLessThanOrEqual(10 * MB)
  })

  test('oversized file gets its own part, chunked only when zip.chunk', () => {
    const input = [f('a', 3 * MB), f('big', 30 * MB), f('c', 3 * MB)]
    // c still fits the open part 1, so it joins a there; big sits alone in part 2
    expect(packFresh(input, zip(10 * MB))).toEqual([
      { n: 1, chunked: false, files: [input[0], input[2]] },
      { n: 2, chunked: false, files: [input[1]] }
    ])
    expect(packFresh(input, zip(10 * MB, true)).map((p) => p.chunked)).toEqual([false, true])
  })

  test('a single oversized file stays a numbered part', () => {
    expect(rels(packFresh([f('big', 30 * MB)], zip(10 * MB)))).toEqual({ 1: ['big'] })
  })
})

describe('packStable', () => {
  const L = 10 * MB
  const base = ['a', 'b', 'c', 'd', 'e', 'f'].map((r) => f(r, 3 * MB))
  const prev = asPrev(packFresh(base, zip(L)), L) // 1: a b c, 2: d e f

  test('no previous entry or a different limit → packFresh', () => {
    expect(packStable(base, undefined, zip(L))).toEqual(packFresh(base, zip(L)))
    expect(packStable(base, prev, zip(20 * MB))).toEqual(packFresh(base, zip(20 * MB)))
  })

  test('unchanged files keep their part', () => {
    expect(rels(packStable(base, prev, zip(L)))).toEqual({ 1: ['a', 'b', 'c'], 2: ['d', 'e', 'f'] })
  })

  test('mtime within 2 s counts as unchanged', () => {
    const touched = base.map((x) => (x.rel === 'a' ? { ...x, mtimeMs: x.mtimeMs + 1500 } : x))
    expect(rels(packStable(touched, prev, zip(L)))[1]).toEqual(['a', 'b', 'c'])
  })

  test('new file appends to the last part when it fits', () => {
    const small = asPrev(packFresh(base.slice(0, 4), zip(L)), L) // 1: a b c, 2: d
    const r = packStable([...base.slice(0, 4), f('zz', 3 * MB)], small, zip(L))
    expect(rels(r)).toEqual({ 1: ['a', 'b', 'c'], 2: ['d', 'zz'] })
  })

  test('new file that does not fit opens part max(n)+1', () => {
    expect(rels(packStable([...base, f('aa', 3 * MB)], prev, zip(L)))).toEqual({
      1: ['a', 'b', 'c'],
      2: ['d', 'e', 'f'],
      3: ['aa']
    })
  })

  test('a changed file that no longer fits moves to a new part', () => {
    const grown = base.map((x) => (x.rel === 'b' ? f('b', 5 * MB, 9000) : x))
    expect(rels(packStable(grown, prev, zip(L)))).toEqual({
      1: ['a', 'c'],
      2: ['d', 'e', 'f'],
      3: ['b']
    })
  })

  test('removed files leave; a part below half the limit merges into the next', () => {
    const r = packStable(
      base.filter((x) => !['a', 'b'].includes(x.rel)),
      prev,
      zip(L)
    )
    // part 1 keeps only c (3 MB < 5 MB) → merged with part 2 would be 12 MB > 10 MB → stays
    expect(rels(r)).toEqual({ 1: ['c'], 2: ['d', 'e', 'f'] })
    const r2 = packStable(
      base.filter((x) => !['a', 'b', 'd', 'e'].includes(x.rel)),
      prev,
      zip(L)
    )
    // 1: c, 2: f → merged into part 1, which then is a single part → collapses to n 0
    expect(rels(r2)).toEqual({ 0: ['c', 'f'] })
  })

  test('merge keeps the lower number and leaves later parts alone', () => {
    const three = asPrev(packFresh([...base, f('g', 3 * MB), f('h', 3 * MB)], zip(L)), L) // 1 abc 2 def 3 gh
    const r = packStable(
      [...base, f('g', 3 * MB), f('h', 3 * MB)].filter(
        (x) => !['a', 'b', 'd', 'e'].includes(x.rel)
      ),
      three,
      zip(L)
    )
    expect(rels(r)).toEqual({ 1: ['c', 'f'], 3: ['g', 'h'] })
  })

  test('shrinking to one part collapses to n 0', () => {
    expect(rels(packStable(base.slice(0, 2), prev, zip(L)))).toEqual({ 0: ['a', 'b'] })
  })

  test('an unsplit archive that grows past the limit gets numbered parts', () => {
    const one = asPrev(packFresh(base.slice(0, 3), zip(L)), L) // 0: a b c
    expect(rels(packStable([...base.slice(0, 3), f('d', 3 * MB)], one, zip(L)))).toEqual({
      1: ['a', 'b', 'c'],
      2: ['d']
    })
  })

  test('oversized new file gets its own new part', () => {
    const r = packStable([...base, f('big', 30 * MB)], prev, zip(L, true))
    expect(r.find((p) => p.n === 3)).toMatchObject({ chunked: true, files: [{ rel: 'big' }] })
  })
})

test('names', () => {
  expect(partBaseName('B', { n: 0 })).toBe('B.zip')
  expect(partBaseName('B', { n: 3 })).toBe('B.part3.zip')
  expect(chunkName('B.part3.zip', 1)).toBe('B.part3.zip.001')
  expect(chunkName('B.part3.zip', 12)).toBe('B.part3.zip.012')
  expect(['B.zip', 'B.part2.zip', 'B.part2.zip.014'].every((n) => ownsFile('B', n))).toBe(true)
  expect(
    ['C.zip', 'B.part.zip', 'B-2.zip', 'B.zip.001', 'xB.zip'].some((n) => ownsFile('B', n))
  ).toBe(false)
  expect(ownsFile('a.b+c', 'a.b+c.part1.zip')).toBe(true)
  expect(ownsFile('a.b+c', 'aXb+c.zip')).toBe(false)
})

test('packStable keeps an unchanged oversized own-part file in its part', () => {
  const L = 10 * MB
  const files = [f('a', 3 * MB), f('big', 30 * MB), f('c', 3 * MB), f('d', 5 * MB)]
  const fresh = packFresh(files, zip(L))
  expect(rels(fresh)).toEqual({ 1: ['a', 'c'], 2: ['big'], 3: ['d'] })
  expect(rels(packStable(files, asPrev(fresh, L), zip(L)))).toEqual(rels(fresh))
})

test('names with 1000+ pieces are still recognised', () => {
  expect(chunkName('B.part1.zip', 1000)).toBe('B.part1.zip.1000')
  expect(ownsFile('B', 'B.part1.zip.1000')).toBe(true)
})
