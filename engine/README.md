# nova-ink-engine (spike)

NOVA-owned handwriting engine, developed in isolation from the working v0.2.3 tldraw app. **Experimental: not used by the NOVA Ink widget, the MCP server or any saved notebook.** Architecture, acceptance criteria and measurements: `docs/ENGINE_ARCHITECTURE.md`. Status lives in `../CODEX_HANDOFF.md`.

No runtime dependencies; no tldraw code (its license forbids copying it).

```
npm install
npm test               # 36 Node tests (core model, input rules, format, renderer with a fake canvas)
npm run typecheck
npm run dev            # browser harness at http://localhost:5180 (localhost only)
npm run build          # typecheck + static harness build into dist/
npm run bench          # model-side costs at 3,000 strokes; `-- --write` updates docs/bench-results.json
```

For iPad Safari testing on the same Wi-Fi, `npx vite --host` serves the harness on the LAN (anyone on that network can open it; it holds only scratch strokes). Running it inside ChatGPT needs a separate MCP resource and is not built.

## Layout

| Path | Role | DOM? |
|---|---|---|
| `src/core/types.ts` | Stroke, camera, bounds types; raw points kept as Float32 `[x, y, pressure, dt]` | no |
| `src/core/geometry.ts` | bounds, distances, pressure radius, variable-width outline polygon | no |
| `src/core/camera.ts` | page/screen transforms, zoom about a point, drift-free pinch | no |
| `src/core/stroke.ts` | immutable stroke factory, ids that work without HTTPS | no |
| `src/core/document.ts` | ordered stroke list (z-order), change events, viewport query | no |
| `src/core/history.ts` | undo/redo with grouped gestures; restores original z-order | no |
| `src/core/eraser.ts` | whole-stroke eraser hit test | no |
| `src/core/input.ts` | pointer rules: pen/mouse ink, fingers navigate, palm rejection | no |
| `src/core/format.ts`, `codec.ts` | versioned `nova-ink` page format v1 (delta varint, base64) | no |
| `src/core/metrics.ts` | percentile ring buffer | no |
| `src/render/renderer.ts` | two-layer Canvas 2D renderer with cached paths | canvas interface only |
| `src/dom/surface.ts` | browser binding: pointer events, rAF scheduling, metrics | yes |
| `src/dev/generate.ts` | deterministic generated strokes for tests and benchmarks | no |
| `harness/` | development page: pen, eraser, undo, 3,000-stroke load, pan benchmark, results export, local scratch draft | yes |

The harness draft is stored in this browser's `localStorage` under `nova-ink-engine-harness:draft:v1`. It is scratch data, never a NOVA notebook.
