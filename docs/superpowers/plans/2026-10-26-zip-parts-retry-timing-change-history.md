# Zip Parts, Retry Timing and Change History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split oversized zip archives into independent parts (optionally chunking huge files), back off retry checks for missing destinations from 1 to 5 minutes, and record per-file changes for every job, viewable in History and the Run screen.

**Architecture:** A new pure packing module decides part layouts (fresh for snapshots, stable via a v2 manifest for mirrors); the zip writer gains a non-finalizing mode plus a chunk splitter. A streaming gzip `ChangeRecorder` threads through `ExecContext`/`JobRun` so every job records changes without holding them in memory; a snapshot index in userData provides the previous-snapshot baseline. Retry timing is two new state fields evaluated inside the existing 60 s tick.

**Tech Stack:** existing — Electron, React, TypeScript, zod, yazl, vitest; Node built-ins `zlib`, `readline` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-10-26-zip-parts-retry-timing-change-history-design.md` (extends `docs/superpowers/specs/2026-10-25-backup-manager-design.md`). § numbers below refer to the new spec.

## Global Constraints

- No new npm dependencies. Engine and scheduler still never import `electron` (architecture test).
- `config.json` stays `version: 1`; every new config field has a zod `.default(...)` so old files load. `state.json` stays `version: 1` with defaulted new fields.
- Size inputs in the UI use binary units: 1 MB = 1,048,576 bytes, 1 GB = 1,073,741,824 bytes. Minimum limit / chunk size: 1 MiB (1,048,576).
- Part names: `B.zip` (unsplit), `B.partN.zip`, chunks `B.partN.zip.001` (3-digit, 1-based).
- Retry check delay after the k-th miss: `min(60 s × (k + 1), 300 s)`; first check 60 s after marking.
- Change files: `<historyDir>/<runId>.changes.ndjson.gz`; snapshot index: `<userData>/snapshot-index/<sourceId>__<destId>.json.gz`.
- `history.changes` default page 200, max 1000.
- All new output files are written via `.bm-partial` siblings and renamed (existing rule).
- TDD for engine, scheduler, services and pure UI helpers; UI screens verified by CDP screenshots (`BM_USER_DATA` profile, `--remoteDebuggingPort`).

## Review Focus

1. **Limit changed or switched off on an existing split mirror** — the archive is repacked (e.g. parts → `B.zip`), old part files go through the deletion policy, nothing is lost → test in Task 7.
2. **A chunked part rewritten with fewer chunks than before** — stale higher-numbered chunks (`.003` of the old version) must be removed, or reassembly yields a corrupt zip → test in Task 3.
3. **Interruption while splitting a chunked part** — no partial chunk set may look complete; leftovers are `.bm-partial` and swept next run → test in Task 3.
4. **Clock moved backwards with a pending retry** — a `nextRetryAt` more than 300 s in the future is treated as due, so retries never stall → test in Task 9.
5. **Runs recorded before this upgrade** — no change file and no `changeCount`: History must still open them and `history.changes` returns an empty result instead of throwing → test in Task 10.

---

## File Structure

```
src/shared/schema.ts            + zip/destination fields with defaults, effectiveZipSettings()
src/shared/types.ts             + ChangeAction, ChangeEntry, ChangeQuery, ChangePage; JobResult.changeCount;
                                  SchedulerStatus.pendingRetries items gain nextRetryAt
