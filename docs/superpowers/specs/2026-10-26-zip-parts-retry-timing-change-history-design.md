# Zip Parts, Retry Timing and Change History — Design

Date: 2026-10-26
Status: Draft, awaiting review
Extends: `docs/superpowers/specs/2026-10-25-backup-manager-design.md` (the "base spec"; § numbers
below without a file name refer to it). Everything in the base spec still applies unless this
document changes it.

## 1. Goals

1. **Zip size limits.** A zip archive larger than a configured size is split into several
   independent zips ("parts") that each open natively on macOS and Windows. Files bigger than the
   limit are either given a part of their own or — optionally — cut into raw chunks.
2. **Retry timing.** Checks for a missing destination back off from 60 s to a 5-minute cap
   instead of running every 60 s, implemented as a shifting due time inside the existing 60 s
   scheduler tick. The skip/retry state is visible in the UI.
3. **Change history.** Every run records the actual per-file changes (added, updated, removed,
   trashed, deleted, skipped) for every job, viewable by expanding a job in History or in the Run
   screen's last-run card.

## 2. Configuration changes

All new fields have defaults, so existing `config.json` files stay valid (`version` stays 1; zod
fills defaults on load and they are written back on the next save).

```ts
type Source = {
  // …existing fields…
  zip: {
    level: number
    looseFiles: 'individual' | 'bundle'
    partLimitBytes: number | null     // NEW, default null = no limit; min 1 MiB
    oversized: 'own-part' | 'chunk'   // NEW, default 'own-part'
    chunkBytes: number | null         // NEW, default null = same as effective limit; min 1 MiB
  }
}

type Destination = {
  // …existing fields…
  zipPartLimitBytes: number | null    // NEW, default null
  forceChunkOversized: boolean        // NEW, default false
}
```

### 2.1 Effective settings for one source × destination job

- `limit` = the smaller of `source.zip.partLimitBytes` and `destination.zipPartLimitBytes`,
  ignoring nulls; `null` when both are null (no splitting).
- `chunk` = `source.zip.oversized === 'chunk' || destination.forceChunkOversized`.
- `chunkSize` = `min(source.zip.chunkBytes ?? limit, limit)`. Only meaningful when `limit` is
  non-null; with no limit nothing is oversized, so chunking never happens.

Because `limit` can differ per destination, zip targets are computed per job (they already are).

### 2.2 UI

- Source editor, Packaging section (zip packagings only): "Split archives larger than" with an
  off switch and a number + unit (MB/GB) input; "Files larger than the limit": "Keep whole in
  their own part" / "Split into raw chunks"; when chunking, "Chunk size" (default "same as
  limit").
- Destination dialog: "Limit zip parts to" (off / number + unit) and "Always split oversized
  files into chunks" switch, with hint text mentioning FAT32's 4 GB file limit.

## 3. Zip parts

### 3.1 Layout

For an archive with base name `B` (`<slug>` for zip-whole, the child name for zip-children,
`_files` for the bundle — exactly as today):

| situation | files written |
|---|---|
| no limit, or the archive fits within `limit` | `B.zip` (unchanged from today) |
| exceeds `limit` | `B.part1.zip`, `B.part2.zip`, … — each a complete zip with a subset of the files |
| a single file larger than `limit`, `chunk` off | that file alone in its own `B.partN.zip`, which exceeds `limit` |
| a single file larger than `limit`, `chunk` on | that file alone in a zip that is byte-split into `B.partN.zip.001`, `.002`, … of `chunkSize` bytes (the last one may be smaller) |

- Part numbers are 1-based and contiguous in snapshot mode; in mirror mode numbers are stable
  once assigned (§3.3), so gaps can appear after merges.
- Chunked files are always placed in their own part number; joining `B.partN.zip.001…` byte-wise
  (`cat`, `copy /b`) yields a normal zip, and 7-Zip opens `.001` directly.
- Entry names inside parts stay relative to the source root (base spec §5), so extracting all
  parts into one folder reconstructs the tree.
- When an archive switches between `B.zip` and split form (it grew past or fell under the limit,
  or the limit changed), the files that are no longer produced are handled by the mirror
  deletion policy (base spec §6.4), like any other stale archive.

### 3.2 Packing budget

Compressed sizes are unknown before writing, so a part's budget is computed from uncompressed
sizes:

```
partSize(files) = 22 + 20 + 56                        (end records incl. zip64, always counted)
                  + Σ over files ( size
                                   + 5 · ceil(size / 16384) + 6   (deflate worst-case expansion)
                                   + 76 + 2 · byteLength(utf8 name) )
```

