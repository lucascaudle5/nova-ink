# nova-ink-cloudflare-spike

Local-only spike for moving NOVA Ink storage to Cloudflare (Durable Objects + SQLite). **Not deployed, no auth, not for production.** Design and findings: `docs/V0.3_STORAGE_AND_CLOUDFLARE.md`. Raw measurements: `docs/bench-results.json`.

Generated test data only. This folder never reads the NOVA repo's data or `%LOCALAPPDATA%\NOVA-Ink\data`; `test/helpers/snapshots.mjs` is a copy of the NOVA repo's helper.

```
npm install
npm run fixtures                      # real tldraw snapshots -> test/fixtures (gitignored)
npm run typecheck
npm test                              # Workers runtime tests (vitest + @cloudflare/vitest-plugin)
npx wrangler deploy --dry-run --outdir dist   # local bundle only: no login, no deploy
npm run test:node                     # real process restart + tldraw load + v0.2 import (needs dist/)
npm run bench                         # local CPU / row-write measurements (needs dist/, Windows PowerShell)
```

`npm run test:node` and `bench` need `--test-force-exit`-style behaviour; the scripts already set it.
Set `WRANGLER_SEND_METRICS=false` to stop wrangler telemetry.

Layout: `src/canvas-do.ts` (storage engine), `src/index.ts` (JSON routes), `src/diff.ts` (client-side change computation), `src/import-v02.mjs` (read-only importer).
