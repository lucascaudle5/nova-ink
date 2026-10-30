# Plan: let ChatGPT see and organize engine notebooks

Status: **approved, October 30, 2026; not started.** Branch `engine/spike`. Written for a coding agent to follow phase by phase.
The user approved all three phases and answered the open questions at the end (October 30, 2026, ~8:45 AM).

## Why this is next

ChatGPT can open the engine notebook (`open_nova_notebook`) but cannot see anything in it. Every other tool in
`cloudflare/src/engine/mcp.ts` is widget-only (`visibility: ['app']`), and the engine app has no Ask NOVA yet
(ENGINE_ARCHITECTURE.md section 9 lists "Viewport PNG export and shape context for Ask NOVA" as not built).
The old tldraw app had Ask NOVA (`src/main.tsx`, `ask`), so the engine app is currently a step backwards for tutoring.
Without this, none of the roadmap's tutoring items (hint ladder, check this step, units checker) can work.

## Rules for the agent (read first)

- Read `AGENTS.md`, `CODEX_HANDOFF.md` ("Accepted product decisions" and "Engine spike status") and
  `engine/docs/ENGINE_ARCHITECTURE.md` before changing code. Pull before starting; commit and push to `origin` when done.
- Product decisions that bind every phase:
  - 8: inspect the selection or the visible viewport first; never move the user's camera.
  - 9: no unsolicited hints. The student starts every tutoring request. No percent-correct estimates.
  - 10: AI-authored marks stay distinguishable from student work.
- The model must never change or delete ink, pictures or pages. Phases 1–3 add no tool that draws on a page.
- Storage changes are additive and backward compatible (see how `rotation` and `folders` were added).
- **Do not deploy.** `wrangler deploy` needs the user's explicit go-ahead at that moment. The live Worker is
  version 098ea8e1; picture rotation (commit e190e46) is built but not deployed and goes out with the next deploy.
- Keep code in the style of the surrounding files: small functions, short doc comments, tests next to features.
- After each phase run all checks and record results in `CODEX_HANDOFF.md` under "Engine spike status",
  saying which were automated, desktop preview, or user-reported on iPad:
  - `engine`: `npm test`, `npx tsc --noEmit -p .`
  - root: `npm run test:engine-app`, `npx tsc -p engine-app --noEmit`, `npm test`
  - `cloudflare`: `npm run test:engine`, `npx tsc --noEmit`
  - desktop preview: `npm run dev:engine-app`, open `/notebook.html?mock` (`window.novaSurface`, `window.novaInsertPicture`).

## Phase 1: Ask NOVA in the engine app (widget to chat)

Goal: the student taps Ask NOVA, picks a help level, types a question, and ChatGPT receives a picture of the visible
work plus a short description. This is the foundation for every tutoring feature.

1. **Render the view to PNG (engine).** Add `InkSurface.exportView(): Promise<Blob>` (or a pure helper in
   `engine/src/render/`) that draws paper, pictures and ink for the current camera onto a fresh canvas using
   `CanvasRenderer` with throwaway layers, without the live layer (no selection frame or eraser ring). Cap the
   output at about 1600 px on the long side. Unit-test the scene composition with the fake `Context2D` in
   `engine/test/renderer.test.ts`.
2. **Context text (engine-app).** A pure function, e.g. `engine-app/ask.ts` `askContext(...)`, that returns
   notebook name, page title, page number, paper style, zoom, counts of visible strokes and pictures, the help level,
   and the student's question (trimmed to 1,200 characters). No stroke coordinates. Unit-test it.
3. **Help levels (roadmap "hint ladder").** The student picks one: Nudge, Concept, Next step, Check my work.
   Each maps to one fixed instruction sentence sent with the message, for example Check my work = "Point to the first
   error, if any, without solving the rest." Keep the wording in one table in `ask.ts`.
4. **UI.** An Ask NOVA button in the top bar opens a small sheet: help level (segmented control), question box,
   the disclosure "ChatGPT will see what is on screen now", Send. Send calls `app.sendMessage({ role: 'user',
   content: [text, image] })` as `src/main.tsx` does. Show "Sent" or the error; never fail silently. In the mock
   preview, log the message instead of sending.
