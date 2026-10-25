# Backup Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-platform Electron desktop app that backs up user-chosen folders to filesystem destinations, per-source mirror/snapshot + copy/zip options, manual and scheduled runs from a tray app.

**Architecture:** A pure-Node engine (`src/main/engine`) plans and executes backups; a pure-Node scheduler (`src/main/scheduler`) owns the run queue, due checks, retries and recovery, with clock/timers/OS signals injected. The Electron main process wires both to IPC, tray, notifications, login item and power events. The React renderer (shadcn/ui) talks to main only through a typed `window.api`.

**Tech Stack:** Electron, electron-vite, React, TypeScript (strict), Tailwind CSS v4, shadcn/ui, zod, yazl 3.x, picomatch, vitest, yauzl (tests only), electron-builder.

**Spec:** `docs/superpowers/specs/2026-10-25-backup-manager-design.md` — read it alongside this plan; section numbers below (§) refer to it.

## Global Constraints

- TypeScript `strict: true` everywhere.
- Runtime deps (main): `zod`, `yazl`, `picomatch` only. UI deps: React, Tailwind, shadcn/ui (+ its peers: `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, Radix packages it pulls in). Dev/test: `vitest`, `yauzl`, `@types/*`, `electron-builder`. Ask before adding anything else. IDs via `crypto.randomUUID()`.
- No state-management library in the renderer.
- `src/main/engine/**` and `src/main/scheduler/**` must not import `electron` (enforced by a test in Task 1).
- BrowserWindow: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Relative paths inside the engine always use `/` separators.
- Timestamp format `YYYY-MM-DD_HHmmss`, local time; collisions get `-2`, `-3`, ….
- Mirror mtime tolerance: 2000 ms. Default global excludes: `[".DS_Store", "Thumbs.db", "desktop.ini"]`. Default zip level 6. Default `keepMin` 10. History keeps the last 200 runs. Scheduler check interval 60 s.
- The engine never creates a destination root directory.
- All file writes that produce backup output go to a `.partial` name and are renamed when complete. `config.json` and `state.json` are written via temp file + rename.
- Engine and scheduler are built test-first; tests use real temp directories (engine) and a fake clock (scheduler). `TZ=Europe/Rome` for all tests.

## Review Focus

1. **Case-only rename at the source** (`Foo.txt` → `foo.txt`) on case-insensitive filesystems (macOS, Windows): the mirror must end up containing `foo.txt`, not lose it. Executor applies removals before copies → test in Task 9.
2. **A file vanishes or changes between plan and copy**: vanished → warning, job `completed-with-warnings`; grown/shrunk → the copy reflects what was read, size verified against bytes actually written, not the walk's size → tests in Tasks 5 and 9.
3. **Destination disappears mid-job** (USB unplugged): job `failed` with reason `destination-lost`, no `.partial` left on a reachable destination, run continues with next job, scheduler marks it for retry → tests in Tasks 12 and 16.
4. **System clock moved backwards** (`lastScheduledAt` in the future): the source must not stay "not due" forever; future `lastScheduledAt` is clamped to now → test in Task 13.
5. **`zip-children` edge cases**: an empty top-level folder produces no archive; a top-level folder named `_files` with `looseFiles: "bundle"` must not collide with the bundle (bundle becomes `_files-2.zip`) → tests in Task 8.

---

## File Structure

```
electron.vite.config.ts        aliases: @shared → src/shared; renderer @ → src/renderer/src; Tailwind plugin
vitest.config.ts               node env, tests/**/*.test.ts, TZ=Europe/Rome, @shared alias
electron-builder.yml
src/shared/
  schema.ts                    zod schemas: Config, Settings, Source, Destination, Schedule; defaults; refinements; slugify; newSource/newDestination
  types.ts                     FileEntry, Plan, JobPlan, JobResult, RunLog, ProgressEvent, RunTrigger, statuses
  ipc.ts                       Api type (window.api), channel names, SchedulerStatus
src/main/
  index.ts                     app lifecycle, window, single instance, close-to-tray, wiring
  services.ts                  createServices(userDataDir, deps) → config store, history, scheduler, handlers
  ipc.ts                       createHandlers(services) (pure) + registerIpc(handlers) (electron)
  tray.ts                      tray icon + menu; trayStatusLine() pure
  os.ts                        login item, linuxAutostartEntry() pure, notifications + shouldNotify() pure, power hooks
  engine/
    fsutil.ts                  atomicWriteText, toPosix, joinRel, isPartialName
    config.ts                  loadConfig, saveConfig, defaultConfig
    walk.ts                    walkTree
    destination.ts             Destination interface, FsDestination
    naming.ts                  formatTimestamp, parseSnapshotName, uniqueTimestampName
    retention.ts               selectSnapshotsToPrune, selectTrashToPurge, applyRetention
    packaging/zip.ts           writeZip, readZipEntryCount
    packaging/targets.ts       computeZipTargets, fingerprint
    mirror.ts                  diffMirror, prepareMirrorCopy, prepareMirrorZip
    snapshot.ts                prepareSnapshot
    errors.ts                  classifyError, JobAbort
    planner.ts                 planRun
    executor.ts                runBackup
    history.ts                 writeRunLog, listRuns, getRun
  scheduler/
    schedule.ts                latestSlot, isDue, nextRunAt
    state.ts                   State schema, loadState, saveState, jobKey
    queue.ts                   RunQueue
    scheduler.ts               Scheduler
src/preload/index.ts           exposes window.api
src/renderer/src/
  main.tsx, App.tsx            shell: sidebar + header strip + screen switch
  lib/api.ts, hooks/*.ts       useConfig, useSchedulerStatus, useRunProgress
  screens/Sources.tsx, SourceEditor.tsx, Destinations.tsx, Run.tsx, History.tsx, Settings.tsx
  components/ui/*              shadcn
tests/
  helpers/fs.ts                makeTree, readTree, tmpDir, setMtime
  architecture.test.ts
  shared/*.test.ts, engine/*.test.ts, scheduler/*.test.ts, main/*.test.ts
docs/smoke-checklist.md
```

## Shared types (defined in Task 2, used everywhere)

```ts
// src/shared/types.ts
export type FileEntry = { rel: string; size: number; mtimeMs: number };   // rel uses '/'
export type SkippedEntry = { rel: string; reason: "symlink" | "unreadable" };
export type JobRequest = { sourceId: string; destId: string };
export type RunTrigger = "manual" | "scheduled" | "catch-up" | "retry" | "recovery";
export type JobStatus = "completed" | "completed-with-warnings" | "failed" | "cancelled" | "skipped";
export type RunStatus = "completed" | "completed-with-warnings" | "failed" | "cancelled";
export type JobReason = "source-missing" | "destination-missing" | "destination-lost"
  | "disk-full" | "error" | "cancelled";
export type JobKind = "mirror-copy" | "mirror-zip" | "snapshot-copy" | "snapshot-zip";
export type PlanCounts = { copy: number; update: number; zip: number; trash: number; delete: number; unchanged: number };
export type JobPlan = {
  sourceId: string; destId: string; kind: JobKind;
  status: "ready" | "skipped"; reason?: "source-missing" | "destination-missing";
  counts: PlanCounts; bytes: number; skippedEntries: SkippedEntry[];
};
export type Plan = { createdAt: string; jobs: JobPlan[] };
export type Counts = { copied: number; updated: number; zipped: number; trashed: number;
  deleted: number; pruned: number; skipped: number };
export type Warning = { path: string; code: string; message: string };
export type JobResult = { sourceId: string; destId: string; status: JobStatus; reason?: JobReason;
  counts: Counts; bytesWritten: number; warnings: Warning[]; error?: string };
export type RunLog = { id: string; trigger: RunTrigger; startedAt: string; endedAt: string;
  status: RunStatus; jobs: JobResult[] };
export type ProgressEvent =
  | { type: "run-start"; runId: string; trigger: RunTrigger; totalJobs: number }
  | { type: "job-start"; runId: string; sourceId: string; destId: string; bytesTotal: number }
  | { type: "file"; runId: string; path: string; bytesDone: number; bytesTotal: number }
  | { type: "warning"; runId: string; warning: Warning }
  | { type: "job-end"; runId: string; result: JobResult }
  | { type: "run-end"; runId: string; log: RunLog };
export type QueuedRun = { id: string; trigger: RunTrigger; jobs: JobRequest[] };
export type SchedulerStatus = {
  active: QueuedRun | null; pending: QueuedRun[]; pausedUntil: string | null;   // ISO or "forever"
  nextRuns: Array<{ sourceId: string; at: string | null }>;                      // null = manual only
  pendingRetries: JobRequest[];
};
```

Run status rule: worst of job statuses with rank `completed`(0) < `completed-with-warnings`(1) = `skipped`(1) < `failed`(2) < `cancelled`(3); `skipped` maps to `completed-with-warnings`. A run with zero jobs is `completed`.

---

### Task 1: Scaffold the Electron app and test harness

**Files:**
- Create: project files from the electron-vite `react-ts` template, `vitest.config.ts`, `tests/architecture.test.ts`
- Modify: `package.json`, `tsconfig*.json`, `electron.vite.config.ts`, `.gitignore`

**Interfaces:**
- Produces: `npm run dev`, `npm run typecheck`, `npm test`; aliases `@shared/*` (all three processes + vitest) and `@/*` (renderer, for shadcn).

- [ ] **Step 1: Generate the template** in the scratch area and move it into the repo root (the repo already has `docs/`, `.git`, `.gitignore`):

```bash
npm create @quick-start/electron@latest bm-tmp -- --template react-ts --skip
```
Move everything except `.git` from `bm-tmp/` into the repo root, merge its `.gitignore` entries into ours, set `"name": "backup-manager"` in `package.json`, `npm install`.

- [ ] **Step 2: Add tooling:** `npm i zod yazl picomatch` and `npm i -D vitest yauzl @types/yazl @types/yauzl @types/picomatch tailwindcss @tailwindcss/vite`. Add `@tailwindcss/vite` to the renderer config, `@import "tailwindcss";` in the renderer's main CSS, then `npx shadcn@latest init` (style default, base color neutral) with `@/*` → `src/renderer/src/*` in `tsconfig.web.json` and the renderer alias.
- [ ] **Step 3: Configure** `@shared` alias in `electron.vite.config.ts` (main, preload, renderer), `tsconfig.node.json`, `tsconfig.web.json`; enable `strict`. Create `vitest.config.ts`: `environment: "node"`, `include: ["tests/**/*.test.ts"]`, `env: { TZ: "Europe/Rome" }`, alias `@shared`. Add `"test": "vitest run"` and `"test:watch": "vitest"` scripts. Create empty `src/shared/` and `src/main/engine/`, `src/main/scheduler/` (with `.gitkeep`).
- [ ] **Step 4: Write the architecture test**

```ts
// tests/architecture.test.ts
test("engine and scheduler never import electron", () => {
  const files = globSync(["src/main/engine/**/*.ts", "src/main/scheduler/**/*.ts"]); // node:fs globSync
  for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/from ["']electron["']|require\(["']electron["']\)/);
});
```
(Use `fs.globSync` from Node ≥ 22; if the Node in use lacks it, walk the dirs with `readdirSync({ recursive: true })`.)

- [ ] **Step 5: Verify:** `npm test` → 1 passed. `npm run typecheck` → no errors. `npm run dev` → the template window opens.
- [ ] **Step 6: Commit** `chore: scaffold electron-vite app with tailwind, shadcn, vitest`.

---

### Task 2: Shared schema and types

**Files:**
- Create: `src/shared/schema.ts`, `src/shared/types.ts` (exact content of "Shared types" above), `tests/shared/schema.test.ts`

**Interfaces:**
- Produces:
  - zod schemas `ConfigSchema`, `SourceSchema`, `DestinationSchema`, `ScheduleSchema`, `SettingsSchema` and inferred types `Config`, `Source`, `Destination`, `Schedule`, `Settings`, `Weekday` — fields exactly as spec §4.
  - `DEFAULT_GLOBAL_EXCLUDES: string[]`
  - `defaultConfig(): Config` — version 1, default excludes, settings `{ launchAtLogin: true, notifications: "problems", skipScheduledOnBattery: false }`, empty lists.
  - `newSource(path: string, name: string, existingSlugs: string[]): Source` — defaults: enabled, `mode: "mirror"`, `packaging: "copy"`, `zip: { level: 6, looseFiles: "individual" }`, `mirror: { deletion: "trash", trashRetentionDays: null }`, `snapshot: { keepMin: 10, maxAgeDays: null }`, `excludes: []`, `useGlobalExcludes: true`, `destinationIds: "all"`, `schedule: null`, `retryWhenAvailable: true`, unique slug.
  - `newDestination(path: string, name: string): Destination`
  - `slugify(name: string, existing: string[]): string`
  - `defaultModeFor(packaging: Source["packaging"]): Source["mode"]` (copy → mirror, zip-* → snapshot)
  - `validateConfig(input: unknown): { ok: true; config: Config } | { ok: false; errors: string[] }` — zod parse + refinements, `errors` as `"<path>: <message>"`.

- [ ] **Step 1: Write the failing tests**

```ts
test("defaultConfig is valid", () => expect(validateConfig(defaultConfig()).ok).toBe(true));
test("slugify strips characters illegal on Windows and dedupes", () => {
  expect(slugify('My: Docs/"2024"?', [])).toBe("My-Docs-2024");
  expect(slugify("Docs", ["Docs"])).toBe("Docs-2");
  expect(slugify("CON", [])).toBe("CON-1");          // Windows reserved name
  expect(slugify("...", [])).toBe("source");         // nothing left → fallback
});
test("rejects duplicate slugs", () => { /* two sources slug "a" */ expect(errorsOf(cfg)).toContainEqual(expect.stringContaining("slug")); });
test("rejects source inside destination and destination inside source", () => {
  // source /x/backups/docs with destination /x/backups → error; source /x with destination /x/out → error
});
test("rejects keepMin < 1, empty weekly days, bad HH:MM, everyHours < 1 or non-integer", ...);
test("rejects destinationIds referencing unknown destination", ...);
test("newSource uses spec defaults", () => {
  const s = newSource("/p", "Docs", []);
  expect(s).toMatchObject({ mode: "mirror", packaging: "copy", zip: { level: 6, looseFiles: "individual" },
    mirror: { deletion: "trash", trashRetentionDays: null }, snapshot: { keepMin: 10, maxAgeDays: null },
    useGlobalExcludes: true, destinationIds: "all", schedule: null, retryWhenAvailable: true, slug: "Docs" });
});
test("defaultModeFor", () => { expect(defaultModeFor("copy")).toBe("mirror"); expect(defaultModeFor("zip-children")).toBe("snapshot"); });
```

- [ ] **Step 2:** `npx vitest run tests/shared` → FAIL (module not found).
- [ ] **Step 3: Implement.** Slug rule: replace runs of `[<>:"/\\|?*\x00-\x1f\s]` with `-`, trim leading/trailing `-` and `.`, empty → `"source"`, Windows reserved names (`CON PRN AUX NUL COM1-9 LPT1-9`, case-insensitive) get `-1`, then dedupe with `-2`, `-3` (case-insensitive compare). Path-nesting check: compare `path.resolve` results case-insensitively on win32/darwin, by prefix with trailing separator. `time` regex `^([01]\d|2[0-3]):[0-5]\d$`.
- [ ] **Step 4:** `npx vitest run tests/shared` → PASS.
- [ ] **Step 5: Commit** `feat(shared): config schema, defaults and shared types`.

---

### Task 3: Config load/save and fs utilities

**Files:**
- Create: `src/main/engine/fsutil.ts`, `src/main/engine/config.ts`, `tests/engine/config.test.ts`

**Interfaces:**
- Produces:
  - `atomicWriteText(file: string, text: string): Promise<void>` — writes `file.tmp-<random>`, fsync, rename.
  - `toPosix(p: string): string`, `joinRel(...parts: string[]): string` (posix join, rejects `..` segments and absolute parts by throwing), `isPartialName(name: string): boolean` (ends with `.partial`).
  - `loadConfig(file: string): Promise<{ ok: true; config: Config; created: boolean } | { ok: false; errors: string[] }>` — missing file → writes and returns `defaultConfig()` with `created: true`; invalid JSON or schema → `ok: false` and file untouched.
  - `saveConfig(file: string, config: Config): Promise<{ ok: true } | { ok: false; errors: string[] }>` — validates first; writes atomically.

- [ ] **Step 1: Failing tests:** `loadConfig` on a missing file creates it with default content; on `"{bad"` returns `ok:false` and the file still reads `"{bad"`; `saveConfig` with an invalid config returns errors and does not change the file; round-trip save→load equals input; `joinRel("a","../b")` throws.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(engine): config persistence with atomic writes`.

---

### Task 4: Directory walk with exclusions

**Files:**
- Create: `src/main/engine/walk.ts`, `tests/helpers/fs.ts`, `tests/engine/walk.test.ts`

**Interfaces:**
- Produces:
  - `walkTree(root: string, opts: { excludes: string[]; signal?: AbortSignal; skipNames?: (name: string) => boolean }): Promise<{ files: FileEntry[]; skipped: SkippedEntry[] }>` — files sorted by `rel`; directories are not entries. `skipNames` lets callers hide `.partial`/manifest names.
  - `buildMatcher(excludes: string[]): (rel: string, isDir: boolean) => boolean` — picomatch with `{ dot: true }`; a pattern without `/` matches the basename at any depth (`matchBase` semantics); a pattern ending in `/` matches directories only.
  - Test helpers: `tmpDir(): Promise<string>` (auto-removed in `afterEach`), `makeTree(root, spec: Record<string, string | { content: string; mtime?: Date }>)`, `readTree(root): Promise<Record<string, string>>` (posix rels → content), `setMtime(file, date)`.

- [ ] **Step 1: Failing tests:**

```ts
test("lists files with posix rel, size, mtime, sorted", ...) // {"b.txt","a/c.txt"} → rels ["a/c.txt","b.txt"]
test("excludes by basename at any depth", ...)    // excludes [".DS_Store"] hides "x/.DS_Store"
test("directory pattern prunes subtree", ...)     // ["node_modules/"] hides "p/node_modules/m/i.js" and does not descend (spy: no readdir of it — assert via a dir with mode 000 inside node_modules not producing an "unreadable" skip)
test("glob with slash is relative to root", ...)  // ["build/*.tmp"] hides "build/x.tmp" but not "src/build/x.tmp"
test("symlinks are skipped and reported", ...)    // skipped [{ rel: "link", reason: "symlink" }]  (skip test on win32)
test("unreadable directory is reported, walk continues", ...) // chmod 000; skipped reason "unreadable" (skip on win32 / root)
```
- [ ] **Step 2:** FAIL. **Step 3:** implement with `fs.promises.opendir`, `lstat`-style dirent checks (`dirent.isSymbolicLink()`), sizes/mtimes from `fs.promises.stat`. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): directory walk with glob exclusions`.

---

### Task 5: Destination abstraction

**Files:**
- Create: `src/main/engine/destination.ts`, `tests/engine/destination.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Destination {
  readonly root: string;
  isAvailable(): Promise<boolean>;                       // root exists and is a directory
  stat(rel: string): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null>;
  list(rel: string): Promise<{ name: string; isDir: boolean }[]>;   // [] if missing
  walk(rel: string, excludes: string[]): Promise<FileEntry[]>;    // rels relative to `rel`; hides *.partial and .backup-manager.json
  mkdirp(rel: string): Promise<void>;                    // never creates root: throws DestinationUnavailable if root missing
  copyFileIn(absSrc: string, rel: string, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<{ bytes: number }>;
  writeStream(rel: string): Promise<NodeJS.WritableStream>;   // raw write to rel (caller picks .partial name)
  rename(fromRel: string, toRel: string): Promise<void>;  // creates parent of toRel
  remove(rel: string): Promise<void>;                     // recursive, missing ok
  removeEmptyDirs(rel: string): Promise<void>;            // bottom-up, keeps `rel` itself
  removePartials(rel: string): Promise<number>;           // recursive delete of *.partial entries; returns count
  readText(rel: string): Promise<string | null>;
  writeTextAtomic(rel: string, text: string): Promise<void>;
  abs(rel: string): string;
}
export class FsDestination implements Destination { constructor(root: string) }
export class DestinationUnavailable extends Error {}
```

`copyFileIn`: stream `absSrc` → `<rel>.partial`, count bytes, fsync, then check the `.partial` size equals bytes streamed (else throw), `utimes` to the source's mtime as stat'ed **when the copy started**, rename over `rel`. On error or abort, remove the `.partial` and rethrow.

- [ ] **Step 1: Failing tests:** `mkdirp` throws `DestinationUnavailable` when the root is missing (root not created afterwards); `copyFileIn` preserves mtime (±1 ms) and content, leaves no `.partial`; aborting mid-copy (abort after first `onBytes` on a 5 MB file) rejects and leaves neither target nor `.partial`; source deleted before `copyFileIn` → rejects with `code === "ENOENT"`; `walk` hides `x.partial` and `.backup-manager.json`; `removeEmptyDirs` removes nested empty dirs but not ones containing files; `joinRel` escape (`"../x"`) throws on every method.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): filesystem destination with atomic copies`.

---

### Task 6: Snapshot naming and retention selection

**Files:**
- Create: `src/main/engine/naming.ts`, `src/main/engine/retention.ts`, `tests/engine/naming.test.ts`, `tests/engine/retention.test.ts`

**Interfaces:**
- Produces:
  - `formatTimestamp(d: Date): string` → `"2026-10-25_165200"` (local time).
  - `parseSnapshotName(name: string): Date | null` — accepts `TS`, `TS-N`, `TS.zip`, `TS-N.zip`; rejects `TS.partial`, `TS.zip.partial`, `current`, `.trash`.
  - `uniqueTimestampName(base: string, taken: Set<string>): string` — a candidate is taken if `c`, `c.zip`, `c.partial` or `c.zip.partial` is in `taken`; tries `base`, `base-2`, ….
  - `selectSnapshotsToPrune(snaps: { name: string; date: Date }[], keepMin: number, maxAgeDays: number | null, now: Date): string[]`
  - `selectTrashToPurge(entries: { name: string; date: Date }[], retentionDays: number | null, now: Date): string[]`
  - `applyRetention(dest: Destination, source: Source, now: Date): Promise<{ pruned: number }>` — snapshot mode: lists `<slug>/`, prunes selected snapshots (dirs or `.zip`); mirror mode: purges `<slug>/.trash/<TS>` entries.

- [ ] **Step 1: Failing tests:**

```ts
test("format/parse round-trip", () => { const d = new Date(2026, 9, 25, 16, 52, 0); expect(parseSnapshotName(formatTimestamp(d) + "-3.zip")).toEqual(d); });
test("uniqueTimestampName skips names taken as dir or zip", () => {
  expect(uniqueTimestampName("T", new Set(["T.zip"]))).toBe("T-2");
});
test("keepMin always kept even if old", () => { // 3 snaps 100 days old, keepMin 2, maxAge 30 → prune only the oldest
});
test("maxAgeDays null prunes nothing", ...);
test("newer than maxAge kept beyond keepMin", ...); // 12 snaps over 5 days, keepMin 10, maxAge 30 → []
test("trash null retention purges nothing; 7 days purges older entries only", ...);
test("applyRetention on disk removes selected snapshot dirs and zips, ignores current/.trash/partials", ...);
```
- [ ] **Step 2:** FAIL. **Step 3:** implement (age test: `now - date > maxAgeDays * 86_400_000`, sort newest first, keep first `keepMin`). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): snapshot naming and retention rules`.

