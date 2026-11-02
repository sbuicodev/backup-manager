# Mac-Style UI Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-screen UI with a backups-first sidebar and detail pane (backup pages, drive pages, Activity, a setup assistant) as specified, without changing how backups are made.

**Architecture:** The renderer gets one selection model (`backup` / `drive` / `activity` / `settings`) driving a detail pane; pure helpers in `src/renderer/src/lib/` derive summaries and per-pair statuses and are unit-tested; the existing editor's field groups are split into reusable form sections used by the in-page editor and the assistant. Main gains a few validated IPC calls (free space, reveal, check-now, latest result per pair, tray selection). The engine is untouched except excluding not-set-up backups.

**Tech Stack:** Electron 44, electron-vite, React 19, TypeScript strict, Tailwind v4 + shadcn/ui (Radix via the `radix-ui` package), zod 4, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-mac-style-ui-design.md`

## Global Constraints

- Branch `ui/mac-rework`; commit per task; nothing pushed.
- No new npm dependencies (`radix-ui` already provides ContextMenu).
- Engine and scheduler stay free of Electron imports (architecture test).
- Every IPC payload is validated with zod in `handlers.ts`; invalid input throws `invalid arguments`.
- Existing configs must keep loading; new fields have defaults.
- Copy: sentence case, no "please", no "successfully", verbs first on buttons.
- Edits are saved only by an explicit **Save**; the only immediate writes are single explicit actions (enable/disable, Send another backup here, delete, Check now).
- Light and dark, glass on and off, collapsed sidebar all keep working.
- `npm test` and `npm run typecheck` pass after every task.

## Review Focus

1. A not-set-up backup must never run: Run all, schedule, catch-up, retry, recovery and Back up now on it.
2. Leaving an edited page (select another item, close window, quit) with unsaved changes must ask; Cancel must restore the saved values exactly.
3. `shell.showInFolder` must refuse paths outside configured destinations (`..`, symlink-free normalisation, other drives).
4. Per-pair status after a destination or backup is removed or renamed: no crash, no stale rows.
5. A config with zero sources or zero destinations: empty states, not blank panes.

---

### Task 1: `setupComplete` — not-set-up backups never run

**Files:** Modify `src/shared/schema.ts`, `src/main/engine/planner.ts`, `src/main/scheduler/scheduler.ts`. Test `tests/shared/schema.test.ts`, `tests/engine/planner.test.ts`, `tests/scheduler/scheduler.test.ts`.

**Interfaces — Produces:** `Source.setupComplete: boolean` (default `true`); `isRunnable(source): boolean` exported from `planner.ts` (`enabled && setupComplete`).

- [ ] Failing tests:
  - schema: `setupComplete` defaults to true for old configs; a source with `setupComplete: false` and `items: []` validates; with `setupComplete: true` and `items: []` it fails as today.
  - planner: `planRun(cfg, {})` and `planRun(cfg, { sourceIds: [id] })` produce no job for a not-set-up source; `planRun(cfg, { jobs: [{sourceId, destId}] })` neither.
  - scheduler: a not-set-up source with a due schedule is not enqueued; `runNow()` skips it; a leftover `pendingRetry` for it is not checked; `status().pendingRetries` omits it.
- [ ] Run → FAIL.
- [ ] Implement: schema field + skip the "at least one item" issue when `setupComplete === false`; use `isRunnable` everywhere sources are filtered by `enabled` in planner and scheduler (`selectPairs`, `runNow`, due checks, `retryEnabled`).
- [ ] Run `npx vitest run tests/shared tests/engine/planner.test.ts tests/scheduler` → PASS; `npm run typecheck` clean.
- [ ] Commit `feat: backups can be saved as not set up and never run`.

### Task 2: Pure helpers — summary sentence and pair status

**Files:** Create `src/renderer/src/lib/summary.ts`, `tests/shared/summary.test.ts`. Modify `src/shared/types.ts`.

**Interfaces — Consumes:** `Source`, `Destination`, `SchedulerStatus`. **Produces:**
- `type PairResult = { sourceId; destId; runId; endedAt: string; status: JobStatus; reason?; error?; changeCount?: number; bytesWritten: number }` in `types.ts` (filled by Task 3)
- `backupSummary(source: Source, last: string | null, now: Date): string`
- `pairStatus(source, dest, result: PairResult | null, status: SchedulerStatus | null, available: boolean | undefined, now): { tone: 'ok' | 'waiting' | 'failed' | 'idle' | 'off'; text: string; canCheckNow: boolean }`
- `backupTone(source, results: PairResult[], status, running: boolean): 'ok' | 'waiting' | 'failed' | 'notSetUp' | 'paused' | 'running' | 'idle'`

- [ ] Failing tests (exact strings):
  - `Mirror · plain files · every 4 hours · last backed up 2 hours ago`
  - `Versions · one zip · every day at 22:00 · not backed up yet`
  - `Mirror · a zip per item · runs only when you click Back up now · last backed up yesterday` (existing `formatRelativeTime` wording)
  - not set up → `Not set up`
  - pair: pending retry → `{ tone: 'waiting', text: 'waiting · next check 15:40', canCheckNow: true }`; last result failed with `disk full` → `failed · disk full`; never → `never`; unavailable and no retry → `not connected` / `off` when the destination is disabled.
  - tone precedence: running > notSetUp > paused > failed > waiting > ok > idle.
  - a result for a destination no longer in the config is ignored (no row, no tone).
- [ ] FAIL → implement (reuse `describeSchedule`, `formatRelativeTime`, `checkClock`) → PASS.
- [ ] Commit `feat(ui): summary sentence and per-drive status helpers`.

### Task 3: Main process calls

**Files:** Modify `src/shared/ipc.ts`, `src/shared/types.ts`, `src/main/handlers.ts`, `src/main/services.ts`, `src/main/engine/history.ts`, `src/main/scheduler/scheduler.ts`, `src/main/index.ts`, `src/main/tray.ts` (select only), `src/preload/index.ts`. Test `tests/main/handlers.test.ts`, `tests/engine/history.test.ts`, `tests/scheduler/scheduler.test.ts`.

**Interfaces — Consumes:** `PairResult` (Task 2). **Produces:**
- `latestResults(historyDir): Promise<PairResult[]>` in `history.ts` (newest result per pair across kept logs).
- IPC: `history.latest(): Promise<PairResult[]>`; `destinations.info(id): Promise<{ available: boolean; freeBytes: number | null }>` (via `fs.statfs` on the destination root); `shell.showInFolder(path): Promise<boolean>`; `scheduler.checkNow(sourceId, destId): Promise<void>`; `app.onSelect(cb: (sel: { kind: 'backup'; id: string }) => void)`; `files.pathOf(file: File): string` in preload (`webUtils.getPathForFile`); `dialog.statItems(paths: string[]): Promise<SourceItem[]>` for dropped paths.
- `Scheduler.checkNow(req)` resets that pair's retry timing and ticks.

- [ ] Failing tests: `latestResults` picks the newest per pair and ignores pairs with no runs; `destinations.info` reports `available:false, freeBytes:null` for a missing folder and a number for an existing one; `showInFolder` rejects a path outside every destination (including `<dest>/../x`) and accepts `<dest>/S/Docs`; `checkNow` on a pending retry triggers one availability check immediately; `statItems` returns kinds and rejects non-absolute paths.
- [ ] FAIL → implement → PASS (`npx vitest run tests/main tests/engine/history.test.ts tests/scheduler`), typecheck.
- [ ] Commit `feat(main): calls for free space, reveal, check now, latest results and drops`.

### Task 4: App shell — sidebar, selection, toolbar

**Files:** Create `src/renderer/src/lib/selection.ts`, `src/renderer/src/components/AppSidebar.tsx`, `src/renderer/src/components/ui/context-menu.tsx` (shadcn, from `radix-ui`), `src/renderer/src/hooks/useLatestResults.ts`. Modify `App.tsx`, `TopBar.tsx`; delete `components/Sidebar.tsx` at the end of Task 9.

**Interfaces — Produces:** `type Selection = { kind: 'backup' | 'drive'; id: string } | { kind: 'activity' | 'settings' | 'new' }`; `useLatestResults(): PairResult[]` (refreshes on `run-end`); `<AppSidebar selection onSelect collapsed …>`.

- [ ] Sidebar per spec §2: Backups (status dot from `backupTone`), Drives (shared only, greyed when unavailable, a **+** on the section heading opens the existing `DestinationDialog` to add a shared drive), Activity, footer New backup and gear; collapsed mode keeps icons/dots with tooltips; context menus for backups and drives (actions wired to existing calls; Duplicate copies the source with a new id and " copy" name, not set up = unchanged).
- [ ] Toolbar: status text as today; **Back up now** runs all runnable backups and becomes **Stop** while a run is active; hover tooltip from `run.plan()` summarising copies, bytes and drives not connected.
- [ ] Selection restored to the first backup on start; empty config shows an empty state ("Choose what to back up" + New backup).
- [ ] Check in the running app (CDP screenshots, dark and light, collapsed). Commit `feat(ui): backups-first sidebar and toolbar`.

### Task 5: Backup page — reading view

**Files:** Create `src/renderer/src/screens/BackupPage.tsx`. Modify `App.tsx`.

- [ ] Header (name, `backupSummary`, Edit); What list; Where list with `pairStatus` rows, Check now, right-click Show in Finder; Last run line linking to Activity (`Selection` with run id filter); Options row entering edit mode; responsive stack under ~760px.
- [ ] Live progress strip on the page while this backup runs (bar, current file, Stop).
- [ ] Check in the app with a profile holding a waiting pair, a failed pair and a never-run pair. Commit `feat(ui): backup page`.

### Task 6: Shared form sections and in-place editing

**Files:** Create `src/renderer/src/components/backup-form/` (`ItemsSection.tsx`, `WhereSection.tsx`, `ScheduleSection.tsx`, `VersionsSection.tsx`, `DeletionsSection.tsx`, `ExclusionsSection.tsx`, `ZipSection.tsx`, `GeneralSection.tsx`, `useBackupDraft.ts`), `src/renderer/src/hooks/useUnsavedGuard.ts`. Modify `BackupPage.tsx`, `App.tsx`. Delete `screens/SourceEditor.tsx` when its parts are moved.

**Interfaces — Produces:** `useBackupDraft(config, source)` → `{ draft, patch, dirty, ownDests, setOwnDests, save(): Promise<string[] | null>, reset() }` (save builds the next config exactly as `SourceEditor.submit` does today, including exclusive destinations, sets `setupComplete: true`, and refuses with "Add at least one drive" when no destination applies); `useUnsavedGuard(dirty, onSave)` → `confirmLeave(): Promise<boolean>` (Save / Don't save / Cancel alert dialog) and a `beforeunload` hook for window close.

- [ ] Sections laid out as inset grouped rows (System Settings style) with pop-up menus per spec §3.2; drop area on the items list (uses `files.pathOf` + `dialog.statItems`).
- [ ] Editing in place: Edit → form; Unsaved changes marker; Cancel restores; errors beside their section (`readableError` map extended with section ids).
- [ ] Unit tests for `useBackupDraft`'s pure core (extract `buildNextConfig(config, draft, ownDests)` into `lib/` and test: exclusive destinations replaced, setupComplete set, no-destination refusal).
- [ ] Check in the app: edit, cancel restores; edit then select another backup → prompt; close window with changes → prompt. Commit `feat(ui): edit backups in place with explicit save`.

### Task 7: Drive page

**Files:** Create `src/renderer/src/screens/DrivePage.tsx`. Modify `App.tsx`. Remove `screens/Destinations.tsx` at the end of Task 9.

- [ ] Header with `destinations.info` (connected, free space), Edit (existing `DestinationDialog`), Backups going here (schedule + last result for this pair), Send another backup here (menu of runnable backups not targeting it; saves immediately), Show in Finder, Remove (existing confirmation).
- [ ] Check in the app. Commit `feat(ui): drive page`.

### Task 8: Activity

**Files:** Create `src/renderer/src/screens/ActivityPage.tsx`. Modify `App.tsx`. Reuse `ChangeList`. Remove `screens/History.tsx`, `screens/Run.tsx` at the end of Task 9.

- [ ] Day groups, trigger labels, job rows with dot and short result, expand to `ChangeList`; filter (All / backup / drive); live run at the top; deep link from a backup's Last run line opens the run expanded.
- [ ] Check in the app. Commit `feat(ui): activity`.

### Task 9: New backup assistant, tray, settings, clean-up

**Files:** Create `src/renderer/src/screens/NewBackupAssistant.tsx`. Modify `src/main/tray.ts`, `src/main/os-helpers.ts` (pure menu model, tested), `App.tsx`, `screens/Settings.tsx`, `tests/main/os-helpers.test.ts`. Delete the old screens and `components/Sidebar.tsx`.

**Interfaces — Consumes:** form sections from Task 6 (ItemsSection, WhereSection in tile mode). **Produces:** `trayModel(status, config, results, now): Array<{ kind: 'backup'; id; label } | { kind: 'action'; action: TrayAction } | { kind: 'separator' }>`.

- [ ] Assistant per spec §6: steps, Set up later on every step (saves `setupComplete: false` with what was entered), manual-only option, Create backup starts the first run unless manual-only, selects the new backup.
- [ ] Tray: failing test for `trayModel` lines (`Documents — backed up 2 hours ago`, `Photos — waiting for USB stick`, `Tax — not set up`), then implement; clicking a backup row shows the window and sends `app.onSelect`.
- [ ] Settings reachable from the gear and ⌘, (app menu item on macOS).
- [ ] Remove old screens, `Sidebar.tsx`, unused code; update README screenshots and text, smoke checklist (pickers, drag and drop, tray, Windows/Linux).
- [ ] Full suite, typecheck, CDP pass over every view (light/dark, glass on/off, collapsed). Commit `feat(ui): new backup assistant, tray status, clean-up`.
