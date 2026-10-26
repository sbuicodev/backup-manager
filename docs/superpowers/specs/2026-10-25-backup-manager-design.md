# Backup Manager — Design

Date: 2026-10-25
Status: Draft, awaiting review

## 1. Purpose

A cross-platform desktop app (macOS, Windows, Linux) that backs up a user-chosen list of
source folders to one or more destination folders. Each source has its own options:
whether it is mirrored or snapshotted, whether and how it is zipped, exclusions, retention,
and which destinations it goes to.

Destinations are filesystem paths: local folders, external drives, mounted network shares,
and locally synced cloud folders (e.g. the OneDrive folder — the OneDrive client handles
upload; the app never talks to cloud APIs).

Primary success criteria:

- Configure sources/destinations entirely from the GUI.
- Preview a run (dry run) and see exactly what will happen.
- Run manually or on a per-source schedule, with live progress, and get a clear per-run
  report.
- Scheduled backups happen reliably on a laptop: missed runs catch up, unplugged drives are
  retried when reconnected, interrupted runs are recovered.
- Never corrupt or silently lose backup data: partial outputs are never left looking valid,
  missing drives never cause writes to the wrong disk, deletions are recoverable by default.
- Simple to maintain: few dependencies, one build tool, a UI-independent engine.

## 2. Scope

### In scope (v1)

- Electron + Vite + React + shadcn/ui (Tailwind) GUI.
- Manual runs (all sources, or a single source).
- Per-source schedules (interval / daily / weekly), run queue, missed-run catch-up,
  retry-when-destination-available, interrupted-run recovery.
- Tray / menu-bar presence, close-to-tray, launch at login, native notifications.
- Per-source mode: `mirror` or `snapshot`.
- Per-source packaging: `copy`, `zip-whole`, `zip-children`.
- Mirror deletion policy: `trash` (default), `exact`, `never`.
- Snapshot retention: keep-at-least-N + max-age-days (default: keep forever).
- Glob exclusions per source + global list.
- Dry-run plan preview, live progress, cancellation.
- Run history (JSON logs) viewable in the UI.
- Config import/export.

### Out of scope (v1), but the design must not block it

- Non-filesystem destinations (S3, SFTP, cloud APIs) — destinations go through a small
  interface so adapters can be added.
- Encryption, content hashing, parallel jobs, hardlink-deduplicated snapshots.
- Restore UI (backups are plain files/zips the user can open directly).

## 3. Architecture

```
┌──────────────────────── Electron ────────────────────────┐
│ Renderer (React + shadcn)      Preload        Main (Node)│
│  screens, forms, progress  ◄── typed IPC ──►  ipc handlers│
│  no Node access                (contextBridge)    │       │
│                       tray, notifications,        │       │
│                       login item, powerMonitor ──►│       │
│                                                   ▼       │
│                                   ┌──── scheduler ───────┐│
│                                   │ next-run calc, queue ││
│                                   │ catch-up, retry      ││
│                                   └─────────┬────────────┘│
│                                             ▼             │
│                                   ┌────────── engine ────┐│
│                                   │ config  planner      ││
│                                   │ executor  retention  ││
│                                   │ fs-walk  zip  history││
│                                   └──────────────────────┘│
└───────────────────────────────────────────────────────────┘
```

- **Engine** (`src/main/engine/`): pure Node + TypeScript, **no Electron imports**. Takes a
  config and paths as arguments, emits progress via callbacks, supports cancellation via
  `AbortSignal`.
- **Scheduler** (`src/main/scheduler/`): pure Node + TypeScript, **no Electron imports**.
  Decides what is due, owns the run queue, and calls the engine. Time (`now()`), timers,
  and OS signals (suspend/resume, battery state) are injected so it is fully testable with
  a fake clock.
- **Main process** (`src/main/`): window lifecycle, tray, notifications, login item,
  `powerMonitor` / `powerSaveBlocker` wiring, IPC handlers, native dialogs, resolving
  the config/state/history location (`app.getPath('userData')`). Both manual runs and
  scheduled runs go through the scheduler's queue.
- **Preload** (`src/preload/`): exposes one typed `window.api` object via `contextBridge`.
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Renderer** (`src/renderer/`): React UI only. Talks to main exclusively through
  `window.api`.
- **Shared** (`src/shared/`): zod schemas, inferred TS types, IPC channel contracts. Imported
  by main, preload and renderer.

### Tooling

