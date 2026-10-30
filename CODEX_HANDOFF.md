# NOVA Ink — Codex Handoff

**Snapshot:** October 29, 2026  
**Packaged reference:** v0.2.1, user-tested on iPad
**Current local working copy:** v0.2.3 (branch v0.2.3-reliability); not repackaged or published; iPad acceptance is pending but is not a development gate; the user tests in occasional batches (IPAD_ACCEPTANCE.md)
**Engine spike:** branch engine/spike (Windows worktree `Documents\GitHub\nova-ink-engine`), package `engine/`; experimental, not wired into the app (see "Engine spike status" below)

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
- engine/ (branch engine/spike only): NOVA-owned engine spike, self-contained package with its own tests and browser harness; imports nothing from the app, tldraw, MCP, storage or cloudflare/. See engine/README.md and engine/docs/ENGINE_ARCHITECTURE.md.

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
- Top toolbar and backup UI have not been verified on iPad (they await a user test batch).
- No guaranteed iPad side-by-side interaction.
- Tldraw licensing is required before production.
- Secrets, private tunnel identity, and actual notebook data stay outside Git.

## Repository and workflow
- The code is in a private GitHub repo, https://github.com/lucascaudle5/nova-ink, shared between a work machine (Cursor) and a personal machine (Codex). Active branches: v0.2.3-reliability (working app, reliability reference) and engine/spike (engine work; branched from v0.2.3-reliability at a5fb0c5; this handoff section is only on engine/spike until merged).
- Pushing to this private remote (origin) is authorized. Making it public, or pushing anywhere else, still requires explicit permission. Nothing is packaged or published.
- Workflow: pull before starting, commit and push before stopping.
- The package folder's Git repository uses the user's personal author identity; the v0.2.1 source baseline was the first commit. The NOVA ARCHAELOGY chat workspace remains separate from the code package.

## Next steps
1. iPad acceptance is not a gate for development. The user runs IPAD_ACCEPTANCE.md (full checklist, plus the quick check after changes) on a physical iPad in occasional batches; it includes two-client handoff and backup restore. Report results by source: verified on iPad (user-reported), automated tests only, or desktop ChatGPT only. Items for those batches, with the user and disposable test canvases:
   - Verify lease handoff between two independent clients and that an expired editor cannot save.
   - Restore an earlier valid backup through Host tools → Backups and confirm a new revision.
   - Verify toolbar, Pencil, finger pan/zoom, persistence, and canvas switching on iPad.
   - Do not intentionally corrupt real data.
2. Next development priority, proceeding without waiting for iPad acceptance and ahead of v0.3 notebooks: PDF page import. PDF pages become separate movable pages with source provenance (document, page number), and page-associated annotations travel with their pages. Provide lock and detach controls. Plan it first; storage changes stay backward compatible.
3. v0.3 (also proceeds without waiting for iPad acceptance; incremental, backward compatible): notebooks grouping canvases, rename, soft-delete trash, metadata search, explicit schema versioning with opt-in migration.
4. Do not publish or redeploy without explicit authorization.
5. Engine spike (branch engine/spike): next milestone and open decisions are under "Engine spike status" below. It does not block items 1–3.

## Long-term roadmap (accepted October 29, 2026)
The user is an aerospace engineering student (current courses: Dynamics, Mechanics of Materials) and intends to use and personally extend NOVA Ink for years. Every item below is accepted; the order is a recommendation, not a commitment. Plan each item before building it, keep storage backward compatible, and follow the accepted product decisions above (student-initiated help, no unsolicited hints, AI marks distinguished from student work).

### Recommended order
1. PDF page import (Next steps, item 2).
2. Export pages to PDF for submission.
3. Engineering tool plug-in pattern: each tool is a self-contained module behind one small interface, so new tools can be added each semester. First tool: units checker.
4. Shear and moment diagram checker, and Mohr's circle (highest value for current courses).
5. Hint ladder and "check this step", then "redo later".
6. Remaining items below.

