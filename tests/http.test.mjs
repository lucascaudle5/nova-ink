// Exercises the real Express -> MCP -> storage path with genuine tldraw snapshots.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createHttpApp, HTTP_BODY_LIMIT_BYTES } from '../http.ts'
import { NotebookStore, MAX_SNAPSHOT_BYTES } from '../storage.mjs'
import { bytesOf, loadsInTldraw, makeSnapshot, shapeCount } from './helpers/snapshots.mjs'

let dir, listener, url
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nova-ink-http-'))
  const app = createHttpApp(new NotebookStore(dir, { log: () => {} }))
  await new Promise(resolve => { listener = app.listen(0, '127.0.0.1', resolve) })
  url = new URL(`http://127.0.0.1:${listener.address().port}/mcp`)
})
after(async () => {
  listener.closeAllConnections()
  await new Promise(resolve => listener.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

async function withClient(cb) {
  const client = new Client({ name: 'nova-ink-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  try { return await cb(client) } finally { await client.close() }
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then(r => r.structuredContent)

async function openFresh(client, label) {
  const created = await call(client, 'ink_create_canvas', { name: label })
  const clientId = randomUUID()
  const opened = await call(client, 'ink_open_canvas', { canvasId: created.canvas.id, clientId })
  assert.equal(opened.ok, true)
  return { canvasId: created.canvas.id, clientId, revision: opened.revision }
}

test('a real handwriting snapshot round-trips through HTTP and loads in tldraw', () => withClient(async client => {
  const { canvasId, clientId } = await openFresh(client, 'Round trip')
  const snapshot = makeSnapshot({ strokes: 12, camera: { x: -40, y: 25, z: 1.75 } })
  const saved = await call(client, 'ink_save_canvas', { canvasId, clientId, expectedRevision: 0, saveId: randomUUID(), snapshot })
  assert.equal(saved.ok, true)
  const reopened = await call(client, 'ink_open_canvas', { canvasId, clientId: randomUUID() })
  assert.equal(reopened.revision, 1)
  assert.equal(shapeCount(reopened.snapshot), 12)
  assert.equal(loadsInTldraw(reopened.snapshot), 12)
  const state = Object.values(reopened.snapshot.session.pageStates)[0]
  assert.deepEqual(state.camera, { x: -40, y: 25, z: 1.75 })
}))

test('snapshots far above the old 100 KB parser default are accepted', () => withClient(async client => {
  const { canvasId, clientId } = await openFresh(client, 'Large handwriting')
  const handwriting = makeSnapshot({ strokes: 1500 })
  assert.ok(bytesOf(handwriting) > 1024 * 1024, `fixture is ${bytesOf(handwriting)} bytes`)
  const first = await call(client, 'ink_save_canvas', { canvasId, clientId, expectedRevision: 0, saveId: randomUUID(), snapshot: handwriting })
  assert.equal(first.ok, true)
  const withImage = makeSnapshot({ strokes: 40, imageBytes: 6 * 1024 * 1024 })
  const second = await call(client, 'ink_save_canvas', { canvasId, clientId, expectedRevision: 1, saveId: randomUUID(), snapshot: withImage })
  assert.equal(second.ok, true)
  assert.equal(second.revision, 2)
}))

test('a snapshot just over the storage limit gets a structured TOO_LARGE answer and nothing is saved', () => withClient(async client => {
  const { canvasId, clientId } = await openFresh(client, 'Too large')
  const snapshot = makeSnapshot({ strokes: 2, imageBytes: MAX_SNAPSHOT_BYTES + 1024 })
  assert.ok(bytesOf(snapshot) < HTTP_BODY_LIMIT_BYTES)
  const outcome = await call(client, 'ink_save_canvas', { canvasId, clientId, expectedRevision: 0, saveId: randomUUID(), snapshot })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'TOO_LARGE')
  assert.match(outcome.message, /limit is 12 MB/)
  assert.equal((await call(client, 'ink_open_canvas', { canvasId, clientId })).revision, 0)
}))

test('a request over the HTTP body limit fails with an explicit size error, not a silent drop', () => withClient(async client => {
  const { canvasId, clientId } = await openFresh(client, 'Over body limit')
  const snapshot = makeSnapshot({ strokes: 1, imageBytes: HTTP_BODY_LIMIT_BYTES + 1024 })
  await assert.rejects(
    client.callTool({ name: 'ink_save_canvas', arguments: { canvasId, clientId, expectedRevision: 0, saveId: randomUUID(), snapshot } }),
    error => /limit is 16 MB|413/.test(String(error?.message ?? error)),
  )
  assert.equal((await call(client, 'ink_open_canvas', { canvasId, clientId })).revision, 0)
}))

test('only the launcher binds the widget; every notebook tool is app-only', () => withClient(async client => {
  const { tools } = await client.listTools()
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  assert.equal(byName.open_nova_ink._meta.ui.resourceUri, 'ui://nova-ink/canvas')
  assert.deepEqual(byName.open_nova_ink._meta['openai/ui'], { entrypoints: [{ type: 'thread' }] })
  const notebookTools = tools.filter(tool => tool.name.startsWith('ink_'))
  assert.ok(notebookTools.length >= 10)
  for (const tool of notebookTools) {
    assert.deepEqual(tool._meta.ui.visibility, ['app'], tool.name)
    assert.equal(tool._meta.ui.resourceUri, undefined, tool.name)
  }
}))

test('the widget resource keeps fullscreen available', { skip: !existsSync('dist/mcp-app.html') && 'dist not built' }, () => withClient(async client => {
  const { contents } = await client.readResource({ uri: 'ui://nova-ink/canvas' })
  assert.deepEqual(contents[0]._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen'])
}))
