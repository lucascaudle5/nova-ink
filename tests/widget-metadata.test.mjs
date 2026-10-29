import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const server = fs.readFileSync(path.resolve('server.ts'), 'utf8')

test('only the visible launcher binds the tldraw widget', () => {
  assert.match(server, /registerAppTool\(server, 'open_nova_ink',[\s\S]*?resourceUri: UI_URI/)
  assert.match(server, /const appOnly = \{ ui: \{ visibility: \[\'app\' as const\] \} \}/)
  assert.doesNotMatch(server, /const appOnly = \{ ui: \{ resourceUri:/)
})

test('all notebook and recovery operations remain private to the embedded app', () => {
  for (const name of ['ink_list_canvases', 'ink_create_canvas', 'ink_open_canvas', 'ink_list_backups', 'ink_restore_backup', 'ink_save_canvas', 'ink_heartbeat', 'ink_release_editor']) {
    assert.match(server, new RegExp(`registerAppTool\\(server, '${name}'`))
  }
})