src/shared/ipc.ts               + history.changes, CH.historyChanges
src/main/engine/packaging/parts.ts   NEW pure: partSize, packFresh, packStable, part file names/ownership
src/main/engine/packaging/zip.ts     + writeZip finalize:false, splitIntoChunks
src/main/engine/destination.ts       + readStream(rel, start, end)
src/main/engine/naming.ts            + snapshotKey; uniqueTimestampName understands parts
src/main/engine/retention.ts         groups a snapshot's files by key
src/main/engine/changes.ts           NEW: ChangeRecorder (gzip NDJSON writer), readChanges, changeFileName
src/main/engine/snapshot-index.ts    NEW: read/write/prune snapshot file lists
src/main/engine/job.ts               JobContext.zip + indexDir; ExecContext.record; JobRun.change(); warn() records skipped
src/main/engine/mirror.ts            mirror-copy records changes; mirror-zip rewritten around parts + manifest v2
src/main/engine/snapshot.ts          parts for zip packagings, staging for split zip-whole, index diff
src/main/engine/planner.ts           computes JobContext.zip per pair; passes indexDir
src/main/engine/executor.ts          creates/closes the recorder; changeCount; indexDir option
src/main/engine/history.ts           retention also deletes change files
src/main/scheduler/state.ts          retryAttempts, nextRetryAt
src/main/scheduler/scheduler.ts      retry due-time logic, resume/AC reset, status
src/main/services.ts, handlers.ts    indexDir wiring, prune indexes at start, history:changes handler
src/main/os-helpers.ts               trayStatusLine adds retries
src/renderer/src/components/SizeInput.tsx, ChangeList.tsx   NEW
src/renderer/src/lib/retry.ts        NEW pure: retry text helpers (tested)
src/renderer/src/screens/*           SourceEditor, Destinations, Sources, Run, History, App header
tests/…                              mirrors the above
```

## Shared type additions (Task 1 and Task 5 define them; used everywhere)

```ts
// src/shared/types.ts
export type ChangeAction = 'added' | 'updated' | 'removed' | 'trashed' | 'deleted' | 'skipped'
export type ChangeEntry = {
  sourceId: string; destId: string; action: ChangeAction; path: string
  size?: number; archive?: string; code?: string
}
export type ChangeQuery = {
  sourceId: string; destId: string; actions?: ChangeAction[]; search?: string
  offset?: number; limit?: number
}
export type ChangePage = { total: number; counts: Record<ChangeAction, number>; items: ChangeEntry[] }
// JobResult gains:            changeCount?: number   (absent in logs written before this change)
// SchedulerStatus.pendingRetries: Array<JobRequest & { nextRetryAt: string | null }>
```

```ts
// src/shared/schema.ts (Task 1)
export type EffectiveZip = { limit: number | null; chunk: boolean; chunkSize: number | null }
export function effectiveZipSettings(source: Source, dest: Destination): EffectiveZip
```

---

### Task 1: Config fields and effective zip settings

**Files:**
- Modify: `src/shared/schema.ts`
- Test: `tests/shared/schema.test.ts`

**Interfaces:**
- Produces: `Source.zip.partLimitBytes: number | null` (default `null`), `Source.zip.oversized: 'own-part' | 'chunk'` (default `'own-part'`), `Source.zip.chunkBytes: number | null` (default `null`), `Destination.zipPartLimitBytes: number | null` (default `null`), `Destination.forceChunkOversized: boolean` (default `false`); `MIN_PART_BYTES = 1_048_576`; `EffectiveZip`, `effectiveZipSettings(source, dest)`. `newSource`/`newDestination` include the defaults.

- [ ] **Step 1: Write the failing tests**

```ts
test('a config written before zip limits existed still loads, with defaults', () => {
  const old = defaultConfig() as any
  old.destinations.push({ id: 'd', name: 'D', path: '/d', enabled: true })
  const s = newSource('/a', 'A', []) as any
  s.zip = { level: 6, looseFiles: 'individual' }
  old.sources.push(s)
  const r = validateConfig(old)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.sources[0].zip).toEqual({ level: 6, looseFiles: 'individual', partLimitBytes: null, oversized: 'own-part', chunkBytes: null })
    expect(r.config.destinations[0]).toMatchObject({ zipPartLimitBytes: null, forceChunkOversized: false })
  }
})
test.each([[0], [1024], [1_048_575]])('rejects part limit / chunk size below 1 MiB (%i)', (n) => { /* partLimitBytes = n → error; chunkBytes = n → error; zipPartLimitBytes = n → error */ })
test('effectiveZipSettings', () => {
  const GB = 1024 ** 3
  const src = (p: Partial<Source['zip']>) => ({ ...newSource('/a', 'A', []), zip: { ...newSource('/a','A',[]).zip, ...p } })
  const dst = (p: Partial<Destination>) => ({ ...newDestination('/d', 'D'), ...p })
  expect(effectiveZipSettings(src({}), dst({}))).toEqual({ limit: null, chunk: false, chunkSize: null })
  expect(effectiveZipSettings(src({ partLimitBytes: 2 * GB }), dst({ zipPartLimitBytes: GB }))).toEqual({ limit: GB, chunk: false, chunkSize: GB })
  expect(effectiveZipSettings(src({ partLimitBytes: 2 * GB, oversized: 'chunk', chunkBytes: 3 * GB }), dst({}))).toEqual({ limit: 2 * GB, chunk: true, chunkSize: 2 * GB })
  expect(effectiveZipSettings(src({ partLimitBytes: 2 * GB, chunkBytes: 100 * 1024 ** 2 }), dst({ forceChunkOversized: true }))).toEqual({ limit: 2 * GB, chunk: true, chunkSize: 100 * 1024 ** 2 })
  expect(effectiveZipSettings(src({}), dst({ zipPartLimitBytes: GB, forceChunkOversized: true }))).toEqual({ limit: GB, chunk: true, chunkSize: GB })
})
```
- [ ] **Step 2:** `npx vitest run tests/shared/schema.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement** in `src/shared/schema.ts`: add the fields with `.default(...)` and `.int().min(MIN_PART_BYTES).nullable()`; `effectiveZipSettings` per spec §2.1 (`chunkSize` = `null` when `limit` is `null`, else `min(source.zip.chunkBytes ?? limit, limit)`). `Destination`/`Source` types are `z.infer` of the output (defaults applied), so `newSource`/`newDestination` must set them explicitly.
- [ ] **Step 4:** `npm test` → all PASS; `npm run typecheck` clean (fix any test fixtures that build `Source`/`Destination` literals by spreading `newSource`/`newDestination`).
- [ ] **Step 5: Commit** `feat(shared): zip part limit and chunking settings`.

