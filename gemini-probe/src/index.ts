/**
 * A tiny, throw-away MCP server whose only job is to answer one question: does Gemini render an MCP App (a ui://
 * widget) from a server added by URL? It has no sign-in, no storage and no connection to NOVA Ink or any notebook:
 * one tool opens one page that says so in big letters and shows every message the host sends it.
 *
 * Every request is logged as one JSON line (`wrangler tail`), so we can see whether the host asks for the widget
 * (resources/read) even when it shows nothing.
 *
 * Plain JSON-RPC over HTTP (the "Streamable HTTP" transport, answered as JSON, no sessions), so there is nothing
 * to install and nothing that could differ from the specification by accident.
 */

const UI_URI = 'ui://gemini-probe/hello'
const MIME = 'text/html;profile=mcp-app'

const WIDGET = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Probe widget</title>
<style>
  body { margin: 0; font: 16px system-ui, sans-serif; background: #fff7d6; color: #1b1b1b; }
  h1 { margin: 0; padding: 18px; background: #16a34a; color: #fff; font-size: 28px; }
  pre { margin: 0; padding: 12px 18px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  button { margin: 12px 18px; padding: 10px 16px; font-size: 16px; }
</style></head>
<body>
<h1>PROBE WIDGET RENDERED</h1>
<pre id="static">This page loaded and its script is running. Time: <span id="t"></span></pre>
<button id="ping">Call the probe_ping tool from this widget</button>
<pre id="log"></pre>
<script>
  const log = (line) => { document.getElementById('log').textContent += line + '\\n' }
  document.getElementById('t').textContent = new Date().toISOString()
  log('frame: top=' + (window === window.top) + ' origin=' + location.origin)
  let nextId = 1
  const pending = new Map()
  const send = (message) => window.parent.postMessage(message, '*')
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => { if (pending.delete(id)) reject(new Error('no answer to ' + method + ' after 5 s')) }, 5000)
  })
  window.addEventListener('message', (event) => {
    const m = event.data
    log('host -> widget: ' + JSON.stringify(m).slice(0, 600))
    if (m && m.jsonrpc === '2.0' && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  })
  document.getElementById('ping').addEventListener('click', async () => {
    try { log('tools/call result: ' + JSON.stringify(await request('tools/call', { name: 'probe_ping', arguments: {} }))) }
    catch (e) { log('tools/call failed: ' + e.message) }
  })
  ;(async () => {
    try {
      const r = await request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'gemini-probe', version: '1.0.0' },
        appCapabilities: {},
      })
      log('ui/initialize ok: ' + JSON.stringify(r).slice(0, 600))
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} })
    } catch (e) { log('ui/initialize failed: ' + e.message) }
  })()
</script>
</body></html>`

const TOOLS = [
  {
    name: 'show_probe',
    description: 'Show the probe widget. Use this when the user asks to open, show or test the probe.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: UI_URI }, 'ui/resourceUri': UI_URI },
  },
  {
    name: 'probe_ping',
    description: 'Return the current time. Called by the probe widget to test the widget-to-server bridge.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app', 'model'] } },
  },
]

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }

function handle(message: Rpc): unknown | null {
  const { id, method, params } = message
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } })
  if (id === undefined || id === null) return null // a notification: no reply
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, extensions: { 'io.modelcontextprotocol/ui': {} } },
        serverInfo: { name: 'gemini-probe', version: '1.0.0' },
        instructions: 'A test server with one tool, show_probe, that opens a small widget. It holds no data.',
      })
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: TOOLS })
    case 'tools/call': {
      if (params?.name === 'show_probe') return ok({ content: [{ type: 'text', text: 'The probe widget was opened. If you can see a green banner that says PROBE WIDGET RENDERED, widgets work here.' }], structuredContent: { probe: true } })
      if (params?.name === 'probe_ping') return ok({ content: [{ type: 'text', text: 'pong ' + new Date().toISOString() }], structuredContent: { pong: true } })
      return fail(-32602, 'Unknown tool')
    }
    case 'resources/list': return ok({ resources: [{ uri: UI_URI, name: 'Probe widget', mimeType: MIME }] })
    case 'resources/templates/list': return ok({ resourceTemplates: [] })
    case 'resources/read':
      if (params?.uri === UI_URI) return ok({ contents: [{ uri: UI_URI, mimeType: MIME, text: WIDGET, _meta: { ui: { csp: { resourceDomains: [], connectDomains: [] } } } }] })
      return fail(-32002, 'Resource not found')
    case 'prompts/list': return ok({ prompts: [] })
    default: return fail(-32601, 'Method not found')
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ok: true, app: 'gemini-probe' })
    if (url.pathname !== '/mcp') return new Response('Gemini probe: an MCP test server at /mcp. It holds no data.', { status: 404 })
    if (request.method === 'GET') return new Response('This server answers POST only.', { status: 405, headers: { allow: 'POST' } })
    if (request.method !== 'POST') return new Response(null, { status: 405 })

    let body: Rpc | Rpc[]
    try { body = await request.json() } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 }) }
    const batch = Array.isArray(body)
    const replies: unknown[] = []
    for (const message of batch ? body : [body]) {
      console.log(JSON.stringify({ evt: 'rpc', method: message?.method, tool: message?.params?.name, uri: message?.params?.uri, ua: request.headers.get('user-agent')?.slice(0, 80) }))
      const reply = handle(message ?? {})
      if (reply) replies.push(reply)
    }
    if (!replies.length) return new Response(null, { status: 202 })
    return Response.json(batch ? replies : replies[0])
  },
}
