# Mac-Style UI Rework — Design

Date: 2026-11-03
Status: Draft, awaiting review
Branch: `ui/mac-rework`
Extends: `2026-10-25-backup-manager-design.md` (the "base spec"). The backup engine, scheduler and
configuration rules stay as they are unless this document says otherwise.

## 1. Goals

- Make it obvious **what goes where**: every backup shows its files and folders and the drives it
  goes to on one page, and every drive shows the backups that go to it.
- Make it easy to **set up** a backup: a short assistant for the common case, full control in the
  editor.
- Make it easy to **keep track**: status visible at a glance in the sidebar and the menu bar.
- **Less clutter**, closer to a native Mac app (Mail, Notes, System Settings): one sidebar, one
  detail pane, plain-language summaries, pop-up menus instead of blocks of radio buttons.

Not in scope: a map overview of all backups and drives (possible later), a restore UI, changes to
how backups are made.

## 2. Window

```
┌ toolbar ─────────────────────────────────────────────────────────────┐
│ [panel] Backup Manager        ● Next: Documents at 22:00  [Back up now]│
├ sidebar ─────────┬ detail ────────────────────────────────────────────┤
│ Backups          │                                                    │
│ ● Documents      │   (the selected backup, drive or Activity)         │
│ ● Photos         │                                                    │
│ ○ Tax (not set up)│                                                   │
│ Drives           │                                                    │
│ ▣ Backup Drive   │                                                    │
│ ▣ NAS            │                                                    │
│ ▢ USB stick      │                                                    │
│ ─────────────    │                                                    │
│ ◷ Activity       │                                                    │
│ [+] New backup   ⚙ │                                                  │
└──────────────────┴────────────────────────────────────────────────────┘
```

- **Toolbar** (the existing custom top bar): sidebar toggle, app name, the scheduler status
  ("Next: Documents at 22:00", "Waiting for USB stick · next check in 3 min", "Paused"), Pause and
  **Back up now**. While a run is active, Back up now becomes **Stop**. Hovering Back up now shows
  what it would do, from the existing plan: "Will copy 3 files (156 KB) · 1 drive not connected".
- **Sidebar**, three sections:
  - **Backups**, in config order, each with a status dot: green (last run fine), amber (waiting
    for a drive or finished with warnings), red (failed), grey ring (not set up), a small progress
    ring while it runs, and a pause glyph when disabled.
  - **Drives**: the shared destinations. Destinations exclusive to one backup are not listed here;
    they appear on that backup's page (see §4). A drive that is not connected is greyed out.
  - **Activity**.
  - At the bottom: **New backup** (opens the assistant) and a gear for **Settings** (also ⌘, on
    macOS through the app menu).
- The collapsed sidebar keeps working as today (icons only, tooltips); backups then show their
  status dot with the name as tooltip.
- The glass appearance and centred content column stay.

Right-click on a backup in the sidebar: Back up now, Pause/Resume this backup (its `enabled`
switch), Duplicate, Show in Finder (Explorer on Windows; the backup's folder on the first connected
drive), Delete… (confirmation as today).

Right-click on a drive: Show in Finder, Edit…, Remove… .

## 3. A backup's page

### 3.1 Reading

```
Documents                                                        [Edit]
Mirror · plain files · every 4 hours · last backed up 2 hours ago

What                                         Where
┌───────────────────────────────┐            ┌──────────────────────────────────────┐
│ ▤ Documents   ~/Documents     │            │ ● Backup Drive        2 hours ago    │
│ ▢ tax.pdf     ~/Desktop       │            │ ● USB stick  waiting · next 15:40  [Check now] │
└───────────────────────────────┘            └──────────────────────────────────────┘

Last run   Today 14:02 · 3 files changed  ›        (opens it in Activity)
Options    Schedule, versions, deletions, exclusions, zip  ›
```

- **Header**: the name, then one summary sentence built from the settings:
  `<Mirror|Versions> · <plain files|one zip|a zip per item> · <schedule> · <last backed up …>`.
  A manual-only backup reads "runs only when you click Back up now"; one that has never run reads
  "not backed up yet".