---

### Task 7: Zip writer

**Files:**
- Create: `src/main/engine/packaging/zip.ts`, `tests/engine/zip.test.ts`

**Interfaces:**
- Produces:
  - `type ZipEntry = { absPath: string; name: string; mtimeMs: number }` (`name` posix).
  - `writeZip(dest: Destination, rel: string, entries: ZipEntry[], level: number, opts: { signal?: AbortSignal; onBytes?: (n: number) => void; onEntryError?: (e: ZipEntry, err: NodeJS.ErrnoException) => void }): Promise<{ bytes: number; entryCount: number }>` — writes `<rel>.partial` via `dest.writeStream`, renames to `rel` after verification; removes `.partial` on any failure/abort.
  - `readZipEntryCount(file: string): Promise<number>`

yazl: `zip.addReadStream(stream, name, { mtime: new Date(mtimeMs), compressionLevel: level })` (yazl ≥ 3 supports `compressionLevel`; `0` = store). Open each file's read stream lazily (on the previous entry's end) so thousands of files don't exhaust descriptors; an entry whose file cannot be opened (`ENOENT`, `EACCES`, `EBUSY`, `EPERM`) is skipped via `onEntryError` and not counted. Verification: file size > 0 and `readZipEntryCount` equals entries actually added, else throw.

