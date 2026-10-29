# NOVA Ink v0.2.1 — persistent, iPad-first notebook development test

NOVA Ink is a private tldraw MCP App for the native ChatGPT iPad app. Focus Mode is the working experience: write independently, request help intentionally, return to the canvas without losing the current camera. The desktop thread entrypoint is retained; iPad side-by-side is not currently dependable.

## v0.2.1: private tool metadata compatibility

Removed the UI resource binding from the six app-only notebook data operations. Only `open_nova_ink` now declares the widget resource. This addresses the ChatGPT Refresh tools warning about private tools not rendering their widgets. The app-only tools retain `visibility: ["app"]` and are still callable from the embedded notebook. No storage format or data directory changes. Whether the warning disappears in ChatGPT must be verified against the connected host after restart/refresh.

## Changes from v0.1.3

- Named canvases, with last-opened canvas restored on launch
- Server-side tldraw snapshot persistence (drawing **and** camera/session state)
- Automatic saves after 650ms of quiet; Save now button; server-acknowledged **Saved**, **Saving**, **Not synced** status
- Optimistic revision conflict protection; single active editing lease per canvas (45 seconds, renewed every 15 seconds)
- Library with Create / switch canvas; read-only view if another client is editing; explicit Release editing under Host tools
- Previous five revisions retained as local backups
- Ask NOVA still uses the selected work or visible viewport, with an image and an evidence-bounded hint request; annotations are not yet implemented
- No IndexedDB or third-party persistence service is required

This is a **private, single-process prototype**, not a production-ready multi-user service. It has no end-user authentication, database transactions, encryption-at-rest, backup export, or durable offline capability. Keep it on `127.0.0.1` behind the existing restricted OpenAI Secure MCP Tunnel. **Do not store employer or confidential documents** here. The snapshot limit is 12 MiB per canvas.

## Installation / upgrade on Windows

**Before updating:** v0.1.3 drawings are only in memory. Photograph or export anything you want to keep. Stop the old `npm run start` server with `Ctrl+C` but keep the secure tunnel process open.

1. Extract this ZIP into a **new folder** (do not overwrite the existing v0.1.3 project).
2. Open PowerShell or CMD in the extracted `nova-ink-chatgpt-mcp-v0.2.1` folder.
3. Run:

```cmd
npm install
npm test
npm run build:host-test
npm run start
```

Or run `start-windows-test.cmd` (build and launch; it installs dependencies if needed).

The server still listens at `http://127.0.0.1:3001/mcp` and `/health` still confirms availability. **Keep your existing tunnel and plugin**; they continue pointing to the same local port. The ChatGPT host may cache the old UI resource, so refresh/reconnect the custom plugin if it still displays v0.1.3.

### Durable data location

Storage defaults to:

```text
%LOCALAPPDATA%\NOVA-Ink\data
```

For example: `C:\Users\<you>\AppData\Local\NOVA-Ink\data`. Unlike the source folder, this directory survives replacing the application code. It contains `manifest.json`, `canvases\<canvas-id>.json`, and `backups\...`.

You can customize it *before launching the server*:

```powershell
$env:NOVA_INK_DATA_DIR = Join-Path $HOME 'Documents\NOVA-Ink-Test-Data'
npm run start
```

**Keep the data directory private**; the files contain your complete notes and history. Do not delete it while upgrading. Data is backed up locally to five prior snapshot versions, but there is no cloud disaster recovery yet.

## iPad acceptance test

1. Relaunch the linked `NOVA Ink Dev` plugin and confirm that the header displays **v0.2.1**.
2. Create a `Dynamics — Test` canvas. Write `F = ma`, and pan/zoom to an unusual position.
3. Wait until the footer or top bar explicitly says **Saved**. The initial in-memory label is **not** sufficient.
4. Close NOVA Ink and reopen it in a *new ChatGPT tool invocation*. Verify that it resumes `Dynamics — Test` with the same drawing, position, and zoom.
5. Create a second canvas, switch away and back, verify the content is kept separately.
6. Disconnect the network temporarily: confirm a failed save reports **Not synced**, never **Saved**. Avoid intentionally producing important unsaved work.
7. Optionally open the same canvas on a second device while the first is active: the second should be read only. To transfer control, ensure the first says Saved, then use **Host tools → Release editing**; refresh/request editing on the second. If the first app was terminated abruptly, wait up to 45 seconds for its lease to expire.
8. Ask NOVA for a hint and verify canvas-context image transfer still works.

**Important:** Autosave happens shortly after changes stop, not instantly. If you close the window before the server confirms Saved, recent changes may be lost. A failed or conflicting save blocks canvas switching rather than silently overwriting data.

## Known limitations

- Full React/MCP build was **not verified in the authoring environment** because dependency installation timed out. The independent storage tests passed. Complete `npm test` and `npm run build:host-test` on Windows before trying iPad.
- The tldraw production license warning remains in development builds. `build:host-test` builds with `NODE_ENV=development` for local prototype evaluation only.
- Browser/app host behavior can prevent reliable teardown callbacks; never assume the last edits saved without confirmation.
- The default tldraw bottom toolbar has not yet been moved to the top; that is a separate UI task.
- PDF imports, AI-generated annotations, replay/event ledger, simultaneous editing, persistent offline use, and cloud-hosted multi-instance storage are later milestones.
- If you use a different machine with the *same* tunnel but run a different server, the data is **not shared** automatically. Persistence is bound to the machine hosting the server. We can migrate it to a centrally hosted store after acceptance testing.

## References

- https://tldraw.dev/sdk-features/persistence
- https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/patterns.md
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
