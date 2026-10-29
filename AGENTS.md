# NOVA Ink — Codex Repository Instructions

## Purpose
Build an iPad-first, Apple Pencil engineering notebook inside ChatGPT using tldraw + MCP Apps. Maintain the existing working prototype; avoid rebuilding it from scratch.

## Read first
- `README.md` — actual scripts, storage format, and limitations.
- `CODEX_HANDOFF.md` — accepted product decisions, test evidence, and next priorities.
- `server.ts`, `main.ts`, `storage.mjs`, `src/main.tsx`, `src/context.ts` — current implementation.
- `tests/` — current automated expectations.

## Engineering agreements
- Work directly in the existing working source directory. Preserve its local configuration, tunnel connectivity, and saved notebook data.
- Prefer small, reviewed changes and Git commits over full-package replacement.
- Before editing, inspect the existing implementation and tests; do not assume earlier chat descriptions exactly match the local files.
- For meaningful changes, run `npm test` and `npm run build:host-test` when possible, and report commands/results. Run an iPad host test only with the user.
- Never claim a successful build, deployment, data write, or on-device test without evidence.
- Do not silently alter existing saved snapshots, canvas IDs, revisions, camera state, or the data storage location.
- The server must not claim `Saved` until it receives a successful durable save acknowledgement. On error, use `Not synced` and preserve recoverable local state.
- Preserve one active editing lease per canvas and server-side revision conflict protection.
- Prefer default tldraw pencil/touch behavior; user already confirmed Apple Pencil and finger pan/zoom work naturally.
- ChatGPT host controls presentation. Do not add undocumented display-mode flags to force a native iPad side pane.
- The user initiates every AI hint. Chat hints do not mutate the canvas; AI annotations require a separate explicit selection and attribution.
- Keep the user's independent work distinguishable from AI-assisted edits in future learning records.
- Distinguish reported observations, verified runtime behavior, future plans, and assumptions.

## Privacy and environment
- Keep MCP server bound to `127.0.0.1` and use the existing restricted OpenAI Secure MCP Tunnel for testing.
- Do not log or commit API keys, tokens, tunnel profiles, `.env` files, real canvas contents, or `%LOCALAPPDATA%\\NOVA-Ink\\data`.
- Keep project ownership and use of employer resources separate; do not ingest employer proprietary information.
- Current tldraw build uses `NODE_ENV=development` for local evaluation. Do not claim this provides a production license.
- Do not create or publish public GitHub repositories, redeploy, change infrastructure, or migrate personal data without explicit user approval.

## Current baseline
- **v0.2.1** is the last packaged reference, with app-only widget metadata fix.
- User reported on October 29, 2026 that persistence survives closing/reopening and backend restarts; failure on server outage behaved as intended.
- Side-by-side layout works in Windows ChatGPT web; native iPad ChatGPT currently exposes working fullscreen/inline presentation, not usable simultaneous drawing plus conversation.
- Two remaining *separately testable* reliability items: concurrent editor handoff and backup recovery. Neither should be marked complete based on earlier unit tests alone.

## Suggested next task
Establish a safe Git baseline and verify the current repository, tests, storage behavior, and known limits. Then propose a small implementation sequence for top-mounted toolbar and PDF imports. Ask before destructive actions or publication.
