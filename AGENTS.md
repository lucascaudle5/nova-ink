# NOVA Ink — Codex Repository Instructions

## Purpose
Build an iPad-first, Apple Pencil engineering notebook in ChatGPT using tldraw and MCP Apps. Maintain the working prototype; do not rebuild from scratch.

## Read first
- README.md for scripts, storage, evidence, and limitations.
- CODEX_HANDOFF.md for product decisions and status.
- server.ts, main.ts, storage.mjs, src/main.tsx, src/context.ts, and tests/.

## Engineering agreements
- Work in the existing source directory. Preserve local configuration, tunnel connectivity, and saved notebook data.
- Inspect implementation and tests before editing; make small reviewed changes.
- For meaningful changes, run npm test and npm run build:host-test when possible. Report actual results. iPad tests happen with the user.
- Never claim successful builds, deployments, data writes, or device tests without evidence.
- Do not silently alter saved snapshots, IDs, revisions, camera state, or data location.
- Show Saved only after durable server acknowledgement. On failure, show Not synced and preserve recoverable state.
- Preserve one active editor lease per canvas and revision conflict protection.
- Preserve tldraw's native Pencil/touch behavior. Top toolbar is implemented but needs iPad acceptance.
- Do not use undocumented host metadata to force an iPad side pane.
- The user initiates every AI hint. Chat hints do not mutate the canvas; AI annotations need separate explicit selection and attribution.
- Distinguish independent student work from AI-assisted edits. Separate user reports, verified behavior, plans, and assumptions.

## Privacy and environment
- Keep the MCP server bound to 127.0.0.1 behind the existing restricted OpenAI Secure MCP Tunnel.
- Never log or commit keys, tokens, tunnel profiles, .env files, real canvas content, or %LOCALAPPDATA%\NOVA-Ink\data.
- Do not ingest employer proprietary information.
- NODE_ENV=development is for local evaluation; it does not provide a production license.
- Do not publish a public GitHub repo, redeploy, change infrastructure, or migrate personal data without explicit authorization.

## Current status — October 29, 2026
- v0.2.1 is the last packaged and user-tested reference. Current local source is v0.2.3 (branch v0.2.3-reliability), not packaged or published, and not accepted until IPAD_ACCEPTANCE.md passes on a real iPad.
- v0.2.3: 16 MB HTTP body limit; idempotent saves (saveId); lease re-acquired after restart; client session controller (src/session.ts) that never discards edits silently; conflict recovery including Save my version as a new canvas; manifest backup/rebuild; missing/incompatible record recovery; 10 backups; independent backup/restore scripts (backup.mjs, npm run backup / restore); viewport-clipped Ask NOVA.
- Tests must use temporary directories (see tests/helpers). Session tests run the real MCP server in-memory via tests/helpers/harness.mjs. Prefer behavioral tests over source-regex tests.
- Storage changes must stay backward compatible: new fields are optional; no silent migrations.
- User reported persistence after closing/reopening NOVA Ink and restarting the local server; server outages were reported to show failures as intended.
- Desktop ChatGPT web has a functional conversation side panel. Native iPad ChatGPT does not provide dependable simultaneous drawing and conversation.
- Native tldraw toolbar is in the top panel in this source; Pencil and touch need iPad verification.
- Backup listing and restore are implemented. Restore creates a new revision; a corrupt current file is copied under recovery/ first.
- Unit tests cover lease acquisition/expiry, conflict handling, backup restore, corrupt records, and retention. They do not prove live multi-client or iPad behavior.
- On October 29, npm test passed 76 tests and npm run build:host-test completed in development mode. Repeat after code changes.
- Actual notebook data is outside Git at %LOCALAPPDATA%\NOVA-Ink\data. Do not inspect or alter it during routine development.

## Next work
With the user and disposable test canvases:
1. Verify lease handoff between two independent clients and that an expired editor cannot save.
2. Restore an earlier valid backup through Host tools → Backups and confirm a new revision.
3. Verify toolbar, Pencil, finger pan/zoom, persistence, and canvas switching on iPad.

Do not intentionally corrupt real data. After acceptance, prioritize PDF page import with source provenance and page-associated annotations. Do not publish or redeploy without explicit authorization.
