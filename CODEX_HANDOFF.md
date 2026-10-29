# NOVA Ink — Codex Handoff
**Snapshot:** October 29, 2026  
**Reference:** v0.2.1 working prototype (user-tested on iPad)

## Mission
A ChatGPT-integrated engineering notebook that is useful for solving actual coursework. Preserve the benefits of productive independent struggle while allowing student-initiated contextual tutoring.

## Status and evidence (do not conflate)
### User-reported acceptance results
- Native ChatGPT iPad app opens NOVA Ink with functioning tldraw Apple Pencil handwriting and touch panning/zoom.
- The app sends a rendered viewport image plus shape context to ChatGPT; handwriting and simple equations were understood in chat.
- Named canvases and asynchronous server-acknowledged autosave work.
- User reported that handwriting, zoom, and camera position were restored after closing/reopening and after restarting the local MCP server.
- User reported failures are correctly surfaced when the server is shut off.
- Desktop ChatGPT web has a functional native conversation side panel.
- iPad native app: fullscreen canvas and native conversation overlay work, but interaction with canvas stops while overlay is open. Restoring overlay retains canvas state.
- iPad Safari side panel renders but canvas controls are intercepted; not a viable primary experience.
- One private-tool widget warning on ChatGPT refresh disappeared after v0.2.1 metadata fix (reported by user).

### Automated checks in source
- Node tests exist in `tests/context.test.mjs`, `tests/storage.test.mjs`, `tests/thread-entrypoint.test.mjs`, `tests/widget-metadata.test.mjs`.
- Re-run locally rather than assuming tests still pass; prior reports are historical.
- Full production-licensed deployment, external disaster recovery, real multi-device collision acceptance, and backup restoration after corruption are NOT verified.

## Existing implementation map
- `main.ts`: Express Streamable HTTP MCP endpoint `127.0.0.1:3001/mcp`; `/health` endpoint; optional stdio.
- `server.ts`: UI resource `ui://nova-ink/canvas`, visible tool `open_nova_ink`, six app-only notebook tools. The visible tool advertises an `openai/ui` thread entrypoint. **App-only tools must NOT declare `ui.resourceUri`**; that previously broke tool refresh.
- `storage.mjs`: server-side JSON store, manifest, snapshots, prior 5 backups, optimistic revision check, 45s editing lease (15s heartbeat in UI). Default storage `%LOCALAPPDATA%\\NOVA-Ink\\data` on Windows.
- `src/main.tsx`: embedded tldraw, autosave after 650ms inactivity, server acknowledgments, named canvas list, resume last, viewport-first Ask NOVA, host display requests.
- `src/context.ts`: geometry/context selection. `src/styles.css`: current notebook layout.
- `scripts/build-host-test.mjs`: development-license evaluation build with `NODE_ENV=development`.

## Confirmed design decisions
1. **Target:** Native ChatGPT on iPad, Apple Pencil first. Desktop is mainly for imports, organization, and development.
2. **Organization:** Independently named, course-associated infinite canvases; automatically resume last canvas on launch.
3. **Saving:** Online-first v1, server-persisted snapshots, honest `Saved`/`Saving`/`Not synced` status, camera recovery. Durable offline support deferred.
4. **Editing:** One active editor per canvas; desktop allowed to take control for importing material, with safe handoff.
5. **Presentation:** Preferred future Study Mode = native ChatGPT and canvas side-by-side. For iPad v1, Focus Mode fullscreen with a native ChatGPT conversation overlay. Host controls input while overlay is open; don't force unsupported API fields.
6. **UI:** Drawing toolbar on TOP, never bottom. Preserve tldraw's native pen/touch feel; dark graph paper is desirable but secondary.
7. **Imports:** PDFs become separate movable canvas pages (not a monolithic scrolling PDF). PDF annotations travel with pages when moved or resized; handwriting elsewhere remains separate. Provide lock and detach controls.
8. **AI context:** First inspect selected items or the visible viewport; examine elsewhere on the canvas when context requires it; do not pan the user's camera.
9. **Tutoring:** No unsolicited hints. The student explicitly initiates a chat hint or separately selects Annotate Canvas. Productive/local errors get minimal hints. Fundamentally invalid approaches get a substantial conceptual correction that preserves the student's responsibility for the solution. Do not present arbitrary percentage-correct estimates.
10. **Learning history:** Record and distinguish independent work, hints, and AI-authored annotations. Later infer recurring conceptual difficulties only from linked evidence, and mention relevant well-supported patterns constructively.
11. **Replay:** Long-term requirement: chronological event ledger incl. strokes, erasures, moves, undo, timestamps, automatic/manual chapters, and replay. **Not yet implemented**.

## Non-goals for the immediate sprint
- Reimplementing tldraw's drawing engine.
- Promising ChatGPT iPad native side-panel support via undocumented host metadata.
- Cloud/multi-instance deployment, production-level security, durable offline usage.
- Automatically grading handwriting without inspecting the actual rendered canvas and its problem context.

## Open risks / tech debt
- No end-user authentication on the local prototype; use only through private restricted tunnel.
- Backups are local to the hosting Windows machine. No tested off-machine disaster recovery.
- Current storage is a single-process prototype with JSON snapshots (12 MiB max per canvas).
- AI annotation mode is not implemented yet; Ask NOVA provides chat hints.
- Need to verify the main toolbar is moved to the top in future implementation.
- No guaranteed browser/iPad side-by-side interaction despite correct thread metadata.
- Tldraw licensing required before production use.
- Secret/token values, private tunnel identity, and actual notebook data belong outside Git.

## First Codex session
1. Inspect the exact local project and identify all scripts/entrypoints before edits.
2. Run `npm test` and `npm run build:host-test` if environment allows, documenting failures.
3. Inspect `git status` and confirm repository root; initialize Git only after user approval if not already initialized.
4. Review security and `.gitignore` for sensitive file/data risks, especially files under `%LOCALAPPDATA%`.
5. Identify a safe smallest next implementation slice; recommended **concurrent lease/handoff acceptance diagnostics**, then **top-mounted toolbar**.
6. Provide a concise plan and test evidence. Avoid wholesale refactoring or switching frameworks.

## Local development / handoff facts
- Existing ChatGPT plugin `NOVA Ink Dev` points through an OpenAI Secure MCP Tunnel to the local Windows server.
- During dev, server runs `npm run start` on port 3001. Keep the tunnel daemon independently running.
- The user has a faster development launcher in addition to scripts in the project; inspect actual working files before adopting changes.
- The boss reportedly approved development during work and separate ownership, but this is user-reported and not independent legal verification. Don't include company information in repository artifacts.

## Suggested roadmap
- Phase 0: Git baseline, reproducible tests/build, sensible ignores, backup integrity demonstration.
- Phase 1: Concurrent editor handoff validation; schema/backup recovery procedures; reliability improvements.
- Phase 2: Top toolbar, responsive fullscreen UI, accessible pen settings.
- Phase 3: PDF page import and per-page attachment/grouping of handwriting, source provenance.
- Phase 4: More robust AI scene interpretation and explicit annotation mode with undo and attribution.
- Phase 5: Historical replay/event ledger and grounded longitudinal tutoring.
