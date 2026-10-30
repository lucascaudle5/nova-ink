import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index'

const rpc = async (method: string, params?: unknown, id: number | null = 1) => {
  const res = await worker.fetch(new Request('https://probe.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }) }))
  return { res, body: res.status === 202 ? null : await res.json() as any }
}

test('initialize echoes the client protocol version and advertises tools, resources and the UI extension', async () => {
  const { body } = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  assert.equal(body.result.protocolVersion, '2025-11-25')
  assert.ok(body.result.capabilities.tools && body.result.capabilities.resources)
  assert.ok(body.result.capabilities.extensions['io.modelcontextprotocol/ui'])
})

test('the one model-facing tool links to the widget, in both the current and the older metadata key', async () => {
  const { body } = await rpc('tools/list')
  const show = body.result.tools.find((t: any) => t.name === 'show_probe')
  assert.equal(show._meta.ui.resourceUri, 'ui://gemini-probe/hello')
  assert.equal(show._meta['ui/resourceUri'], 'ui://gemini-probe/hello')
  assert.equal(show.annotations.readOnlyHint, true)
})

test('the widget is served as an MCP App page that shows a banner and talks to its host', async () => {
  const { body } = await rpc('resources/read', { uri: 'ui://gemini-probe/hello' })
  const c = body.result.contents[0]
  assert.equal(c.mimeType, 'text/html;profile=mcp-app')
  assert.match(c.text, /PROBE WIDGET RENDERED/)
  assert.match(c.text, /ui\/initialize/)
  assert.match(c.text, /ui\/notifications\/initialized/)
  assert.doesNotMatch(c.text, /<script[^>]+src=/, 'one inline script, nothing external')
  const missing = await rpc('resources/read', { uri: 'ui://gemini-probe/other' })
  assert.equal(missing.body.error.code, -32002)
})

test('tools answer, notifications get no reply, unknown things are errors', async () => {
  assert.match((await rpc('tools/call', { name: 'show_probe', arguments: {} })).body.result.content[0].text, /PROBE WIDGET RENDERED/)
  assert.match((await rpc('tools/call', { name: 'probe_ping', arguments: {} })).body.result.content[0].text, /^pong /)
  assert.equal((await rpc('tools/call', { name: 'nope' })).body.error.code, -32602)
  assert.equal((await rpc('notifications/initialized', undefined, null)).res.status, 202)
  assert.equal((await rpc('bogus')).body.error.code, -32601)
  const get = await worker.fetch(new Request('https://probe.test/mcp'))
  assert.equal(get.status, 405)
  assert.equal((await worker.fetch(new Request('https://probe.test/health'))).status, 200)
})
