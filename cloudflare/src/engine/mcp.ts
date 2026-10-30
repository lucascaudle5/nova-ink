/**
 * MCP server for the engine notebook (Worker `nova-ink-engine`). Notebooks and pages live in the user's
 * NotebookLibraryDO; each page's strokes in its own PageDO. Saves are deltas (strokes added, ids removed).
 *
 * Every tool needs mcp:read; tools that change anything need mcp:write. All tools except open_nova_notebook are
 * widget-only, and none lets the model draw on a page.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import type { ServerContext } from '../app'
import type { NotebookLibraryDO, PageMeta } from './library-do'
import type { PageDO } from './page-do'
import { ENGINE_WIDGET_HTML } from './widget.generated'

export const ENGINE_VERSION = '0.3.0-engine'
export const ENGINE_UI_URI = 'ui://nova-ink-engine/notebook'
const TOUCH_EVERY_MS = 60_000

export interface EngineEnv {
  PAGE: DurableObjectNamespace<PageDO>
  ENGINE_LIBRARY: DurableObjectNamespace<NotebookLibraryDO>
}

type Data = Record<string, any> & { ok: boolean }

const uuid = z.string().uuid()
const saveId = z.string().min(1).max(64)
const name = z.string().min(1).max(80)
const paper = z.object({ color: z.string().max(16), pattern: z.string().max(16) })
const camera = z.object({ x: z.number(), y: z.number(), z: z.number() })
const stroke = z.record(z.string(), z.unknown())

function result(data: Data) {
  const text = data.ok ? 'NOVA Ink notebook operation completed.' : `NOVA Ink notebook error: ${String(data.message ?? data.code)}`
  return { structuredContent: data as Record<string, unknown>, content: [{ type: 'text' as const, text }] }
}

const lastTouch = new Map<string, number>()

export function createEngineServer(ctx: ServerContext): McpServer {
  const env = ctx.env as EngineEnv
  const server = new McpServer({ name: 'NOVA Ink Notebook', version: ENGINE_VERSION })
  const library = () => env.ENGINE_LIBRARY.get(env.ENGINE_LIBRARY.idFromName(`engine-library:${ctx.userId}`)) as any
  const page = (id: string) => env.PAGE.get(env.PAGE.idFromName(`page:${id}`)) as any
  const notFound = (): Data => ({ ok: false, code: 'NOT_FOUND', message: 'That page was not found.' })
  const inTrash = (): Data => ({ ok: false, code: 'IN_TRASH', message: 'That page is in the trash. Restore it before editing.' })

  async function run(tool: string, scope: 'mcp:read' | 'mcp:write', operation: () => Promise<Data>) {
    const started = Date.now()
    let data: Data
    try {
      if (!ctx.scopes.includes('mcp:read') || (scope === 'mcp:write' && !ctx.scopes.includes('mcp:write'))) {
        data = { ok: false, code: 'INSUFFICIENT_SCOPE', message: `This connection does not have the ${scope} permission. Reconnect NOVA Ink and allow it.` }
      } else data = await operation()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      data = { ok: false, code: 'SERVER_ERROR', message: `Notebook server error: ${message}. The save was not confirmed.` }
    }
    const { stats, ...clean } = data
    console.log(JSON.stringify({ evt: 'tool', tool, ok: data.ok, code: data.code, ms: Date.now() - started, bytesIn: ctx.bytesIn, rows: stats?.rowsWritten }))
    return result(clean as Data)
  }

  /** The page's library entry if this user owns it; editing tools also refuse pages in the trash. */
  async function owned(pageId: string, editing: boolean): Promise<{ meta: PageMeta } | { error: Data }> {
    const meta = await library().getPage(pageId) as PageMeta | null
    if (!meta) return { error: notFound() }
    if (editing && meta.deletedAt) return { error: inTrash() }
    return { meta }
  }

  /** Keeps the library's "was this page ever saved" revision current without a write on every save. */
  async function touch(pageId: string, revision: number, savedAt: string, now: boolean) {
    const key = `${ctx.userId}:${pageId}`
    const t = Date.now()
    if (!now && t - (lastTouch.get(key) ?? 0) < TOUCH_EVERY_MS) return
    lastTouch.set(key, t)
    const write = library().touch({ pageId, revision, savedAt })
    if (now) await write
    else ctx.waitUntil(Promise.resolve(write).catch(() => {}))
  }

  registerAppTool(server, 'open_nova_notebook', {
    title: 'Open NOVA Ink notebook',
    description: 'Open the NOVA Ink handwriting notebook: notebooks of infinite pages for Apple Pencil, saved to the private NOVA Ink server. The user initiates all tutoring requests; this tool does not read or change any page.',
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: ENGINE_UI_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  }, async () => ({
    content: [{ type: 'text', text: `Opening NOVA Ink notebook v${ENGINE_VERSION}. Saving is asynchronous; the notebook shows Saved only after the server confirms each change.` }],
    structuredContent: { application: 'nova-ink-engine', version: ENGINE_VERSION },
  }))

  const app = { ui: { visibility: ['app' as const] } }
  const tool = <S extends z.ZodObject<any>>(toolName: string, description: string, schema: S, scope: 'mcp:read' | 'mcp:write', body: (args: z.infer<S>) => Promise<Data>) =>
    registerAppTool(server, toolName, { description, inputSchema: schema, _meta: app }, ((args: z.infer<S>) => run(toolName, scope, () => body(args))) as any)

  tool('nb_list', 'List notebooks and pages', z.object({}), 'mcp:read', () => library().list())

  tool('nb_create_notebook', 'Create a notebook after an explicit user action', z.object({ name }), 'mcp:write', a => library().createNotebook({ name: a.name }))
  tool('nb_rename_notebook', 'Rename a notebook', z.object({ notebookId: uuid, name }), 'mcp:write', a => library().renameNotebook(a))
  tool('nb_remove_notebook', 'Move a notebook to the trash (restorable)', z.object({ notebookId: uuid }), 'mcp:write', a => library().removeNotebook(a))
  tool('nb_restore_notebook', 'Restore a notebook from the trash', z.object({ notebookId: uuid }), 'mcp:write', a => library().restoreNotebook(a))

  tool('nb_add_page', 'Add a page; it starts with the paper of the page it follows', z.object({ notebookId: uuid, afterPageId: uuid.nullable().optional(), title: z.string().max(80).optional() }), 'mcp:write', async a => {
    const added = await library().addPage(a)
    if (!added.ok) return added
    if (added.previousPageId) {
      const info = await page(added.previousPageId).info()
      if (info.ok) await page(added.pageId).init({ paper: info.paper })
    }
    return added
  })
  tool('nb_rename_page', 'Rename a page', z.object({ pageId: uuid, title: name }), 'mcp:write', a => library().renamePage(a))
  tool('nb_move_page', 'Move a page within or between notebooks', z.object({ pageId: uuid, afterPageId: uuid.nullable(), notebookId: uuid.optional() }), 'mcp:write', a => library().movePage(a))
  tool('nb_remove_page', 'Move a page to the trash (restorable)', z.object({ pageId: uuid }), 'mcp:write', a => library().removePage(a))
  tool('nb_restore_page', 'Restore a page from the trash', z.object({ pageId: uuid }), 'mcp:write', a => library().restorePage(a))

  tool('nb_open_page', 'Load a page and obtain editing control if available', z.object({ pageId: uuid, clientId: uuid, takeOver: z.boolean().optional() }), 'mcp:read', async a => {
    const own = await owned(a.pageId, true)
    if ('error' in own) return own.error
    const opened = await page(a.pageId).open({ clientId: a.clientId, takeOver: !!a.takeOver, knownRevision: own.meta.revision })
    if (opened.ok) ctx.waitUntil(Promise.resolve(library().setLast({ pageId: a.pageId })).catch(() => {}))
    return { ...opened, page: own.meta }
  })

  tool('nb_save_page', 'Save the strokes added and removed since the last confirmed save, with revision and editor checks', z.object({
    pageId: uuid, clientId: uuid, saveId, baseRevision: z.number().int().nonnegative(),
    adds: z.array(z.object({ key: z.string().max(64), stroke })).max(5000).optional(),
    removes: z.array(z.string().max(64)).max(5000).optional(),
    paper: paper.optional(), camera: camera.optional(),
  }), 'mcp:write', async a => {
    const own = await owned(a.pageId, true)
    if ('error' in own) return own.error
    const saved = await page(a.pageId).save(a)
    if (saved.ok && !saved.replayed) await touch(a.pageId, saved.revision, saved.savedAt, own.meta.revision === 0)
    return saved
  })

  tool('nb_heartbeat', 'Renew editing control of a page', z.object({ pageId: uuid, clientId: uuid }), 'mcp:read', async a => {
    const own = await owned(a.pageId, false)
    return 'error' in own ? own.error : page(a.pageId).heartbeat({ clientId: a.clientId })
  })
  tool('nb_release', 'Release editing control after the last confirmed save', z.object({ pageId: uuid, clientId: uuid }), 'mcp:read', async a => {
    const own = await owned(a.pageId, false)
    return 'error' in own ? own.error : page(a.pageId).release({ clientId: a.clientId })
  })

  tool('nb_list_checkpoints', 'List saved checkpoints of a page', z.object({ pageId: uuid }), 'mcp:read', async a => {
    const own = await owned(a.pageId, false)
    return 'error' in own ? own.error : page(a.pageId).listCheckpoints()
  })
  tool('nb_restore_checkpoint', 'Restore a user-selected checkpoint as a new revision', z.object({
    pageId: uuid, clientId: uuid, saveId, checkpointRevision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative().nullable(),
  }), 'mcp:write', async a => {
    const own = await owned(a.pageId, true)
    if ('error' in own) return own.error
    const restored = await page(a.pageId).restoreCheckpoint({ ...a, knownRevision: own.meta.revision })
    if (restored.ok && !restored.replayed) await touch(a.pageId, restored.revision, restored.savedAt, true)
    return restored
  })

  registerAppResource(server, 'NOVA Ink Notebook', ENGINE_UI_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    if (!ctx.scopes.includes('mcp:read')) throw new Error('mcp:read permission required')
    return {
      contents: [{
        uri: ENGINE_UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: ENGINE_WIDGET_HTML,
        _meta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' }, ui: { csp: { resourceDomains: [], connectDomains: [] } } },
      }],
    }
  })

  return server
}
