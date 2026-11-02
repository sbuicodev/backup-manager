import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { effectiveZipSettings, newDestination, newSource, type Source } from '@shared/schema'
import type { ChangeEntry, FileEntry, JobResult, ProgressEvent } from '@shared/types'
import { FsDestination } from '../../src/main/engine/destination'
import { JobAbort } from '../../src/main/engine/errors'
import type { ExecContext, JobContext } from '../../src/main/engine/job'
import { diffMirror, prepareMirrorCopy, prepareMirrorZip } from '../../src/main/engine/mirror'
import { formatTimestamp } from '../../src/main/engine/naming'
import { walkTree } from '../../src/main/engine/walk'
import { makeTree, readTree, tmpDir } from '../helpers/fs'

const NOW = new Date(2026, 9, 25, 10, 0, 0)
const TS = formatTimestamp(NOW)

class FailingDest extends FsDestination {
  calls = 0
  constructor(
    root: string,
    private failOn: number,
    private code: string
  ) {
    super(root)
  }
  override async copyFileIn(
    ...args: Parameters<FsDestination['copyFileIn']>
  ): Promise<{ bytes: number }> {
    if (++this.calls === this.failOn) throw Object.assign(new Error(this.code), { code: this.code })
    return super.copyFileIn(...args)
  }
}

async function ctxFor(source: Source, dest: FsDestination): Promise<JobContext> {
  const { files, skipped } = await walkTree(source.items[0].path, {
    excludes: [...source.excludes, ...(source.useGlobalExcludes ? ['.DS_Store'] : [])]
  })
  return {
    source,
    destId: 'd1',
    dest,
    globalExcludes: ['.DS_Store'],
    srcFiles: files,
    srcSkipped: skipped,
    now: NOW,
    zip: effectiveZipSettings(source, newDestination('/d', 'D'))
  }
}

function exec(events: ProgressEvent[] = [], changes: ChangeEntry[] = []): ExecContext {
  return {
    runId: 'r1',
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    record: (c) => (changes.push(c), true),
    drain: async () => {}
  }
}

async function run(source: Source, dest: FsDestination, x = exec()): Promise<JobResult> {
  const ctx = await ctxFor(source, dest)
  const prepared =
    source.packaging === 'copy' ? await prepareMirrorCopy(ctx) : await prepareMirrorZip(ctx)
  return prepared.execute(x)
}

async function setup(
  spec: Parameters<typeof makeTree>[1]
): Promise<{ src: string; root: string; source: Source; dest: FsDestination }> {
  const src = await tmpDir()
  const root = await tmpDir()
  await makeTree(src, spec)
  return { src, root, source: newSource(src, 'S', []), dest: new FsDestination(root) }
}

const fe = (rel: string, size: number, mtimeMs: number): FileEntry => ({ rel, size, mtimeMs })

describe('diffMirror', () => {
  test('new, changed size, mtime within 2s, mtime beyond 2s, removed', () => {
    const src = [
      fe('new', 1, 0),
      fe('size', 2, 0),
      fe('near', 1, 1999),
      fe('far', 1, 3000),
      fe('same', 1, 5)
    ]
    const dst = [
      fe('size', 1, 0),
      fe('near', 1, 0),
      fe('far', 1, 0),
      fe('same', 1, 5),
      fe('gone', 1, 0)
    ]
    const d = diffMirror(src, dst)
    expect(d.copy.map((f) => f.rel)).toEqual(['new'])
    expect(d.update.map((f) => f.rel)).toEqual(['size', 'far'])
    expect(d.remove).toEqual(['gone'])
    expect(d.unchanged).toBe(2)
  })
})

