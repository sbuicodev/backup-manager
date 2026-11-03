import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { onTestFinished } from 'vitest'

/** Creates a temp dir removed when the current test finishes. */
export async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bm-test-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export type TreeSpec = Record<string, string | { content: string; mtime?: Date }>

/** Creates files under root; keys are posix rel paths. A key ending in '/' creates an empty dir. */
export async function makeTree(root: string, spec: TreeSpec): Promise<void> {
  for (const [rel, v] of Object.entries(spec)) {
    const abs = join(root, ...rel.split('/'))
    if (rel.endsWith('/')) {
      await mkdir(abs, { recursive: true })
      continue
    }
    await mkdir(dirname(abs), { recursive: true })
    const content = typeof v === 'string' ? v : v.content
    await writeFile(abs, content)
    if (typeof v !== 'string' && v.mtime) await utimes(abs, v.mtime, v.mtime)
  }
}

/**
 * Reads all files under root into { posixRel: content }. The mirror's layout marker is
 * bookkeeping, not backed-up content, so it is left out.
 */
/** Every file under `root` by relative path; `hidden: false` leaves out dot-named entries. */
export async function readTree(
  root: string,
  { hidden = true } = {}
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile() || e.name === '.backup-manager-layout') continue
    const abs = join(e.parentPath, e.name)
    const rel = relative(root, abs).split('\\').join('/')
    if (!hidden && rel.split('/').some((p) => p.startsWith('.'))) continue
    out[rel] = await readFile(abs, 'utf8')
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

export async function setMtime(file: string, date: Date): Promise<void> {
  await utimes(file, date, date)
}
