# Release smoke checklist

Run on each OS before a release, with an installed build (not `npm run dev`).
Use a throwaway profile by launching with `BM_USER_DATA=/tmp/bm-smoke` when possible.

## App lifecycle

- [ ] Tray / menu-bar icon appears; on macOS it follows light/dark menu bar.
- [ ] Tray menu shows a status line, one line per backup ("Documents — backed up 2 hours ago"; clicking one opens the window on it), Run all now, Cancel while running, Pause (1 hour / until resumed) or Resume, Open, Quit.
- [ ] Closing the window keeps the app in the tray; "Open" brings it back; Quit exits.
- [ ] Launching the app a second time focuses the existing window (single instance).
- [ ] Launch at login ON: after logging out/in the app starts hidden in the tray.
      Linux: `~/.config/autostart/backup-manager.desktop` exists; turning the setting OFF removes it.

## Window

- [ ] New backup: Add… picks files and folders together (macOS); Add folder… / Add files… (Windows, Linux); dropping files and folders from Finder/Explorer adds them.
- [ ] Other folder… in the assistant picks a folder and makes it a drive for that backup only.
- [ ] Create backup starts the first run (not for manual-only); Set up later leaves a "Not set up" backup that never runs.
- [ ] Edit, change a field, select another backup: Save / Don't save / Cancel prompt; quitting with unsaved changes shows Discard changes / Cancel.
- [ ] Right-click a backup: Back up now, Pause, Duplicate, Show in Finder (Explorer), Delete; right-click a Where row: Show in Finder opens that backup's folder on the drive.
- [ ] Drive page shows free space; Check now on a waiting drive checks immediately.
- [ ] Settings opens with ⌘, on macOS and from the sidebar gear.
- [ ] Windows: the native window buttons sit in the top bar and the layout matches macOS; Linux likewise.

## Backups

- [ ] Each packaging × mode produces the layout from spec §5:
      mirror copy `S/<item>/…`; mirror zip `S/<folder>/*.zip`, `S/<file>.zip` + `.backup-manager.json`;
      snapshot copy `S/<timestamp>/…`; snapshot zip-whole `S/<timestamp>.zip`; snapshot zip-children `S/<timestamp>/*.zip`.
- [ ] Second mirror run with no changes writes nothing (History shows "No changes").
- [ ] Deleting a source file moves it to `S/.trash/<timestamp>/` (trash policy).
- [ ] OneDrive (or another synced folder) works as a destination.

## Scheduling

- [ ] Set a source to daily at 2 minutes from now: it runs on time, History shows "Scheduled".
- [ ] Quit the app past a slot, relaunch: one "Catch-up" run happens.
- [ ] Pause for 1 hour: nothing runs; Resume: missed slot runs once.
- [ ] Unplug the USB destination before a scheduled run: job is skipped; plug it back in: a "Retry" run starts within a minute.
- [ ] "Skip scheduled runs on battery" ON + unplug charger: due run waits; plug in: it runs.

## Interruptions

- [ ] Close the laptop lid during a large backup; after wake the job either completes or is retried; no `*.partial` files remain at the destination.
- [ ] Force-quit during a run, relaunch: a "Recovery" run re-does the unfinished jobs.
- [ ] Unplug the USB drive during a run: that job fails with "Destination disconnected during backup"; other jobs complete.

## Notifications

- [ ] With "Only failures and warnings": a run with a skipped destination shows a notification; clicking it opens the run in History.
- [ ] A clean run shows no notification.