- Scaffold: `electron-vite` (React + TS template). Packaging: `electron-builder`.
- UI: Tailwind CSS + shadcn/ui components (copied into `src/renderer/components/ui`).
- Runtime deps (main): `zod`, `yazl` (zip writing, streaming), `picomatch` (globs).
- Dev/test deps: `vitest`, `yauzl` (reading zips in tests).
- No state-management library; React state + small IPC hooks.

### Project layout

```
src/
  shared/        schema.ts (zod config), ipc.ts (channel contracts), types.ts
  main/
    index.ts     window + app lifecycle, single-instance lock, close-to-tray
    ipc.ts       handler registration
    tray.ts      tray / menu-bar icon and menu
    os.ts        notifications, login item (incl. Linux autostart file), power hooks
    scheduler/
      schedule.ts    next-run computation for interval / daily / weekly
      queue.ts       run queue (dedupe, sequential execution, cancel)
      scheduler.ts   due checks, catch-up, retry-when-available, pause, recovery
      state.ts       load/save state.json
    engine/
      config.ts      load/save/validate/migrate config file
      walk.ts        directory walk with exclusions → file list (path, size, mtime)
      planner.ts     config + fs state → Plan
      executor.ts    Plan → performs actions, emits progress
      packaging/     copy.ts, zip.ts
      mirror.ts      diff + deletion policy
      snapshot.ts    naming, atomic finalize
      retention.ts   snapshot pruning, trash purging
      history.ts     run log write/read
      destination.ts Destination interface + FsDestination (all destination I/O in
                     mirror/snapshot/retention goes through it)
  preload/index.ts
  renderer/
    App.tsx, screens/, components/, hooks/useApi.ts
tests/            engine tests (vitest, real temp dirs)
```

## 4. Configuration

Stored as JSON at `<userData>/config.json`, validated by zod on load and on save. A
`version` field allows future migrations. Invalid config on load → app shows the error and
offers to reset or import; it never silently overwrites the file.

```ts
type Config = {
  version: 1;
  globalExcludes: string[];            // default: [".DS_Store", "Thumbs.db", "desktop.ini"]
  settings: Settings;
  destinations: Destination[];
  sources: Source[];
};

type Settings = {
  launchAtLogin: boolean;              // default true; starts hidden in tray
  notifications: "problems" | "always" | "never"; // default "problems" (failed / warnings)
  skipScheduledOnBattery: boolean;     // default false; when true, due runs wait for AC
};

type Destination = {
  id: string;                          // uuid
  name: string;
  path: string;                        // absolute; must already exist at run time
  enabled: boolean;
};

type Source = {
  id: string;                          // uuid
  name: string;                        // display name
  slug: string;                        // folder name at destination; unique, filesystem-safe
  path: string;                        // absolute
  enabled: boolean;
  mode: "mirror" | "snapshot";
  packaging: "copy" | "zip-whole" | "zip-children";
  zip: {
    level: number;                     // 0 (store) – 9 (max); default 6
    looseFiles: "individual" | "bundle"; // zip-children only; default "individual"
  };
  mirror: {
    deletion: "trash" | "exact" | "never"; // default "trash"
    trashRetentionDays: number | null;     // null = keep forever (default)
  };
  snapshot: {
    keepMin: number;                   // >= 1; default 10
    maxAgeDays: number | null;         // null = never prune (default)
  };
  excludes: string[];                  // globs relative to source root
  useGlobalExcludes: boolean;          // default true
  destinationIds: "all" | string[];    // default "all"
  schedule: Schedule | null;           // null = manual only (default)
  retryWhenAvailable: boolean;         // default true; see 7.4
};

type Schedule =
  | { kind: "interval"; everyHours: number }                  // integer >= 1
  | { kind: "daily"; time: string }                           // "HH:MM", local time
  | { kind: "weekly"; days: Weekday[]; time: string };        // days non-empty

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
```

UI defaults when creating a source: `packaging: "copy"` → `mode: "mirror"`; choosing a zip
packaging switches the default to `mode: "snapshot"` (user can override).

Validation rules beyond types: slugs unique; source paths must not be inside a destination
path and vice versa; `keepMin >= 1`; explicit `destinationIds` must reference existing
destinations.

## 5. Destination layout

For source slug `S` at destination root `D`:

| mode     | packaging      | output                                              |
|----------|----------------|-----------------------------------------------------|
| mirror   | copy           | `D/S/current/<files…>`                              |
| mirror   | zip-whole      | `D/S/current/S.zip`                                 |
| mirror   | zip-children   | `D/S/current/<child>.zip` (+ `_files.zip` if bundling) |
| snapshot | copy           | `D/S/<YYYY-MM-DD_HHmmss>/<files…>`                  |
| snapshot | zip-whole      | `D/S/<YYYY-MM-DD_HHmmss>.zip`                       |
| snapshot | zip-children   | `D/S/<YYYY-MM-DD_HHmmss>/<child>.zip …`             |

- Mirror trash: `D/S/.trash/<YYYY-MM-DD_HHmmss>/<relative path>`.
- Timestamps use local time; if a name already exists, append `-2`, `-3`, ….
- `zip-children`: each top-level directory → `<dir>.zip`. Each loose top-level file →
  `<file>.zip` (`individual`) or all of them in `_files.zip` (`bundle`).
- Mirror + zip keeps a sidecar manifest `D/S/current/.backup-manager.json` recording a
  fingerprint (hash of sorted `path|size|mtime` entries) for each produced archive. An
  archive is regenerated only when its fingerprint changes, so unchanged children are not
  rewritten — important for OneDrive, which re-uploads any changed file in full.

## 6. Engine behaviour

### 6.1 Run flow

