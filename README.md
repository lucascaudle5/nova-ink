# NOVA Ink v0.2.2 working copy — persistent, iPad-first notebook development test

NOVA Ink is a private tldraw MCP App for ChatGPT on iPad. Focus Mode is the working experience: write independently, request help intentionally, then return to the canvas without losing the camera. Desktop conversation side-by-side is available; iPad side-by-side use is not dependable.

## Current working changes

This source folder began as packaged v0.2.1. It is now a local v0.2.2 working copy and has not been repackaged or published.

- Moved tldraw's native toolbar into its top panel. Drawing behavior is unchanged in code; Apple Pencil and touch behavior still need iPad acceptance.
- Added an app-only backup picker under Host tools → Backups. Restore creates a new revision and preserves the current valid revision as a backup.
- If the current saved record is corrupt, the app offers valid backups and copies the damaged file into recovery/ before restoring. A current editor lease and revision check still apply.
- A client whose editing lease expired must reacquire control before saving.

## Existing features

- Named canvases and last-opened canvas resume
- Server-side tldraw snapshots, including drawing and camera/session state
- Autosave after 650 ms of quiet; Save now; server-confirmed Saved, Saving, and Not synced status
- Optimistic revision checks and one active editor lease per canvas (45 seconds, renewed every 15 seconds)
- Canvas library, read-only view while another client edits, and explicit Release editing under Host tools
- Five newest valid revisions retained as local backups
- Ask NOVA uses selected work or the visible viewport and does not mutate the canvas

This is a private, single-process prototype, not a production multi-user service. It has no end-user authentication, database transactions, encryption at rest, backup export, or durable offline capability. Keep it on 127.0.0.1 behind the existing restricted OpenAI Secure MCP Tunnel. Do not store employer or confidential documents. The snapshot limit is 12 MiB per canvas.

## Run this working copy on Windows

From the project folder containing package.json:

    npm install
    npm test
    npm run build:host-test
    npm run start

Or run start-windows-test.cmd to build and launch; it installs dependencies if needed.

The server listens at http://127.0.0.1:3001/mcp. The /health endpoint confirms availability. Keep the existing tunnel and plugin; they point to the same local port. Refresh or reconnect the custom plugin if ChatGPT displays a cached older UI.

### Durable data

The default data location is %LOCALAPPDATA%\NOVA-Ink\data. It contains the manifest, canvas snapshots, and backups and is separate from the source folder. Keep it private and do not delete it while updating. Backups stay on the hosting machine; there is no off-machine disaster recovery.

To use a separate test location, set it before launching:

    $env:NOVA_INK_DATA_DIR = Join-Path $HOME 'Documents\NOVA-Ink-Test-Data'
    npm run start

## iPad and host acceptance checklist

Use a disposable canvas for backup testing. Do not corrupt real notebook files.

1. Relaunch the linked NOVA Ink Dev plugin and confirm version 0.2.2.
2. Create a Dynamics — Test canvas, write F = ma, and pan or zoom.
3. Wait until the UI explicitly says Saved.
4. Close NOVA Ink and reopen it in a new ChatGPT tool invocation. Verify drawing, position, and zoom return.
5. Create another canvas, switch away and back, and verify contents remain separate.
6. On a disposable canvas with multiple revisions, use Host tools → Backups to restore an earlier revision and confirm it appears as a new revision.
7. Open the same canvas in a second client while the first is active; it should be read-only. After the first says Saved, use Release editing and request control from the second client.
8. On iPad, verify top-toolbar placement, Apple Pencil writing, and finger pan/zoom.
9. Ask NOVA for a hint and verify canvas-context image transfer.

Autosave occurs shortly after changes stop. If the app closes before the server confirms Saved, recent edits may be lost. A failed or conflicting save blocks canvas switching rather than silently overwriting data.

## Verification and limitations

On October 29, 2026, npm test passed all 24 tests and npm run build:host-test completed in development mode. Automated lease and backup tests do not replace live two-client or iPad acceptance.

The tldraw development build is for local evaluation, not production licensing. PDF imports, AI-generated annotations, replay/event ledger, simultaneous editing, durable offline use, and multi-instance cloud storage remain future work. Persistence is bound to the server's machine.