(76 bytes ≈ local header + central directory record + data descriptor + zip64 extra fields per
entry; the deflate term is zlib's documented worst case for incompressible input.) A file
"fits" a part when `partSize(part ∪ {file}) ≤ limit`; a file is *oversized* when
`partSize({file}) > limit`. A part written under this budget therefore never exceeds `limit`,
even for incompressible data; well-compressing data simply produces smaller parts.

### 3.3 Mirror mode: stable part assignment

The mirror manifest `D/S/current/.backup-manager.json` moves to version 2:

```ts
type ManifestV2 = {
  version: 2
  archives: Record<string /* base name B */, {
    parts: Array<{
      n: number                 // part number (0 when the archive is unsplit: B.zip)
      chunked: boolean          // B.partN.zip.001… instead of B.partN.zip
      fingerprint: string       // as today, over the part's files + level (+ chunkSize when chunked)
      files: Array<{ rel: string; size: number; mtimeMs: number }>
    }>
    limit: number | null        // effective limit the parts were built for
  }>
}
```

A version-1 (or unreadable) manifest is treated as empty: every archive is rebuilt once and the
old files are handled as stale archives.

Assignment for one archive, given its current source files and the previous manifest entry:

1. If `limit` changed (or there is no previous entry), pack from scratch in path order (§3.4).
2. Otherwise start from the previous parts. Remove files no longer in the source. A file whose
   size or mtime changed (2 s tolerance, base spec §6.4) stays in its part if the part still fits
   the budget, else it is removed and treated as new.
3. New files (sorted by path) go into the highest-numbered non-chunked part if they fit, else
   into a new part `max(n)+1`. Oversized files always get a new part of their own (chunked if
   `chunk`).
4. Merge: a non-chunked part whose `partSize` is below `limit / 2` is merged into the next
   non-chunked part (by number) if the result fits; the merged part keeps the lower number.
   Repeat until no merge applies.
5. If the result is a single non-chunked part with no oversized files and the archive fits the
   limit, it is written as unsplit `B.zip` (`n = 0`).
6. A part is (re)written when its fingerprint differs from the previous manifest's part with the
   same number or its file(s) are missing at the destination. All other parts are left untouched.

The protections from base spec §6.5 and the post-review fixes still apply per archive: an
archive with unreadable members is kept as it was (all its parts), and an empty-looking source
never removes or rewrites anything.

### 3.4 Snapshot mode

Snapshots pack from scratch every run: files sorted by path fill part 1, then part 2, …;
oversized files get their own part (chunked if `chunk`) in path order. Layout under the snapshot
follows §3.1 (`<ts>.zip` → `<ts>.part1.zip`… for zip-whole; `<ts>/B.part1.zip`… for
zip-children).

Retention (base spec §6.8) recognises `TS.partN.zip` and `TS.partN.zip.NNN` as belonging to
snapshot `TS` and prunes all of a snapshot's files together.

### 3.5 Verification and atomicity

- Each part is written to its own `.bm-partial` sibling and verified (entry count, size > 0)
  before rename, as today.
- A chunked part is written as one zip to a `.bm-partial` file, verified, then split into chunk
  files (each written to its own `.bm-partial` and renamed); the unsplit temp file is removed.
  If splitting fails, all chunk files of that part are removed.
- In mirror mode, the manifest is written after all parts of all archives, and only records
  parts that were successfully written (failed parts are retried next run, as today).

## 4. Retry timing

### 4.1 State

`state.json` job entries gain (zod defaults keep old files valid):

```ts
retryAttempts: number          // default 0
nextRetryAt: string | null     // ISO; default null = due now
```

### 4.2 Behaviour (replaces base spec §7.4 timing; triggers unchanged)

- When a job is marked `pendingRetry` (base spec §7.4/§7.6 conditions): `retryAttempts = 0`,
  `nextRetryAt = now + 60 s`, unless it was already pending — then attempts and the due time
  continue from where they were (a retry that fails again does not restart the sequence).
- The 60 s scheduler tick is unchanged for everything else. For retries it only checks pairs with
  `pendingRetry && (nextRetryAt === null || nextRetryAt <= now)`:
  - destination available → enqueue a `retry` run (as today); `nextRetryAt` stays as it is.
  - still missing → `retryAttempts += 1`; `nextRetryAt = now + min(60 s × (retryAttempts + 1), 300 s)`.
    Resulting checks: +1, +2, +3, +4, +5 min after the skip, then every 5 min.
- `onResume` and `onPowerChange` set `nextRetryAt = now` and `retryAttempts = 0` for every
  pending retry, then tick.
- Clearing is unchanged: on success, or when the source's next regular slot runs (which also
  resets `retryAttempts`/`nextRetryAt`).

### 4.3 Status and UI

