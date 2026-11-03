# Backup Manager

A desktop app for macOS and Windows (Linux builds too) that backs up the files and folders you
choose to one or more destinations: an external drive, a NAS share, or a cloud folder synced by
its own client (OneDrive, Dropbox, iCloud Drive…). It runs from the menu bar / system tray, on a
schedule, and copes with laptops: missed runs catch up, unplugged drives are retried, interrupted
runs recover.

![A backup's page](docs/screenshots/backup.png)

- **See what goes where.** Each backup has one page: how it's doing, its files and folders, its
  destinations with their own status, and its settings as cards.
- **Arrange it your way.** Put items into subfolders on the destination and give any item a
  different name there (an alias), Finder style.
- **Copy or versions.** Keep one up-to-date copy, or a dated version on each run; as plain files,
  one zip, or a zip per item, with optional size limits that split big archives.
- **Safe by default.** Deleted files go to a `.trash` folder; nothing is written when a drive is
  missing; half-written files are never left looking finished.
- **See what changed.** Every run records the files added, updated, removed or skipped.

Backups are ordinary files and zips: you never need this app to get your data back.

- [Install](#install)
- [Usage](#usage)
- [Development](#development)

## Install

Download the installer for your computer from the
[latest release](https://github.com/sbuicodev/backup-manager/releases/latest):

| Computer                  | File                                       |
| ------------------------- | ------------------------------------------ |
| Mac with Apple silicon    | `backup-manager-<version>.dmg`             |
| Windows PC (Intel or AMD) | `backup-manager-<version>-x64-setup.exe`   |
| Windows on ARM            | `backup-manager-<version>-arm64-setup.exe` |

The installers are not code-signed:

- **macOS:** open the `.dmg` and drag Backup Manager to Applications. On first launch macOS blocks
  it; open **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows:** run the setup file; if SmartScreen appears, click **More info → Run anyway**.

To build an installer yourself, see [Development](#development).

## Usage

The sidebar lists your **Backups** (each with a status dot), your **Destinations**, and
**Activity**. Select one to see it on the right. **Back Up Now** in the top bar runs every backup;
hovering it shows what it would do ("Will copy 3 files (156 KB) · 1 drive not connected").

### 1. Create a backup

Click **+** next to **Backups**. A sheet walks you through three steps:

1. **What to back up**: files and folders from anywhere. On macOS **Add…** picks both at once; on
   Windows use **Add Folder…** and **Add Files…**. You can also drop them from Finder or Explorer.
2. **Where it goes**: pick one or more destinations, or create a new one.
3. **How and when**: one up-to-date copy or dated versions; every day at 22:00, every 4 hours, or
   manually.

![New backup](docs/screenshots/new-backup.png)

**Create Backup** saves it and starts its first run. **Cancel** leaves without creating anything.

### 2. Destinations

A destination is a folder that already exists: on an external drive, a NAS share, or your OneDrive
folder. Backup Manager never creates it, so an unplugged drive is skipped instead of filling up
your internal disk. Add one with the **+** next to **Destinations**, or from a backup's settings.

When you add one from a backup, **Only this backup** makes it that backup's own: other backups
can't use it and it isn't listed in the sidebar.

A destination's page shows whether it's connected, its free space, and every backup saved there.

![A destination's page](docs/screenshots/drive.png)

### 3. See what goes where

A backup's page starts with how it's doing ("Up to date · last backup 2 hours ago · next today
22:00"), with **Back Up Now** and **History**. Below it:

- **Files and folders**, grouped by subfolder, with aliases in italics.
- **Destinations**, each with its own status ("2 hours ago", "Waiting · next check 15:40" with
  **Check Now**, "Failed · disk full"). Right-click one to show the backup in Finder or Explorer.
- **Settings** as four cards: schedule, versions, storage, and what's on the destination. Click any
  of them to edit that part.

### 4. Change a backup

Click **Edit…** (or any row or card on the page). Every setting is in one sheet, with tabs on top
that follow as you scroll; nothing is saved until you click **Save**, and closing with unsaved
changes asks first.

![Editing a backup](docs/screenshots/backup-edit.png)

- **General**: the backup's name and its folder name on each destination.
- **Files and folders**: click, ⌘-click and ⇧-click to select; drag items between groups. Right-click
  for **Set Alias…** (the name it gets on the destination), **Move To**, **New Subfolder with
  N Items**, and **Remove**.
- **Destinations**: **Select All**, or tick shared and backup-only destinations one by one.
- **Schedule**: every few hours, every day, every week, or manually; and whether to back up when an
  unplugged drive is reconnected.
- **Versions**: one up-to-date copy, or dated versions keeping at least N and deleting those older
  than X days.
- **Deletions** (copy): a file deleted from your computer moves to the backup's Trash (emptied after
  the days you choose), is removed, or is kept.
- **Exclusions**: patterns such as `*.tmp` or `node_modules/`, on top of the global ones.
- **Zip**: plain files, one zip, or a zip per item, with compression and an optional size limit
  that splits big archives into parts that each open on their own.

What lands where, for a backup named `S` holding a folder `Photos` and a file `tax.pdf`:

| Keep     | Plain files                                 | One zip                   | A zip per item                                            |
| -------- | ------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| Copy     | `S/Photos/…`, `S/tax.pdf`                   | `S/S.zip`                 | `S/Photos/<entry>.zip`, `S/tax.pdf.zip`                   |
| Versions | `S/2026-10-26_154307/Photos/…`, `…/tax.pdf` | `S/2026-10-26_154307.zip` | `S/2026-10-26_154307/Photos/<entry>.zip`, `…/tax.pdf.zip` |

- A backup of **one folder** with no subfolder or alias saves that folder's **contents** directly
  in `S/`.
- An item in a subfolder lands at `S/<subfolder>/<name>`; an alias replaces `<name>`.
- A copy also keeps a few hidden items of its own in `S/`: `.trash/` for removed files,
  `.backup-manager.json` (zips) and `.backup-manager-layout`. Backups made by earlier versions are
  moved into this layout on their next run, by renaming only.

Right-click a backup in the sidebar to back it up now, pause it, duplicate it, show it in Finder,
or delete it.

### 5. Let it run on schedule

Close the window and Backup Manager keeps running in the menu bar / system tray. Its menu shows the
next run, one line when something needs a look ("Photos is waiting for USB stick", or "3 backups
need attention"), and Run all now, Cancel, Pause and Quit. Turn on **Open at login** in Settings to
have it start hidden when you log in.

- **Missed runs** (the computer was off or asleep) run once as soon as the app is running again.
- **A missing drive** is skipped and retried when it comes back: checks happen 1, 2, 3, 4 and
  5 minutes after the skip, then every 5 minutes, and right away when the computer wakes up or is
  plugged in.
- **Interrupted runs** (crash, forced shutdown, lid closed for good) are run again on the next
  start; leftover half-written files are cleaned up first.
- **Skip scheduled backups on battery** makes due backups wait until the computer is plugged in.

### 6. Activity

**Activity** lists runs by day, with what started them when it wasn't you (scheduled, catch-up,
retry, recovery). Click a backup → destination row to see the files it changed, with filters and
search; filter the list to one backup or one destination. A running backup shows its progress at
the top.

![Activity](docs/screenshots/activity.png)

### Restoring

Copy the files back from the destination, or open the zips with your system's archive tool.

- Split archives (`.part1.zip`, `.part2.zip`, …) are independent zips: extract them all into the
  same folder.
- Chunked files (`.part3.zip.001`, `.002`, …) must be joined first: open the `.001` file with
  7-Zip, or join them with `cat Photos.part3.zip.* > Photos.part3.zip` (macOS/Linux) or
  `copy /b Photos.part3.zip.001+Photos.part3.zip.002 Photos.part3.zip` (Windows).
- Copies keep removed files under `S/.trash/<timestamp>/` until the trash is emptied.

### Settings and data

Settings opens from the gear at the bottom of the sidebar (or ⌘, on macOS):

- **Appearance**: System, Light or Dark theme, and the frosted glass look.
- **Background**: open at login, skip scheduled backups on battery, and notifications (after every
  backup, only failures and warnings, or never).
- **Global exclusions** skipped in every backup.
- **Configuration file**: where it lives, with **Export…** and **Import…**. Run history, scheduler
  state and change logs sit next to it in the app's data folder.

![Settings](docs/screenshots/settings.png)

![Dark theme](docs/screenshots/backup-dark.png)

## Development

You need [Node.js](https://nodejs.org/) 24 and git.

```bash
git clone https://github.com/sbuicodev/backup-manager.git
```

```bash
cd backup-manager && npm install
```

```bash
npm run dev
```

`npm run dev` starts the app with hot reload. To keep test data away from your real configuration,
point it at a throwaway profile folder:

```bash
BM_USER_DATA=/tmp/bm-dev npm run dev
```

| Script                                            | What it does                                            |
| ------------------------------------------------- | ------------------------------------------------------- |
| `npm run dev`                                     | Run the app in development mode                         |
| `npm test`                                        | Run the test suite once (`npm run test:watch` to watch) |
| `npm run typecheck`                               | Type-check main/preload and renderer                    |
| `npm run format`                                  | Format with Prettier                                    |
| `npm run lint`                                    | ESLint                                                  |
| `npm run build`                                   | Type-check and build into `out/`                        |
| `npm start`                                       | Run the built app from `out/`                           |
| `npm run build:mac` / `build:win` / `build:linux` | Package installers into `dist/`                         |

`build:win` makes the x64 installer and works on a Mac too (add `-- --arm64` for Windows on ARM).

### Releases

Pushing a version tag builds the installers on GitHub and publishes them as a release
([.github/workflows/release.yml](.github/workflows/release.yml)); every push also runs the typecheck
and tests on macOS and Windows ([test.yml](.github/workflows/test.yml)). The version comes from
`package.json`, so bump it and tag in one go:

```bash
npm version minor
```

```bash
git push --follow-tags
```

### How it is built

Electron + electron-vite, React 19, TypeScript, Tailwind CSS v4 with shadcn/ui, zod for validation,
yazl for zip writing.

```
src/
  shared/       zod config schema, shared types, IPC channel contract
  main/
    engine/     backups: walk, plan, mirror, snapshot, zip parts, retention, history, change log
    scheduler/  schedules, run queue, catch-up, retries, crash recovery
    index.ts    window, tray, notifications, power events, wiring
    handlers.ts IPC handlers (every payload validated)
  preload/      exposes window.api to the renderer
  renderer/     React UI: screens/, components/, hooks/, lib/
tests/          vitest suites for engine, scheduler, main and shared code
docs/           design specs and plans, release smoke checklist, screenshots
```

- The **engine** and **scheduler** are plain Node with no Electron imports (a test enforces this),
  so they are tested directly against real temporary folders, with a fake clock for the scheduler.
- The renderer talks to the main process only through `window.api` (context isolation and sandbox
  on); main validates every payload.
- Every file is written to a `.bm-partial` sibling and renamed into place when complete, so a crash
  never leaves a half-written file looking finished.

### Tests

```bash
npm test
```

Tests run in the `Europe/Rome` time zone (set in `vitest.config.mts`) so schedule and DST tests are
deterministic. The UI has no automated tests; before a release, go through
[docs/smoke-checklist.md](docs/smoke-checklist.md) on each OS.

### Design documents

- [docs/superpowers/specs/2026-10-25-backup-manager-design.md](docs/superpowers/specs/2026-10-25-backup-manager-design.md):
  the base design.
- [docs/superpowers/specs/2026-10-26-zip-parts-retry-timing-change-history-design.md](docs/superpowers/specs/2026-10-26-zip-parts-retry-timing-change-history-design.md):
  zip parts, retry timing and change history.
- [docs/superpowers/plans/](docs/superpowers/plans/): the implementation plans.
