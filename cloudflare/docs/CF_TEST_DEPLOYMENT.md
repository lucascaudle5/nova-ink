# NOVA Ink on Cloudflare: throwaway test deployment (auth + MCP layer)

Purpose: answer the three go/no-go questions of `V0.3_STORAGE_AND_CLOUDFLARE.md` section 9 on real Cloudflare. The Windows server stays the working version. Nothing here replaces it, and nothing here may touch real notes: **generated test data only**.

Worker name `nova-ink-test` on `workers.dev`. Delete it when done (section 6).

## 1. What exists

```
ChatGPT --OAuth 2.1+PKCE--> /authorize (consent page) --> Cloudflare Access login (OTP, your email only)
        <-- /callback: verify ID token (signature via JWKS, issuer, audience, nonce, expiry) + ALLOWED_EMAIL
        --Bearer token--> /mcp  --> tools (server.ts contract) --> LibraryDO (canvas list) + CanvasDO (one per canvas)
```

- `src/app.ts`: `@cloudflare/workers-oauth-provider` (`OAuthProvider`, one Worker) with our `/authorize` and `/callback`; KV namespace `OAUTH_KV`; scopes `mcp:read`, `mcp:write`, `offline_access`.
- `src/mcp.ts`: the same tool names, input schemas, result shapes and `ui://nova-ink/canvas` resource as the Windows `server.ts` (v0.2.3).
- `src/config.ts`: **fail closed**. Any missing or malformed secret/binding => every route except `GET /health` returns 503.
- `src/library-do.ts`: minimal canvas list (no notebooks, trash, PDF sources).
- `CanvasDO.diagOp` + `src/diag-data.ts`: generated canvases for the diagnostics tool.

### Differences from the Windows server (deliberate)

| Area | Windows `server.ts` | This Worker |
|---|---|---|
| `ink_save_canvas` | stores the whole snapshot | receives the whole snapshot (widget unchanged); the Durable Object diffs it against stored rows and writes only changes |
| `ink_start_canvas_fresh` | works | returns `NOT_IMPLEMENTED` (not built) |
| `ink_list_backups` / restore | v0.2 backup files | gzip checkpoints in the canvas object (10 kept, at most 1 per 10 min) |
| Extra tools | none | `nova_ink_diagnostics`, `nova_ink_diag_payload` (model-visible; generated data only) |
| Canvas library | `manifest.json` | `LibraryDO` (ownership check: an id not in your library is `NOT_FOUND`) |
| Unauthenticated JSON API of the first spike | n/a | removed |

## 2. Verification status

| Claim | Where verified | How |
|---|---|---|
| Unauthenticated / garbage / wrong-scheme bearer requests to `/mcp` get 401 | **local workerd only** | `test/workers/auth.test.ts` |
| Wrong email, wrong audience/issuer/signature, missing or replayed nonce, expired token never produce a code | **local workerd only**, fake Access with real RS256 + JWKS. Mutation-checked: disabling the email and nonce checks makes 4 tests fail | same |
| Missing/blank/malformed secret or binding => 503 everywhere but `/health` | **local workerd** (tests) and **`wrangler dev` with no secrets** (curl: every route 503, `/health` says `configured:false`) | same + manual |
| Access URLs not on `*.cloudflareaccess.com` are refused (the client secret cannot be sent elsewhere) | local workerd only | same |
| Valid auth reaches the tools: list, create, open, save, replay, conflict, lease, checkpoint restore, save-as-new, scopes, refresh-token rotation | **local workerd only** | same |
| Existing storage tests (34) still pass | local workerd | `npm test` |
| Generated diagnostic canvases load in real tldraw | local Node | `test/node/diag-data.test.mjs` |
| Anything on real Cloudflare, real Access, real ChatGPT (CIMD client registration, refresh behaviour, payload limits, CPU limits) | **NOT verified** | that is what the checks below are for |
| `scripts/tail-report.mjs` parses real `wrangler tail` output | **NOT verified**: only run on a hand-made sample. First real run may need a field-name fix | see section 5 |

ChatGPT registers itself by Client ID Metadata Document (CIMD). The tests use Dynamic Client Registration instead, so **the CIMD path is untested locally**. It is enabled (compat flag `global_fetch_strictly_public`).

## 3. Configuration