`readZipEntryCount` algorithm (no yauzl in runtime code): read the last `min(size, 65557)` bytes; scan backwards for EOCD signature `0x06054b50`; entry total = uint16 at EOCD+10. If it is `0xFFFF`, read the ZIP64 EOCD locator (signature `0x07064b50`) at EOCD−20, take the uint64 offset at locator+8, read the ZIP64 EOCD record there (signature `0x06064b50`) and take the uint64 total at +32.

- [ ] **Step 1: Failing tests:** zip of 3 files read back with yauzl has names `["a.txt","d/b.txt","d/e/c.txt"]`, contents equal, mtimes within 2 s; level 0 entries use compression method 0, level 9 method 8; `readZipEntryCount` matches for 0, 3 and 70 000 entries (the last forces ZIP64 — 70 000 `ZipEntry`s that all point at one 1-byte file with names `f0`…`f69999`, level 0; mark this test `{ timeout: 60_000 }`); a missing entry file → `onEntryError` called, archive valid with the remaining entries; abort mid-write → rejects, no `.partial`, no target.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): streaming zip writer with verification`.

---

### Task 8: Zip targets and fingerprints

**Files:**
- Create: `src/main/engine/packaging/targets.ts`, `tests/engine/targets.test.ts`

**Interfaces:**
- Produces:
  - `type ZipTarget = { name: string; files: FileEntry[]; fingerprint: string }` — `name` is the archive file name (`"S.zip"`, `"Photos.zip"`, `"notes.txt.zip"`, `"_files.zip"`); `files` keep `rel` relative to the source root, which is also the entry name inside the archive (so `Photos.zip` contains `Photos/...`).
  - `computeZipTargets(source: Source, files: FileEntry[]): ZipTarget[]` — `zip-whole`: one target `<slug>.zip` with all files (even if empty). `zip-children`: one per top-level dir that has ≥ 1 file; loose top-level files → one target each (`<file>.zip`) or one `_files.zip` when `looseFiles: "bundle"`. Name collisions resolved with `-2`, `-3` before `.zip` (bundle is named last).
  - `fingerprint(files: FileEntry[], level: number): string` — sha256 hex of `"level:" + level + "\n" + files.sort(by rel).map(f => `${f.rel}|${f.size}|${Math.floor(f.mtimeMs)}`).join("\n")`.

- [ ] **Step 1: Failing tests:** whole; children individual; children bundle; **empty top-level dir → no target** (Review Focus 5); **dir `_files` + bundle → targets `_files.zip` (the dir) and `_files-2.zip` (the bundle)** (Review Focus 5); fingerprint changes when size, mtime or level changes and is order-independent.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): zip target layout and fingerprints`.