---

### Task 2: Part packing (pure)

**Files:**
- Create: `src/main/engine/packaging/parts.ts`
- Test: `tests/engine/parts.test.ts`

**Interfaces:**
- Consumes: `FileEntry`, `EffectiveZip`.
- Produces:

```ts
export type PartPlan = { n: number; chunked: boolean; files: FileEntry[] }   // n = 0 → unsplit B.zip
export type ManifestPart = { n: number; chunked: boolean; chunks?: number; fingerprint: string; files: FileEntry[] }
export type ManifestArchive = { limit: number | null; parts: ManifestPart[] }
export function partSize(files: FileEntry[]): number                         // spec §3.2 formula
export function isOversized(f: FileEntry, limit: number): boolean            // partSize([f]) > limit
export function packFresh(files: FileEntry[], zip: EffectiveZip): PartPlan[]
export function packStable(files: FileEntry[], prev: ManifestArchive | undefined, zip: EffectiveZip): PartPlan[]
export function partBaseName(base: string, p: Pick<PartPlan, 'n'>): string  // "B.zip" | "B.partN.zip"
export function chunkName(partFile: string, i: number): string              // "B.part3.zip.001"
export function ownsFile(base: string, name: string): boolean               // B.zip, B.partN.zip, B.partN.zip.NNN
```

`partSize` = `98 + Σ (size + 5·ceil(size/16384) + 6 + 76 + 2·Buffer.byteLength(rel))` (98 = 22 + 20 + 56). `packFresh`: `zip.limit === null` → `[{ n: 0, chunked: false, files }]`; else sort by `rel`, oversized files each get their own part (`chunked: zip.chunk`), the rest fill parts in order starting a new part when the next file doesn't fit; number parts 1..k in path order of their first file; if the result is exactly one non-chunked part (no oversized files) → renumber it `n: 0`. `packStable`: spec §3.3 steps 1–5 (2 s mtime tolerance; merge below `limit/2` into the next non-chunked part by number, keeping the lower number; collapse a single non-chunked part to `n: 0`); `prev` absent or `prev.limit !== zip.limit` → `packFresh`.

- [ ] **Step 1: Write the failing tests** (use `const MB = 1024 ** 2`, `f(rel, size)` helper, `limit` values chosen with `partSize`):

```ts
test('partSize matches the spec formula', () => expect(partSize([f('ab', 100)])).toBe(98 + 100 + 5 + 6 + 76 + 4))
test('no limit → one unsplit part', () => expect(packFresh(files, { limit: null, chunk: false, chunkSize: null })).toEqual([{ n: 0, chunked: false, files }]))
test('everything fits → unsplit B.zip (n 0)', ...)
test('fills parts in path order and never exceeds the limit', () => { for (const p of parts) expect(partSize(p.files)).toBeLessThanOrEqual(limit) ; expect(parts.map(p => p.n)).toEqual([1, 2, 3]) })
test('oversized file gets its own part; chunked only when zip.chunk', ...)   // chunked: false vs true
test('packStable: unchanged files keep their part; new file appends to the last part', ...)
test('packStable: new file that does not fit opens part max(n)+1', ...)
test('packStable: changed file that no longer fits moves out of its part', ...)
test('packStable: removed files leave; a part below half the limit merges into the next', ...) // merged keeps lower n
test('packStable: limit change repacks from scratch', ...)
test('packStable: shrinks to one part → n 0', ...)
test('names', () => {
  expect(partBaseName('B', { n: 0 })).toBe('B.zip'); expect(partBaseName('B', { n: 3 })).toBe('B.part3.zip')
  expect(chunkName('B.part3.zip', 1)).toBe('B.part3.zip.001')
  expect(['B.zip', 'B.part2.zip', 'B.part2.zip.014'].every((n) => ownsFile('B', n))).toBe(true)
  expect(['C.zip', 'B.part.zip', 'B-2.zip', 'B.zip.001'].some((n) => ownsFile('B', n))).toBe(false)
})
```
- [ ] **Step 2:** `npx vitest run tests/engine/parts.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `parts.ts` as specified above.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(engine): zip part packing`.

---

### Task 3: Zip writer: non-finalizing mode and chunk splitting

**Files:**
- Modify: `src/main/engine/packaging/zip.ts`, `src/main/engine/destination.ts`
- Test: `tests/engine/zip.test.ts`, `tests/engine/destination.test.ts`