| Name | Kind | Where | Value |
|---|---|---|---|
| `OAUTH_KV` | KV binding | `wrangler.jsonc` | created: id `1fd7d147353e4718a9f7a7388fa1ef2c` (an id is not a secret) |
| `CANVAS`, `LIBRARY` | Durable Object bindings | `wrangler.jsonc` | `CanvasDO`, `LibraryDO` (SQLite) |
| `PUBLIC_ORIGIN` | plain var | `wrangler.jsonc` | `https://nova-ink-test.<your-subdomain>.workers.dev`; empty until the first deploy (fails closed) |
| `ACCESS_CLIENT_ID` | secret | `wrangler secret put` | from the Access SaaS app |
| `ACCESS_CLIENT_SECRET` | secret | same | same |
| `ACCESS_TOKEN_URL` | secret | same | `https://nova-dev.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>/token` |
| `ACCESS_AUTHORIZATION_URL` | secret | same | `.../authorization` |
| `ACCESS_JWKS_URL` | secret | same | `.../jwks` (the "Key endpoint") |
| `ALLOWED_EMAIL` | secret | same | your email, the one allowed by the Access policy |

The Worker derives the expected ID-token issuer from `ACCESS_AUTHORIZATION_URL` (the same URL without `/authorization`) and refuses the configuration unless all three URLs are on one `*.cloudflareaccess.com` host and one app path.

## 4. Deployment steps and where they stand

1. DONE: `npx wrangler login` (account "Ai.nova.personal@gmail.com's Account"), Zero Trust team `nova-dev`, OTP login, policy for your email.
2. DONE: `npx wrangler kv namespace create OAUTH_KV`.
3. **BLOCKED ON YOU: register a `workers.dev` subdomain.** The account has none; `wrangler deploy` says "You need to register a workers.dev subdomain before publishing" and cannot do it non-interactively. Open https://dash.cloudflare.com/b4099aa2c922291057c185b0edaec09a/workers/onboarding and choose a subdomain. It becomes part of the public URL, so pick one you are happy to have in it.
4. After 3: `npm run widget` then `npx wrangler deploy` (no secrets yet; it fails closed). Note the printed URL, put its origin in `PUBLIC_ORIGIN`, deploy again, then `curl <url>/health` (expect `"configured":false`) and `curl -i <url>/mcp` (expect 503).
5. Create the Access app and set the secrets (below). Nothing can sign in before this.

### 4a. Access for SaaS (OIDC) application: dashboard steps

Checked against the Cloudflare One docs page "Generic OIDC application" (updated Aug 25, 2026). Menu names move around; the page is https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/.

1. Cloudflare dashboard -> **Zero Trust** -> **Access controls** -> **Applications** -> **Create new application**.
2. Choose **SaaS application**. For *Application*, type a custom name (`NOVA Ink test`) and select the text box that appears below the drop-down.
3. Choose **OIDC** -> **Add application**.
4. **Scopes**: keep `openid`, `email`, `profile`. (`email` is required; the Worker refuses a token without it.)
5. **Redirect URLs**: `https://nova-ink-test.<your-subdomain>.workers.dev/callback` (exactly; no trailing slash).
6. **PKCE**: turn it on (the Worker always sends a PKCE challenge, so either setting works).
7. **Refresh tokens**: turn on, if the toggle is shown. Note for check 2: ChatGPT's refresh uses refresh tokens issued by *this Worker*, not by Access, so this setting does not decide whether ChatGPT stays connected. It only matters if we later make the Worker re-check Access on refresh.
8. **OIDC flows**: leave on "No additional OIDC flows" (refresh tokens are not supported with hybrid/implicit flows).
9. **Access policies**: add your existing "only my email" policy. **Identity providers**: One-time PIN only.
10. **Create**. Copy: Client ID, Client secret, Token endpoint, Authorization endpoint, Key endpoint. Keep them out of chat, files and commits.

### 4b. Secrets: run these yourself

Each command prompts for the value; paste it at the prompt (not on the command line). Run from `cloudflare/`:

```powershell
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_JWKS_URL
npx wrangler secret put ALLOWED_EMAIL
npx wrangler secret list
```

`ACCESS_TOKEN_URL` = "Token endpoint", `ACCESS_AUTHORIZATION_URL` = "Authorization endpoint", `ACCESS_JWKS_URL` = "Key endpoint". `secret list` shows names only. Then `curl <url>/health` should say `"configured":true`.

## 5. After deploying: checklist