### Drawing engine decision (October 29, 2026)
- The user will replace tldraw with a NOVA-owned handwriting engine built from scratch: no watermark, no license dependency, and the user builds all of it. Do not copy tldraw source (its license forbids it); MIT-licensed libraries such as perfect-freehand are acceptable.
- tldraw stays in place until the new engine matches it on the iPad. Until then, tldraw runs only as a development-mode evaluation build, not as a licensed production canvas.
- Start with a bare-bones engine spike tested on the iPad inside ChatGPT against tldraw (Pencil latency, pressure, palm rejection, pan/zoom at 3,000 strokes). Pen feel needs frequent iPad testing; this is the one area where batch-only iPad testing does not fit.
- The engine owns a documented NOVA stroke/page format. Plan a one-time, non-destructive converter from existing tldraw snapshots. Ask NOVA's viewport image and shape context must be reimplemented on the new engine.
- Keep engineering tools, tutoring, and the learning record independent of the drawing engine.

### Engine spike status (October 29, 2026, evening)
Verified before starting: no engine code existed on any branch; cloudflare/ is a storage/hosting experiment (tldraw records in Durable Objects), not an engine experiment; session.ts is already engine-agnostic through EditorPort; tldraw coupling is limited to src/main.tsx, src/snapshot.ts and the storage envelope check (`document.store` / `document.schema` / `session` in storage.mjs and CanvasDO).

