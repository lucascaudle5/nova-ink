# nova-ink-engine (spike)

NOVA-owned handwriting engine, developed in isolation from the working v0.2.3 tldraw app. **Not used by the v0.2.3 tldraw app, its MCP server or its saved notebooks. As of October 30, 2026 it powers a separately deployed ChatGPT widget, the Cloudflare Worker `nova-ink-engine` (see `../engine-app/` and `../cloudflare/`), which the user is testing on iPad; treat it as an actively developed prototype.** Architecture, acceptance criteria and measurements: `docs/ENGINE_ARCHITECTURE.md`. Status lives in `../CODEX_HANDOFF.md`.

No runtime dependencies; no tldraw code (its license forbids copying it).

```
npm install
npm test               # 59 Node tests (core model, partial eraser, input rules and finger taps, format, paper, zoom, renderer with a fake canvas, pen presets)
npm run typecheck
npm run dev            # browser harness at http://localhost:5180 (localhost only)
npm run build          # typecheck + static harness build into dist/
npm run bench          # model-side costs at 3,000 strokes; `-- --write` updates docs/bench-results.json
```

For iPad Safari testing on the same Wi-Fi (approved by the user), `npm run dev:lan` serves the harness on the LAN and prints a `Network:` URL to open on the iPad. Anyone on that network can open it; it holds only scratch strokes. Running it inside ChatGPT needs a separate plugin and is not built.

## Layout

| Path | Role | DOM? |
|---|---|---|
| `src/core/types.ts` | Stroke, camera, bounds types; raw points kept as Float32 `[x, y, pressure, dt]` | no |
| `src/core/geometry.ts` | bounds, distances, constant-width outline polygon | no |
| `src/core/camera.ts` | page/screen transforms, zoom about a point, drift-free pinch, zoom stops, camera animation, snapshot coverage | no |
| `src/core/stroke.ts` | immutable stroke factory, ids that work without HTTPS | no |
| `src/core/document.ts` | ordered stroke list (z-order), change events, viewport query | no |
| `src/core/history.ts` | undo/redo with grouped gestures; restores original z-order | no |
| `src/core/eraser.ts` | eraser hit test and partial erase (cuts strokes into pieces) | no |
| `src/core/paper.ts` | page paper colors and patterns, pattern spacing per zoom, ink display on dark paper | no |
| `src/core/input.ts` | pointer rules: pen/mouse ink, fingers navigate, palm rejection | no |
| `src/core/format.ts`, `codec.ts` | versioned `nova-ink` page format v1 (delta varint, base64) | no |
| `src/core/metrics.ts` | percentile ring buffer | no |
| `src/render/renderer.ts` | two-layer Canvas 2D renderer with cached paths | canvas interface only |
| `src/dom/surface.ts` | browser binding: pointer events, rAF scheduling, metrics | yes |
| `src/dev/generate.ts` | deterministic generated strokes for tests and benchmarks | no |
| `harness/presets.ts` | four width and four color pen presets, Goodnotes-style (pure, tested) | no |
| `harness/` | development page: pen, eraser options, width and color presets, undo, zoom bar, paper styles, 3,000-stroke load, pan benchmark, results export, local scratch draft | yes |

The harness draft is stored in this browser's `localStorage` under `nova-ink-engine-harness:draft:v1`. It is scratch data, never a NOVA notebook.
