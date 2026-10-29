import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import { NotebookStore } from './storage.mjs'
import type { StorageResult } from './storage.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const UI_URI = 'ui://nova-ink/canvas'
const notebooks = new NotebookStore()
const uuid = z.string().uuid()

function result(data: StorageResult) {
  return { structuredContent: data, content: [{ type: 'text' as const, text: data.ok ? 'NOVA Ink notebook operation completed.' : `NOVA Ink notebook error: ${String(data.message ?? data.code)}` }] }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'NOVA Ink Private Notebook', version: '0.2.1' })

  registerAppTool(server, 'open_nova_ink', {
    title: 'Open NOVA Ink',
    description: 'Open NOVA Ink: a private tldraw notebook with named canvases, server-confirmed autosave and student-initiated ChatGPT hints.',
    inputSchema: z.object({}),
    _meta: {
      ui: { resourceUri: UI_URI },
      // ChatGPT conversation panel / thread tab entrypoint.
      // This makes the notebook available as a thread surface, but the
      // ChatGPT host still owns device-specific split-screen presentation.
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
    },
  }, async () => ({
    content: [{ type: 'text', text: 'Opening NOVA Ink v0.2: named canvases are saved to the private MCP server. Saving is asynchronous; check the saved status before closing the notebook. The user initiates all tutoring requests.' }],
    structuredContent: { application: 'nova-ink', phase: 'persistent-canvas-test', version: '0.2.1' },
  }))

  // These six tools are private data operations, not UI launchers.
  // A widget URI here made ChatGPT's tool refresh report that private tools
  // could not render their widgets. The visible open_nova_ink tool alone
  // owns the UI template. App-only visibility still permits app-origin calls.
  const appOnly = { ui: { visibility: ['app' as const] } }
  registerAppTool(server, 'ink_list_canvases', {
    description: 'Read the private NOVA Ink canvas library', inputSchema: z.object({}), _meta: appOnly,
  }, async () => result(await notebooks.list()))
  registerAppTool(server, 'ink_create_canvas', {
    description: 'Create a named canvas after an explicit user action', inputSchema: z.object({ name: z.string().min(1).max(80) }), _meta: appOnly,
  }, async ({ name }) => result(await notebooks.create(name)))
  registerAppTool(server, 'ink_open_canvas', {
    description: 'Restore a canvas and obtain editing control if available', inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, async ({ canvasId, clientId }) => result(await notebooks.open(canvasId, clientId)))
  registerAppTool(server, 'ink_save_canvas', {
    description: 'Save a complete tldraw snapshot with optimistic revision checking',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid, expectedRevision: z.number().int().nonnegative(), snapshot: z.record(z.string(), z.unknown()) }), _meta: appOnly,
  }, async ({ canvasId, clientId, expectedRevision, snapshot }) => result(await notebooks.save(canvasId, clientId, expectedRevision, snapshot)))
  registerAppTool(server, 'ink_heartbeat', {
    description: 'Renew an editing lease for a canvas', inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, async ({ canvasId, clientId }) => result(await notebooks.heartbeat(canvasId, clientId)))
  registerAppTool(server, 'ink_release_editor', {
    description: 'Release editing control after confirmed save', inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, async ({ canvasId, clientId }) => result(await notebooks.release(canvasId, clientId)))

  registerAppResource(server, 'NOVA Ink Canvas', UI_URI, {
    mimeType: RESOURCE_MIME_TYPE,
  }, async () => {
    const html = await fs.readFile(path.join(here, 'dist', 'mcp-app.html'), 'utf-8')
    return {
      contents: [{
        uri: UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        // Tell ChatGPT up front which host layouts this app can use.
        _meta: {
          'openai/ui': {
            availableDisplayModes: ['inline', 'fullscreen'],
            preferredDisplayMode: 'fullscreen',
          },
          ui: {
            // tldraw normally retrieves its UI fonts, icons, and translations
            // from this CDN. Hosts may still reject these domains.
            csp: { resourceDomains: ['https://cdn.tldraw.com'], connectDomains: ['https://cdn.tldraw.com'] },
          },
        },
      }],
    }
  })

  return server
}
