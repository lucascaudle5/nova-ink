# NOVA Ink handwriting engine: architecture, criteria and spike results

Status: **spike on branch `engine/spike`.** Nothing here is used by the v0.2.3 widget, either server, or any saved notebook. Every measured number below comes from a Windows desktop (Intel i7-10750H, Chromium in Cursor's browser, 144 Hz display, devicePixelRatio 1) and generated strokes. **No number has been measured on an iPad or inside ChatGPT.** Only iPad numbers decide the acceptance criteria.

## 1. What the repository said before this spike (verified Oct 29, 2026)

- `CODEX_HANDOFF.md` → "Drawing engine decision (October 29, 2026)": the user will replace tldraw with a NOVA-owned engine. tldraw stays until the new engine matches it on the iPad. First step is a bare-bones spike compared against tldraw for Pencil latency, pressure, palm rejection and pan/zoom at 3,000 strokes. The engine owns a documented stroke/page format, a one-time non-destructive converter from tldraw snapshots is planned, and Ask NOVA's image/context must be rebuilt on the engine. MIT libraries such as perfect-freehand are allowed; tldraw source is not.
- No engine code existed on any branch (`main`, `v0.2.3-reliability`); no stash, no other worktree.
- `cloudflare/` is a **storage and hosting** experiment, not an engine experiment. It stores tldraw records one row per record in a SQLite Durable Object, speaks the same MCP tool contract as `server.ts`, and has a live throwaway deployment (`nova-ink-test`, generated data only, left running by the user for the OAuth refresh check).
- Coupling to tldraw is concentrated in three places: `src/main.tsx` (the `<Tldraw>` mount, store listeners, `toImageDataUrl` for Ask NOVA), `src/snapshot.ts` (load validation), and the storage envelope check (`storage.mjs` `hasSnapshotShape` and `CanvasDO` require `{ document: { store, schema }, session }`).
- `src/session.ts` (save, lease, conflict, recovery) is already engine-agnostic: it reaches the editor only through `EditorPort { getSnapshot(); setReadOnly() }` and an injected `validateSnapshot`.

## 2. Platform constraints that shape the engine

Facts about the web platform, then things only a device can answer (the harness reports them).

- A web app (Safari or the ChatGPT app's web view) receives the Pencil only as Pointer Events: `pointerType: "pen"`, `pressure`, tilt / `altitudeAngle` / `azimuthAngle` where supported, and optionally `getCoalescedEvents()` / `getPredictedEvents()`. It has no access to PencilKit, the Pencil's double-tap or squeeze, or native low-latency drawing. A web engine will always draw through the browser compositor, so it can match tldraw (also a web engine), but should not be expected to match Apple Notes.
- User-reported (CODEX_HANDOFF): tldraw Pencil writing works in the native ChatGPT iPad app, and drawing pauses while ChatGPT's conversation overlay is open. That pause is a host behaviour no engine can fix.
- **Unknown until measured on the device** (shown in the harness stats and the Results export): whether coalesced and predicted events are delivered inside the ChatGPT web view; whether `requestAnimationFrame` runs at 120 Hz or is held to 60 Hz on ProMotion; real Pencil sample rate; maximum pressure range; whether iPadOS palm rejection already filters resting-palm touches before they reach the page.

## 3. Separation of concerns

| Concern | Owner | Depends on |
|---|---|---|
| 1. Drawing engine and document model | `engine/` (this package) | nothing (no DOM in `src/core`) |
| 2. Notebook storage and sync | `src/session.ts` + `storage.mjs` (Windows) or `CanvasDO` (Cloudflare) | a serialized page; never the engine's internals |
| 3. Application interface | React shell in `src/main.tsx` (top bar, banners, library, backups) | engine through an `EditorPort` adapter |
| 4. Hosting and Cloudflare | `main.ts`/`http.ts` or `cloudflare/` | storage only |
| 5. ChatGPT / MCP integration | `server.ts`, `@modelcontextprotocol/ext-apps` calls in `main.tsx` (the HostAdapter of cloudflare/docs section 8) | the app shell, not the engine |
| 6. AI tutoring and canvas context | `src/context.ts` + Ask NOVA | the engine's viewport query and image export (not built) |

Rules kept in the spike: the engine has no idea a server, a lease, ChatGPT or Cloudflare exists. AI marks are a data property (`author: "ai"`), so the learning record and tutoring layers can distinguish them without engine changes.

### Reuse map

| Existing component | Reuse with the engine |
|---|---|
| `src/session.ts` + its tests | As is. The engine needs an `EditorPort` adapter (getSnapshot = serialized page, setReadOnly) and a `validateSnapshot` that calls `parsePage`. |
| `src/context.ts` | Viewport geometry and `DISCLOSURE` reusable; `makeCanvasContext` needs a stroke-based shape list. |
| `storage.mjs`, `backup.mjs`, `server.ts` tools | Patterns (revisions, saveId, lease, backups) are reusable; the tldraw envelope is not needed, because the user decided engine pages need no compatibility with old notes. Engine pages get their own store/format (still to be planned). |
| `cloudflare/` CanvasDO | Same storage design is reusable; one record per stroke (`stroke:<id>`) would give per-stroke change saves. Not tried. |
| Top bar, banners, backups UI | As is. |
| tldraw | Kept, untouched, as the reference and the working app. |

## 4. Technology evaluation

| Option | For | Against | Verdict |
|---|---|---|---|
| Canvas 2D, two layers, cached `Path2D` | Universal (Safari, ChatGPT web view), GPU-accelerated in WebKit, simple, easy image export for Ask NOVA | Per-path fill cost when thousands of strokes are visible | **Chosen for the spike**; measured below |
| WebGL 2 (triangulated strokes) | Best throughput when zoomed out; instanced draws | Context loss handling, more code, antialiasing work, harder to debug | Keep as the escalation path if a gesture-time cache is not enough |
| SVG / DOM | Trivial hit testing | Thousands of DOM nodes; known slow pan/zoom at this scale | Rejected |
| WebGPU | Future-proof | Availability in the ChatGPT iPad web view unverified | Not now |
| Native iPad app (PencilKit) | Lowest latency, Pencil features | Leaves the ChatGPT MCP App; separate codebase; contradicts decision 1 | Out of scope; noted only |
| perfect-freehand (MIT) | Proven stroke shape | User wants to build it; small enough to own | Not used; own outline in `geometry.ts` |

Renderer is behind a small interface (`Context2D`, `createPath`), so a WebGL renderer can replace it without touching the model, input or format.

## 5. Spike design decisions (reversible)

- **Raw input is the record.** Strokes store every coalesced sample (x, y, pressure, ms since start). Smoothing and width are computed at render time, so better rendering later never rewrites saved work, and the timing data supports replay (decision 11).
- **Constant width, no pressure styling** (user decision): each stroke has one width, chosen from four width presets (tap the selected one again to adjust it), alongside four color presets. Pressure is recorded but ignored when drawing.
- **Same outline for live and committed strokes**, so nothing changes shape at pen-up. Live layer redraws only the stroke in progress; committing draws one stroke onto the base layer (tested: no clear, one fill).
- **Strokes are immutable** (frozen, private Float32 copy). Undo/redo stores references; erase restores original z-order (tested). Encoded strokes are cached, so autosave cost is proportional to new strokes.
- **Fingers never draw.** One finger pans, two pan and zoom, computed from the gesture start (no drift). Pen-down cancels a finger gesture already in progress and touches landing during a stroke stay ignored until lifted (tested, including a mutation check). A system `pointercancel` keeps the stroke.
- **Partial eraser** (user decision): cuts a stroke's centerline where it crosses the eraser circle widened by half the stroke width, interpolating the crossing between samples; the pieces are new immutable strokes (new ids; style, author and time kept) placed at the original z-order position. No format change. Whole-stroke mode stays as an option. Fixed screen-size radius (6/12/24 px) with interpolation for fast moves; one gesture is one undo step (tested).
- **Undo** covers strokes, erases, Clear and bulk adds. A quick two-finger tap undoes, three fingers redo; taps during or within 400 ms of pen use are ignored as the palm (tested).
- **Layers:** paper (color and pattern, page coordinates, redrawn exactly every camera change; coarser spacing when zoomed out), base (committed ink), live (stroke in progress or eraser ring), and an offscreen snapshot of the base.
- **Gesture snapshot** (criterion 4b): on heavy views (≥ 300 strokes in view or a redraw over 4 ms), pans, pinches, wheel scrolls and zoom animations show the snapshot moved and scaled; the ink is redrawn exactly when the gesture ends, and mid-gesture at most every 200 ms if the snapshot covers under 70% of the view or is scaled beyond 0.5–2.5×. Exposed edges show paper until then. Edits, resizes and paper changes invalidate it. Light views always redraw exactly. Stroke count is part of the trigger because Chrome's script-side draw time (~1 ms) hides the real raster cost.
- **Zoom** 5%–3200% with fixed stops for buttons and animated camera moves (geometric zoom, straight-line centre).
- **Paper** is page data (optional `paper` field in the format). On dark paper near-black neutral ink is displayed light; the stored color never changes.
- **Precision.** In-memory points are Float32: under 0.004 page-unit error up to 100,000 units from the origin (tested); camera math is float64. The page format quantizes to 0.01 page units and 0.001 pressure. The user chose an infinite canvas, so far from the origin Float32 degrades (about 0.06 units at 1,000,000). Planned fix: store each stroke's points relative to a float64 stroke origin.
- **Format `nova-ink` v1**: versioned JSON, per-stroke base64 of zigzag delta varints. Parsing refuses non-NOVA data, newer versions, duplicates, bad counts, truncation, out-of-range values ("refuse rather than guess", tested). Not used for any real notebook.
- **Ids** use `crypto.getRandomValues`, because `crypto.randomUUID` is unavailable over plain HTTP (iPad on LAN).

## 6. Acceptance criteria (proposed; to be confirmed by the product owner)

"Desktop" = this PC in Chromium; it is a sanity check only.

| # | Criterion | Target (on iPad, Safari and inside ChatGPT) | How measured | Status |
|---|---|---|---|---|
| 1 | Input to frame latency | p95 ≤ one refresh period + 4 ms, and not worse than tldraw in the user's judgement (each plugin tested separately; no side-by-side setup) | harness `input→frame` (event timestamp to end of the drawing frame; excludes compositing, so not photon latency) | not measured on iPad (synthetic events only on desktop) |
| 2 | No dropped samples | every delivered sample stored | unit test; harness `samples/event` | tested in Node |
| 3 | Writing at 3,000 strokes | p95 frame time below refresh period while writing | harness frame ms | not measured on iPad |
| 4a | Pan at writing zoom (~1×), 3,000-stroke page | p95 frame interval ≤ refresh period | Benchmark pan | desktop: 7.1 ms at 144 Hz, 867 strokes visible: pass |
| 4b | Pan zoomed out, all 3,000 visible | p95 frame interval ≤ 2 × refresh period | Benchmark pan | desktop: 27.9 ms without the gesture snapshot; **7.2 ms with it** (0.26×, 3,006 strokes, 144 Hz): pass on desktop. iPad was 41 ms before the snapshot; not re-measured |
| 5 | Commit cost independent of page size | one stroke drawn per commit | unit test | tested |
| 6 | Palm rejection | 0 ink from fingers; 0 unwanted pans while writing with a resting palm for 2 min | unit tests + user iPad session | tested in Node; iPad not tested |
| 7 | Page size, 3,000 strokes | ≤ 4 MiB (tldraw fixture: 3.9 MiB; save limit 12 MiB) | `npm test`, bench | 2.17 MiB |
| 8 | Autosave serialization, 3,000 strokes | ≤ 10 ms on iPad | bench | Node desktop: 3.9 ms cached, 86 ms first time |
| 9 | Load (parse), 3,000 strokes | ≤ 150 ms on iPad | bench | Node desktop: 44 ms |
| 10 | Engine memory, 3,000 strokes | ≤ 30 MiB excluding path cache | bench | Node: 6.2 MiB |
| 11 | Correctness | undo/redo exact incl. z-order; format refuses bad data | unit tests | tested |
| 12 | Recovery | an unsaved stroke survives reload/crash | harness draft (scratch only); in the product, server-confirmed save via `session.ts` | desktop harness: 3,004-stroke draft restored after reload |

## 7. Measured results (desktop only)

`docs/bench-results.json` (Node, `npm run bench -- --write`): 3,000 strokes / ~301,000 points, 6.2 MiB, 2.17 MiB saved; outline of all strokes ~26 ms; viewport query and eraser hit test ~0.02 ms; erase 50 + undo ~4 ms.

Harness in Chromium (1904 × 997 CSS px canvas, dpr 1):

| Scene | Strokes visible | Frame interval p50 / p95 | Draw submit p50 |
|---|---|---|---|
| Writing zoom (0.98×) | 867 | 6.9 / 7.1 ms (144 Hz, no drops) | 0.4 ms |
| Fit all (0.24×) | 3,004 | 27.7 / 27.9 ms (~36 fps) | 1.1 ms |
| Fit all (0.26×), gesture snapshot | 3,006 | 6.9 / 7.2 ms (144 Hz, no drops) | 0.1 ms; exact redraw after the gesture 1.8 ms |

Submit time is small; the cost is GPU/compositor rasterization of thousands of filled paths. Input in this session was synthetic (`dispatchEvent`), which has no coalesced samples and no real latency; criterion 1 is therefore unmeasured.

## 8. Migration strategy

1. **Now (done):** engine in `engine/` on `engine/spike`, in its own worktree (`..\nova-ink-engine`). The v0.2.3 checkout, its tests, server, tunnel and data are untouched. A self-contained package (like `cloudflare/`) keeps the engine independently testable while staying in the same repo for later integration; a separate repository would make the eventual `EditorPort` integration and shared tests harder.
2. **Device spike:** measure the harness on iPad Safari, then inside ChatGPT next to tldraw. Zoomed-out pan (criterion 4b) has a fix that passes on desktop; re-measure on iPad.
3. **Engine plugin:** its own notebook storage on Cloudflare (plan below), served as a separate ChatGPT app. The tldraw plugin keeps working unchanged; the user tests each plugin separately.
4. **Parity on iPad, then switch.** No converter: the user decided old tldraw notes need no compatibility. Old data is left in place (not deleted) unless the user explicitly asks. tldraw is removed only after the engine plugin is accepted.

### Engine storage plan: Cloudflare (user decision October 29, 2026, 8:50 PM; steps 1–5 built locally, not deployed)

Supersedes the earlier Windows-folder plan (same day, 8:40 PM). Kept from it: notebooks hold several pages; each page is its own infinite canvas; paper is per page and a new page copies the previous page's paper; engine data is fully separate from tldraw data, which is never read, migrated or deleted.

Why Cloudflare suits the engine better than it suited tldraw: strokes never change once drawn, so a save only has to send the strokes added and the ids removed. The tldraw test shipped the whole canvas on every save (1.90 MiB at 1,500 strokes) and was over the documented free-plan CPU figure on every widget call; small delta saves are the main answer to that risk.

**Shape**
- A new Worker, `nova-ink-engine`, separate from anything tldraw. Its code lives in `cloudflare/` next to the old spike (second wrangler config and entry point) so it reuses the tested sign-in code: OAuth provider for ChatGPT, Cloudflare Access login with only the allowed email, fail closed when any secret is missing (`app.ts`, `access.ts`, `config.ts` and their 36 tests). It imports the engine's format code from `engine/`; `engine/` never imports anything back.
- **Library object** (one per user, `engine-library:<userId>`): notebooks (id, name, order, deleted_at) and pages (id, notebook, title, fractional order key, last known revision, deleted_at). Removing a page or notebook sets deleted_at (trash, restorable); nothing is destroyed at delete time. Every page id is checked against the caller's library (`NOT_FOUND` otherwise), as in the spike. As built, "Recovered pages" was dropped: a page is registered in the library before its page object exists, so the library is the only index and there is no orphan to recover. Paper lives in the page object; a new page's object is initialised with the previous page's paper.
- **Page object** (one per page, SQLite, `WITHOUT ROWID` tables): `strokes` (id, order key, serialized stroke as in the `nova-ink` v1 format); `head` (format version, revision, saveId, savedBy, savedAt, stroke count); `meta` (paper, camera); lease; gzip checkpoints. A format version newer than the code is refused (`FORMAT_NEWER`), like today.

**Save protocol** (same order of checks as `storage.mjs` and the spike's `CanvasDO`)
- Request: `{ clientId, saveId, baseRevision, adds: [{ stroke, order }], removes: [id], paper?, camera? }`. A partial erase is removes plus adds in one save, so it is atomic.
- Checks: replay of the same saveId returns ok and writes nothing; another client's live lease returns `LEASE_HELD`; a stale baseRevision returns `CONFLICT` (with `ownLastSaveId` so a lost acknowledgement is not mistaken for a conflict); every added stroke is validated with the engine's parser (refuse, don't guess); then one transaction writes the rows and the new head.
- Cost: about one row per added or removed stroke plus the head. Erasing through three strokes is roughly 10 rows. The free plan allows 100,000 row writes a day; that is tens of thousands of saves.
- **Saved** only after this acknowledgement; on failure the widget shows **Not synced** and keeps the unsent changes in memory to retry (unchanged product rule). Lease 45 s with 15 s heartbeats, stored only when the holder changes.
- Open returns the whole page (3,000 strokes ≈ 2.2 MB) assembled from rows. If opening large pages proves too expensive in CPU, load in pages of rows.
- Checkpoints: the whole page gzipped, at most one per 10 minutes and only when strokes changed, newest 10 kept; restore creates a new revision. Retention by day and week, and an off-site copy in R2, are later options.

**Tools** (ChatGPT app, `ui://nova-ink-engine/notebook`): list notebooks; create/rename/remove/restore a notebook; add/rename/reorder/remove/restore a page; open a page (takes the lease); save; heartbeat; release; list and restore checkpoints. Save, heartbeat and release are widget-only. No tool lets the model draw on a page (AI annotations stay a separate, explicit feature).

**Your data on your PC**: an export script that downloads every notebook to local `nova-ink` files, so notes do not exist only in Cloudflare. Run it by hand at first; exact sign-in mechanism to be settled when built.

**Open risks, checked only after deploying**: ChatGPT staying signed in after an hour and the next day (never run on the old test); free-plan CPU on open of a large page; latency from the iPad; whether the ChatGPT widget can keep a local draft (IndexedDB) for crash recovery.

**Build order** (everything before step 6 is local, tested in workerd and Node, nothing deployed):
1. Engine: helpers to serialize and validate a single stroke and to assemble a page from stroke rows, with tests (the existing page format stays unchanged).
2. Page object: rows, delta save, replay/lease/conflict, checkpoints and restore, with workerd tests.
3. Library object: notebooks, ordered pages, trash, recovered pages, paper copied to new pages, ownership checks, with tests.
4. Engine Worker: sign-in reused, MCP tools and widget resource, end-to-end tests with fake Access.
5. Widget: the harness drawing surface inside a ChatGPT app UI (outside `engine/`), with a save queue, Saved/Not synced, lease handling and page tabs; desktop-tested.
6. **Needs the user's go-ahead:** deploy `nova-ink-engine`, add it in ChatGPT as a connector, run the sign-in, refresh, CPU and iPad checks.
7. Export to the PC (optional; the user is open to it but has not decided).

**As built (October 29, 2026, evening; local only, nothing deployed at that time; deployed to Cloudflare as `nova-ink-engine` on October 30, 2026, see CODEX_HANDOFF.md for the current status):**
- Step 1: `engine/src/core/format.ts` `parseStroke`, `engine/src/core/order.ts` (order keys), `engine/src/core/sync.ts` `PageSync` (which strokes to send; tracks unconfirmed sends so a lost acknowledgement cannot duplicate or orphan rows). Engine read-only mode: `InkSurface.readOnly` (pen and mouse do nothing, undo/redo refused, fingers still navigate).
- Steps 2–4: `cloudflare/src/engine/` (`page-do.ts`, `library-do.ts`, `mcp.ts`, `index.ts`), config `cloudflare/wrangler.engine.jsonc`, tests `cloudflare/test/engine/` (`npm run test:engine`).
- Step 5: `engine-app/` at the repo root. `session.ts` is the DOM-free session (Saved only after the server confirms; Not synced and retries 2/5/10/20/30 s on failure, with the same saveId so the server replays rather than applies twice; one save in flight; autosave 650 ms, camera 3 s quietly; 15 s heartbeat; take over; conflict, damaged, trash and lost-control states never overwrite, and "Copy to a new page" keeps the work). `main.ts` wires it to `InkSurface`, the harness toolbar (`engine/harness/tools.ts`), a notebooks/pages panel with trash, page arrows, status pill and a More menu with checkpoints. `npm run build:engine-app` makes one 322 KB file (`engine-app/dist/notebook.html`); `npm run engine-widget` in `cloudflare/` embeds it in the Worker. Opened outside ChatGPT (or with `?mock`), it runs on an in-memory preview server (`mock-server.ts`) for desktop testing.
- Verified: engine 66/66; engine-app 8/8 (session against the mock server) and `tsc` clean; cloudflare engine suite 27/27 in workerd, including the app's own session code driving the real Worker and Durable Objects through the MCP tools (save, lost reply, hand-over between two devices, copy to a new page, pages, trash, notebooks); old cloudflare suite 70/70; root 76/76. Desktop Chromium preview: drawing, autosave to Saved, new page, page arrows, offline Not synced and refusal to leave the page, recovery after reconnect, another device holding the page, take over, revision conflict and Copy to a new page, More menu; layout checked at 1180×820 and 700×560.
- Not verified: anything inside ChatGPT (host bridge, display modes, safe areas, teardown), on the iPad, on real Cloudflare, or checkpoint restore through the UI.
- Known gap (same as v0.2's CanvasDO): a damaged stroke row is detected when the page is opened, not when saving; the app then offers checkpoints instead of loading part of the page.

**Pictures and PDF pages (built, not deployed):** `core/image.ts` (`ImageItem`: a stored picture id plus a page-unit rectangle; immutable, a move or resize replaces it with a new id), images held in `InkDocument` below all ink, history commands for insert/delete/replace and `insertImages` (one step), `format.ts` `parseItem`/`serializeItem` for mixed rows, `PageSync` over `PageItem[]` (images sent first), renderer `imageSource` with a placeholder box while loading, `select` tool in `InputController`. `InkSurface.insertImage` fits a picture into 60% of the view; `insertImageColumn` stacks PDF pages. The engine never decodes files or fetches anything: the app (`engine-app/main.ts`, `engine-app/pdf.ts`) prepares pictures, uploads them in pieces and supplies decoded bitmaps.

## 9. Known gaps (not built)

Stored page previews for ChatGPT (Phase 2 of PLAN_CHATGPT_TOOLS.md; the visible-view export, the whole-page and chosen-area PNG exports (composeRegion, up to 4000 px) and Ask NOVA, including Choose an area and asking about a selection, are built); tiles / level of detail for ink (the gesture snapshot covers pans and pinches only); spatial index (linear culling is ~0.02 ms at 3,000 strokes, so not needed yet); picture cropping (free rotation and finger move/resize/turn are built); predicted-event rendering; IndexedDB drafts; WebGL renderer; stroke-relative coordinates for the infinite canvas; page reordering in the app UI (the server tool exists); verified running inside ChatGPT.

## 10. Open decisions for the product owner

Decisions made and still open are in CODEX_HANDOFF.md → "Engine spike status" (kept in one place).