---

### Task 9: Mirror jobs (copy and zip)

**Files:**
- Create: `src/main/engine/errors.ts`, `src/main/engine/mirror.ts`, `tests/engine/mirror.test.ts`

**Interfaces:**
- Consumes: `walkTree`, `Destination`, `computeZipTargets`, `fingerprint`, `writeZip`, `formatTimestamp`.
- Produces:
  - `errors.ts`: `class JobAbort extends Error { reason: JobReason }`; `classifyError(err: unknown, dest: Destination): Promise<"file" | JobReason>` — `ENOSPC`/`EDQUOT` → `"disk-full"`; `EROFS` or `!(await dest.isAvailable())` → `"destination-lost"`; `AbortError` → `"cancelled"`; `ENOENT`/`EACCES`/`EPERM`/`EBUSY`/`ELOOP` on a source path → `"file"`; anything else → `"error"`.
  - Shared job interfaces (export from `mirror.ts`, reused by `snapshot.ts`):

```ts
export type JobContext = { source: Source; destId: string; dest: Destination; globalExcludes: string[];
  srcFiles: FileEntry[]; srcSkipped: SkippedEntry[]; now: Date };
export type ExecContext = { runId: string; signal: AbortSignal; emit: (e: ProgressEvent) => void };
export type PreparedJob = { plan: JobPlan; execute(x: ExecContext): Promise<JobResult> };
```
  - `diffMirror(src: FileEntry[], dst: FileEntry[]): { copy: FileEntry[]; update: FileEntry[]; remove: string[]; unchanged: number }` — update if size differs or `|mtime diff| > 2000`.
  - `prepareMirrorCopy(ctx: JobContext): Promise<PreparedJob>`; `prepareMirrorZip(ctx: JobContext): Promise<PreparedJob>`.

Mirror-copy execute order: `removePartials("<slug>")` → `mkdirp("<slug>/current")` → **removals first** (per `deletion`: `trash` → `rename` to `<slug>/.trash/<formatTimestamp(now)>/<rel>`, `exact` → `remove`, `never` → none) → copies/updates via `copyFileIn` (emit `file` events with cumulative bytes) → `removeEmptyDirs("<slug>/current")` unless `never`. Per-file errors classified `"file"` become warnings (`code` = errno code); any other class throws `JobAbort`. The destination side of the diff is `dest.walk("<slug>/current", effectiveExcludes)`, so excluded paths at the destination are never touched.