**Interfaces:**
- Produces:
  - `Destination.readStream(rel: string, start?: number, end?: number): NodeJS.ReadableStream` (inclusive `end`, like `fs.createReadStream`).
  - `writeZip(..., opts & { finalize?: boolean })`: with `finalize: false` the verified archive is left at its `.bm-partial` temp path and the result gains `tempRel: string`; the caller must move or remove it. Default `true` keeps today's behaviour.
  - `splitIntoChunks(dest: Destination, tempRel: string, targetRel: string, chunkSize: number, signal?: AbortSignal): Promise<string[]>` — writes `targetRel.001…` (each through its own `.bm-partial` sibling + rename), then removes existing `targetRel.NNN` files numbered above the new count, then removes `tempRel`; returns the chunk file names (basenames). On any error: removes every chunk it wrote in this call and `tempRel`, rethrows.

- [ ] **Step 1: Failing tests**

```ts
test('readStream reads a byte range', ...)   // 'abcdef', start 2 end 3 → 'cd'
test('finalize:false leaves a verified temp zip and no target', ...)
test('splitIntoChunks: chunks rejoin byte-identically to the zip and extract with yauzl', ...) // 3 MB random file, level 0, chunkSize 1 MiB → .001 .002 .003 (+ .004 for overhead), Buffer.concat equals temp bytes; yauzl on concat yields file
test('splitIntoChunks removes stale higher-numbered chunks from a previous, larger version', ...) // Review Focus 2: pre-create B.part1.zip.004/.005, split into 3 → only .001-.003 remain
test('abort mid-split leaves no chunk files and no temp file', ...)        // Review Focus 3: abort on first chunk written
```
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (chunks via `pipeline(dest.readStream(tempRel, i*size, …), await dest.writeStream(partialSiblingRel(chunkRel)), { signal })`, then `rename`). **Step 4:** run zip + destination tests → PASS.
- [ ] **Step 5: Commit** `feat(engine): non-finalizing zip writes and chunk splitting`.

---

### Task 4: Snapshot names and retention with parts

**Files:**
- Modify: `src/main/engine/naming.ts`, `src/main/engine/retention.ts`
- Test: `tests/engine/naming.test.ts`, `tests/engine/retention.test.ts`

**Interfaces:**
- Produces: `snapshotKey(name: string): { key: string; date: Date } | null` — accepts `TS`, `TS-N` followed by nothing, `.zip`, `.partN.zip` or `.partN.zip.NNN`; `key` is `TS` or `TS-N`. `parseSnapshotName(name)` = `snapshotKey(name)?.date ?? null`. `uniqueTimestampName(base, taken)` treats a candidate as taken when any name in `taken` has that key, or `candidate + PARTIAL_SUFFIX` is in `taken`. `applyRetention` (snapshot mode) groups entries by key, selects keys with `selectSnapshotsToPrune` (fed one `{ name: key, date }` per key) and removes every entry of each pruned key; `pruned` counts snapshots (keys), not files.

- [ ] **Step 1: Failing tests:** `snapshotKey('2026-10-25_165200-2.part3.zip.007')` → key `2026-10-25_165200-2`; rejects `TS.part.zip`, `TS.zip.001`, `TS.bm-partial`; `uniqueTimestampName('T', new Set(['T.part1.zip']))` → `'T-2'` (use a real timestamp for T); retention with snapshot A = `{A.part1.zip, A.part2.zip.001, A.part2.zip.002}` and B = `{B/}` dir, keepMin 1, maxAge 0 → all three A files removed, `pruned: 1`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS (existing naming/retention tests still pass).
- [ ] **Step 5: Commit** `feat(engine): snapshot naming and retention understand parts`.

---

### Task 5: Change recorder and plumbing

**Files:**
- Create: `src/main/engine/changes.ts`
- Modify: `src/shared/types.ts`, `src/main/engine/job.ts`, `src/main/engine/executor.ts`, `src/main/engine/history.ts`, `src/main/engine/mirror.ts` (mirror-copy only)
- Test: `tests/engine/changes.test.ts`, `tests/engine/executor.test.ts`, `tests/engine/history.test.ts`, `tests/engine/mirror.test.ts`