- `SchedulerStatus.pendingRetries` items become `{ sourceId, destId, nextRetryAt: string | null }`.
- Run screen, last-run card: a job skipped or lost with a pending retry shows
  "Skipped — <destination> not available · retrying, next check HH:MM" (or "Failed — … ·
  retrying…" for `destination-lost`). Without a pending retry (manual run, retry disabled) it
  shows the reason only.
- Run screen, Waiting card: each pending retry shows "next check in N min".
- Header strip: when idle and not paused, and a retry is due before the next scheduled run, it
  shows "Waiting for <destination> · next check in N min" (one destination named, "+N more"
  when several).
- Sources list: under the schedule, "Waiting for <destination> (next check HH:MM)" for each
  pending retry of that source.
- Tray status line: appends " · N retries pending" when N > 0.
- History detail: a skipped/lost job notes "retry pending" if the pair is still pending.

## 5. Change history

### 5.1 Change entries

```ts
type ChangeAction = 'added' | 'updated' | 'removed' | 'trashed' | 'deleted' | 'skipped'
type ChangeEntry = {
  sourceId: string
  destId: string
  action: ChangeAction
  path: string          // source-relative posix path
  size?: number         // file size for added/updated
  archive?: string      // part file name for zip changes, e.g. "Photos.part2.zip"
  code?: string         // for skipped: SYMLINK, UNREADABLE, CASE_CONFLICT, errno…
}
```

What each job records:

| job | recorded |
|---|---|
| mirror-copy | `added` (copied), `updated`, `trashed`/`deleted` per deletion policy |
| mirror-zip | per rewritten part: files `added` (new to the archive), `updated` (size/mtime changed), `removed` (gone from the source) — computed from the v2 manifest; files only moved between parts by a merge or limit change are **not** listed |
| snapshot (any packaging) | `added`/`updated`/`removed` compared with the previous successful snapshot of the same source × destination; the first snapshot lists every file as `added` |
| all | `skipped` for every warning that concerns a path (symlink, unreadable, case conflict, per-file errno, kept archive) |

Snapshot comparison data: after each successful snapshot job, its file list (`rel`, `size`,
`mtimeMs`) is saved to `<userData>/snapshot-index/<sourceId>__<destId>.json.gz`. A missing or
unreadable index means "no previous snapshot" (everything `added`). Index files of pairs that
no longer exist in the config are deleted at startup.

### 5.2 Storage

- During a run, change entries are streamed as NDJSON through gzip to
  `<userData>/history/<runId>.changes.ndjson.gz` (written as `.bm-partial` and renamed at run
  end). Memory use is independent of run size.
- `JobResult` gains `changeCount: number` (entries recorded for that job).
- History retention (base spec §6.10, 200 runs) deletes a run's change file with its log.
  `listRuns` ignores `.changes` files.
- A failed or cancelled job keeps the entries recorded before it stopped.

### 5.3 Reading

New IPC call (validated like the others):

```ts
history.changes(runId: string, query: {
  sourceId: string; destId: string
  actions?: ChangeAction[]        // default all
  search?: string                 // case-insensitive substring of path
  offset?: number                 // default 0
  limit?: number                  // default 200, max 1000
}): Promise<{ total: number; counts: Record<ChangeAction, number>; items: ChangeEntry[] }>
```

The main process streams through the gzip file, filtering as it goes; `counts` are per action
for the job (ignoring `actions`/`search`) so the filter chips can show them.

### 5.4 UI

- A shared `ChangeList` component: action filter chips with counts, path search (debounced),
  table (action badge, path, size, part), "Load more" (next 200).
- History detail: each job row gets an expand chevron when `changeCount > 0`; expanding shows
  `ChangeList` beneath the row.
- Run screen, last-run card: same expand control per job row, available once the run ended.
- Live progress during a run is unchanged.

## 6. Testing

- **Packing (pure):** budget formula; fits/overflow boundaries; oversized detection; snapshot
  path-order packing; stable mirror assignment — unchanged files keep parts, new files append,
  changed file that no longer fits moves, removals, merges below half the limit, limit change
  repacks, single part collapses to `B.zip`.
- **Writing (temp dirs):** parts open with yauzl and together contain every file with correct
  content (multi-chunk random data, level 6 and 0); no part exceeds the limit when no file is
  oversized; chunked file reassembles byte-identically and extracts; only changed parts are
  rewritten across runs (mtime check); `B.zip` ↔ split transitions follow the deletion policy;
  unreadable-member and empty-source protections hold with parts; snapshot retention prunes all
  parts and chunks of a snapshot.
- **Effective settings (pure):** source/destination limit, chunk and chunk-size combination.
- **Config:** an old config without the new fields loads with defaults.
- **Retry timing (fake clock):** check schedule 1-2-3-4-5-5 min; available → retry run; resume and
  AC reset; a failing retry continues the sequence; regular slot clears; status exposes
  `nextRetryAt`; old state files load.
- **Change history:** each job type records the expected entries (mirror copy, mirror zip
  across two runs, snapshot vs previous snapshot, first snapshot, skipped); change file is
  gzip NDJSON, survives a failed job, is deleted with its log; `history.changes` filtering,
  search, paging and counts; snapshot index cleanup of removed pairs.
- **UI:** manual checks via CDP screenshots as before (editor fields, retry status texts, change
  list expand/filter/search/load more).