Mirror-zip execute: targets from `computeZipTargets`; manifest at `<slug>/current/.backup-manager.json` = `{ version: 1, archives: Record<string, string> }` (name → fingerprint; unreadable/invalid manifest = empty). Write a target when fingerprint differs or file missing. Archives listed in `<slug>/current/` (`*.zip`) not among targets follow `deletion` (trash path `<slug>/.trash/<TS>/<name>`). Manifest written atomically at the end with only the current targets.

Result status: `completed` if no warnings, else `completed-with-warnings`; `counts.skipped` = warnings + `srcSkipped.length` (skipped entries also become warnings with code `"SYMLINK"`/`"UNREADABLE"`).

- [ ] **Step 1: Failing tests** (real temp dirs, `FsDestination`, `ctx.now` fixed):

```ts
test("diffMirror: new, changed size, mtime within 2s unchanged, mtime 3s differs, removed", ...);
test("mirror-copy first run copies all files with mtimes, plan counts match", ...);
test("second run with no changes copies nothing", ...);              // counts.copied === 0
test("trash policy moves deleted files under .trash/<TS>/ keeping rel path", ...);
test("exact policy deletes; never policy keeps; empty dirs removed except never", ...);
test("excluded file at destination is left untouched", ...);       // dest has current/x.tmp, excludes ["*.tmp"]
test("case-only rename keeps the renamed file", ...);               // Review Focus 1: src Foo.txt → foo.txt; readTree(current) has "foo.txt" with content
test("source file deleted between prepare and execute → warning, completed-with-warnings", ...); // Review Focus 2
test("source file grown between prepare and execute → destination has the full new content", ...); // Review Focus 2
test("stale .partial from a crash is removed at job start", ...);
test("mirror-zip writes only archives whose fingerprint changed", ...); // zip-children, change one child → only that zip's mtime changes
test("mirror-zip removed child follows deletion policy and manifest is updated", ...);
test("disk full is fatal: JobAbort reason disk-full", ...);          // inject: dest wrapper whose copyFileIn throws {code:"ENOSPC"}
```
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): mirror jobs for copy and zip packaging`.

---

### Task 10: Snapshot jobs

**Files:**
- Create: `src/main/engine/snapshot.ts`, `tests/engine/snapshot.test.ts`

**Interfaces:**
- Consumes: `JobContext`, `ExecContext`, `PreparedJob`, `JobAbort`, `classifyError` (Task 9), `writeZip`, `computeZipTargets`, `uniqueTimestampName`, `formatTimestamp`.
- Produces: `prepareSnapshot(ctx: JobContext): Promise<PreparedJob>` handling `snapshot-copy` and `snapshot-zip` (whole and children).

Execute: `removePartials("<slug>")` → `name = uniqueTimestampName(formatTimestamp(now), names in <slug>/)` → copy: files into `<slug>/<name>.partial/<rel>`, then `rename` to `<slug>/<name>`; zip-whole: `writeZip` to `<slug>/<name>.zip`; zip-children: each target into `<slug>/<name>.partial/<target.name>`, then rename dir. On `JobAbort` or abort, `remove` the `.partial` dir before rethrowing. Plan counts: `copy` = files (copy) or `zip` = targets; `bytes` = sum of file sizes.

- [ ] **Step 1: Failing tests:** each of the three layouts matches spec §5 table paths; two runs in the same second → second named `TS-2`; failure mid-copy (dest wrapper throwing `ENOSPC` on 2nd file) → `JobAbort("disk-full")`, no `<name>` and no `<name>.partial` remain; abort mid-run → same cleanup with reason `cancelled`; per-file vanish → warning and snapshot still finalized.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): snapshot jobs with atomic finalize`.

---

### Task 11: Planner

**Files:**
- Create: `src/main/engine/planner.ts`, `tests/engine/planner.test.ts`

**Interfaces:**
- Consumes: `prepareMirrorCopy`, `prepareMirrorZip`, `prepareSnapshot`, `walkTree`, `FsDestination`.
- Produces:
  - `type RunRequest = { sourceIds?: string[] } | { jobs: JobRequest[] }`
  - `planRun(config: Config, request: RunRequest, deps?: { now?: () => Date; makeDestination?: (root: string) => Destination; signal?: AbortSignal }): Promise<{ plan: Plan; prepared: Array<{ plan: JobPlan; execute?: PreparedJob["execute"] }> }>`

Rules: selects enabled sources (by `sourceIds` if given) × their enabled destinations (`"all"` = every enabled destination), or exactly `jobs` (ignoring entries whose source/destination no longer exist or are disabled). Order: config source order, then destination order. Source missing/unreadable → every job of it `skipped`/`source-missing` (walk once per source, reused across its destinations). Destination `!isAvailable()` → `skipped`/`destination-missing`. Effective excludes = `source.excludes` + (`useGlobalExcludes` ? `globalExcludes` : []). Kind = `` `${mode}-${packaging === "copy" ? "copy" : "zip"}` ``.

- [ ] **Step 1: Failing tests:** 2 sources × 2 destinations (one with `destinationIds: [d1]`) → 3 jobs in order; disabled source/destination excluded; missing source → skipped jobs with reason, walk not attempted for destinations; missing destination root → skipped and root **not created**; `{ jobs }` request returns exactly those pairs; plan for unchanged mirror has `counts.unchanged === n` and `bytes === 0`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): run planner`.

---

### Task 12: Executor and run history

**Files:**
- Create: `src/main/engine/executor.ts`, `src/main/engine/history.ts`, `tests/engine/executor.test.ts`, `tests/engine/history.test.ts`

**Interfaces:**
- Consumes: `planRun`, `applyRetention`, `JobAbort`.
- Produces:
  - `runBackup(config: Config, request: RunRequest, opts: { runId: string; trigger: RunTrigger; signal: AbortSignal; emit: (e: ProgressEvent) => void; historyDir: string; now?: () => Date; makeDestination?: (root: string) => Destination }): Promise<RunLog>`
  - `writeRunLog(dir: string, log: RunLog): Promise<void>` (file `<log.id>.json`, then deletes oldest beyond 200), `listRuns(dir: string): Promise<Array<Omit<RunLog, "jobs"> & { jobCount: number }>>` (newest first), `getRun(dir: string, id: string): Promise<RunLog | null>`.
  - `newRunId(now: Date, existing: Set<string>): string` (= `uniqueTimestampName(formatTimestamp(now), existing)`), exported from `history.ts`.

Flow: emit `run-start` → `planRun` → for each prepared job, sequentially: skipped → `JobResult` `skipped` with reason (also emitted as a `warning`); else `job-start`, `execute`; on `JobAbort` → `failed` (or `cancelled`) with reason, and if cancelled, every remaining job gets `cancelled` without running; on success → `applyRetention` (adds `counts.pruned`; a retention error becomes a warning). Emit `job-end` after each. Compute run status (rule in "Shared types"), `writeRunLog`, emit `run-end`, return the log.

- [ ] **Step 1: Failing tests:**

```ts
test("runs jobs sequentially and writes a history log", ...);   // listRuns length 1, status completed
test("skipped destination → run completed-with-warnings, other jobs still run", ...);
test("destination removed mid-job → failed destination-lost, next job runs, no partial left", ...); // Review Focus 3: emit hook deletes dest root on first "file" event of job 1
test("cancel during job 1 → job 1 cancelled, job 2 cancelled without running, run cancelled", ...);
test("retention runs only after success", ...);                 // keepMin 1, maxAge 0: after 2 successful runs only 1 snapshot; failed run prunes nothing
test("history keeps the last 200 logs", ...);                   // write 205 → 200 files, oldest gone
test("getRun returns null for unknown id", ...);
```
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. Run the whole suite: `npm test` → all PASS.
- [ ] **Step 5: Commit** `feat(engine): run executor and history`.

---

### Task 13: Schedule computation

**Files:**
- Create: `src/main/scheduler/schedule.ts`, `tests/scheduler/schedule.test.ts`

**Interfaces:**
- Produces:
  - `latestSlot(schedule: Exclude<Schedule, { kind: "interval" }>, now: Date): Date` — most recent slot ≤ now (looks back up to 7 days for weekly).
  - `isDue(schedule: Schedule, lastScheduledAt: Date, now: Date): { due: boolean; slot: Date; late: boolean }` — `lastScheduledAt` greater than `now` is treated as `now` (clamp). Interval: due if `now ≥ last + everyHours h`, `slot = now`, `late = now − (last + h) > 120 s`. Daily/weekly: `slot = latestSlot`, due if `slot > last`, `late = now − slot > 120 s`.
  - `nextRunAt(schedule: Schedule, lastScheduledAt: Date, now: Date): Date` — `now` if currently due; else interval `last + h`, daily/weekly the first slot after `max(last, now)`.

Slots are built with `new Date(y, m, d, hh, mm)` in local time (DST handled by the JS engine: a non-existent 02:30 becomes 03:30).

- [ ] **Step 1: Failing tests** (`TZ=Europe/Rome` from vitest config):

```ts
test("interval due after N hours, not before", ...);
test("daily: before today's time → yesterday's slot; after → today's", ...);
test("weekly on mon,thu at 09:00 from a Sunday → previous Thursday", ...);
test("missed several daily slots → due once; after setting last=slot, not due", ...);
test("late flag: slot 3 minutes ago → late true; 30 s ago → false", ...);
test("spring forward 2026-03-29 daily 02:30 → slot at 03:30 local that day", ...);
test("fall back 2026-10-25 daily 02:30 → after running at first 02:30, not due at second 02:30", ...);
test("clock moved backwards: lastScheduledAt tomorrow → treated as now, due again at next slot", ...); // Review Focus 4
test("nextRunAt for each kind", ...);
```
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(scheduler): schedule slot computation`.