5. **Refusals.** Empty question, nothing visible, or image over 3 MB → a clear message and nothing sent.
6. Checks as above; preview screenshot of the sheet and of a logged message. Stop and report; the user tests it in
   ChatGPT on the iPad.

## Phase 2: page previews and read-only tools for the model

Goal: in chat the student can say "look at page 3 of my Dynamics notebook" and ChatGPT can find and see it, even
when the notebook is not open.

1. **Spike first (half a day at most):** confirm that ChatGPT shows an `image` content item returned by a
   model-visible tool on this connector. Add a throwaway tool behind a test-only flag or test against the local
   mock, and report what happens. If images in tool results do not work, stop and ask the user; the fallback is
   Phase 1 only.
2. **Page previews:** after a confirmed save (debounced, at most once every 30 s per page, and on leaving
   a page), the widget renders the whole page's content bounds with step 1.1's renderer to a JPEG (long side
   ≤ 1600 px) and stores it with the existing picture pieces (`nb_put_image`), then records it on the page with a new
   widget-only tool `nb_set_preview { pageId, imageId, revision }`. Add a nullable `preview_image` and
   `preview_revision` to the library's page rows on first use, like `folder_id` was added. Old previews of the same
   page may be deleted. A Worker cannot draw ink itself, which is why the widget makes the preview.
3. **PDF provenance (additive):** when importing a PDF, record the file name and page number on each picture
   (optional fields on the stored picture's metadata in the library, not on the row). Show them in `nova_read_page`.
4. **Model-visible tools** (no `visibility: ['app']`; `annotations: { readOnlyHint: true }`; scope `mcp:read`):
   - `nova_list_notebooks`: folders, notebooks, page titles, page numbers, last edited, whether a preview exists.
     Not trashed items.
   - `nova_read_page { pageId }`: page title, notebook, paper, last edited, picture provenance, and the stored
     preview as an `image` content item. If the preview is older than the page's revision, say so in the text.
   - Descriptions must say: "Call only when the user asks about their notes. Do not give hints the user did not ask
     for." Keep results small (no stroke data).
5. Worker tests in `cloudflare/test/engine/` for both tools: ownership (another user's page is NOT_FOUND), trash
   excluded, stale-preview flag, missing scope refused. Checks as above. Stop and report.

## Phase 3: let the model organize

Goal: "make a Mechanics HW 6 notebook in my Mechanics folder with five graph pages" works from chat.

- Model-visible, scope `mcp:write`, wrapping the existing library methods: `nova_create_notebook { name, folder?,
  color? }`, `nova_add_pages { notebookId, count ≤ 20, paper?, titles? }`, `nova_create_folder`, `nova_rename`
  (notebook, folder or page). Nothing that deletes, trashes or touches page content.
- Match folders by name case-insensitively; if several match, return the choices instead of guessing.
- An open widget picks up library changes on its next `nb_list` (check the library reload path in `main.ts`).
- Tests per tool, including INSUFFICIENT_SCOPE without `mcp:write`. Stop and report.

## Later (each needs its own plan and the user's decisions)

- AI annotation layer: rows with `author: 'ai'` already parse; needs a distinct color, a hide toggle, attribution,
  and a model tool that only adds, never edits student rows (decision 10). Start only after the user asks.
- Lasso selection of ink, so Ask NOVA and "check this step" can send just the selected lines.
- Engineering tools behind one plug-in interface (roadmap): units checker first, then shear and moment diagrams and
  Mohr's circle.
- Export pages to PDF (roadmap item 2), not a model tool.
- Stroke-relative coordinates for the infinite canvas (current engine milestone (b)).

## User decisions (October 30, 2026)

1. Phase 2: ChatGPT may read any page in the library, read-only, only when the user asks.
2. Phase 2: storing a preview image of every page on Cloudflare is accepted.
3. Phase 3: the model may create and rename notebooks, folders and pages; never delete or trash them.
