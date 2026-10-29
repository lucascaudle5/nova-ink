import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const server = fs.readFileSync(path.resolve('server.ts'), 'utf8')

test('the notebook tool advertises a ChatGPT thread entrypoint', () => {
  assert.match(server, /'openai\/ui': \{ entrypoints: \[\{ type: 'thread' \}\] \}/)
  assert.match(server, /inputSchema: z\.object\(\{\}\)/)
  assert.match(server, /resourceUri: UI_URI/)
})

test('the resource keeps fullscreen available for focus mode', () => {
  assert.match(server, /availableDisplayModes: \[\s*'inline', 'fullscreen'\s*\]/)
})
