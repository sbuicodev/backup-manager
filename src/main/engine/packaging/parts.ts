import type { EffectiveZip } from '@shared/schema'
import type { FileEntry } from '@shared/types'

/** n = 0 means the archive is written unsplit as `B.zip`. */
export type PartPlan = { n: number; chunked: boolean; files: FileEntry[] }
export type ManifestPart = {
  n: number
  chunked: boolean
  chunks?: number
  fingerprint: string
  files: FileEntry[]
}
export type ManifestArchive = { limit: number | null; parts: ManifestPart[] }

const MTIME_TOLERANCE_MS = 2000
const END_RECORDS = 22 + 20 + 56

const byRel = (a: FileEntry, b: FileEntry): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)

function entrySize(f: FileEntry): number {
  // Stored bytes + zlib's worst-case deflate expansion + headers/central directory/zip64 extras.
  return f.size + 5 * Math.ceil(f.size / 16384) + 6 + 76 + 2 * Buffer.byteLength(f.rel)
}

/** Upper bound of the zip size for these files (spec §3.2). */
export function partSize(files: FileEntry[]): number {
  return files.reduce((n, f) => n + entrySize(f), END_RECORDS)
}

export function isOversized(f: FileEntry, limit: number): boolean {
  return partSize([f]) > limit
}

const unsplit = (files: FileEntry[]): PartPlan[] => [{ n: 0, chunked: false, files }]

/** A single part that fits needs no part numbers: it becomes `B.zip`. */
function collapse(parts: PartPlan[], limit: number): PartPlan[] {
  if (parts.length === 0) return unsplit([])
  if (parts.length === 1 && !parts[0].chunked && partSize(parts[0].files) <= limit) {
    return unsplit(parts[0].files)
  }
  return parts
}

/** Packs files in path order: parts fill up to the limit, oversized files get their own part. */
export function packFresh(files: FileEntry[], zip: EffectiveZip): PartPlan[] {
  const { limit } = zip
  if (limit === null) return unsplit(files)
  const parts: PartPlan[] = []
  let current: PartPlan | null = null
  for (const f of [...files].sort(byRel)) {
    if (isOversized(f, limit)) {
      parts.push({ n: parts.length + 1, chunked: zip.chunk, files: [f] })
      continue
    }
    if (!current || partSize([...current.files, f]) > limit) {
      current = { n: parts.length + 1, chunked: false, files: [] }
      parts.push(current)
    }
    current.files.push(f)
  }
  return collapse(parts, limit)
}

const unchanged = (a: FileEntry, b: FileEntry): boolean =>
  a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) <= MTIME_TOLERANCE_MS

/**
 * Keeps files in the part they were in last time (spec §3.3) so only parts whose content
 * changed need rewriting; new files go to the last part or a new one; small parts merge.
 */
export function packStable(
  files: FileEntry[],
  prev: ManifestArchive | undefined,
  zip: EffectiveZip
): PartPlan[] {
  const { limit } = zip
  if (!prev || limit === null || prev.limit !== limit) return packFresh(files, zip)

  const current = new Map(files.map((f) => [f.rel, f]))
  const placed = new Set<string>()
  const parts: PartPlan[] = []
  for (const p of [...prev.parts].sort((a, b) => a.n - b.n)) {
    // An unsplit archive may grow into several parts, so it restarts as part 1.
    const part: PartPlan = { n: p.n === 0 ? 1 : p.n, chunked: p.chunked, files: [] }
    if (p.chunked) {
      const f = current.get(p.files[0]?.rel ?? '')
      if (f && zip.chunk && isOversized(f, limit)) {
        part.files.push(f)
        placed.add(f.rel)
      }
    } else {
      const changed: FileEntry[] = []
      for (const old of p.files) {
        const f = current.get(old.rel)
        if (!f || isOversized(f, limit)) continue
        if (unchanged(old, f)) {
          part.files.push(f)
          placed.add(f.rel)
        } else {
          changed.push(f)
        }
      }
      for (const f of changed) {
        if (partSize([...part.files, f]) <= limit) {
          part.files.push(f)
          placed.add(f.rel)
        }
      }
    }
    if (part.files.length > 0) parts.push(part)
  }

  const maxN = (): number => parts.reduce((m, p) => Math.max(m, p.n), 0)
  for (const f of files.filter((x) => !placed.has(x.rel)).sort(byRel)) {
    if (isOversized(f, limit)) {
      parts.push({ n: maxN() + 1, chunked: zip.chunk, files: [f] })
      continue
    }
    const last = parts
      .filter((p) => !p.chunked && !p.files.some((x) => isOversized(x, limit)))
      .sort((a, b) => b.n - a.n)[0]
    if (last && partSize([...last.files, f]) <= limit) last.files.push(f)
    else parts.push({ n: maxN() + 1, chunked: false, files: [f] })
  }

  // Merge parts below half the limit into the next mergeable part, keeping the lower number.
  let merged = true
  while (merged) {
    merged = false
    const normal = parts
      .filter((p) => !p.chunked && !p.files.some((x) => isOversized(x, limit)))
      .sort((a, b) => a.n - b.n)
    for (let i = 0; i < normal.length - 1; i++) {
      const [a, b] = [normal[i], normal[i + 1]]
      if (partSize(a.files) < limit / 2 && partSize([...a.files, ...b.files]) <= limit) {
        a.files.push(...b.files)
        parts.splice(parts.indexOf(b), 1)
        merged = true
        break
      }
    }
  }

  for (const p of parts) p.files.sort(byRel)
  return collapse(
    parts.sort((a, b) => a.n - b.n),
    limit
  )
}

export function partBaseName(base: string, p: Pick<PartPlan, 'n'>): string {
  return p.n === 0 ? `${base}.zip` : `${base}.part${p.n}.zip`
}

export function chunkName(partFile: string, i: number): string {
  return `${partFile}.${String(i).padStart(3, '0')}`
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `name` is one of the files archive `base` can produce (B.zip, B.partN.zip[.NNN]). */
export function ownsFile(base: string, name: string): boolean {
  return (
    name === `${base}.zip` ||
    new RegExp(`^${escapeRe(base)}\\.part\\d+\\.zip(\\.\\d{3})?$`).test(name)
  )
}