describe('mirror-copy', () => {
  test('first run copies all files with mtimes; plan counts match', async () => {
    const mtime = new Date(2025, 1, 2, 3, 4, 5)
    const { src, source, dest, root } = await setup({
      'a.txt': { content: 'a', mtime },
      'd/b.txt': 'bb'
    })
    const prepared = await prepareMirrorCopy(await ctxFor(source, dest))
    expect(prepared.plan).toMatchObject({
      kind: 'mirror-copy',
      status: 'ready',
      counts: { copy: 2, update: 0, trash: 0, delete: 0, unchanged: 0 },
      bytes: 3
    })
    const r = await prepared.execute(exec())
    expect(r).toMatchObject({ status: 'completed', counts: { copied: 2 }, bytesWritten: 3 })
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'a', 'S/d/b.txt': 'bb' })
    expect((await stat(join(root, 'S/a.txt'))).mtimeMs).toBe(mtime.getTime())
    expect(src).toBeTruthy()
  })

  test('second run with no changes copies nothing', async () => {
    const { source, dest } = await setup({ 'a.txt': 'a', 'd/b.txt': 'bb' })
    await run(source, dest)
    const r = await run(source, dest)
    expect(r.counts.copied + r.counts.updated).toBe(0)
  })

  test('changed file is updated', async () => {
    const { src, source, dest, root } = await setup({ 'a.txt': 'a' })
    await run(source, dest)
    await writeFile(join(src, 'a.txt'), 'changed!')
    const r = await run(source, dest)
    expect(r.counts.updated).toBe(1)
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'changed!' })
  })

  test('trash policy moves deleted files under .trash/<TS>/ keeping rel path', async () => {
    const { src, source, dest, root } = await setup({ 'a.txt': 'a', 'd/b.txt': 'b' })
    await run(source, dest)
    await rm(join(src, 'd'), { recursive: true })
    const r = await run(source, dest)
    expect(r.counts.trashed).toBe(1)
    expect(await readTree(root)).toEqual({
      'S/a.txt': 'a',
      [`S/.trash/${TS}/d/b.txt`]: 'b'
    })
  })

  test('exact policy deletes and removes empty dirs', async () => {
    const { src, source, dest, root } = await setup({ 'a.txt': 'a', 'd/b.txt': 'b' })
    source.mirror.deletion = 'exact'
    await run(source, dest)
    await rm(join(src, 'd'), { recursive: true })
    const r = await run(source, dest)
    expect(r.counts.deleted).toBe(1)
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'a' })
    expect(await dest.stat('S/d')).toBeNull()
  })

  test('never policy keeps deleted files', async () => {
    const { src, source, dest, root } = await setup({ 'a.txt': 'a', 'd/b.txt': 'b' })
    source.mirror.deletion = 'never'
    await run(source, dest)
    await rm(join(src, 'd'), { recursive: true })
    await run(source, dest)
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'a', 'S/d/b.txt': 'b' })
  })

  test('excluded file at destination is left untouched', async () => {
    const { source, dest, root } = await setup({ 'a.txt': 'a' })
    source.excludes = ['*.tmp']
    await makeTree(root, { 'S/x.tmp': 'keep me' })
    source.mirror.deletion = 'exact'
    await run(source, dest)
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'a', 'S/x.tmp': 'keep me' })
  })

  test('case-only rename keeps the renamed file', async () => {
    const { src, source, dest, root } = await setup({ 'Foo.txt': 'v1', 'Dir/x.txt': 'x' })
    await run(source, dest)
    await rm(join(src, 'Foo.txt'))
    await rm(join(src, 'Dir'), { recursive: true })
    await makeTree(src, { 'foo.txt': 'v2', 'dir/x.txt': 'x' })
    await run(source, dest)
    const tree = await readTree(root)
    expect(tree['S/foo.txt']).toBe('v2')
    expect(tree['S/dir/x.txt']).toBe('x')
    expect(tree['S/Foo.txt']).toBeUndefined()
  })

  test('source file deleted between prepare and execute → warning, completed-with-warnings', async () => {
    const { src, source, dest } = await setup({ 'a.txt': 'a', 'b.txt': 'b' })
    const prepared = await prepareMirrorCopy(await ctxFor(source, dest))
    await rm(join(src, 'a.txt'))
    const events: ProgressEvent[] = []
    const r = await prepared.execute(exec(events))
    expect(r.status).toBe('completed-with-warnings')
    expect(r.warnings).toEqual([expect.objectContaining({ path: 'a.txt', code: 'ENOENT' })])
    expect(r.counts.copied).toBe(1)
    expect(events.some((e) => e.type === 'warning')).toBe(true)
  })

  test('source file grown between prepare and execute → destination has the full new content', async () => {
    const { src, source, dest, root } = await setup({ 'a.txt': 'short' })
    const prepared = await prepareMirrorCopy(await ctxFor(source, dest))
    await writeFile(join(src, 'a.txt'), 'much longer content now')
    const r = await prepared.execute(exec())
    expect(r.status).toBe('completed')
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'much longer content now' })
  })

  test('stale .partial from a crash is removed at job start', async () => {
    const { source, dest, root } = await setup({ 'a.txt': 'a' })
    await makeTree(root, { 'S/sub/.0a1b2c3d4e5f.bm-partial': 'junk' })
    await run(source, dest)
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'a' })
  })

  test('symlinks and unreadable entries become warnings', async () => {
    const { source, dest } = await setup({ 'a.txt': 'a' })
    const ctx = await ctxFor(source, dest)
    ctx.srcSkipped = [{ rel: 'link', reason: 'symlink' }]
    const r = await (await prepareMirrorCopy(ctx)).execute(exec())
    expect(r.status).toBe('completed-with-warnings')
    expect(r.warnings).toEqual([expect.objectContaining({ path: 'link', code: 'SYMLINK' })])
    expect(r.counts.skipped).toBe(1)
  })

  test('disk full is fatal: JobAbort reason disk-full', async () => {
    const { source, root } = await setup({ 'a.txt': 'a', 'b.txt': 'b' })
    const dest = new FailingDest(root, 2, 'ENOSPC')
    await expect(run(source, dest)).rejects.toSatisfy(
      (e: unknown) => e instanceof JobAbort && e.reason === 'disk-full'
    )
  })

  test('emits file progress events', async () => {
    const { source, dest } = await setup({ 'a.txt': 'aaa', 'b.txt': 'bb' })
    const events: ProgressEvent[] = []
    await run(source, dest, exec(events))
    const files = events.filter((e) => e.type === 'file')
    expect(files.at(-1)).toMatchObject({ type: 'file', bytesDone: 5, bytesTotal: 5 })
  })
})