1. Load and validate config.
2. **Plan** — for the requested sources × their enabled destinations (or an explicit list of
   source × destination jobs, used by the scheduler's retries), check availability, walk
   the source (applying excludes), inspect the destination, and produce a `Plan`: a list of
   jobs, each with its actions (copy / update / zip / trash / delete / prune) and byte/file
   estimates. Dry run = plan only, shown in the UI.
3. **Execute** — run jobs sequentially (one source at a time, its destinations in turn).
   Emit progress events (job started, file progress, bytes done/total, warnings, job done).
4. **Retention** — after a job succeeds (with or without warnings, never after a fatal
   error), prune snapshots / purge expired trash for that source at that destination.
5. **History** — write a run log.

The plan is recomputed at the start of execution (state may change between preview and
run); the preview is informative, not a contract.

### 6.2 Availability (missing drives)

- Source path missing or unreadable → skip all its jobs, warning.
- Destination root missing → skip all jobs for it, warning. The engine **never creates a
  destination root** (prevents writing to the internal disk when an external drive's mount
  point is absent). It does create `S/` and subfolders inside an existing root.

### 6.3 Directory walk

- Recursive walk with `fs.promises.opendir`; records relative path, size, mtime.
- Exclusions: picomatch globs (source `excludes` + `globalExcludes` if enabled), matched
  against the relative path; a matching directory is not descended into.
- Symlinks are not followed and not copied in v1; each is logged as a skipped entry.

### 6.4 Mirror (copy)

- Diff source files against `current/`: a file is copied if missing or if size differs or
  mtime differs by more than 2 s (FAT/exFAT have 2 s resolution).
- Copies preserve mtime (`fs.utimes`) so subsequent diffs are stable.
- Each copy writes to a temporary sibling `.<hash>.bm-partial` in the same directory (a short
  hashed name, so long file names never exceed name-length limits), verifies the size, then
  renames over the target.
- Files present in `current/` but not in the source (and not excluded) are handled per
  `deletion`: `trash` → moved under `.trash/<run timestamp>/`; `exact` → deleted; `never` →
  left alone. Empty directories left behind are removed (except under `never`).
- Excluded paths at the destination are never touched.

### 6.5 Mirror (zip)

- Compute the fingerprint for each archive to produce; regenerate only those whose
  fingerprint differs from the manifest (or that are missing).
- Archives no longer produced (a child removed at source) follow the `deletion` policy.
- Update the manifest after all archives for that job are written.

### 6.6 Snapshot

- At the start of each job, stale `.bm-partial` files/folders under `D/S/` (left by a crash,
  power loss or forced shutdown) are deleted. The same applies to mirror jobs.
- Write into `<timestamp>.bm-partial` (folder) or a `.bm-partial` sibling of `<timestamp>.zip`
  (file); rename to the final name only when the whole snapshot completes. On failure or
  cancel, the `.bm-partial` is removed.
- Copies preserve mtime.

### 6.7 Zip writing

- `yazl` streams files into the archive; output goes to a `.bm-partial` sibling then is renamed.
- Compression level from `zip.level` (0 = store). Entries keep relative paths and mtimes.
- Verification: after writing, check the archive's size is non-zero and the entry count
  matches the planned count (read the central directory).

### 6.8 Retention

- Snapshots for a source at a destination are the finalized `<timestamp>` folders/zips
  under `D/S/` (names that parse as timestamps; `.bm-partial` and `.trash` ignored).
- Sort newest first. Always keep the first `keepMin`. Of the rest, delete those older than
  `maxAgeDays`. `maxAgeDays: null` → delete nothing.
- Trash: subfolders of `.trash/` older than `trashRetentionDays` are deleted
  (`null` → never).

### 6.9 Errors

- Per-file problems (locked, permission denied, vanished mid-run) → logged, file skipped,
  job ends as `completed-with-warnings`.
- Fatal problems for a job (destination full `ENOSPC`, destination becomes unavailable,
  zip write failure) → that job aborts as `failed`, its `.bm-partial` outputs are cleaned up,
  the run continues with the next job.
- Cancellation → current job aborts like a failure (status `cancelled`), remaining jobs
  of that run are not started (other queued runs are unaffected, see 7.5).
- Run status = worst job status.

### 6.10 History

- One JSON file per run in `<userData>/history/<timestamp>.json`: trigger
  (`manual` / `scheduled` / `catch-up` / `retry` / `recovery`), start/end time, status,
  per-job status, counts (copied, updated, zipped, trashed, deleted, pruned, skipped),
  bytes written, and the list of warnings/errors with paths.
- The UI lists runs newest first and shows details. Keep the last 200 logs.

## 7. Scheduling

### 7.1 State

`<userData>/state.json` (zod-validated, written atomically via temp file + rename):

```ts
type State = {
  version: 1;
  jobs: Record<string /* `${sourceId}:${destId}` */, {
    lastSuccessAt: string | null;      // ISO time of last completed / completed-with-warnings
    lastAttemptAt: string | null;
    pendingRetry: boolean;             // skipped because destination was unavailable
  }>;
  sources: Record<string /* sourceId */, { lastScheduledAt: string | null }>;
  pausedUntil: string | null;          // ISO time, or "forever"
  activeRun: { runId: string; jobs: string[] } | null; // set while a run executes
};
```

Unknown ids (deleted sources/destinations) are dropped on load.

### 7.2 Next-run computation

- `interval`: `lastScheduledAt + everyHours` (or now, if never run).
- `daily` / `weekly`: the most recent slot at or before now; the source is due if that slot
  is after `lastScheduledAt`. Computed in local time, so DST shifts move the slot with the
  wall clock.
- Own small implementation (no cron dependency).

### 7.3 Due checks and catch-up

- The scheduler checks for due sources every 60 s, at startup, and on `powerMonitor`
  `resume`.
- A source whose slot was missed (app not running, machine off or asleep) is due at the
  next check — **once**, not once per missed slot. `lastScheduledAt` is set to the slot
  time when the run is enqueued.
- When paused (tray menu), due checks do nothing; once the pause ends, missed slots catch
  up once as above.
- With `skipScheduledOnBattery`, due sources stay due (not enqueued) until AC power.

### 7.4 Retry when destination available

- If a scheduled/catch-up job is skipped because its destination root is missing, and the
  source has `retryWhenAvailable`, the job is marked `pendingRetry`.
- Every 60 s check, pending jobs whose destination root now exists are enqueued (only that
  source × destination). A retry is cleared on success, and also when the next regular
  slot of the source runs.

### 7.5 Queue

- One queue for manual and scheduled runs; runs execute strictly one at a time.
- Enqueuing a source × destination job already queued (not yet running) is a no-op.
- Jobs due at the same check are grouped into one run (one history entry).
- Cancel (UI or tray) cancels the active run; the remaining queue is kept.

### 7.6 Sleep and interrupted runs

- During a run, `powerSaveBlocker.start("prevent-app-suspension")` prevents idle sleep.
  It cannot prevent lid-close or user-requested sleep; that is handled by recovery.
- `activeRun` in state is written when a run starts and cleared when it ends.
- On `resume`: the run continues; jobs that then fail because their destination vanished
  fall into 7.4.
- On startup with a non-null `activeRun` (crash, forced shutdown): jobs from that run that
  did not succeed are re-enqueued with trigger `recovery`. A job that ended without
  success (failed, skipped, lost) is kept in `activeRun` until the run ends, so it is
  recovered too; only successful jobs are removed from it as they finish. Stale `.bm-partial`
  outputs are removed by the job itself (6.6).

### 7.7 App lifecycle and OS integration

- Single-instance lock; launching again focuses the existing window.
- Closing the window hides it; the app keeps running in the tray / menu bar. Quit only from
  the tray menu (or Cmd+Q on macOS, which also quits).
- Tray menu: status line ("Idle · next: Documents at 14:00" / "Running: Photos → NAS"),
  Run all now, Cancel running backup (only while a run is active), Pause schedules (1 hour /
  until resumed) or Resume, Open, Quit.
- Launch at login: `app.setLoginItemSettings({ openAtLogin, openAsHidden })` on macOS and
  Windows; on Linux, write/remove `~/.config/autostart/backup-manager.desktop`. Started at
  login → no window shown.
- Notifications (Electron `Notification`) at the end of a run, per `settings.notifications`.
  Clicking one opens the run in History.

## 8. IPC API

Exposed as `window.api` (types from `src/shared/ipc.ts`):

| call | direction | purpose |
|------|-----------|---------|
| `config.get()` | invoke | current config (or load error) |
| `config.save(config)` | invoke | validate + write; returns validation errors |
| `config.export()` / `config.import()` | invoke | save/open dialog, file read/write in main |
| `dialog.pickFolder()` | invoke | native folder picker → path or null |
| `run.plan(sourceIds?)` | invoke | dry-run plan |
| `run.start(sourceIds?)` | invoke | enqueue a manual run; returns run id |
| `run.cancel()` | invoke | cancel the active run |
| `run.onProgress(cb)` | event | progress events; returns unsubscribe |
| `scheduler.status()` | invoke | active run, queue, next run per source, pause state, pending retries |
| `scheduler.pause(until)` / `scheduler.resume()` | invoke | pause schedules (ISO time or "forever") |
| `scheduler.onStatus(cb)` | event | status changes; returns unsubscribe |
| `history.list()` / `history.get(id)` | invoke | run logs |
| `app.onNavigate(cb)` | event | main asks the UI to open a screen (e.g. from a notification) |

All payloads crossing IPC are validated with the shared zod schemas in main.

## 9. UI

shadcn components; a sidebar with five screens:

1. **Sources** — list (name, path, mode, packaging, schedule summary + next run, enabled
   toggle, "Run this source"). Editor sheet/dialog: path picker, name/slug, mode,
   packaging, zip options, mirror deletion + trash retention, snapshot retention, excludes
   editor, global-excludes toggle, destinations (all / pick), schedule (none / every N
   hours / daily at / weekly on days at), retry-when-available toggle.
2. **Destinations** — list (name, path, availability indicator, enabled toggle); add/edit
   with folder picker.
3. **Run** — "Preview" shows the plan grouped by source → destination with counts and
   sizes, plus skipped items (missing drives). "Run" enqueues and shows live progress
   (overall bar, current job, current file, warnings stream) and a Cancel button. Also
   shows the queue and pending retries. Ends with a summary.
4. **History** — run list with status and trigger badges; detail view with per-job stats
   and warnings.
5. **Settings** — launch at login, notifications, skip scheduled runs on battery, global
   excludes editor, config import/export, path of the config file.

A header strip shows scheduler state (next run / running / paused) with a pause/resume
control. The UI saves config on each confirmed edit (no global "save" button).

## 10. Testing

- **Engine** (main focus): vitest with real temp directories. Cover walk + excludes, mirror
  diff/copy/update, each deletion policy, mirror-zip fingerprint skipping, snapshot naming
  and collisions, atomic `.bm-partial` cleanup on failure/cancel, retention rules, missing
  source/destination handling, zip contents (read back with yauzl), config validation.
- **Scheduler**: vitest with a fake clock and injected OS signals. Cover next-run
  computation (interval, daily, weekly, DST changes), catch-up runs once after a gap,
  pause/resume, battery deferral, queue dedupe and grouping, retry-when-available,
  recovery from a leftover `activeRun`, state.json round-trip and dropping unknown ids.
- Engine and scheduler are written test-first (TDD).
- **IPC/main**: thin; covered by a few tests on payload validation. Tray, notifications,
  login item and power hooks are covered by the manual smoke checklist.
- **Renderer**: no automated UI tests in v1; manual smoke checklist per release.
- CI-friendly: `npm test` runs engine tests on all three OSes if CI is set up later.

## 11. Future extensions (designed for, not built)

- Remote destinations: implement the `Destination` interface (list, stat, write stream,
  rename, remove) for S3/SFTP.
- Encryption: post-process archives; passwords via Electron `safeStorage`.
- Content hashing option for change detection; parallel jobs.
