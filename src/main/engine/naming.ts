const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Local-time timestamp `YYYY-MM-DD_HHmmss`. */
export function formatTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

const SNAPSHOT = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:-\d+)?(?:\.zip)?$/

/** Parses `TS`, `TS-N`, `TS.zip`, `TS-N.zip`; anything else (incl. partials) → null. */
export function parseSnapshotName(name: string): Date | null {
  const m = SNAPSHOT.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
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
  return date
}

/** First of `base`, `base-2`, … not taken as a dir, zip or partial of either. */
export function uniqueTimestampName(base: string, taken: Set<string>): string {
  const isTaken = (c: string): boolean =>
    [c, `${c}.zip`, `${c}.partial`, `${c}.zip.partial`].some((n) => taken.has(n))
  if (!isTaken(base)) return base
  for (let n = 2; ; n++) if (!isTaken(`${base}-${n}`)) return `${base}-${n}`
}