describe('awkward file names', () => {
  test('user files named *.partial are mirrored once and not re-copied', async () => {
    const { source, dest, root } = await setup({ 'a.partial': 'mine', 'b.txt': 'b' })
    await run(source, dest)
    expect((await readTree(root))['S/a.partial']).toBe('mine')
    const r = await run(source, dest)
    expect(r.counts.copied + r.counts.updated).toBe(0)
  })

  test('a 250-character file name is backed up', async () => {
    const long = 'n'.repeat(246) + '.txt'
    const { source, dest, root } = await setup({ [long]: 'x', 'z.txt': 'z' })
    const r = await run(source, dest)
    expect(r.status).toBe('completed')
    expect(Object.keys(await readTree(root)).sort()).toEqual([`S/${long}`, 'S/z.txt'])
  })
})

describe('mirror-zip', () => {
  test('zip-children writes one archive per child and a manifest', async () => {
    const { source, dest, root } = await setup({ 'A/x.txt': 'x', 'B/y.txt': 'y' })
    source.packaging = 'zip-children'
    const r = await run(source, dest)
    expect(r).toMatchObject({ status: 'completed', counts: { zipped: 2 } })
    const tree = await readTree(root)
    expect(Object.keys(tree).sort()).toEqual(['S/.backup-manager.json', 'S/A.zip', 'S/B.zip'])
    expect(JSON.parse(tree['S/.backup-manager.json'])).toMatchObject({ version: 2 })
  })

  test('only archives whose fingerprint changed are rewritten', async () => {
    const { src, source, dest, root } = await setup({ 'A/x.txt': 'x', 'B/y.txt': 'y' })
    source.packaging = 'zip-children'
    await run(source, dest)
    const old = new Date(2020, 0, 1)
    const { utimes } = await import('node:fs/promises')
    await utimes(join(root, 'S/A.zip'), old, old)
    await utimes(join(root, 'S/B.zip'), old, old)
    await writeFile(join(src, 'B/y.txt'), 'changed')
    const prepared = await prepareMirrorZip(await ctxFor(source, dest))
    expect(prepared.plan.counts).toMatchObject({ zip: 1, unchanged: 1 })
    const r = await prepared.execute(exec())
    expect(r.counts.zipped).toBe(1)
    expect((await stat(join(root, 'S/A.zip'))).mtimeMs).toBe(old.getTime())
    expect((await stat(join(root, 'S/B.zip'))).mtimeMs).not.toBe(old.getTime())
  })

  test('removed child follows deletion policy and manifest is updated', async () => {
    const { src, source, dest, root } = await setup({ 'A/x.txt': 'x', 'B/y.txt': 'y' })
    source.packaging = 'zip-children'
    await run(source, dest)
    await rm(join(src, 'B'), { recursive: true })
    const r = await run(source, dest)
    expect(r.counts.trashed).toBe(1)
    const tree = await readTree(root)
    expect(Object.keys(tree).sort()).toEqual([
      'S/.backup-manager.json',
      'S/.trash/' + TS + '/B.zip',
      'S/A.zip'
    ])
    expect(Object.keys(JSON.parse(tree['S/.backup-manager.json']).archives)).toEqual(['A'])
  })

  test('missing archive is rewritten even if manifest matches', async () => {
    const { source, dest, root } = await setup({ 'A/x.txt': 'x' })
    source.packaging = 'zip-whole'
    await run(source, dest)
    await rm(join(root, 'S/S.zip'))
    const r = await run(source, dest)
    expect(r.counts.zipped).toBe(1)
  })
})