**Interfaces:**
- Produces:
  - Types in "Shared type additions" (`ChangeAction`, `ChangeEntry`, `ChangeQuery`, `ChangePage`, `JobResult.changeCount?`).
  - `changeFileName(runId: string): string` → `` `${runId}.changes.ndjson.gz` ``.
  - `class ChangeRecorder { static async open(historyDir: string, runId: string): Promise<ChangeRecorder>; record(e: ChangeEntry): void; countFor(sourceId: string, destId: string): number; close(): Promise<void> }` — writes NDJSON through `zlib.createGzip()` to a `.bm-partial` file; `close()` ends the stream and renames it to `changeFileName(runId)`, or deletes it when nothing was recorded.
  - `readChanges(historyDir: string, runId: string, q: ChangeQuery): Promise<ChangePage>` — streams `gunzip` + `readline`; missing file → `{ total: 0, counts: all zero, items: [] }`; `counts` per action for the job ignoring `actions`/`search`; `total` after filters; `search` case-insensitive substring of `path`; `limit` clamped to 1..1000, default 200.
  - `ExecContext.record: (e: ChangeEntry) => void` (required; tests pass `() => {}` or a collector).
  - `JobRun.change(action: ChangeAction, path: string, extra?: { size?: number; archive?: string }): void` (fills sourceId/destId). `JobRun.warn(w)` also records `{ action: 'skipped', path: w.path, code: w.code }` when `w.path !== ''`.
  - `runBackup` creates the recorder before planning, passes `record` into every `ExecContext`, sets `result.changeCount = recorder.countFor(...)` for every job result (including failed/cancelled), and `close()`s it before `writeRunLog`.
  - `writeRunLog` retention also removes `changeFileName(id)` for each pruned log.
  - mirror-copy records `added` (copy, with size), `updated` (with size), `trashed`/`deleted` per policy.

- [ ] **Step 1: Failing tests**

```ts
// changes.test.ts
test('recorded entries round-trip through gzip NDJSON with filters, search, paging and counts', ...)
  // 250 entries for (s1,d1): 200 added (paths a/0..), 30 updated, 20 skipped; 5 entries for (s1,d2)
  // readChanges(...,{sourceId:'s1',destId:'d1'}) → total 250, items.length 200, counts {added:200, updated:30, skipped:20, others 0}
  // offset 200 → 50 items; actions ['updated'] → total 30; search 'A/1' (case-insensitive) matches 'a/1…'
test('nothing recorded → no file left behind', ...)
test('missing change file → empty page', ...)
// executor.test.ts
test('a run records changes and sets changeCount per job', ...)       // mirror-copy of 3 files → changeCount 3, readChanges shows 3 'added'
test('a job that fails after copying keeps the changes recorded before it failed', ...) // FailingDest ENOSPC on 3rd file → changeCount 2
// history.test.ts
test('history retention also deletes change files', ...)
// mirror.test.ts
test('mirror-copy records added, updated and trashed', ...)
test('warnings with a path are recorded as skipped', ...)            // symlink → { action:'skipped', path:'link', code:'SYMLINK' }
```
- [ ] **Step 2:** run the four test files → new tests FAIL.
- [ ] **Step 3:** implement; update every `ExecContext` literal in tests/helpers (`exec()` in `tests/helpers/job.ts` gains a `record` collector argument).
- [ ] **Step 4:** `npm test` → all PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(engine): per-file change recording`.

---

### Task 6: Snapshot index

**Files:**
- Create: `src/main/engine/snapshot-index.ts`
- Test: `tests/engine/snapshot-index.test.ts`

**Interfaces:**
- Produces: `indexFileName(sourceId, destId)` → `` `${sourceId}__${destId}.json.gz` ``; `readSnapshotIndex(dir: string, sourceId: string, destId: string): Promise<FileEntry[] | null>` (missing/corrupt → `null`); `writeSnapshotIndex(dir, sourceId, destId, files: FileEntry[]): Promise<void>` (gzip JSON, atomic, creates `dir`); `pruneSnapshotIndexes(dir: string, keep: Set<string> /* "sourceId__destId" */): Promise<number>`.

- [ ] **Step 1: Failing tests:** round trip; corrupt file → `null`; prune keeps only listed pairs and returns the number deleted; missing dir → `null` / `0`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): snapshot file-list index`.

---

### Task 7: Mirror zip with parts and manifest v2

**Files:**
- Modify: `src/main/engine/job.ts` (`JobContext.zip: EffectiveZip`), `src/main/engine/planner.ts` (sets it via `effectiveZipSettings(source, destinationConfig)`), `src/main/engine/mirror.ts` (`prepareMirrorZip`, manifest), `src/main/engine/packaging/targets.ts`
- Test: `tests/engine/mirror.test.ts`, `tests/helpers/job.ts` (`ctxFor` sets `zip` from `effectiveZipSettings(source, newDestination(root,'D'))` unless overridden)

**Interfaces:**
- Consumes: Task 2 (`packStable`, `partBaseName`, `chunkName`, `ownsFile`, `ManifestArchive`), Task 3 (`writeZip` finalize:false, `splitIntoChunks`), Task 5 (`JobRun.change`).
- Produces:
  - `ZipTarget` gains `base: string` (archive base without `.zip`: `<slug>`, child name, `name-2`, `_files`); `name` stays `` `${base}.zip` ``.
  - `type ManifestV2 = { version: 2; archives: Record<string, ManifestArchive> }` stored in `current/.backup-manager.json`; anything else read as `{ version: 2, archives: {} }`.
  - Part fingerprint: `fingerprint(files, level)` for normal parts; for chunked parts additionally suffixed `` `|chunk:${chunkSize}` `` (hash it into the string).