---

### Task 14: Scheduler state persistence

**Files:**
- Create: `src/main/scheduler/state.ts`, `tests/scheduler/state.test.ts`

**Interfaces:**
- Produces:
  - `StateSchema` (zod) / `type State` exactly as spec §7.1; `pausedUntil: string | "forever" | null`.
  - `jobKey(j: JobRequest): string` → `` `${sourceId}:${destId}` ``; `parseJobKey(k: string): JobRequest`.
  - `emptyState(): State`
  - `loadState(file: string, config: Config): Promise<State>` — missing or invalid → `emptyState()`; drops jobs/sources whose ids are not in config; drops `activeRun.jobs` entries likewise.
  - `saveState(file: string, s: State): Promise<void>` (atomic).

- [ ] **Step 1: Failing tests:** round trip; invalid JSON → empty state (and the bad file is renamed to `state.json.bad` so it isn't lost); unknown source/destination ids dropped.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(scheduler): persistent scheduler state`.

---

### Task 15: Run queue

**Files:**
- Create: `src/main/scheduler/queue.ts`, `tests/scheduler/queue.test.ts`

**Interfaces:**
- Produces:

```ts
// QueuedRun comes from @shared/types
export type Runner = (run: QueuedRun, signal: AbortSignal) => Promise<void>;
export class RunQueue {
  constructor(runner: Runner, newId: () => string);
  enqueue(jobs: JobRequest[], trigger: RunTrigger): QueuedRun | null; // drops jobs already in a *pending* run; null if none left
  cancelActive(): void;              // aborts the active run's signal; pending runs stay
  get active(): QueuedRun | null;
  get pending(): readonly QueuedRun[];
  onChange(cb: () => void): () => void;
  whenIdle(): Promise<void>;
}
```
Runs execute strictly one at a time in FIFO order; a runner rejection is caught (logged via `console.error`) and the queue continues.

- [ ] **Step 1: Failing tests:** two enqueues run sequentially (runner B starts only after A resolves); enqueuing a job already pending is dropped, while one that is only in the active run is accepted; `cancelActive` aborts the signal and the next pending run still starts; runner throwing doesn't stop the queue; `onChange` fires on enqueue/start/finish.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(scheduler): sequential run queue`.

---

### Task 16: Scheduler

**Files:**
- Create: `src/main/scheduler/scheduler.ts`, `tests/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `isDue`, `nextRunAt`, `State`/`loadState`/`saveState`/`jobKey`, `RunQueue`, `QueuedRun`.
- Produces:

```ts
export type SchedulerDeps = {
  now(): Date;
  setInterval(fn: () => void, ms: number): () => void;     // returns a canceller
  getConfig(): Config;
  stateFile: string;
  isOnBattery(): boolean;
  isDestinationAvailable(destId: string): Promise<boolean>;
  execute(run: QueuedRun, signal: AbortSignal, onJobEnd: (r: JobResult) => void): Promise<RunLog>;
  onRunFinished?(log: RunLog): void;                         // used by main for notifications
  newRunId(): string;
};
// SchedulerStatus comes from @shared/types
export class Scheduler {
  constructor(deps: SchedulerDeps);
  start(): Promise<void>;          // load state, recovery, tick, setInterval(tick, 60_000)
  stop(): void;
  tick(): Promise<void>;
  onResume(): Promise<void>;       // = tick
  onPowerChange(): Promise<void>;  // = tick (AC plugged in)
  runNow(sourceIds?: string[]): QueuedRun | null;   // trigger "manual"
  cancel(): void;
  pause(until: Date | "forever"): Promise<void>;
  resume(): Promise<void>;
  status(): SchedulerStatus;
  onChange(cb: () => void): () => void;
}
```

Behaviour (spec §7.3–7.6):
- `tick`: if paused and `pausedUntil` not passed → return; if passed → clear it. For each enabled source with a schedule: if no `lastScheduledAt`, set it to `now` (first slot is the *next* one, not immediately). If `isDue` and not (`settings.skipScheduledOnBattery && isOnBattery()`): collect its enabled destination jobs, set `lastScheduledAt = slot`, clear their `pendingRetry`. Enqueue all collected as **one** run with trigger `"catch-up"` if every due source was `late`, else `"scheduled"`. Then retries: jobs with `pendingRetry` whose destination is available (same battery rule) → one run `"retry"`. Save state.
- Runner (given to `RunQueue`): set `state.activeRun = { runId, jobs }` and save; call `deps.execute`; on each `onJobEnd` update `lastAttemptAt`, `lastSuccessAt` (on `completed`/`completed-with-warnings`), set `pendingRetry = true` when reason is `destination-missing` or `destination-lost` and the run's trigger is not `"manual"` and the source has `retryWhenAvailable`, clear it on success; remove the job from `activeRun.jobs`; save. After the run: `activeRun = null`, save, `onRunFinished(log)`.
- `start` recovery: if loaded `activeRun` is non-null and has jobs → enqueue them with trigger `"recovery"` before the first tick; then `activeRun = null`.
- `pause` writes `pausedUntil` (ISO or `"forever"`); `resume` clears it and ticks.
- `runNow(sourceIds?)` expands to jobs: each enabled source (all, or those listed) × its enabled destinations (`"all"` = every enabled destination); pausing does not block manual runs.
- `deps.newRunId` is passed to `RunQueue`; the queued run id is also the `RunLog.id` (main passes it to `runBackup` as `runId`).

- [ ] **Step 1: Failing tests** (fake clock object; `setInterval` captured and invoked manually; `execute` is a fake returning canned `JobResult`s; temp `stateFile`):

```ts
test("new schedule does not run immediately; runs at next slot", ...);
test("due sources at the same tick are grouped into one scheduled run", ...);
test("missed slots while off → one catch-up run on start", ...);
test("paused: no runs; after pausedUntil passes, catch-up runs once", ...);
test("battery deferral keeps the source due until on AC", ...);   // onPowerChange triggers it
test("scheduled job skipped for destination-missing → pendingRetry; retried when destination becomes available", ...);
test("destination-lost during scheduled run → pendingRetry", ...); // Review Focus 3
test("manual run skipped for destination-missing does not set pendingRetry", ...);
test("retryWhenAvailable false → no retry", ...);
test("leftover activeRun on start → unfinished jobs re-enqueued as recovery", ...);
test("job finished before crash is not re-run on recovery", ...); // onJobEnd removed it from activeRun
test("status reports nextRuns, pending retries and pause", ...);
```
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. `npm test` → all PASS.
- [ ] **Step 5: Commit** `feat(scheduler): due checks, catch-up, retries and recovery`.

---

### Task 17: IPC contract, handlers and preload

**Files:**
- Create: `src/shared/ipc.ts`, `src/main/services.ts`, `src/main/ipc.ts`, `tests/main/handlers.test.ts`
- Modify: `src/preload/index.ts`, `src/preload/index.d.ts` (template's `window` typing)

**Interfaces:**
- Consumes: `loadConfig`, `saveConfig`, `planRun`, `runBackup`, `listRuns`, `getRun`, `newRunId`, `Scheduler`.
- Produces:
  - `src/shared/ipc.ts`: `type ConfigState = { ok: true; config: Config; path: string } | { ok: false; errors: string[]; path: string }`, and

```ts
export type Api = {
  config: { get(): Promise<ConfigState>; save(c: Config): Promise<{ ok: true } | { ok: false; errors: string[] }>;
            export(): Promise<boolean>; import(): Promise<{ ok: true } | { ok: false; errors: string[] } | null>; reset(): Promise<void> };
  dialog: { pickFolder(): Promise<string | null> };
  destinations: { availability(): Promise<Record<string, boolean>> };
  run: { plan(sourceIds?: string[]): Promise<Plan>; start(sourceIds?: string[]): Promise<string | null>;
         cancel(): Promise<void>; onProgress(cb: (e: ProgressEvent) => void): () => void };
  scheduler: { status(): Promise<SchedulerStatus>; pause(until: string | "forever"): Promise<void>;
               resume(): Promise<void>; onStatus(cb: (s: SchedulerStatus) => void): () => void };
  history: { list(): Promise<Awaited<ReturnType<typeof listRuns>>>; get(id: string): Promise<RunLog | null> };
  app: { onNavigate(cb: (screen: Screen, arg?: string) => void): () => void };
};
export type Screen = "sources" | "destinations" | "run" | "history" | "settings";
export const CH = { /* one string constant per method/event, e.g. configGet: "config:get", progress: "run:progress" */ } as const;
```
  - `services.ts`: `createServices(opts: { userDataDir: string; platform: { now(): Date; setInterval: SchedulerDeps["setInterval"]; isOnBattery(): boolean }; broadcast: (channel: string, payload: unknown) => void; onRunFinished: (log: RunLog) => void }): Promise<Services>` — owns `config.json`, `state.json`, `history/` paths in `userDataDir`; keeps current config in memory; builds the `Scheduler` with `newRunId = () => newRunId(now(), ids already in history + ids issued this session)` and whose `execute` calls `runBackup(config, { jobs: run.jobs }, { runId: run.id, trigger: run.trigger, … })` with `emit` → `broadcast(CH.progress, e)` and forwards `job-end` to `onJobEnd`; scheduler `onChange` → `broadcast(CH.status, status())`.
  - `ipc.ts`: `createHandlers(services: Services, dialogs: { pickFolder(): Promise<string | null>; saveFile(defaultName: string): Promise<string | null>; openFile(): Promise<string | null> }): Record<string, (...args: unknown[]) => Promise<unknown>>` (pure, every argument zod-validated, invalid → throws `Error("invalid arguments")`) and `registerIpc(handlers)` (calls `ipcMain.handle` for each).
  - Preload: `contextBridge.exposeInMainWorld("api", api)` implementing `Api` with `ipcRenderer.invoke` / `on` + unsubscribe.

- [ ] **Step 1: Failing tests** (`createServices` with a temp `userDataDir` and fake platform; `createHandlers` with fake dialogs): `config:save` with an invalid config → `{ ok:false }` and file unchanged; `run:plan` with `sourceIds: [123]` → throws `invalid arguments`; `run:start` enqueues and resolves to a run id, progress events broadcast on `run:progress`; `config:import` of a valid file replaces config, of an invalid file returns errors and keeps the current config; `scheduler:pause` with `"forever"` shows in `status()`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. `npm run typecheck` → no errors.
- [ ] **Step 5: Commit** `feat(main): typed IPC contract, services and preload bridge`.

---

### Task 18: Main process lifecycle and OS integration

**Files:**
- Create: `src/main/tray.ts`, `src/main/os.ts`, `tests/main/os.test.ts`, `resources/trayTemplate.png` + `resources/trayTemplate@2x.png` (16/32 px monochrome; macOS template image), `resources/tray.png` (Windows/Linux)
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `createServices`, `createHandlers`, `registerIpc`, `Scheduler`.
- Produces (pure, tested):
  - `trayStatusLine(status: SchedulerStatus, config: Config, now: Date): string` → `"Running: Photos → NAS"`, `"Paused until 15:30"`, `"Paused"`, `"Idle · next: Documents at 14:00"` (`HH:MM` today, else `Mon 14:00`), `"Idle · no schedules"`.
  - `shouldNotify(setting: Settings["notifications"], status: RunStatus): boolean` — `problems` → `failed` or `completed-with-warnings` (not `cancelled`); `always` → true; `never` → false.
  - `linuxAutostartEntry(execPath: string): string` — `[Desktop Entry]\nType=Application\nName=Backup Manager\nExec="<execPath>" --hidden\nX-GNOME-Autostart-enabled=true\n`.
  - `setLaunchAtLogin(enabled: boolean): Promise<void>` — macOS/Windows `app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ["--hidden"] })`; Linux writes/removes `~/.config/autostart/backup-manager.desktop`.

`index.ts` wiring: `app.requestSingleInstanceLock()` (second instance → show/focus window); create services with `platform.now = () => new Date()`, `setInterval` real, `isOnBattery = () => powerMonitor.isOnBatteryPower()`; `powerMonitor.on("resume", scheduler.onResume)`, `on("on-ac", scheduler.onPowerChange)`; `powerSaveBlocker.start("prevent-app-suspension")` on `run-start`, `stop` on `run-end`; window `close` → `preventDefault` + `hide()` unless quitting; `before-quit` sets quitting; started with `--hidden` (or `app.getLoginItemSettings().wasOpenedAsHidden`) → don't show window; tray rebuilt on scheduler status changes (menu: status line (disabled item), Run all now, Pause 1 hour / Pause until resumed or Resume, Open, Quit); notifications via `Notification` when `shouldNotify`, click → show window + `broadcast(CH.navigate, "history", log.id)`; call `setLaunchAtLogin(config.settings.launchAtLogin)` on startup and whenever settings change; macOS: hide dock icon when the window is hidden (`app.dock.hide()` / `show()`).

- [ ] **Step 1: Failing tests** for `trayStatusLine` (each variant), `shouldNotify` (table of 3 settings × 4 statuses), `linuxAutostartEntry` (exact string).
- [ ] **Step 2:** FAIL. **Step 3:** implement pure functions, then the wiring. **Step 4:** PASS; `npm run typecheck` clean; `npm run dev` → tray icon appears, closing the window keeps the app in the tray, Quit from the tray exits.
- [ ] **Step 5: Commit** `feat(main): tray, notifications, login item and power handling`.

---

### Task 19: Renderer shell, Destinations and Settings screens

**Files:**
- Create: `src/renderer/src/lib/api.ts` (`export const api = window.api`), `src/renderer/src/hooks/useConfig.ts`, `src/renderer/src/hooks/useSchedulerStatus.ts`, `src/renderer/src/screens/Destinations.tsx`, `src/renderer/src/screens/Settings.tsx`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/main.tsx`; remove template demo components/assets