1. **Confirm the Worker refuses unauthenticated access.** `curl -i https://<worker>/mcp` -> `401` with a `WWW-Authenticate: Bearer ... resource_metadata=` header; `curl -i -X POST https://<worker>/mcp -d "{}"` -> `401`; `curl -i https://<worker>/api/canvas/00000000-0000-4000-8000-000000000000/open` -> `404`. `curl https://<worker>/health` -> `{"ok":true,...,"configured":true}` and nothing else about the Worker. Optional: `wrangler secret delete ALLOWED_EMAIL` then `/mcp` must return 503 (fail closed on real Cloudflare), then put it back.
2. **Connect it to ChatGPT on desktop first** (web or Windows app). Where things live in ChatGPT changes, and I have not verified the current menus, so treat these as the usual path: Settings -> Apps / Connectors -> Advanced settings -> turn on **Developer mode** -> **Create** (new app/connector). Name `NOVA Ink test`; MCP server URL `https://nova-ink-test.<your-subdomain>.workers.dev/mcp`; Authentication **OAuth** (leave client id/secret empty so ChatGPT registers itself). Click Create/Connect; a NOVA Ink consent page opens; tick nothing off, **Allow and sign in**; Cloudflare Access asks for your email and a one-time PIN; you return to ChatGPT. In a new chat enable the app and say "Open NOVA Ink". Create a canvas, draw, wait for **Saved**. Tell me what you see (including any ChatGPT error text); I will not claim it works until you confirm.
3. **Run each go/no-go check and record the numbers.** In a second terminal: `npx wrangler tail nova-ink-test --format json | node scripts/tail-report.mjs --raw` (leave running; the first lines print raw events so we can confirm the field names).
   - **Check 1, Durable Object CPU limits.** In ChatGPT: "Run nova_ink_diagnostics with sizes s100, s500, s1500", then "... s3000", then "... img3mb, img8mb". At most 4 sizes per call (Worker subrequest limit). The reply lists wall time and rows per step; the CPU per step is in the tail table ("object" rows). Record, for each size and step: cpu ms, wall ms, outcome. Note any `exceededCpu`, error 1102, or a step marked FAILED. Then the real path: "Run nova_ink_diagnostics with sizes s1500 and materialize true", open the new `DIAG s1500 ... (generated)` canvas in the widget, move one stroke, wait for Saved; record the "tool" rows for `ink_open_canvas` and `ink_save_canvas` (these include the Worker's own JSON work, which the diagnostics steps do not).
   - **Check 2, OAuth and refresh.** Record: did the whole sign-in complete first try? Access tokens last 1 hour; use the app again after more than 1 hour and again the next day without reconnecting. Record whether ChatGPT asked you to sign in again. Refresh grants last 30 days from the code exchange (fixed, not sliding).
   - **Check 3, payload limits.** In the widget, on a DIAG canvas, paste/drag in images of about 1, 3, 6, 9 and 11 MB and watch the status; record the largest that reaches **Saved** and the exact text of the first "Not synced"/error. The tail "tool" rows show `bytesIn` for each save. Also ask ChatGPT: "Call nova_ink_diag_payload with respondBytes 1000000", then 4000000, 8000000, 12000000.
   Record results in the table below.
4. **Take it down if the results say no** (section 6).

### Results table (fill in)

| Check | Size / step | cpu ms | wall ms | Outcome | Notes |
|---|---|---|---|---|---|
| 1 | s100 open | | | | |
| 1 | s500 open | | | | |
| 1 | s1500 open | | | | |
| 1 | s1500 first save | | | | |
| 1 | s1500 save +3 (steady) | | | | |
| 1 | s1500 checkpoint | | | | |
| 1 | s3000 open / save | | | | |
| 1 | real widget: `ink_open_canvas` s1500 | | | | |
| 1 | real widget: `ink_save_canvas` s1500 | | | | |
| 2 | first sign-in completes | | | | |
| 2 | works after 1 h (refresh) | | | | |
| 2 | works next day | | | | |
| 3 | largest save that reaches Saved | | | | |
| 3 | largest tool response received | | | | |

Interpretation: if open/save of a 100-stroke canvas already exceeds the limit, the free plan does not work for this design (V0.3 doc section 3.4: paged load, alarm checkpoints, Workers Paid, or keep the Windows server).

## 6. Take it down

```powershell
npx wrangler delete --name nova-ink-test          # removes the Worker, its secrets, and (it asks) the Durable Object data
npx wrangler kv namespace delete --namespace-id 1fd7d147353e4718a9f7a7388fa1ef2c
```

Then in the dashboard: delete the `NOVA Ink test` Access application (Zero Trust -> Access controls -> Applications). The `workers.dev` subdomain, the team domain and the policy can stay or be removed separately. Nothing real was ever stored here: only generated canvases and the "My First Canvas" blank.

## 7. Known limits of this test deployment

- `ink_start_canvas_fresh` is not built.
- The Library is minimal (no notebooks, no trash). A canvas's `updatedAt` in the Library is refreshed at most once a minute, so the list order lags edits slightly.
- Access sessions are not re-checked on refresh: once the Worker has issued a grant, revoking you in Access does not stop that grant before it expires (30 days) unless you delete the grant (KV) or the Worker.
- Consent is asked on every connect (no "remember"), by design for a test.
- Cloudflare's per-request CPU cannot be read inside a Worker (timers only advance on I/O), so CPU comes from `wrangler tail`/the dashboard, and wall time in the diagnostics is the Worker's view around each call.