describe('unreadable source entries never cost backup data', () => {
  const posixNonRoot = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test

  for (const deletion of ['exact', 'trash'] as const) {
    posixNonRoot(
      `mirror-copy (${deletion}): backup of an unreadable subfolder is kept`,
      async () => {
        const { src, source, dest, root } = await setup({ 'a.txt': 'a', 'sub/keep.txt': 'k' })
        source.mirror.deletion = deletion
        await run(source, dest)
        await chmod(join(src, 'sub'), 0o000)
        try {
          const r = await run(source, dest)
          expect(r.counts.deleted + r.counts.trashed).toBe(0)
          expect(r.warnings.map((w) => w.path)).toContain('sub')
          expect(await readTree(root)).toEqual({
            'S/a.txt': 'a',
            'S/sub/keep.txt': 'k'
          })
        } finally {
          await chmod(join(src, 'sub'), 0o755)
        }
      }
    )
  }

  posixNonRoot('mirror-zip keeps an archive whose members became unreadable', async () => {
    const { src, source, dest, root } = await setup({
      'A/x.txt': 'x',
      'A/sub/y.txt': 'y',
      'B/z.txt': 'z'
    })
    source.packaging = 'zip-children'
    await run(source, dest)
    const before = await readFile(join(root, 'S/A.zip'))
    await chmod(join(src, 'A/sub'), 0o000)
    try {
      const r = await run(source, dest)
      expect(r.counts.zipped).toBe(0)
      expect(r.warnings.some((w) => w.path === 'A.zip')).toBe(true)
      expect((await readFile(join(root, 'S/A.zip'))).equals(before)).toBe(true)
    } finally {
      await chmod(join(src, 'A/sub'), 0o755)
    }
  })

  posixNonRoot(
    'mirror-zip does not remove the archive of a wholly unreadable top-level folder',
    async () => {
      const { src, source, dest, root } = await setup({ 'A/x.txt': 'x', 'B/z.txt': 'z' })
      source.packaging = 'zip-children'
      source.mirror.deletion = 'exact'
      await run(source, dest)
      await chmod(join(src, 'B'), 0o000)
      try {
        const r = await run(source, dest)
        expect(r.counts.deleted).toBe(0)
        expect(Object.keys(await readTree(root))).toContain('S/B.zip')
      } finally {
        await chmod(join(src, 'B'), 0o755)
      }
    }
  )
})

describe('per-file errors do not abort the job', () => {
  test.each(['EINVAL', 'EILSEQ', 'ENAMETOOLONG', 'EISDIR', 'ENOTDIR', 'EEXIST', 'EIO'])(
    'mirror-copy: %s on one file → warning, other files still backed up',
    async (code) => {
      const { source, root } = await setup({ 'a.txt': 'a', 'b.txt': 'b' })
      const dest = new FailingDest(root, 1, code)
      const r = await run(source, dest)
      expect(r.status).toBe('completed-with-warnings')
      expect(r.warnings).toEqual([expect.objectContaining({ path: 'a.txt', code })])
      expect(await readTree(root)).toEqual({ 'S/b.txt': 'b' })
    }
  )

  test('mirror-zip: an archive that cannot be written is skipped with a warning and retried next run', async () => {
    const { source, root } = await setup({ 'A/x.txt': 'x', 'B/y.txt': 'y' })
    source.packaging = 'zip-children'
    let calls = 0
    const dest = new (class extends FsDestination {
      override async writeStream(rel: string): Promise<NodeJS.WritableStream> {
        if (++calls === 1) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
        return super.writeStream(rel)
      }
    })(root)
    const r = await run(source, dest)
    expect(r.status).toBe('completed-with-warnings')
    expect(r.counts.zipped).toBe(1)
    expect(r.warnings).toEqual([expect.objectContaining({ path: 'A.zip', code: 'EINVAL' })])
    const r2 = await run(source, dest)
    expect(r2.counts.zipped).toBe(1)
  })
})