**Interfaces:**
- Consumes: `Api` (Task 17).
- Produces:
  - `useConfig(): { state: ConfigState | null; save(next: Config): Promise<string[] | null>; reload(): Promise<void> }` — `save` returns errors or `null`.
  - `useSchedulerStatus(): SchedulerStatus | null` (initial `status()` + `onStatus`).
  - App shell: sidebar with the five screens (`Screen` type), header strip with scheduler state ("Next: … / Running … / Paused") and a Pause/Resume dropdown (1 hour / until resumed). If `config.get()` returns `ok:false`, show a full-screen error with the errors list and "Import config…" / "Reset to defaults" buttons. `onNavigate` switches screens.

shadcn components to add: `npx shadcn@latest add button card input label switch select dialog sheet table badge dropdown-menu separator scroll-area progress tabs textarea checkbox sonner tooltip`.

Destinations: table (name, path, availability dot from `destinations.availability()` refreshed every 10 s while visible, enabled switch, edit/delete). Add/edit dialog: name, path with "Browse…" (`dialog.pickFolder`). Deleting a destination referenced by a source's explicit `destinationIds` removes it from those lists (confirm dialog says which sources are affected). Settings: launch at login, notifications select, skip on battery, global excludes (textarea, one pattern per line), Export/Import buttons, config path text. Validation errors from `save` shown via toast (sonner).

