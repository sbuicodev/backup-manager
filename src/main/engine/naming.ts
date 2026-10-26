import { PARTIAL_SUFFIX } from './fsutil'

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Local-time timestamp `YYYY-MM-DD_HHmmss`. */
export function formatTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

const SNAPSHOT =
  /^((\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:-\d+)?)(?:\.zip|\.part\d+\.zip(?:\.\d{3,})?)?$/

/**
 * The snapshot a file or folder at the top of `<slug>/` belongs to: `TS`/`TS-N`, optionally
 * followed by `.zip`, `.partN.zip` or `.partN.zip.NNN`. Anything else (incl. partials) → null.
 */
export function snapshotKey(name: string): { key: string; date: Date } | null {
  const m = SNAPSHOT.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(2, 8).map(Number)
  const date = new Date(y, mo - 1, d, h, mi, s)
  if (
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi ||
    date.getSeconds() !== s
  ) {
    return null
  }
  return { key: m[1], date }
}

const FIRST_PART = /\.part1\.zip(?:\.0*1)?$/
const ANY_PART = /\.part\d+\.zip(?:\.\d{3,})?$/

/**
 * Keys of split snapshots (`TS.partN.zip…` at the top of `<slug>/`) whose first part is missing.
 * A split snapshot's first part is moved into place last, so such a set was left by a crash.
 */
export function incompleteSnapshotKeys(names: string[]): Set<string> {
  const split = new Set<string>()
  const complete = new Set<string>()
  for (const n of names) {
    const k = snapshotKey(n)
    if (!k || !ANY_PART.test(n)) continue
    split.add(k.key)
    if (FIRST_PART.test(n)) complete.add(k.key)
  }
  return new Set([...split].filter((k) => !complete.has(k)))
}

/** Date of the snapshot `name` belongs to, or null. */
export function parseSnapshotName(name: string): Date | null {
  return snapshotKey(name)?.date ?? null
}

/** First of `base`, `base-2`, … not used by any existing snapshot file/folder or partial. */
export function uniqueTimestampName(base: string, taken: Set<string>): string {
  const keys = new Set([...taken].flatMap((n) => snapshotKey(n)?.key ?? []))
  const isTaken = (c: string): boolean => keys.has(c) || taken.has(`${c}${PARTIAL_SUFFIX}`)
  if (!isTaken(base)) return base
  for (let n = 2; ; n++) if (!isTaken(`${base}-${n}`)) return `${base}-${n}`
}
