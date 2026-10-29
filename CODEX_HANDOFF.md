# NOVA Ink — Codex Handoff

**Snapshot:** October 29, 2026  
**Packaged reference:** v0.2.1, user-tested on iPad
**Current local working copy:** v0.2.3 (branch v0.2.3-reliability); not repackaged or published; iPad acceptance pending (IPAD_ACCEPTANCE.md)

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
- v0.2.3 reliability hardening: 16 MB HTTP limit with explicit errors; idempotent saveId saves; lease re-acquired after server restart; persistent editor client ID; client session controller (src/session.ts) that saves before every transition and refuses rather than discards; conflict recovery (Save my version as a new canvas, Take over, confirmed Discard); manifest backup and rebuild; missing/incompatible-record recovery and Start this canvas over; 10 backups; independent verified backup/restore (npm run backup / restore); viewport-clipped Ask NOVA with disclosure text.
- On October 29, 2026, tsc was clean, npm test passed 76/76 (HTTP payload, storage recovery, session lifecycle against the real MCP server, context disclosure, backup/restore), and npm run build:host-test completed in development mode. Repeat after code changes. Automated tests use temporary folders only.
- Unit tests cover lease acquisition/expiry, conflict handling, backup restore, corrupt records, and retention. They do not prove live multi-client or iPad behavior.
- These automated checks are not live host/iPad acceptance. Real two-client handoff, the iPad checklist, production deployment, and off-machine recovery remain unverified.

## Implementation map
- main.ts: MCP endpoint at 127.0.0.1:3001/mcp, /health, and optional stdio.
- server.ts: UI resource, visible open_nova_ink launcher, and eight app-only notebook/recovery tools. Only the launcher declares the widget resource.
- http.ts: Express app (16 MB JSON limit, structured 413/400 errors, /health).
- storage.mjs: single-process JSON store, snapshots, ten valid prior backups, manifest backup/rebuild, optimistic revision checks, idempotent saveId, and 45-second editor lease (15-second UI heartbeat). Default data is %LOCALAPPDATA%\NOVA-Ink\data.
- backup.mjs + scripts/backup-data.mjs, scripts/restore-data.mjs: independent verified backup; restore only into an empty folder.
- src/session.ts: CanvasSession — all save/open/switch/conflict/recovery logic, testable without a browser. src/snapshot.ts: tldraw load validation.
- src/main.tsx: React/tldraw view over CanvasSession, status banners, backup panel, viewport-clipped Ask NOVA, top toolbar.
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

## Repository and workflow
- The code is in a private GitHub repo, https://github.com/lucascaudle5/nova-ink, shared between a work machine (Cursor) and a personal machine (Codex). Active branch: v0.2.3-reliability.
- Pushing to this private remote (origin) is authorized. Making it public, or pushing anywhere else, still requires explicit permission. Nothing is packaged or published.
- Workflow: pull before starting, commit and push before stopping.
- The package folder's Git repository uses the user's personal author identity; the v0.2.1 source baseline was the first commit. The NOVA ARCHAELOGY chat workspace remains separate from the code package.

## Next steps
1. Run IPAD_ACCEPTANCE.md on a physical iPad (includes two-client handoff and backup restore). With the user and disposable test canvases:
   - Verify lease handoff between two independent clients and that an expired editor cannot save.
   - Restore an earlier valid backup through Host tools → Backups and confirm a new revision.
   - Verify toolbar, Pencil, finger pan/zoom, persistence, and canvas switching on iPad.
   - Do not intentionally corrupt real data.
2. Next priority after iPad acceptance, ahead of v0.3 notebooks: PDF page import. PDF pages become separate movable pages with source provenance (document, page number), and page-associated annotations travel with their pages. Provide lock and detach controls. Plan it first; storage changes stay backward compatible.
3. v0.3 (incremental, backward compatible): notebooks grouping canvases, rename, soft-delete trash, metadata search, explicit schema versioning with opt-in migration.
4. Do not publish or redeploy without explicit authorization.
