/**
 * MCP server for the Cloudflare test deployment: the same tool names, input schemas, result shapes and widget
 * resource as the Windows server.ts (v0.2.3), backed by CanvasDO + LibraryDO instead of the filesystem.
 *
 * Differences from server.ts, all deliberate and listed in docs/CF_TEST_DEPLOYMENT.md:
 *   - ink_save_canvas receives a whole snapshot (unchanged widget) and the Durable Object computes the change set.
 *   - ink_start_canvas_fresh is not built (returns NOT_IMPLEMENTED).
 *   - two extra model-visible diagnostic tools (nova_ink_diagnostics, nova_ink_diag_payload), generated data only.
 * Scopes: every tool needs mcp:read; tools that change anything need mcp:write.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import type { AppEnv } from './config'
import { DIAG_SIZES } from './diag-data'
import { WIDGET_HTML } from './widget.generated'

export const VERSION = '0.2.3-cf-test'
const UI_URI = 'ui://nova-ink/canvas'
const uuid = z.string().uuid()
const saveId = z.string().min(1).max(64)
const TOUCH_EVERY_MS = 60_000
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024

export type ToolContext = {
  env: AppEnv
  userId: string
  scopes: string[]
  waitUntil: (promise: Promise<unknown>) => void
  /** Content-Length of the MCP request, for the payload-size log line. */
  bytesIn: number | null
}

type Data = Record<string, any> & { ok: boolean }

function result(data: Data) {
  const text = data.ok ? 'NOVA Ink notebook operation completed.' : `NOVA Ink notebook error: ${String(data.message ?? data.code)}`
  return { structuredContent: data as Record<string, unknown>, content: [{ type: 'text' as const, text }] }
}