describe('names differing only by case', () => {
  test('on a case-insensitive destination the later duplicate is skipped with a warning', async (t) => {
    const { src, source, dest, root } = await setup({ 'a.txt': 'lower' })
    const { existsSync } = await import('node:fs')
    if (!existsSync(join(src, 'A.txt'))) t.skip() // needs a case-insensitive filesystem
    const ctx = await ctxFor(source, dest)
    ctx.srcFiles = [
      { rel: 'A.txt', size: 5, mtimeMs: ctx.srcFiles[0].mtimeMs },
      { rel: 'a.txt', size: 5, mtimeMs: ctx.srcFiles[0].mtimeMs }
    ]
    const r = await (await prepareMirrorCopy(ctx)).execute(exec())
    expect(r.counts.copied).toBe(1)
    expect(r.warnings).toEqual([expect.objectContaining({ path: 'a.txt', code: 'CASE_CONFLICT' })])
    expect(Object.keys(await readTree(root))).toHaveLength(1)
  })
})

describe('a source that suddenly looks empty', () => {
  test('mirror-copy (exact) removes nothing and warns', async () => {
    const { src, source, dest, root } = await setup({ 'a.txt': 'a', 'd/b.txt': 'b' })
    source.mirror.deletion = 'exact'
    await run(source, dest)
    await rm(join(src, 'a.txt'))
    await rm(join(src, 'd'), { recursive: true })
    const r = await run(source, dest)
    expect(r.counts.deleted).toBe(0)
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'EMPTY_SOURCE' })])
    expect(await readTree(root)).toEqual({ 'S/a.txt': 'a', 'S/d/b.txt': 'b' })
  })

  test('mirror-zip (exact) keeps its archives and warns', async () => {
    const { src, source, dest, root } = await setup({ 'A/x.txt': 'x' })
    source.packaging = 'zip-children'
    source.mirror.deletion = 'exact'
    await run(source, dest)
    await rm(join(src, 'A'), { recursive: true })
    const r = await run(source, dest)
    expect(r.counts.deleted).toBe(0)
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'EMPTY_SOURCE' })])
    expect(Object.keys(await readTree(root))).toContain('S/A.zip')
  })

  test('mirror zip-whole does not replace the archive with an empty one', async () => {
    const { src, source, dest, root } = await setup({ 'A/x.txt': 'x' })
    source.packaging = 'zip-whole'
    await run(source, dest)
    const before = await readFile(join(root, 'S/S.zip'))
    await rm(join(src, 'A'), { recursive: true })
    const r = await run(source, dest)
    expect(r.counts.zipped).toBe(0)
    expect((await readFile(join(root, 'S/S.zip'))).equals(before)).toBe(true)
  })
})

describe('change recording', () => {
  test('mirror-copy records added, updated and trashed', async () => {
    const { src, source, dest } = await setup({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
    const first: ChangeEntry[] = []
    await run(source, dest, exec([], first))
    expect(first.map((c) => [c.action, c.path, c.size])).toEqual([
      ['added', 'a.txt', 1],
      ['added', 'b.txt', 1],
      ['added', 'c.txt', 1]
    ])
    await writeFile(join(src, 'b.txt'), 'changed')
    await rm(join(src, 'c.txt'))
    const second: ChangeEntry[] = []
    await run(source, dest, exec([], second))
    expect(second.map((c) => [c.action, c.path])).toEqual([
      ['trashed', 'c.txt'],
      ['updated', 'b.txt']
    ])
    expect(second.every((c) => c.sourceId === source.id && c.destId === 'd1')).toBe(true)
  })

  test('exact policy records deleted', async () => {
    const { src, source, dest } = await setup({ 'a.txt': 'a', 'c.txt': 'c' })
    source.mirror.deletion = 'exact'
    await run(source, dest)
    await rm(join(src, 'c.txt'))
    const changes: ChangeEntry[] = []
    await run(source, dest, exec([], changes))
    expect(changes.map((c) => [c.action, c.path])).toEqual([['deleted', 'c.txt']])
  })

  test('warnings with a path are recorded as skipped', async () => {
    const { source, dest } = await setup({ 'a.txt': 'a' })
    const ctx = await ctxFor(source, dest)
    ctx.srcSkipped = [{ rel: 'link', reason: 'symlink' }]
    const changes: ChangeEntry[] = []
    await (await prepareMirrorCopy(ctx)).execute(exec([], changes))
    expect(changes).toContainEqual(
      expect.objectContaining({ action: 'skipped', path: 'link', code: 'SYMLINK' })
    )
  })
})
