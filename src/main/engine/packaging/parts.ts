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
/**
 * Per-entry bytes yazl writes besides the data and the two copies of the name: local header,
 * data descriptor, central record, extended-timestamp and zip64 extras (measured, rounded up).
 */
const ENTRY_OVERHEAD = 170

const byRel = (a: FileEntry, b: FileEntry): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)

function entrySize(f: FileEntry): number {
  // Stored bytes + zlib's worst-case deflate expansion + headers/central directory/zip64 extras.
  return f.size + 5 * Math.ceil(f.size / 16384) + 6 + ENTRY_OVERHEAD + 2 * Buffer.byteLength(f.rel)
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

/**
 * Running byte budgets of parts being packed, so adding a file costs O(1) instead of re-summing
 * the part (packing a large library would otherwise be quadratic).
 */
class Budgets {
  private size = new Map<PartPlan, number>()
  private big = new Set<PartPlan>() // parts holding an oversized file
  constructor(private readonly limit: number) {}
  of(p: PartPlan): number {
    let n = this.size.get(p)
    if (n === undefined) {
      n = partSize(p.files)
      this.size.set(p, n)
      if (p.files.some((f) => isOversized(f, this.limit))) this.big.add(p)
    }
    return n
  }
  fits(p: PartPlan, f: FileEntry): boolean {
    return this.of(p) + entrySize(f) <= this.limit
  }
  add(p: PartPlan, f: FileEntry): void {
    this.size.set(p, this.of(p) + entrySize(f))
    p.files.push(f)
    if (isOversized(f, this.limit)) this.big.add(p)
  }
  /** Moves all of `b`'s files into `a`. */
  merge(a: PartPlan, b: PartPlan): void {
    this.size.set(a, this.of(a) + this.of(b) - END_RECORDS)
    a.files.push(...b.files)
    if (this.big.has(b)) this.big.add(a)
  }
  /** A part new files and merges may use: not chunked and without an oversized file. */
  normal(p: PartPlan): boolean {
    this.of(p)
    return !p.chunked && !this.big.has(p)
  }
}

/** Packs files in path order: parts fill up to the limit, oversized files get their own part. */
export function packFresh(files: FileEntry[], zip: EffectiveZip): PartPlan[] {
  const { limit } = zip
  if (limit === null) return unsplit(files)
  const budgets = new Budgets(limit)
  const parts: PartPlan[] = []
  let current: PartPlan | null = null
  for (const f of [...files].sort(byRel)) {
    if (isOversized(f, limit)) {
      parts.push({ n: parts.length + 1, chunked: zip.chunk, files: [f] })
      continue
    }
    if (!current || !budgets.fits(current, f)) {
      current = { n: parts.length + 1, chunked: false, files: [] }
      parts.push(current)
    }
    budgets.add(current, f)
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

  const budgets = new Budgets(limit)
  const current = new Map(files.map((f) => [f.rel, f]))
  const placed = new Set<string>()
  const parts: PartPlan[] = []
  for (const p of [...prev.parts].sort((a, b) => a.n - b.n)) {
    // An unsplit archive may grow into several parts, so it restarts as part 1.
    const part: PartPlan = { n: p.n === 0 ? 1 : p.n, chunked: p.chunked, files: [] }
    if (p.chunked) {
      const f = current.get(p.files[0]?.rel ?? '')
      if (f && zip.chunk && isOversized(f, limit)) {
        budgets.add(part, f)
        placed.add(f.rel)
      }
    } else {
      const changed: FileEntry[] = []
      for (const old of p.files) {
        const f = current.get(old.rel)
        if (!f) continue
        if (isOversized(f, limit)) {
          // An own-part oversized file stays where it is; anything else oversized moves out.
          if (!zip.chunk && p.files.length === 1) {
            budgets.add(part, f)
            placed.add(f.rel)
          }
          continue
        }
        if (unchanged(old, f)) {
          budgets.add(part, f)
          placed.add(f.rel)
        } else {
          changed.push(f)
        }
      }
      for (const f of changed) {
        if (budgets.fits(part, f)) {
          budgets.add(part, f)
          placed.add(f.rel)
        }
      }
    }
    if (part.files.length > 0) parts.push(part)
  }

  let maxN = parts.reduce((m, p) => Math.max(m, p.n), 0)
  // The highest-numbered part new files may join; it only moves forward as parts are added.
  let last = parts.filter((p) => budgets.normal(p)).sort((a, b) => b.n - a.n)[0]
  for (const f of files.filter((x) => !placed.has(x.rel)).sort(byRel)) {
    if (isOversized(f, limit)) {
      parts.push({ n: ++maxN, chunked: zip.chunk, files: [f] })
      continue
    }
    if (!last || !budgets.fits(last, f)) {
      last = { n: ++maxN, chunked: false, files: [] }
      parts.push(last)
    }
    budgets.add(last, f)
  }

  // Merge parts below half the limit into the next mergeable part, keeping the lower number.
  const normal = parts.filter((p) => budgets.normal(p)).sort((a, b) => a.n - b.n)
  for (let i = 0; i < normal.length - 1;) {
    const [a, b] = [normal[i], normal[i + 1]]
    if (budgets.of(a) < limit / 2 && budgets.of(a) + budgets.of(b) - END_RECORDS <= limit) {
      budgets.merge(a, b)
      parts.splice(parts.indexOf(b), 1)
      normal.splice(i + 1, 1)
    } else {
      i++
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
    new RegExp(`^${escapeRe(base)}\\.part\\d+\\.zip(\\.\\d{3,})?$`).test(name)
  )
}