/** Deterministic canvas id for "save as new": a retry of the same saveId lands on the same object, which replays. */
export async function canvasIdForSaveId(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`save-as-new:${id}`)))
  const hex = [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// Isolate-local caches. Positive ownership results are safe to keep (canvases are never reassigned); touch times debounce Library writes.
const owned = new Set<string>()
const lastTouch = new Map<string, number>()

export function createNovaServer(ctx: ToolContext): McpServer {
  const { env, userId } = ctx
  const server = new McpServer({ name: 'NOVA Ink Private Notebook', version: VERSION })
  const library = () => env.LIBRARY.get(env.LIBRARY.idFromName(`library:${userId}`)) as any
  const canvas = (id: string) => env.CANVAS.get(env.CANVAS.idFromName(id)) as any
  const key = (id: string) => `${userId}:${id}`

  /** Runs a tool: scope check, structured logging (no content, no tokens), unexpected errors become structured failures. */
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
    console.log(JSON.stringify({ evt: 'tool', tool, ok: data.ok, code: data.code, ms: Date.now() - started, bytesIn: ctx.bytesIn, rows: stats }))
    return result(clean as Data)
  }

  async function getCanvas(id: string) {
    const meta = await library().get(id)
    if (meta) owned.add(key(id))
    return meta as { id: string; name: string; createdAt: string; updatedAt: string; revision: number } | null
  }
  async function isOwned(id: string) {
    return owned.has(key(id)) || !!(await getCanvas(id))
  }
  const notFound = (): Data => ({ ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' })

  /** Keeps the Library's revision (the "was this canvas ever saved" marker) current without a write on every save. */
  async function touch(id: string, revision: number, savedAt: string, firstSave: boolean) {
    const now = Date.now()
    if (!firstSave && now - (lastTouch.get(key(id)) ?? 0) < TOUCH_EVERY_MS) return
    lastTouch.set(key(id), now)
    const write = library().touch({ id, revision, savedAt })
    if (firstSave) await write
    else ctx.waitUntil(Promise.resolve(write).catch(() => {}))
  }

  registerAppTool(server, 'open_nova_ink', {
    title: 'Open NOVA Ink',
    description: 'Open NOVA Ink: a private tldraw notebook with named canvases, server-confirmed autosave and student-initiated ChatGPT hints.',
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: UI_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  }, async () => ({
    content: [{ type: 'text', text: `Opening NOVA Ink v${VERSION}: named canvases are saved to the private MCP server. Saving is asynchronous; check the saved status before closing the notebook. The user initiates all tutoring requests.` }],
    structuredContent: { application: 'nova-ink', phase: 'cloudflare-test', version: VERSION },
  }))

  const appOnly = { ui: { visibility: ['app' as const] } }

  registerAppTool(server, 'ink_list_canvases', {
    description: 'Read the private NOVA Ink canvas library', inputSchema: z.object({}), _meta: appOnly,
  }, () => run('ink_list_canvases', 'mcp:read', async () => {
    const list = await library().list()
    for (const c of list.canvases) owned.add(key(c.id))
    return list
  }))

  registerAppTool(server, 'ink_create_canvas', {
    description: 'Create a named canvas after an explicit user action', inputSchema: z.object({ name: z.string().min(1).max(80) }), _meta: appOnly,
  }, ({ name }) => run('ink_create_canvas', 'mcp:write', async () => {
    const created = await library().create(name)
    if (created.ok) owned.add(key(created.canvas.id))
    return created
  }))

  registerAppTool(server, 'ink_save_as_new_canvas', {
    description: 'Preserve the local version of a canvas as a new named canvas after an explicit user action',
    inputSchema: z.object({ name: z.string().min(1).max(80), clientId: uuid, saveId, snapshot: z.record(z.string(), z.unknown()) }), _meta: appOnly,
  }, ({ name, clientId, saveId: sid, snapshot }) => run('ink_save_as_new_canvas', 'mcp:write', async () => {
    const cleaned = name.trim().slice(0, 80)
    if (!cleaned) return { ok: false, code: 'INVALID_NAME', message: 'Enter a canvas name.' }
    const id = await canvasIdForSaveId(sid)
    const saved = await canvas(id).initFromSnapshot({ clientId, saveId: sid, snapshot })
    if (!saved.ok) return saved
    const registered = await library().register({ id, name: cleaned, revision: saved.revision, savedAt: saved.savedAt, saveId: sid })
    if (!registered.ok) return registered
    owned.add(key(id))
    return { ...saved, canvas: registered.canvas, readOnly: false }
  }))

  registerAppTool(server, 'ink_open_canvas', {
    description: 'Restore a canvas and obtain editing control if available',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid, takeOver: z.boolean().optional() }), _meta: appOnly,
  }, ({ canvasId, clientId, takeOver }) => run('ink_open_canvas', 'mcp:read', async () => {
    const meta = await getCanvas(canvasId)
    if (!meta) return notFound()
    const opened = await canvas(canvasId).open({ clientId, takeOver: !!takeOver, knownRevision: meta.revision })
    if (!opened.ok) return { ...opened, canvas: meta }
    ctx.waitUntil(Promise.resolve(library().setLastOpened(canvasId)).catch(() => {}))
    return { ...opened, canvas: meta }
  }))

  registerAppTool(server, 'ink_list_backups', {
    description: 'List valid local backup revisions for a canvas',
    inputSchema: z.object({ canvasId: uuid }), _meta: appOnly,
  }, ({ canvasId }) => run('ink_list_backups', 'mcp:read', async () => {
    if (!await isOwned(canvasId)) return notFound()
    const listed = await canvas(canvasId).listCheckpoints()
    if (!listed.ok) return listed
    return { ok: true, backups: listed.checkpoints.map((c: any) => ({ revision: c.revision, savedAt: c.savedAt })), stats: listed.stats }
  }))

  registerAppTool(server, 'ink_restore_backup', {
    description: 'Restore a user-selected local backup as a new revision after revision and editor-lease checks',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid, backupRevision: z.number().int().positive(), expectedCurrentRevision: z.number().int().nonnegative().nullable() }), _meta: appOnly,
  }, ({ canvasId, clientId, backupRevision, expectedCurrentRevision }) => run('ink_restore_backup', 'mcp:write', async () => {
    const meta = await getCanvas(canvasId)
    if (!meta) return notFound()
    const restored = await canvas(canvasId).restoreCheckpoint({
      clientId, saveId: crypto.randomUUID(), checkpointRevision: backupRevision, expectedRevision: expectedCurrentRevision, knownRevision: meta.revision,
    })
    if (restored.ok) await touch(canvasId, restored.revision, restored.savedAt, true)
    return restored
  }))

  registerAppTool(server, 'ink_start_canvas_fresh', {
    description: 'Start a damaged or missing canvas blank after the user confirms; damaged files are kept in recovery',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, () => run('ink_start_canvas_fresh', 'mcp:write', async () => ({
    ok: false, code: 'NOT_IMPLEMENTED', message: 'Starting a damaged canvas over is not built in the Cloudflare test deployment. Restore a checkpoint instead.',
  })))

  registerAppTool(server, 'ink_save_canvas', {
    description: 'Save a complete tldraw snapshot with optimistic revision checking',
    inputSchema: z.object({ canvasId: uuid, clientId: uuid, expectedRevision: z.number().int().nonnegative(), saveId: saveId.optional(), snapshot: z.record(z.string(), z.unknown()) }), _meta: appOnly,
  }, ({ canvasId, clientId, expectedRevision, snapshot, saveId: sid }) => run('ink_save_canvas', 'mcp:write', async () => {
    if (!await isOwned(canvasId)) return notFound()
    const saved = await canvas(canvasId).saveSnapshot({ clientId, saveId: sid ?? crypto.randomUUID(), baseRevision: expectedRevision, snapshot })
    if (saved.ok && !saved.replayed) await touch(canvasId, saved.revision, saved.savedAt, saved.revision === 1)
    return saved
  }))

  registerAppTool(server, 'ink_heartbeat', {
    description: 'Renew an editing lease for a canvas', inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, ({ canvasId, clientId }) => run('ink_heartbeat', 'mcp:read', async () => {
    if (!await isOwned(canvasId)) return notFound()
    return canvas(canvasId).heartbeat({ clientId })
  }))

  registerAppTool(server, 'ink_release_editor', {
    description: 'Release editing control after confirmed save', inputSchema: z.object({ canvasId: uuid, clientId: uuid }), _meta: appOnly,
  }, ({ canvasId, clientId }) => run('ink_release_editor', 'mcp:read', async () => {
    if (!await isOwned(canvasId)) return notFound()
    return canvas(canvasId).release({ clientId })
  }))

  // ------------------------------------------------------------------ diagnostics (generated data only)

  const STEPS: Array<{ label: string; op: string }> = [
    { label: 'generate (in object)', op: 'generate' },
    { label: 'full save (first save)', op: 'fullSave' },
    { label: 'open', op: 'open' },
    { label: 'open (raw/fast)', op: 'openRaw' },
    { label: 'save +3 strokes (1st edit: includes inline checkpoint)', op: 'incrementalSave' },
    { label: 'save +3 strokes (steady state)', op: 'incrementalSave' },
    { label: 'save camera only', op: 'cameraSave' },
    { label: 'forced checkpoint', op: 'checkpoint' },
    { label: 'heartbeat', op: 'heartbeat' },
  ]

  server.registerTool('nova_ink_diagnostics', {
    description: 'NOVA Ink test deployment only. Creates generated (fake) canvases of several sizes in Cloudflare Durable Objects and times open, save and checkpoint on each, then deletes them. Uses no real notes. Read the per-request CPU from `wrangler tail`.',
    inputSchema: z.object({
      sizes: z.array(z.enum(['s100', 's500', 's1500', 's3000', 'img3mb', 'img8mb'])).min(1).max(4).optional(),
      materialize: z.boolean().optional(),
    }),
  }, ({ sizes, materialize }) => run('nova_ink_diagnostics', 'mcp:write', async () => {
    const chosen = sizes ?? ['s100', 's500', 's1500']
    const runId = crypto.randomUUID().slice(0, 8)
    const out: Array<Record<string, unknown>> = []
    for (const size of chosen) {
      const spec = DIAG_SIZES[size]
      let id = crypto.randomUUID()
      if (materialize) {
        const created = await library().create(`DIAG ${size} ${runId} (generated)`)
        if (!created.ok) return created
        id = created.canvas.id
        owned.add(key(id))
      }
      const stub = canvas(id)
      const steps: Array<Record<string, unknown>> = []
      for (const step of STEPS) {
        const started = Date.now()
        try {
          const r = await stub.diagOp({ op: step.op, label: step.label, run: runId, size, strokes: spec.strokes, imageBytes: spec.imageBytes })
          steps.push({ step: step.label, wallMs: Date.now() - started, ok: r.ok, ...(r.code ? { code: r.code, message: r.message } : {}), rowsWritten: r.stats?.rowsWritten, rowsRead: r.stats?.rowsRead, records: r.records, bytes: r.bytes })
          if (!r.ok) break
        } catch (error) {
          steps.push({ step: step.label, wallMs: Date.now() - started, ok: false, error: error instanceof Error ? error.message : String(error) })
          break // an exceeded limit usually resets the object; later steps would be meaningless
        }
      }
      if (!materialize) { try { await stub.diagOp({ op: 'purge', label: 'purge', run: runId, size }) } catch { /* the object is generated and empty of real data */ } }
      out.push({ size, canvasId: materialize ? id : undefined, steps })
    }
    const lines = out.flatMap(o => (o.steps as any[]).map(s => `${o.size} | ${s.step} | ${s.ok ? `${s.wallMs} ms wall` : `FAILED: ${s.error ?? s.message ?? s.code}`}${s.rowsWritten !== undefined ? ` | rows w/r ${s.rowsWritten}/${s.rowsRead}` : ''}`))
    return {
      ok: true, run: runId, version: VERSION, sizes: out,
      summary: lines.join('\n'),
      note: 'wallMs is measured by the Worker around each Durable Object call and includes queueing and network. CPU time is not available inside a Worker; read cpuTime per invocation from `npx wrangler tail --format json` (see docs/CF_TEST_DEPLOYMENT.md).',
    }
  }))

  server.registerTool('nova_ink_diag_payload', {
    description: 'NOVA Ink test deployment only. Payload-limit probe: reports how many characters of `echo` arrived and returns a generated filler of `respondBytes` bytes (max 12 MiB).',
    inputSchema: z.object({ echo: z.string().max(16 * 1024 * 1024).optional(), respondBytes: z.number().int().min(0).max(MAX_PAYLOAD_BYTES).optional() }),
  }, ({ echo, respondBytes }) => run('nova_ink_diag_payload', 'mcp:write', async () => ({
    ok: true, receivedChars: echo?.length ?? 0, respondedBytes: respondBytes ?? 0, filler: 'x'.repeat(respondBytes ?? 0),
  })))

  registerAppResource(server, 'NOVA Ink Canvas', UI_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    if (!ctx.scopes.includes('mcp:read')) throw new Error('mcp:read permission required')
    return {
      contents: [{
        uri: UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: WIDGET_HTML,
        _meta: {
          'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' },
          ui: { csp: { resourceDomains: ['https://cdn.tldraw.com'], connectDomains: ['https://cdn.tldraw.com'] } },
        },
      }],
    }
  })

  return server
}
