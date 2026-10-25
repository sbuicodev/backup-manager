import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, utimes } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FileEntry } from '@shared/types'
import { atomicWriteText, isPartialName, joinRel } from './fsutil'
import { walkTree } from './walk'

export const MANIFEST_NAME = '.backup-manager.json'

export class DestinationUnavailable extends Error {
  constructor(root: string) {
    super(`destination not available: ${root}`)
    this.name = 'DestinationUnavailable'
  }
}

export interface Destination {
  readonly root: string
  isAvailable(): Promise<boolean>
  stat(rel: string): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null>
  list(rel: string): Promise<{ name: string; isDir: boolean }[]>
  walk(rel: string, excludes: string[]): Promise<FileEntry[]>
  mkdirp(rel: string): Promise<void>
  copyFileIn(
    absSrc: string,
    rel: string,
    signal?: AbortSignal,
    onBytes?: (n: number) => void
  ): Promise<{ bytes: number }>
  writeStream(rel: string): Promise<NodeJS.WritableStream>
  rename(fromRel: string, toRel: string): Promise<void>
  remove(rel: string): Promise<void>
  removeEmptyDirs(rel: string): Promise<void>
  removePartials(rel: string): Promise<number>
  readText(rel: string): Promise<string | null>
  writeTextAtomic(rel: string, text: string): Promise<void>
  abs(rel: string): string
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

export class FsDestination implements Destination {
  constructor(readonly root: string) {}

  abs(rel: string): string {
    const r = joinRel(rel)
    return r === '' ? this.root : join(this.root, ...r.split('/'))
  }

  async isAvailable(): Promise<boolean> {
    try {
      return (await stat(this.root)).isDirectory()
    } catch {
      return false
    }
  }

  private async ensureRoot(): Promise<void> {
    if (!(await this.isAvailable())) throw new DestinationUnavailable(this.root)
  }

  async stat(rel: string): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
    try {
      const s = await stat(this.abs(rel))
      return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async list(rel: string): Promise<{ name: string; isDir: boolean }[]> {
    try {
      const entries = await readdir(this.abs(rel), { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }

  async walk(rel: string, excludes: string[]): Promise<FileEntry[]> {
    try {
      const { files } = await walkTree(this.abs(rel), {
        excludes,
        skipNames: (n) => isPartialName(n) || n === MANIFEST_NAME
      })
      return files
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }

  async mkdirp(rel: string): Promise<void> {
    const abs = this.abs(rel)
    await this.ensureRoot()
    await mkdir(abs, { recursive: true })
  }

  async copyFileIn(
    absSrc: string,
    rel: string,
    signal?: AbortSignal,
    onBytes?: (n: number) => void
  ): Promise<{ bytes: number }> {
    const target = this.abs(rel)
    const partial = `${target}.partial`
    const srcStat = await stat(absSrc)
    const parent = posix.dirname(joinRel(rel))
    await this.mkdirp(parent === '.' ? '' : parent)
    let bytes = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        onBytes?.(chunk.length)
        cb(null, chunk)
      }
    })
    try {
      await pipeline(createReadStream(absSrc), counter, createWriteStream(partial), { signal })
      const fh = await open(partial, 'r+')
      try {
        await fh.sync()
      } finally {
        await fh.close()
      }
      const written = (await stat(partial)).size
      if (written !== bytes) {
        throw new Error(`size mismatch for ${rel}: wrote ${written}, read ${bytes}`)
      }
      await utimes(partial, srcStat.atime, srcStat.mtime)
      await rename(partial, target)
      return { bytes }
    } catch (err) {
      await rm(partial, { force: true })
      throw err
    }
  }

  async writeStream(rel: string): Promise<NodeJS.WritableStream> {
    const abs = this.abs(rel)
    await this.ensureRoot()
    await mkdir(dirname(abs), { recursive: true })
    return createWriteStream(abs)
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = this.abs(fromRel)
    const to = this.abs(toRel)
    await this.ensureRoot()
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
  }

  async remove(rel: string): Promise<void> {
    await rm(this.abs(rel), { recursive: true, force: true })
  }

  async removeEmptyDirs(rel: string): Promise<void> {
    const sweep = async (abs: string, isBase: boolean): Promise<boolean> => {
      let entries
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch (err) {
        if (isNotFound(err)) return false
        throw err
      }
      let empty = true
      for (const e of entries) {
        if (e.isDirectory() && (await sweep(join(abs, e.name), false))) continue
        empty = false
      }
      if (empty && !isBase) {
        await rmdir(abs)
        return true
      }
      return false
    }
    await sweep(this.abs(rel), true)
  }

  async removePartials(rel: string): Promise<number> {
    let count = 0
    const sweep = async (abs: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch (err) {
        if (isNotFound(err)) return
        throw err
      }
      for (const e of entries) {
        const child = join(abs, e.name)
        if (isPartialName(e.name)) {
          await rm(child, { recursive: true, force: true })
          count++
        } else if (e.isDirectory()) {
          await sweep(child)
        }
      }
    }
    await sweep(this.abs(rel))
    return count
  }

  async readText(rel: string): Promise<string | null> {
    try {
      return await readFile(this.abs(rel), 'utf8')
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async writeTextAtomic(rel: string, text: string): Promise<void> {
    const abs = this.abs(rel)
    await this.ensureRoot()
    await mkdir(dirname(abs), { recursive: true })
    await atomicWriteText(abs, text)
  }
}
