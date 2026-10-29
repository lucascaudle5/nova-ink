# NOVA Ink — Codex Handoff

**Snapshot:** October 29, 2026  
**Packaged reference:** v0.2.1, user-tested on iPad
**Current local working copy:** v0.2.2; not repackaged or published

## Mission
A ChatGPT-integrated engineering notebook for actual coursework. Preserve productive independent problem-solving while allowing student-initiated contextual tutoring.

## Status and evidence

### User-reported acceptance
- Native ChatGPT iPad app opens NOVA Ink with tldraw Apple Pencil writing and touch pan/zoom.
- The app sends a rendered viewport image and shape context to ChatGPT; handwriting and simple equations were understood in chat.
- Named canvases and server-confirmed autosave work; drawing and camera returned after close/reopen and local server restart.
- Server outages are reported as failures.
- Desktop ChatGPT web has a functional conversation side panel.
- On native iPad ChatGPT, the canvas and conversation overlay work, but drawing pauses while the overlay is open. Returning to the canvas retains state.
- iPad Safari side panel renders, but canvas controls are intercepted.
- User reported the private-tool widget warning disappeared after the v0.2.1 metadata fix.

### Current source and local verification
- The v0.2.2 working copy moves tldraw's native toolbar to the top panel. This change has not been tested on iPad.
- Host tools → Backups lists valid local revisions. Restore creates a new revision, preserves the current valid revision, and checks revision and editor lease.
- If the current record is corrupt, the original is copied to recovery/ before a backup is restored.
- Saving requires an unexpired editing lease. Server acknowledgements and revision conflicts remain in place.
- On October 29, 2026, npm test passed all 24 tests and npm run build:host-test completed in development mode.
- These automated checks are not live host/iPad acceptance. Real two-client handoff, iPad toolbar acceptance, production deployment, and off-machine recovery remain unverified.

## Implementation map
- main.ts: MCP endpoint at 127.0.0.1:3001/mcp, /health, and optional stdio.
- server.ts: UI resource, visible open_nova_ink launcher, and eight app-only notebook/recovery tools. Only the launcher declares the widget resource.
- storage.mjs: single-process JSON store, snapshots, five valid prior backups, optimistic revision checks, and 45-second editor lease (15-second UI heartbeat). Default data is %LOCALAPPDATA%\NOVA-Ink\data.
- src/main.tsx: embedded tldraw, 650 ms autosave, named library/resume, viewport-first Ask NOVA, top toolbar, and backup recovery UI.
- src/context.ts: geometry and context selection. src/styles.css: notebook and backup panel.
- scripts/build-host-test.mjs: development-mode evaluation build.

## Accepted product decisions
1. Native ChatGPT on iPad, Apple Pencil first. Desktop is mainly for imports, organization, and development.
2. Independently named course canvases; resume the last canvas on launch.
3. Online-first server snapshots, honest Saved/Saving/Not synced status, and camera recovery. Durable offline support is deferred.
4. One active editor per canvas, with safe control handoff.
5. Preferred future Study Mode is native ChatGPT and canvas side-by-side. iPad v1 uses fullscreen canvas with a native conversation overlay; do not force unsupported metadata.
6. Put the drawing toolbar on top and preserve tldraw's native pen/touch feel.
7. PDFs should become separate movable pages with source provenance; page annotations travel with pages. Provide lock and detach controls.
8. Inspect selected items or the visible viewport first. Do not pan the user's camera.
9. No unsolicited hints. Student initiates chat hints and any Annotate Canvas action. Do not show arbitrary percent-correct estimates.
10. Distinguish independent work, hints, and AI-authored annotations in future learning records.
11. Long-term replay/event ledger is required but not implemented.

## Risks
- No end-user authentication; use only through the private restricted tunnel.
- Backups are on the host machine; no tested off-machine recovery.
- Single-process JSON prototype with 12 MiB per-canvas limit; separate server processes do not coordinate leases.
- AI annotation mode is not implemented.
- Top toolbar and backup UI need iPad acceptance.
- No guaranteed iPad side-by-side interaction.
- Tldraw licensing is required before production.
- Secrets, private tunnel identity, and actual notebook data stay outside Git.

## Initial setup completed
The package folder has a local Git repository and the user's personal author identity. The v0.2.1 source baseline is committed locally; there is no remote and nothing is published. The NOVA ARCHAELOGY chat workspace remains separate from the code package.

## Next steps
1. Verify lease handoff using two independent clients.
2. On a disposable canvas, restore an earlier backup and confirm a new revision.
3. On iPad, verify toolbar, Apple Pencil, touch pan/zoom, canvas resume, and save status.
4. After acceptance, plan PDF page import and page-associated annotations.