- **What**: the items, folder or file icon, name, and the path shortened with `~`.
- **Where**: one row per destination this backup goes to (exclusive ones included, marked "only
  this backup"), each with its own status from the last run and the scheduler: "2 hours ago",
  "waiting · next check 15:40" with **Check now**, "failed · disk full", "not connected", "never".
  Right-click a row: Show in Finder (that backup's folder on that drive).
- **Last run**: a one-line summary that links to that run in Activity.
- **Options**: one row summarising the remaining settings; clicking it enters editing with the
  Options group open.
- Narrow windows stack What above Where.

### 3.2 Editing (explicit Save)

- **Edit** turns the page into a form in place. Nothing is written until **Save**; **Cancel**
  discards. An "Unsaved changes" marker shows when the form differs from what is saved.
- Selecting something else, closing the window or quitting with unsaved changes asks: Save, Don't
  save, Cancel.
- Validation errors appear next to the field they concern (the existing readable messages), and
  Save stays available; saving with errors shows them instead of saving.
- Groups, System Settings style (inset grouped rows, one pop-up menu or switch per row):
  - **General**: Name; Folder name at destination.
  - **What**: the item list with remove buttons; **Add…** (macOS, files and folders together) or
    **Add folder…** / **Add files…** (Windows, Linux); files and folders can also be dropped onto
    the list from Finder/Explorer.
  - **Where**: shared drives as checkboxes ("All drives" on top); this backup's own drives with
    Add/Edit/Remove (as today).
  - **Schedule**: Run — Every N hours / Every day at … / Every week on … at … / Only when I click
    Back up now; Retry when a drive comes back (switch).
  - **Versions**: Keep an up-to-date copy (mirror) / Keep dated versions (snapshots); for
    versions: Always keep at least N, Delete versions older than N days or Never.
  - **Deletions** (mirror only): When a file is deleted — Move it to the trash / Delete it / Keep
    it; Empty the trash after N days or Never.
  - **Exclusions** (only with a folder item): the pattern list and "Also use the global
    exclusions".
  - **Zip**: Store as — Plain files / One zip / A zip per item; then compression, loose files,
    split size, large files and chunk size, as today.
- The fields and rules are the existing ones; only the layout changes.

## 4. A drive's page

```
NAS                                      ● Connected · 412 GB free   [Edit]
/Volumes/NAS

Backups going here
● Photos      Sundays at 03:00 · 3 days ago
● Projects    Daily at 22:30 · yesterday
+ Send another backup here…

Show in Finder
```

- Header: name, path, connection state and free space (new: free space of the drive holding the
  destination folder; "not connected" when it is missing).
- **Backups going here**: every backup that targets this drive, with its schedule and last run on
  this drive; clicking one selects it. **Send another backup here…** offers the backups that do not
  target it yet and adds the drive to the chosen one's destinations (saved right away — this is a
  single explicit action, not a form).
- **Edit** opens the existing destination dialog (name, folder, zip part limit, force chunking);
  it already has Save/Cancel.
- Exclusive destinations are not listed in the sidebar: they belong to their backup, shown in its
  Where list and edited from its form. Their page is reachable from that Where row.
- **Remove…** (right-click or the page menu): as today, with the list of affected backups.

## 5. Activity

- Runs grouped by day (Today, Yesterday, then dates), newest first, each with its trigger when it
  is not manual ("Scheduled", "Catch-up", "Retry", "Recovery").
- A run row shows each job as "Backup → Drive" with its status dot and a short result ("3 files",
  "1 archive", "waiting", "failed · disk full"). Clicking a job expands its change list (the
  existing `ChangeList`, with filters and search).
- A filter at the top: All, or one backup, or one drive.
- The live progress of a running backup shows at the top of Activity and on that backup's page
  (bar, current file, Stop).

## 6. New backup assistant

A sheet with three steps and a footer: **Set up later** on the left, **Back** and
**Continue** / **Create backup** on the right.

1. **What to back up**: the item list as in editing, with a drop area ("Drop files and folders
   here"). Continue needs at least one item.
2. **Where it goes**: tiles for the shared drives (several can be selected; not connected ones are
   shown and selectable, marked "not connected"), and **Other folder…** which adds a destination
   for this backup only. Continue needs at least one.
3. **How and when**:
   - Keep an up-to-date copy (mirror, plain files) — default — or Keep dated versions (snapshots,
     keep 10).
   - Run it: Every day at 22:00 (default) / Every 4 hours / Only when I click Back up now.
   - "You can change more options later."

**Create backup** saves it with defaults for everything else (name and folder name from the
first item), selects it, and starts its first run unless it is manual-only.

**Set up later** (any step) saves what was entered as a backup that is **not set up**: grey dot,
"Not set up" in the sidebar and as its summary, an **Edit** button inviting to finish. It never
runs and is never scheduled. It becomes a normal backup when it is saved from the editor with at
least one item and one destination (§8).

## 7. Menu bar / tray

The tray keeps a native menu (Time Machine style) rather than a custom popover:

```
Documents — backed up 2 hours ago
Photos — waiting for USB stick
Projects — yesterday at 22:30
Tax — not set up
──────────
Back up now
Cancel running backup        (while running)
Pause for 1 hour / Pause until resumed / Resume
──────────
Open Backup Manager
Quit
```

Each status row shows a small status dot image and, when clicked, opens the window with that
backup selected.

## 8. Data changes

- `Source.setupComplete: boolean` (default `true`; existing configs load as complete).
  - When `false`: validation allows zero items and zero destinations; the backup is excluded from
    scheduling, catch-up, retries, Run all and the plan; it can't be run individually ("Finish
    setting it up first").
  - Saving from the editor sets it to `true`. The configuration rules then apply as today (at
    least one item). The editor additionally refuses to finish setup without at least one
    destination, shared or its own; this check lives in the editor only, so existing configs that
    have none still load.
- Manual-only schedules already exist (`schedule: null`).
- No change to the backup engine or the layout on the drives.

New IPC calls (validated like the others):

- `destinations.info(destId)` → `{ available, freeBytes | null }`.
- `shell.showInFolder(path)` → reveals a folder in Finder/Explorer; only paths inside a configured
  destination are accepted.
- `scheduler.checkNow(sourceId, destId)` → resets that pending retry's timing and runs a check
  (the same as wake-from-sleep, for one pair).
- `app.onSelect(cb)` (main → renderer) → the tray asks the window to select a backup.

Drag and drop: the preload exposes `webUtils.getPathForFile` so dropped files become paths; the
main process stats them to tell files from folders (as `dialog.pickItems` does).

## 9. Kept, moved and removed

| Today | After |
| --- | --- |
| Sources screen (table) | Sidebar Backups + backup pages |
| Source editor sheet | Assistant for new backups; editing in place on the page |
| Destinations screen (table) | Sidebar Drives + drive pages |
| Run screen (preview, progress, last run, waiting) | Back up now hover preview; progress on the backup page and in Activity; waiting on Where rows |
| History screen | Activity |
| Settings screen | Settings, from the sidebar gear and ⌘, |
| Header status strip | Toolbar (already in place) |

## 10. Testing

- Unit tests (vitest): the summary sentence for each combination of mode, packaging and schedule;
  `setupComplete` validation and its exclusion from planning, scheduling and retries; the new IPC
  handlers (argument validation, the Show in Finder path check, Check now); free-space lookup for a
  missing folder.
- In the running app (CDP screenshots, as before): the sidebar states, a backup page reading and
  editing (unsaved marker, leave-with-changes prompt), a drive page, Activity with a filter and an
  expanded run, the assistant including Set up later and manual-only, light and dark, glass on and
  off, collapsed sidebar.
- Not automatable here: native pickers, drag and drop from Finder, the tray menu, and Windows and
  Linux; listed in the smoke checklist.
