import type { Source } from '@shared/schema'
import type { Destination } from './destination'
import { parseSnapshotName } from './naming'

const DAY = 86_400_000

type Dated = { name: string; date: Date }

const olderThan = (date: Date, days: number, now: Date): boolean =>
  now.getTime() - date.getTime() > days * DAY

export function selectSnapshotsToPrune(
  snaps: Dated[],
  keepMin: number,
  maxAgeDays: number | null,
  now: Date
): string[] {
  if (maxAgeDays === null) return []
  return [...snaps]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(keepMin)
    .filter((s) => olderThan(s.date, maxAgeDays, now))
    .map((s) => s.name)
}

export function selectTrashToPurge(
  entries: Dated[],
  retentionDays: number | null,
  now: Date
): string[] {
  if (retentionDays === null) return []
  return entries.filter((e) => olderThan(e.date, retentionDays, now)).map((e) => e.name)
}

function dated(entries: { name: string }[]): Dated[] {
  return entries.flatMap((e) => {
    const date = parseSnapshotName(e.name)
    return date ? [{ name: e.name, date }] : []
  })
}

/** Prunes snapshots (snapshot mode) or purges expired trash (mirror mode) for one source. */
export async function applyRetention(
  dest: Destination,
  source: Source,
  now: Date
): Promise<{ pruned: number }> {
  const base = source.slug
  const [dir, names] =
    source.mode === 'snapshot'
      ? [
          base,
          selectSnapshotsToPrune(
            dated(await dest.list(base)),
            source.snapshot.keepMin,
            source.snapshot.maxAgeDays,
            now
          )
        ]
      : [
          `${base}/.trash`,
          selectTrashToPurge(
            dated((await dest.list(`${base}/.trash`)).filter((e) => e.isDir)),
            source.mirror.trashRetentionDays,
            now
          )
        ]
  for (const name of names) await dest.remove(`${dir}/${name}`)
  return { pruned: names.length }
}