- [ ] **Step 1:** Implement hooks and shell. **Step 2:** Implement both screens.
- [ ] **Step 3: Verify:** `npm run typecheck` clean; `npm run dev`: add a destination via Browse, toggle it, rename it; quit and relaunch → persisted; set a nonexistent path → red availability dot; change settings → `config.json` reflects it; export, then import the exported file → no change.
- [ ] **Step 4: Commit** `feat(ui): app shell, destinations and settings screens`.

---

### Task 20: Sources screen and editor

**Files:**
- Create: `src/renderer/src/screens/Sources.tsx`, `src/renderer/src/screens/SourceEditor.tsx`, `src/renderer/src/lib/format.ts`
- Test: `tests/shared/format.test.ts`

**Interfaces:**
- Consumes: `useConfig`, `useSchedulerStatus`, `newSource`, `slugify`, `defaultModeFor`, `validateConfig`.
- Produces: `src/renderer/src/lib/format.ts` (pure, tested): `describeSchedule(s: Schedule | null): string` (`"Manual"`, `"Every 4 hours"`, `"Daily at 02:00"`, `"Mon, Thu at 09:00"`), `formatBytes(n: number): string` (`"0 B"`, `"1.5 KB"`, `"2.0 GB"`, base 1024), `formatRelativeTime(at: Date, now: Date): string` (`"in 5 min"`, `"today 14:00"`, `"Mon 14:00"`).

Sources list: name, path, mode/packaging badges, schedule summary + next run (from status), enabled switch, "Run now" (`run.start([id])`), edit, delete (confirm). Editor sheet sections: Basics (path Browse, name, slug — auto from name until edited), Packaging (copy / zip whole / zip each top-level item; zip level slider 0–9; loose files individual/bundle for zip-children) — changing packaging sets mode via `defaultModeFor` unless the user already changed mode in this edit session; Mode (mirror: deletion select + trash retention days or "forever"; snapshot: keep at least N, delete older than X days or "never"); Exclusions (textarea + "use global excludes" switch); Destinations ("All" or checkboxes); Schedule (none / every N hours / daily at time / weekly with day toggles + time; "Retry when destination becomes available" switch). Save runs `validateConfig` on the whole next config and shows errors inline at the top of the sheet.

- [ ] **Step 1: Failing tests** for `describeSchedule`, `formatBytes`, `formatRelativeTime` (values above). **Step 2:** FAIL. **Step 3:** implement format.ts → PASS.
- [ ] **Step 4:** Implement screens. **Step 5: Verify** (`npm run dev`): create sources with each packaging; mode default flips to snapshot when choosing zip; duplicate name → slug gets `-2`; a source inside a destination shows the validation error; schedule summary and next run appear in the list.
- [ ] **Step 6: Commit** `feat(ui): sources list and editor`.

---

### Task 21: Run and History screens

**Files:**
- Create: `src/renderer/src/hooks/useRunProgress.ts`, `src/renderer/src/screens/Run.tsx`, `src/renderer/src/screens/History.tsx`

**Interfaces:**
- Consumes: `api.run.*`, `api.history.*`, `useSchedulerStatus`, `formatBytes`.
- Produces: `useRunProgress(): { runId: string | null; currentJob: { sourceId: string; destId: string } | null; currentFile: string | null; jobBytesDone: number; jobBytesTotal: number; jobsDone: number; totalJobs: number; warnings: Warning[]; lastLog: RunLog | null }` — reduced from `onProgress` events.

Run screen: source multi-select (default all) → "Preview" shows the plan grouped by source → destination (counts, bytes, skipped badge with reason, skipped entries collapsible); "Run" → `run.start`; while running: overall progress (`jobsDone/totalJobs`), job progress bar, current file, live warnings list, Cancel. Below: queue (pending runs with trigger badges) and pending retries from status. When finished: summary card from `lastLog`. History: table (start time, trigger badge, status badge, duration, jobs) newest first; row click → detail with per-job counts, bytes, reason, warnings table.

- [ ] **Step 1:** Implement hook and screens.
- [ ] **Step 2: Verify** (`npm run dev`): preview a mirror source → counts; run it → progress, summary, History entry; run again → 0 copied; unplug/rename a destination folder → preview shows "destination missing" and run is completed-with-warnings; cancel a large run → cancelled status and no `.partial` left on disk; notification click opens the run in History.
- [ ] **Step 3: Commit** `feat(ui): run and history screens`.

---

### Task 22: Packaging and smoke checklist

**Files:**
- Create: `docs/smoke-checklist.md`
- Modify: `electron-builder.yml` (from template), `package.json`

- [ ] **Step 1:** Configure `electron-builder.yml`: `appId: com.stefano.backupmanager`, `productName: Backup Manager`, targets mac `dmg` (+ `LSUIElement` not set — dock icon is managed at runtime), win `nsis`, linux `AppImage` + `deb`; include `resources/` tray icons via `extraResources`; tray icon path resolved with `app.isPackaged ? process.resourcesPath : "resources"`.
- [ ] **Step 2:** Write `docs/smoke-checklist.md` covering: tray menu items; close-to-tray and Quit; launch at login on/off (and the Linux autostart file); notification on warnings and its click; scheduled run fires (set daily to 2 min from now); catch-up after quitting past a slot; pause/resume; unplug USB destination → retry when plugged back; lid close mid-run → after wake the job completes or is retried, no `.partial` left; battery deferral; OneDrive folder as destination; per-packaging output layout matches spec §5.
- [ ] **Step 3: Verify:** `npm run build:mac` (or the platform's script from the template) produces an installer; install, run the smoke checklist's first five items.
- [ ] **Step 4: Commit** `chore: packaging config and smoke checklist`.