Behaviour (replaces today's per-target logic, keeping its protections):
- Per target: `parts = packStable(target.files, prev.archives[base], ctx.zip)`. A part is written when no previous part with the same `n` has the same `chunked` and fingerprint, or any of its files (`partBaseName`, or chunk names from `prev` part `chunks`) is missing at the destination.
- Non-chunked part → `writeZip(dest, current/<partBaseName>, …)`. Chunked → `writeZip(..., { finalize: false })` then `splitIntoChunks(dest, tempRel, current/<partBaseName>, ctx.zip.chunkSize, signal)`; manifest part records `chunks`.
- Expected names = every file of every part of every (kept or written) archive. Stale = existing files in `current/` that end in `.zip` or `.zip.NNN` and are not expected; protected stale files (unreadable members or empty-looking source — reuse current rules, resolving a name's archive via `ownsFile` against target bases and previous manifest bases) are skipped; the rest follow the deletion policy.
- Kept archives (unreadable members) and the empty-source case copy their previous manifest entry unchanged.
- Changes per archive: compare every file of rewritten parts against `prev` files of the whole archive → `added` / `updated` (size or mtime beyond 2 s) with `archive = partBaseName` (or the first chunk name for chunked parts); previous files absent from the target's new file set → `removed` (archive = their previous part file); a stale archive base (no target any more) → all its previous files `removed`. No entry for files only moved between parts.
- `plan.counts.zip` = parts to write; `unchanged` = parts kept; trash/delete = stale files.

- [ ] **Step 1: Failing tests** (`MB = 1024**2`; build sources with random-content files of known sizes; set `source.zip.partLimitBytes` and pass `ctx.zip` accordingly):

```ts
test('archive within the limit stays B.zip', ...)
test('archive over the limit is written as B.part1.zip, B.part2.zip…, each ≤ limit, together containing every file byte-identically', ...)
test('second run with one changed file rewrites only that file\'s part', ...)          // other parts' mtimes unchanged
test('new file appends to the last part; change list shows it as added in that part', ...)
test('oversized file: own part over the limit (own-part) / chunk files that rejoin (chunk)', ...)
test('limit switched off: parts become B.zip and old part files are trashed', ...)   // Review Focus 1
test('limit lowered: repacked, old names follow the deletion policy, nothing lost', ...) // Review Focus 1
test('a v1 manifest is treated as empty: archives rebuilt once, no data lost', ...)
test('unreadable member keeps every part of that archive unchanged', ...)
test('empty-looking source rewrites and removes nothing with parts', ...)
test('removed source file is recorded as removed with its previous part', ...)
test('files only moved by a merge are not recorded as changes', ...)
```
- [ ] **Step 2:** run → new tests FAIL. **Step 3:** implement. **Step 4:** `npm test` → all PASS (existing mirror-zip tests keep passing with no limit).
- [ ] **Step 5: Commit** `feat(engine): split mirror zips into stable parts`.

---

### Task 8: Snapshots with parts and change diff

**Files:**
- Modify: `src/main/engine/job.ts` (`JobContext.indexDir?: string`), `src/main/engine/planner.ts` (`PlanDeps.indexDir`), `src/main/engine/executor.ts` (`RunOptions.indexDir?: string`, forwarded), `src/main/engine/snapshot.ts`
- Test: `tests/engine/snapshot.test.ts`, `tests/engine/executor.test.ts`

**Interfaces:**
- Consumes: Task 2 `packFresh`, Task 3, Task 4 names, Task 5 `JobRun.change`, Task 6 index functions.
- Behaviour:
  - zip-children: each target packed with `packFresh(target.files, ctx.zip)`; part files written inside `<ts>.bm-partial/` as today, then the dir is renamed.
  - zip-whole: unsplit → today's `<ts>.zip`. Split → all parts (and chunks) are written into staging dir `<slug>/<ts>.bm-partial/`, then each file is renamed to `<slug>/<ts>.partN.zip[.NNN]`, then the staging dir is removed. Any failure before the moves removes the staging dir.
  - Change diff (only when `ctx.indexDir` is set): `prev = readSnapshotIndex(...)`; after the snapshot is finalized: files written (srcFiles minus skipped/failed) vs `prev` → `added` / `updated` / `removed` (`prev === null` → all `added`); `archive` = part file name for zip snapshots; then `writeSnapshotIndex(...)` with the written files. Nothing is recorded or written when the job fails.

- [ ] **Step 1: Failing tests**

```ts
test('zip-whole over the limit → <ts>.part1.zip, <ts>.part2.zip… at the slug top level, no staging left', ...)
test('zip-children: only archives over the limit are split, inside <ts>/', ...)
test('chunked oversized file in a snapshot rejoins byte-identically', ...)
test('failure mid-way through a split zip-whole leaves no <ts>.part* files', ...)
test('first snapshot records every file as added; second records only the diff', ...) // add one, change one, delete one
test('snapshot index is written after success and not after failure', ...)
test('retention prunes all parts and chunks of an old snapshot', ...)                  // end-to-end with runBackup, keepMin 1 maxAge 0
```
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npm test` → all PASS.
- [ ] **Step 5: Commit** `feat(engine): split snapshot zips and record snapshot diffs`.

---

### Task 9: Retry timing

**Files:**
- Modify: `src/shared/types.ts` (`SchedulerStatus.pendingRetries` item type), `src/main/scheduler/state.ts`, `src/main/scheduler/scheduler.ts`
- Test: `tests/scheduler/state.test.ts`, `tests/scheduler/scheduler.test.ts`

**Interfaces:**
- Produces: job state `retryAttempts: number` (default 0), `nextRetryAt: string | null` (default null); exported `RETRY_STEP_MS = 60_000`, `RETRY_MAX_MS = 300_000`, `retryDelayMs(attempts: number): number` = `min(RETRY_STEP_MS × (attempts + 1), RETRY_MAX_MS)`; `status().pendingRetries` items `{ sourceId, destId, nextRetryAt }`.
- Behaviour: spec §4.2. Marking (in `onJobEnd`) when not already pending: `retryAttempts = 0`, `nextRetryAt = now + 60 s`; when already pending: unchanged. In the tick, a pending pair is checked only when `nextRetryAt === null || nextRetryAt ≤ now || nextRetryAt > now + RETRY_MAX_MS` (clock moved back); missing → `retryAttempts += 1`, `nextRetryAt = now + retryDelayMs(retryAttempts)`. `onResume`/`onPowerChange` reset every pending pair to attempts 0 / due now before ticking. Clearing (success, regular slot) also resets both fields.

- [ ] **Step 1: Failing tests** (fake clock harness; destination availability toggled per check):

```ts
test('an old state file without retry fields loads with defaults', ...)
test('missing destination is checked at +1, +2, +3, +4, +5 min after the skip, then every 5 min', ...)
  // record the clock minute of every isDestinationAvailable call → [1, 3, 6, 10, 15, 20, 25]
test('destination back at a check → retry run queued', ...)
test('wake from sleep makes pending retries due now and restarts the sequence', ...)
test('AC power behaves like wake', ...)
test('a retry that fails again continues the sequence instead of restarting', ...)
test('the source\'s next regular slot clears the pending retry and its timing', ...)
test('nextRetryAt far in the future (clock moved back) is treated as due', ...)   // Review Focus 4
test('status exposes nextRetryAt for each pending retry', ...)
```
- [ ] **Step 2:** FAIL. **Step 3:** implement (update existing retry tests whose timing assumptions change: a retry now happens on the first check ≥ 60 s after marking). **Step 4:** `npm test` → all PASS.
- [ ] **Step 5: Commit** `feat(scheduler): back off retry checks from 1 to 5 minutes`.

---

### Task 10: IPC for change history; services wiring

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/services.ts`, `src/main/handlers.ts`, `src/preload/index.ts`
- Test: `tests/main/handlers.test.ts`

**Interfaces:**
- Produces: `CH.historyChanges = 'history:changes'`; `Api.history.changes(runId: string, q: ChangeQuery): Promise<ChangePage>`; handler validates `runId` (string) and `q` with zod (`actions` ⊆ the six actions, `offset ≥ 0`, `1 ≤ limit ≤ 1000`, `search` ≤ 500 chars). `Services.readChanges(runId, q)`; `Services.paths.snapshotIndex` = `<userData>/snapshot-index`, passed as `indexDir` to `runBackup` and `planRun` (via `services.plan`); `services.start()` calls `pruneSnapshotIndexes(indexDir, pairs of the current config)` before starting the scheduler.

- [ ] **Step 1: Failing tests**

```ts
test('history:changes returns the run\'s file changes, filtered and paged', ...)    // run once, then query → 1 'added'
test('history:changes for a run without a change file (older run) returns an empty page', ...) // Review Focus 5: write a RunLog without changeCount via writeRunLog
test('history:changes rejects invalid queries', ...)                                 // limit 5000, actions ['bogus'] → 'invalid arguments'
test('start prunes snapshot indexes of pairs no longer in the config', ...)
test('snapshot runs started through services record a diff against the previous snapshot', ...)
```
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npm test` → all PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(main): history:changes IPC and snapshot index wiring`.

---

### Task 11: UI: zip limit settings

**Files:**
- Create: `src/renderer/src/components/SizeInput.tsx`, `src/renderer/src/lib/size.ts`
- Modify: `src/renderer/src/screens/SourceEditor.tsx`, `src/renderer/src/screens/Destinations.tsx`
- Test: `tests/shared/size.test.ts`

**Interfaces:**
- Produces: `size.ts`: `toBytes(value: number, unit: 'MB' | 'GB'): number`, `fromBytes(bytes: number): { value: number; unit: 'MB' | 'GB' }` (GB when divisible by 1 GiB, else MB, rounding MB to an integer). `SizeInput({ value: number | null, onChange(v: number | null), offLabel: string, defaultBytes: number })`: a switch (off ↔ `null`) plus number input + MB/GB select.
- Source editor (zip packagings): "Split archives larger than" `SizeInput` (default 2 GB when switched on); when on: "Files larger than the limit" select ("Keep whole in their own part" / "Split into raw chunks"); when chunking: "Chunk size" `SizeInput` with off label "Same as limit". Destination dialog: "Limit zip parts to" `SizeInput` (default 4095 MB, hint: "FAT32 drives can't store files of 4 GB or more — use 4095 MB") and switch "Always split oversized files into chunks".

- [ ] **Step 1: Failing tests:** `toBytes(4095,'MB')` = 4_293_918_720; `fromBytes(2*1024**3)` → `{2,'GB'}`; `fromBytes(1536*1024**2)` → `{1536,'MB'}`.
- [ ] **Step 2:** FAIL. **Step 3:** implement helpers, component and screen fields.
- [ ] **Step 4:** tests PASS; typecheck clean; CDP check (dev app, throwaway profile): set a 1 GB limit + chunking on a zip source and a 4095 MB limit on a destination, save, reopen → values persist; `config.json` shows the byte values.
- [ ] **Step 5: Commit** `feat(ui): zip part limit and chunking settings`.

---

### Task 12: UI: skip and retry status everywhere

**Files:**
- Create: `src/renderer/src/lib/retry.ts`
- Modify: `src/main/os-helpers.ts`, `src/renderer/src/App.tsx` (header strip), `src/renderer/src/screens/Run.tsx`, `src/renderer/src/screens/Sources.tsx`, `src/renderer/src/screens/History.tsx`
- Test: `tests/shared/retry.test.ts`, `tests/main/os-helpers.test.ts`

**Interfaces:**
- Produces (`retry.ts`, pure): `retryFor(status: SchedulerStatus | null, sourceId: string, destId: string): { nextRetryAt: string | null } | null`; `waitingText(destName: string, nextRetryAt: string | null, now: Date): string` → `"Waiting for USB drive · next check in 3 min"` (`"next check now"` when due); `headerRetryText(status, config, now): string | null` → first pending retry by `nextRetryAt` with `" +N more"` when several, shown only when it is due before the next scheduled run. `trayStatusLine` appends `" · 1 retry pending"` / `" · N retries pending"` (not while running or paused).
- Screens: per spec §4.3 — last-run card rows ("Skipped — <dest> not available · retrying, next check HH:MM" / "Failed — <dest> disconnected · retrying…"), Waiting card ("next check in N min"), header strip, Sources list line, History detail note "retry pending".

- [ ] **Step 1: Failing tests:** `waitingText('USB drive', +3 min, now)` exact string above; due → `"… · next check now"`; `headerRetryText` null when a scheduled run is sooner, `"Waiting for USB drive · next check in 2 min +1 more"` for two retries; `trayStatusLine(idle with 2 retries)` → `"Idle · next: Documents at 14:00 · 2 retries pending"`.
- [ ] **Step 2:** FAIL. **Step 3:** implement helpers and screens. **Step 4:** tests PASS; CDP check: unplugged destination on a scheduled source → after a scheduled run the Run card, header strip, Sources row and Waiting card show the texts above.
- [ ] **Step 5: Commit** `feat(ui): show skip and retry state`.

---

### Task 13: UI: change lists in History and Run

**Files:**
- Create: `src/renderer/src/components/ChangeList.tsx`
- Modify: `src/renderer/src/screens/History.tsx`, `src/renderer/src/screens/Run.tsx`

**Interfaces:**
- Consumes: `api.history.changes`, `JobResult.changeCount`.
- Produces: `ChangeList({ runId: string, sourceId: string, destId: string })` — loads page 1 on mount; action chips (multi-select, each with its count from `counts`; all selected by default; chips with count 0 hidden); search input debounced 250 ms (resets to page 1); table: action badge, path (monospace, truncated with title), size (`formatBytes`), part; "Load more" appends the next 200 while `items.length < total`. History detail rows and Run "Last run" rows show a chevron when `(changeCount ?? 0) > 0`; clicking toggles a full-width row containing `ChangeList`.

- [ ] **Step 1:** Implement the component and wire both screens.
- [ ] **Step 2: Verify** (CDP, dev app): run a mirror backup of a folder with > 250 files, expand its job in History → 200 rows + "Load more" → 250; filter chip "updated" after changing one file and re-running → 1 row; search narrows; Run screen "Last run" expands the same list; an older run from before this change (no changeCount) shows no chevron and opens without errors.
- [ ] **Step 3:** `npm test` all PASS; typecheck clean.
- [ ] **Step 4: Commit** `feat(ui): per-file change lists in history and run screens`.
