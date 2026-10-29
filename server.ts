import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import type { NotebookStore, StorageResult } from './storage.mjs'

export const VERSION = '0.2.3'
const here = path.dirname(fileURLToPath(import.meta.url))
const UI_URI = 'ui://nova-ink/canvas'
const uuid = z.string().uuid()
const saveId = z.string().min(1).max(64)

function result(data: StorageResult) {
  const text = data.ok ? 'NOVA Ink notebook operation completed.' : `NOVA Ink notebook error: ${String(data.message ?? data.code)}`
  return { structuredContent: data, content: [{ type: 'text' as const, text }] }
}

/** Runs a storage operation; unexpected exceptions become a structured, logged error instead of an opaque failure. */
async function run(tool: string, operation: () => Promise<StorageResult>) {
  try {
    const data = await operation()
    if (!data.ok) console.error(`[nova-ink] ${tool}: ${data.code}`)
    else if (data.warning) console.error(`[nova-ink] ${tool}: ${data.warning}`)
    return result(data)
  } catch (error) {
    const code = (error as { code?: string }).code
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[nova-ink] ${tool} failed: ${code ?? ''} ${message}`)
    return result({
      ok: false, code: code === 'MANIFEST_NEWER' ? code : 'SERVER_ERROR',
      message: code === 'MANIFEST_NEWER' ? message : `Notebook server error${code ? ` (${code})` : ''}: ${message}. The save was not confirmed.`,
    })
  }
}

export function createServer(notebooks: NotebookStore): McpServer {
  const server = new McpServer({ name: 'NOVA Ink Private Notebook', version: VERSION })

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
    content: [{ type: 'text', text: `Opening NOVA Ink v${VERSION}: named canvases are saved to the private MCP server. Saving is asynchronous; check the saved status before closing the notebook. The user initiates all tutoring requests.` }],
    structuredContent: { application: 'nova-ink', phase: 'persistent-canvas-test', version: VERSION },
  }))

  // Private notebook and recovery operations are not UI launchers.
  // Only open_nova_ink owns the widget resource; app-only visibility still
  // permits calls from the embedded notebook without exposing data tools.
  const appOnly = { ui: { visibility: ['app' as const] } }
  registerAppTool(server, 'ink_list_canvases', {
    description: 'Read the private NOVA Ink canvas library', inputSchema: z.object({}), _meta: appOnly,
  }, () => run('ink_list_canvases', () => notebooks.list()))
  registerAppTool(server, 'ink_create_canvas', {
    description: 'Create a named canvas after an explicit user action', inputSchema: z.object({ name: z.string().min(1).max(80) }), _meta: appOnly,
  }, ({ name }) => run('ink_create_canvas', () => notebooks.create(name)))
  registerAppTool(server, 'ink_save_as_new_canvas', {
    description: 'Preserve the local version of a canvas as a new named canvas after an explicit user action',
    inputSchema: z.object({ name: z.string().min(1).max(80), clientId: uuid, saveId, snapshot: z.record(z.string(), z.unknown()) }), _meta: appOnly,
  }, ({ name, clientId, saveId, snapshot }) => run('ink_save_as_new_canvas', () => notebooks.saveAsNew(name, clientId, snapshot, saveId)))
  registerAppTool(server, 'ink_open_canvas', {
    description: 'Restore a canvas and obtain editing control if available',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid, takeOver: z.boolean().optional() }), _meta: appOnly,
  }, ({ canvasId, clientId, takeOver }) => run('ink_open_canvas', () => notebooks.open(canvasId, clientId, { takeOver: !!takeOver })))
  registerAppTool(server, 'ink_list_backups', {
    description: 'List valid local backup revisions for a canvas',
    inputSchema: z.object({ canvasId: uuid }), _meta: appOnly,
  }, ({ canvasId }) => run('ink_list_backups', () => notebooks.listBackups(canvasId)))
  registerAppTool(server, 'ink_restore_backup', {
    description: 'Restore a user-selected local backup as a new revision after revision and editor-lease checks',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid, backupRevision: z.number().int().positive(), expectedCurrentRevision: z.number().int().nonnegative().nullable() }), _meta: appOnly,
  }, ({ canvasId, clientId, backupRevision, expectedCurrentRevision }) => run('ink_restore_backup', () => notebooks.restoreBackup(canvasId, clientId, backupRevision, expectedCurrentRevision)))
  registerAppTool(server, 'ink_start_canvas_fresh', {
    description: 'Start a damaged or missing canvas blank after the user confirms; damaged files are kept in recovery',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, ({ canvasId, clientId }) => run('ink_start_canvas_fresh', () => notebooks.startFresh(canvasId, clientId)))
  registerAppTool(server, 'ink_save_canvas', {
    description: 'Save a complete tldraw snapshot with optimistic revision checking',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid, expectedRevision: z.number().int().nonnegative(), saveId: saveId.optional(), snapshot: z.record(z.string(), z.unknown()) }), _meta: appOnly,
  }, ({ canvasId, clientId, expectedRevision, snapshot, saveId }) => run('ink_save_canvas', () => notebooks.save(canvasId, clientId, expectedRevision, snapshot, saveId)))
  registerAppTool(server, 'ink_heartbeat', {
    description: 'Renew an editing lease for a canvas', inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, ({ canvasId, clientId }) => run('ink_heartbeat', () => notebooks.heartbeat(canvasId, clientId)))
  registerAppTool(server, 'ink_release_editor', {
    description: 'Release editing control after confirmed save', inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, ({ canvasId, clientId }) => run('ink_release_editor', () => notebooks.release(canvasId, clientId)))

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
