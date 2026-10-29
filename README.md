# NOVA Ink v0.2.3 working copy — reliability hardening

NOVA Ink is a private tldraw MCP App for ChatGPT on iPad. Focus Mode is the working experience: write independently, request help intentionally, then return to the canvas without losing the camera. Desktop conversation side-by-side is available; iPad side-by-side use is not dependable.

## Status

Current status, versions, and verification results: see CODEX_HANDOFF.md (the single source of truth).

## What v0.2.3 changes

- **Large canvases save.** The HTTP body limit is 16 MB (it was Express's default 100 KB, which silently broke saves of heavy handwriting or pasted images). Requests over the limit get an explicit "Nothing was saved" error. Snapshots over 12 MiB are refused by the store with their size; the app refuses before sending. Pasted images are downscaled to 2048 px and capped at 8 MB.
- **Edits are never discarded silently.** Switching canvases, creating, restoring, releasing, or tapping the current canvas first saves pending work; if that save fails, the action is refused with a reason. The editor is frozen during transitions so strokes can't land on the wrong canvas.
- **Conflicts are recoverable.** After a revision conflict or lost editing lease, your local version stays on screen and you can: Save my version as a new canvas, Take over (when the other editor is gone), or Discard and load the saved version (two-tap confirm).
- **Saves are idempotent.** Each save carries a `saveId`; a retried save whose first reply was lost is recognised instead of reported as a conflict.
- **Server restarts don't strand edits.** A save with the current revision re-acquires the lease if no one else holds it. The editor client ID persists across reloads, so reopening resumes editing.
- **Storage self-recovers.** A corrupt or missing manifest is restored from `manifest.backup.json` or rebuilt from canvas files (names are now stored in each record). Missing canvas records and snapshots tldraw can't load enter "Recovery needed" with backup restore or Start this canvas over; damaged files are moved to `recovery/`, never deleted. Ten backups are kept, and camera-only saves no longer push out real revisions.
- **Status is honest.** Saved, Unsaved changes, Saving…, Not saved (auto-retry with backoff, plus Retry now), Conflict, Read only, Recovery needed, Offline. Banners wrap on narrow iPad widths and actions are full-size buttons.
- **Ask NOVA discloses only what is shown.** With nothing selected, the image is clipped to the visible viewport and shapes that extend off-screen are marked partially visible without their off-screen text. The panel says what will be sent.
- **Independent backup and restore** (below).

## Run on Windows

From the project folder containing package.json:

    npm install
    npm test
    npm run build:host-test
    npm run start

Faster dev loop:

    npm run typecheck                                       # tsc --noEmit, no tests
    npm run typecheck:watch                                 # re-check on every save
    npm run test:watch                                      # re-run tests/*.test.mjs on change
    node --import tsx --test --test-force-exit tests/session.test.mjs    # run a single test file
    node --import tsx --test --test-force-exit --test-name-pattern "conflict" tests/session.test.mjs   # filter by test name

Keep `--test-force-exit` for single files: session.test.mjs (and others that start servers) does not exit on its own without it. It cannot be combined with `--watch`, so `test:watch` omits it. Each test file runs in its own process, and importing tldraw costs roughly 3 to 6 s per process, which is where most of the `npm test` time goes.

Or run start-windows-test.cmd. The server listens at http://127.0.0.1:3001/mcp; `/health` reports the version. Keep the existing restricted tunnel and plugin. Refresh the plugin if ChatGPT shows a cached older UI.

### Data location and compatibility

Data lives at %LOCALAPPDATA%\NOVA-Ink\data (override with `NOVA_INK_DATA_DIR`). v0.2.3 reads v0.2.1/v0.2.2 data as-is; no migration runs. New fields (`saveId`, `savedBy`, `savedAt`, `meta`, `createdBySaveId`, `manifest.backup.json`) are additive and ignored by older versions, so rolling back to v0.2.2 still opens every canvas.

## Independent backup and restore

Stopping NOVA Ink first is recommended but not required; files that change during the copy are re-copied, and every file is verified by SHA-256.

    npm run backup                                  # → Documents\NOVA-Ink-Backups\nova-ink-backup-<time>\
    npm run backup -- --out E:\NOVA-Backups         # e.g. a USB drive or synced folder
    npm run restore -- --verify <backup folder>     # check a backup without restoring
    npm run restore -- <backup folder> <empty folder>

Restore only writes into a folder that is missing or empty; it never overwrites your live data. To switch to the restored copy, stop NOVA Ink and start it with `$env:NOVA_INK_DATA_DIR = '<that folder>'`. Copying the backup folder off this machine is what provides disaster recovery; NOVA Ink does not upload anything.

## Limitations

Private single-process prototype: no end-user authentication, encryption at rest, simultaneous editing, or durable offline mode. If the app closes before Saved appears, the last edits may be lost (teardown attempts a final save). Separate server processes do not coordinate leases. Keep it on 127.0.0.1 behind the tunnel; do not store employer or confidential documents. The tldraw development build is for local evaluation, not production licensing.
