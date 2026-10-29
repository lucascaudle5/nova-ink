# NOVA Ink v0.2.3 — physical iPad acceptance checklist

**Status: PENDING.** v0.2.3 is not accepted until every required item passes on a real iPad in the native ChatGPT app.

Before starting: back up real data (`npm run backup`), launch with start-windows-test.cmd, and confirm `/health` reports version 0.2.3. Use canvases named `Test — …`; do not experiment on real coursework canvases. Record Pass / Fail / Notes for each step, plus iPad model, iPadOS version, and ChatGPT app version.

## 1. Apple Pencil
- [ ] Write a paragraph and an equation quickly; no dropped or delayed strokes compared with v0.2.1.
- [ ] Pressure and eraser behave as in v0.2.1. Toolbar sits at the top and every tool is reachable.
- [ ] Status shows Unsaved changes → Saving… → Saved within a few seconds of stopping.

## 2. Palm and finger
- [ ] Rest your palm while writing: no stray marks, no accidental pan.
- [ ] One finger does not draw while the pen tool is active with Pencil (tldraw's pen mode).
- [ ] Tapping banner buttons and the library with a finger works first time.

## 3. Pan and zoom
- [ ] Two-finger pan and pinch zoom are smooth on a canvas with 300+ strokes.
- [ ] After pan/zoom only, status returns to Saved; reopening restores the same view.

## 4. Rotation and narrow layouts
- [ ] Rotate portrait ↔ landscape while idle and mid-save; nothing is lost and the status stays accurate.
- [ ] In portrait and in Split View/Slide Over (if available), banners wrap fully, every action button is visible and tappable, and nothing is truncated.

## 5. Backgrounding
- [ ] Write, then immediately switch apps. Return after 10 s: either Saved or a visible retry; strokes present.
- [ ] Background for 2+ minutes (lease expires). On return the canvas either saves normally or offers Take over / Save my version as a new canvas; no silent loss.

## 6. Close and reopen
- [ ] Write, wait for Saved, close NOVA Ink, reopen in a new invocation: drawing, position, zoom, and last canvas all return.
- [ ] Write and close **before** Saved appears. Reopen and note whether the last strokes survived (expected best effort; record result).
- [ ] Reopen immediately after closing: editing resumes without a "someone else is editing" block.

## 7. Large canvases and images
- [ ] Fill a canvas with dense handwriting (several pages' worth). It saves and reopens.
- [ ] Paste a large photo (e.g. 12 MP camera image). It is downscaled, the canvas saves, and reopens with the image.
- [ ] Keep adding images until the canvas is too large: a clear "too large… Nothing was saved" style message appears, and earlier saved state is intact on reopen.

## 8. Server interruption and recovery
- [ ] While writing, stop the server (Ctrl+C). Status moves to Not saved/Offline with retries; drawing remains possible and nothing is cleared.
- [ ] Restart the server: pending edits save automatically (or via Retry now) and show Saved.
- [ ] Try switching canvases while the server is down: refused with an explanation, edits kept.
- [ ] Open the same test canvas on a second device/client: second shows Read only. On the first, keep writing; on the second, use Save my version as a new canvas after drawing → a new canvas holds the second device's work.
- [ ] Host tools → Backups on a test canvas: restore an earlier revision; it appears as a new revision.

## 9. Navigation
- [ ] Switch between three canvases repeatedly; contents stay separate and nothing is lost.
- [ ] Tap the currently open canvas in the library: it just closes the library (no reload, no loss).
- [ ] Create a new canvas while the current one has unsaved strokes: the strokes are saved first.
- [ ] Fullscreen ↔ inline and the ChatGPT overlay: canvas state, status, and camera are retained.

## 10. Ask NOVA
- [ ] With nothing selected, Ask NOVA sends only what is on screen (ask ChatGPT to describe the image; off-screen work must not appear).
- [ ] With a selection, only the selection is sent. The panel's disclosure text matches what happened.

## Sign-off
Tester: ______  Date: ______  Device / iPadOS / ChatGPT version: ______
Result: ☐ Accept v0.2.3  ☐ Reject (list failing steps)
