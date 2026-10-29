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

## Repository and workflow
- The code is in a private GitHub repo, https://github.com/lucascaudle5/nova-ink, shared between a work machine (Cursor) and a personal machine (Codex).
- Pushing to this private remote (origin) is authorized. Making it public, or pushing anywhere else, still requires explicit permission.
- Pull before starting work; commit and push before stopping.

## Privacy and environment
- Keep the MCP server bound to 127.0.0.1 behind the existing restricted OpenAI Secure MCP Tunnel.
- Never log or commit keys, tokens, tunnel profiles, .env files, real canvas content, or %LOCALAPPDATA%\NOVA-Ink\data.
- Do not ingest employer proprietary information.
- NODE_ENV=development is for local evaluation; it does not provide a production license.
- Do not make the GitHub repo public, push to any remote other than the private origin above, redeploy, change infrastructure, or migrate personal data without explicit authorization.

## Status
Current status, verification, and next work live only in CODEX_HANDOFF.md; do not copy them here.

## Testing and compatibility rules
- Tests must use temporary directories (see tests/helpers). Session tests run the real MCP server in-memory via tests/helpers/harness.mjs. Prefer behavioral tests over source-regex tests.
- Storage changes must stay backward compatible: new fields are optional; no silent migrations.
- Actual notebook data is outside Git at %LOCALAPPDATA%\NOVA-Ink\data. Do not inspect or alter it during routine development.
- Do not intentionally corrupt real data. Use the user's disposable test canvases for acceptance work.