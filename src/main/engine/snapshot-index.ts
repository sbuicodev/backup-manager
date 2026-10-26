import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type { FileEntry } from '@shared/types'
import { atomicWriteBuffer } from './fsutil'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const SUFFIX = '.json.gz'

export function indexFileName(sourceId: string, destId: string): string {
  return `${sourceId}__${destId}${SUFFIX}`
}

/** File list of the last successful snapshot of this pair, or null if unknown. */
export async function readSnapshotIndex(
  dir: string,
  sourceId: string,
  destId: string
): Promise<FileEntry[] | null> {
  try {
    const raw = await gunzipAsync(await readFile(join(dir, indexFileName(sourceId, destId))))
    const files = JSON.parse(raw.toString('utf8')) as unknown
    return Array.isArray(files) ? (files as FileEntry[]) : null
  } catch {
    return null
  }
}

export async function writeSnapshotIndex(
  dir: string,
  sourceId: string,
  destId: string,
  files: FileEntry[]
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const data = await gzipAsync(Buffer.from(JSON.stringify(files)))
  await atomicWriteBuffer(join(dir, indexFileName(sourceId, destId)), data)
}

/** Deletes one pair's index (best effort), so a stale list is never used for a diff. */
export async function removeSnapshotIndex(
  dir: string,
  sourceId: string,
  destId: string
): Promise<void> {
  await rm(join(dir, indexFileName(sourceId, destId)), { force: true }).catch(() => {})
}

/** Deletes indexes whose `sourceId__destId` is not in `keep`; returns how many were deleted. */
export async function pruneSnapshotIndexes(dir: string, keep: Set<string>): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const name of names) {
    if (!name.endsWith(SUFFIX) || keep.has(name.slice(0, -SUFFIX.length))) continue
    await rm(join(dir, name), { force: true })
    n++
  }
  return n
}