Built on engine/spike (details and reasoning in engine/docs/ENGINE_ARCHITECTURE.md):
- DOM-free core: immutable strokes storing raw coalesced samples (x, y, pressure, ms); variable-width outline; camera with drift-free pinch; ordered document with viewport query; undo/redo with grouped erase that restores z-order; whole-stroke eraser; input rules (Pencil and mouse ink, fingers only navigate, palm rejection).
- Versioned `nova-ink` page format v1 (delta varint + base64) that refuses non-NOVA, newer or damaged data. Not used for any notebook.
- Two-layer Canvas 2D renderer (cached paths; live stroke on its own layer; commit draws one stroke).
- Browser harness (`cd engine; npm run dev` → http://localhost:5180): pen, eraser, undo/redo, +3,000 generated strokes, pan benchmark, Results export (JSON with metrics and device capabilities), scratch draft in localStorage.

Verification, October 29, 2026, this Windows PC:
- engine: `npm test` 36/36, `tsc` clean, `npm run build` OK, `npm run bench` (Node): 3,000 strokes = 2.17 MiB saved (tldraw fixture 3.9 MiB), 6.2 MiB memory, autosave serialization 3.9 ms (cached), parse 44 ms.
- Harness in Chromium on desktop (synthetic pointer events, not a Pencil): pen strokes with pressure render; a touch that lands before a pen stroke does not pan; eraser + one-step undo; 3,004-stroke draft restored after reload. Pan benchmark at writing zoom (867 strokes visible): p95 frame interval 7.1 ms at 144 Hz (no drops). Zoomed out with all 3,004 visible: 27.9 ms (~36 fps): **fails the proposed target**.
- v0.2.3 reference re-run in its own checkout: `npm test` 76/76, `tsc` clean, working tree unchanged.
- Not verified: anything on iPad, Apple Pencil latency/pressure/coalescing, palm rejection with a real palm, running inside ChatGPT, side-by-side with tldraw.

Recommendation (not yet a product decision): continue the NOVA-owned engine with Canvas 2D; escalate to WebGL only if a gesture-time bitmap cache cannot meet the zoomed-out target on iPad. Develop in engine/ until device numbers meet the criteria in ENGINE_ARCHITECTURE.md section 6, then integrate through an EditorPort adapter. tldraw stays the working canvas until then.

Engine decisions (user, October 29, 2026, 7:19 PM):
- iPad testing over the home Wi-Fi is approved (`cd engine; npm run dev:lan`).
- No side-by-side drawing comparison is required. The tldraw plugin and the engine plugin are each tested separately; criterion 1 is judged that way.
- Fingers never draw (navigation only). This is the spike's behaviour and is now a product rule.
- Infinite canvas, not fixed pages.
- No compatibility between old tldraw notes and the new engine: no converter, and engine pages do not need to fit the tldraw snapshot envelope. The user does not need the old notes. This is not an instruction to delete them: existing data in %LOCALAPPDATA%\NOVA-Ink\data and the v0.2.3 app stay untouched; deleting them still needs an explicit request.

First iPad Safari Results file (user, October 29, 2026, 7:26 PM, over Wi-Fi):
- Safari 18.5 in iPad desktop mode (the user agent says Macintosh); 810 × 1080 CSS screen, devicePixelRatio 2. The exact iPad and Pencil models were not reported.
- `getCoalescedEvents` is **not available**; `getPredictedEvents` and `altitudeAngle` are. Without coalesced events the engine receives one Pencil sample per event, not the full hardware rate.
- That page session recorded no pointer events, no input latency and no pan benchmark (probably drawn before a reload; metrics restart on reload). Two full redraws of 3,003 strokes took 23 and 89 ms (the larger includes building every stroke's path once). Results now include session start and restored-draft count.
- Not yet measured on iPad: Pencil latency, pressure, samples per event, palm rejection, pan frame rate.
- Second Results file (October 29, 2026, 7:33 PM; same iPad and Safari; one page session, 866 Pencil samples, touch also used):
  - Pencil input to frame: p50 5 ms, p95 16 ms, max 32 ms. Criterion 1 target at 60 Hz is p95 ≤ 20.7 ms: **met in Safari**. The refresh rate was not recorded; the screen size suggests a 60 Hz 10.2-inch iPad (not confirmed).
  - Samples per event: always 1 (no coalescing, as expected from the first file).
  - Highest pressure seen: 0.32. Either light writing or Safari's pressure range; pressure scaling may need calibration. Not investigated.
  - Normal use: 267 full redraws with p95 1 ms; frame p95 1 ms.
  - Pan benchmark zoomed out (0.13×, all 3,026 strokes visible): frame interval p50 39 ms / p95 41 ms (about 25 fps), draw submit p50 21 ms. **Criterion 4b fails on iPad**, as it did on desktop. The gesture-time bitmap cache is the next fix.
  - Not measured: pan benchmark at writing zoom, stray marks or pans from a resting palm (needs the user's report).
- User-reported (October 29, 2026, 7:29 PM), iPad Safari over Wi-Fi: "The engine works phenomenally. It's already at par with tldraw." This meets the user-judgement part of criterion 1 in Safari only. Not yet tested inside ChatGPT, and no measured Pencil numbers back it yet.

- User-reported (October 29, 2026, 7:35 PM), iPad Safari: resting a palm never left a mark or moved the canvas (criterion 6, Safari only). Thick strokes were hard to get with pressure.

Engine decisions (user, October 29, 2026, 7:35 PM):
- No pressure-based width. Strokes have one constant width, chosen from favorite widths. Pressure is still recorded with each point (raw input, for replay) but never changes how a stroke looks.
- Goodnotes-style pen presets (user, October 29, 2026): four width slots and four color slots. Tapping a slot uses it; tapping the selected slot again opens its editor (width slider 0.5–24, or a 12-color palette, a system color picker and a hex field); tapping outside closes it. Edits apply immediately and are kept in the harness's localStorage.
- Built: constant-width outline (test: pressure never changes width); presets in `engine/harness/presets.ts` (tested). Desktop Chromium check: selecting a slot, re-tapping to open both editors, choosing a palette color, closing by tapping the canvas, and the presets surviving in storage. Not yet tried on the iPad.
- Image inserting: deferred to its own milestone, designed together with PDF page import (a new non-stroke item type: image storage and size limits, select/move/resize, a page format version bump, and how the eraser and Ask NOVA treat images).

Engine requests (user, October 29, 2026, 7:58 PM): undo is buggy; the eraser must remove parts of strokes, not whole strokes; expand zoom; build the zoomed-out pan fix; let each page choose its paper (e.g. dark with graph lines).
- Partial eraser: cuts each stroke's centerline where it crosses the eraser circle (crossings interpolated, so fast strokes cut cleanly) and keeps the pieces as ordinary strokes with new ids, the same style, author and time. No format change. Undo restores the original stroke at its z-order position; one eraser gesture is one step. Whole-stroke erasing stays available. Tap the selected eraser again for three sizes (6/12/24 px) and partial/whole mode.
- Undo: the user did not say what went wrong, and no logic error was found in History. Changes made for the likely causes: buttons use `touch-action: manipulation` (iOS Safari can drop the second of two quick taps as a double-tap); Clear and +3,000 are now undoable steps (before, they wiped undo history); quick two-finger tap = undo, three-finger tap = redo (Goodnotes), ignored if the pen was used during it or less than 400 ms before. **If undo still misbehaves, the user's description of the failure is needed.**
- Zoom: range 5%–3200% (was 10%–800%); bottom-right zoom bar with −, a percentage (tap for 100%) and +, stepping through fixed stops; Fit and the buttons animate; Ctrl/Cmd +, − and 0.
- Zoomed-out pan fix (gesture snapshot): while a pinch, pan, wheel scroll or zoom animation runs on a heavy view (300 or more strokes in view, or a redraw over 4 ms), the ink layer shows a copy of itself moved and scaled instead of redrawing every stroke. It redraws for real when the gesture ends, and at most every 200 ms mid-gesture if the copy covers under 70% of the view or is scaled beyond 0.5–2.5×. Edits, resizes and paper changes during a gesture invalidate the copy. JavaScript draw time alone does not show the cost (Chrome reported ~1 ms per redraw while frames took 28 ms), hence the stroke-count trigger.
- Paper per page: White, Cream, Slate or Dark, and Blank, Dots, Lined or Graph (fine lines every 20 units, major every 100). The pattern is drawn on its own layer in page coordinates, so it pans and zooms with the ink; zoomed far out it steps to coarser spacing instead of turning into a solid wash. Stored as an optional `paper` field in the page format (pages without it load as White/Blank; unknown values are refused). On dark paper near-black, colorless ink is shown light (stored color unchanged) and the toolbar switches to a dark theme.
- Desktop Chromium (synthetic mouse events, not a Pencil): dark graph paper renders; three strokes erased through the middle became six pieces; the draft restored the six pieces and the paper after reload. Pan benchmark zoomed out (0.26×, 3,006 strokes in view, 144 Hz display): p95 frame interval 27.8 ms before → 7.2 ms with the snapshot; exact redraw after the gesture 1.8 ms. **Not yet measured on the iPad.**

Engine storage decisions (user, October 29, 2026, 8:40 PM); plan in ENGINE_ARCHITECTURE.md "Engine storage plan":
- Engine notebooks live in their own folder (`%LOCALAPPDATA%\NOVA-Ink\engine-data`), fully separate from tldraw data, which is not read, migrated or deleted.
- A notebook holds several pages from the start. Each page is its own infinite canvas (OneNote-style tabs), not a fixed-size sheet.
- Paper style is per page; a new page copies the previous page's style.
- Build next: store and server tools for the engine plugin, then the ChatGPT plugin. Changing the plugin or tunnel setup still needs the user's confirmation at that step.
- Step 1 built: `NotebookStore` takes an optional `snapshots` check (default `TLDRAW_SNAPSHOTS`, today's behaviour). Root suite 77/77 including a new test, `tsc` clean, `build:host-test` passes. Steps 2–6 not built.

Engine storage change (user, October 29, 2026, 8:50 PM): build engine storage on Cloudflare directly instead of the Windows PC folder above. The plan is rewritten in ENGINE_ARCHITECTURE.md "Engine storage plan: Cloudflare" (delta saves of strokes, one Library object plus one object per page, reused sign-in code, build steps 1–7; steps 1–5 are local only). The `NotebookStore` step 1 change was reverted before commit because the Cloudflare plan does not use it; `storage.mjs` is unchanged from v0.2.3. The user chose this knowing the sign-in refresh check (CF_TEST_DEPLOYMENT.md check 2) was never run; it must be run on the engine deployment. Deploying needs the user's go-ahead at that step.

Cloudflare test deployment taken down (October 29, 2026, ~8:55 PM, user's decision):
- The user ran `wrangler delete --name nova-ink-test` and the KV namespace delete; the terminal reported both succeeded.
- Verified afterwards by me with wrangler: the account is Ai.nova.personal@gmail.com's; `deployments list --name nova-ink-test` returns "This Worker does not exist" (code 10007); `kv namespace list` returns `[]`.
- I deleted the `nova-ink-test` Access for SaaS app in the Zero Trust dashboard on the user's request (confirmed gone from the Applications list).
- Kept: the account, Zero Trust team `nova-dev`, the "NOVA Owner" policy, the `workers.dev` subdomain. Also still present and untouched: an Access app named "New SaaS application" on team domain `dark-tooth-ec30`, with no policy; its origin is unknown.

Still open (product owner):
1. The remaining acceptance targets (ENGINE_ARCHITECTURE.md section 6).
2. (Decided above: engine storage plan.)
3. Local device drafts (IndexedDB) for crash recovery, given decision 3 defers durable offline support.
4. The engine plugin in ChatGPT: a separate dev-only MCP server/connector changes the plugin/tunnel setup; confirm before it is set up.
5. (Decided: the Cloudflare test deployment was taken down October 29, 2026, see above.)

Next engine milestone (bounded): (a) the user tries the partial eraser, undo (buttons and finger taps), zoom bar and paper styles on the iPad, and runs Benchmark pan zoomed out with +3,000 strokes, then exports Results; (b) record the numbers here; (c) if undo is still wrong, reproduce it from the user's description; (d) then stroke-relative coordinates for the infinite canvas.

### Long-term foundations
- Data ownership: documented storage formats, PDF export, and tested off-machine backups so notes outlive any app, host, or AI provider.
- Host independence: standalone browser mode alongside the ChatGPT MCP App, and AI requests behind one replaceable adapter.
- Maintainability: the user is the long-term maintainer. Explain changes, keep tests next to features, and keep the code readable.

### Coursework in and out
- PDF page import (problem sets, lecture slides) and export to PDF.
- Engineering page templates: graph paper, engineering grid, free-body diagram and circuit layouts, answer boxes.
- Handwriting to LaTeX on request for a selected equation.

### Student-controlled tutoring
- Hint ladder: the student picks the level (nudge → concept → next step → full check).
- Check this step: verify a selected line, or point to the first error without solving the rest.
- Units checker: flag dimensionally inconsistent equations in a selection.
- AI annotation layer (planned): distinct color, attributed, hideable.

### Dynamics tools
- Paired free-body diagram = kinetic diagram template.
- Coordinate system stamps (x–y, n–t, r–θ) with unit vectors; rotatable.
- Vector arrows tagged with magnitude and angle; components on request.
- Check my FBD: hint-level feedback on missing or misdirected forces.

### Mechanics of Materials tools
- Shear and moment diagram checker: the student draws V and M first, then reveals computed diagrams overlaid.
- Mohr's circle from σx, σy, τxy with principal stresses and angles, to check hand-drawn work.
- Section properties (centroid, moment of inertia) for sketched composite cross-sections.
- Unit consistency for MPa/ksi, N·mm/in·lb.
- Pattern for future aerospace courses (structures, aerodynamics, orbital mechanics, controls): solve first, then reveal to check.

### Learning record
- Replay of how a problem was solved, from the event ledger (decision 11).
- Independence record per problem: hints used and their level, as a record, not a score.
- Redo later: resurface a problem days later on a blank page with the old solution hidden.
- Mistake log, opt-in, populated from "check this step".

### Organization and study
- Formula sheet builder: lasso equations from any page, each linked to its source.
- Links between pages (e.g. a homework step to a lecture slide).
- Handwriting search, using ChatGPT to read handwriting on request.

### Platform
- Cloudflare backend for access from any device (cloudflare/, go/no-go checks pending).
- Standalone browser mode outside ChatGPT.
- Local iPad drafts for writing without a connection (later).
