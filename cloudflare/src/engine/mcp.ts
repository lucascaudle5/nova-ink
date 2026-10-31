/**
 * MCP server for the engine notebook (Worker `nova-ink-engine`). Notebooks and pages live in the user's
 * NotebookLibraryDO; each page's strokes in its own PageDO. Saves are deltas (strokes added, ids removed).
 *
 * Every tool needs mcp:read; tools that change anything need mcp:write. All tools except open_nova_notebook are
 * widget-only, and none lets the model draw on a page.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { EXTENSION_ID, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import { isPaper } from '../../../engine/src/core/paper'
import { cropOk, MARGIN, MAX_ITEMS, parsePageList, pictureOp, stackOps } from './layout'
import type { Item, Layout, Output } from './layout'
import type { ServerContext } from '../app'
import type { NotebookLibraryDO, PageMeta } from './library-do'
import type { PageDO } from './page-do'
import { transcribe } from './transcribe'
import type { VisionAi } from './transcribe'
import { ENGINE_WIDGET_HTML } from './widget.generated'

export const ENGINE_VERSION = '0.3.0-engine'
export const ENGINE_UI_URI = 'ui://nova-ink-engine/notebook'
const TOUCH_EVERY_MS = 60_000
/** Base64 length of the stored view; kept under the 2 MB SQLite row limit. */
export const MAX_VIEW_BASE64 = 1_500_000
const SEEN: Record<string, string> = {
  screen: 'exactly what is on the student\'s screen',
  area: 'the area of the page the student snipped to show you',
  page: 'the whole page, as the student chose to show it',
}
/** Replaced in the served notebook with this Worker's origin, where it loads pdf.js from (see index.ts). */
export const ASSET_ORIGIN_MARK = '__NOVA_ASSET_ORIGIN__'

export interface EngineEnv {
  PAGE: DurableObjectNamespace<PageDO>
  ENGINE_LIBRARY: DurableObjectNamespace<NotebookLibraryDO>
  PUBLIC_ORIGIN?: string
  /** Workers AI, for transcribing the picture in nova_look. */
  AI?: VisionAi
}

type Data = Record<string, any> & { ok: boolean }

const uuid = z.string().uuid()
const saveId = z.string().min(1).max(64)
const name = z.string().min(1).max(80)
const paper = z.object({ color: z.string().max(16), pattern: z.string().max(16) })
const camera = z.object({ x: z.number(), y: z.number(), z: z.number() })
const color = z.string().regex(/^#[0-9a-f]{6}$/)
const stroke = z.record(z.string(), z.unknown())

type Picture = { data: string; mimeType: string; uri: string }
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }

function result(data: Data, say?: (data: Data) => string, picture?: Picture) {
  const text = data.ok ? (say ? say(data) : 'NOVA Ink notebook operation completed.') : `NOVA Ink notebook error: ${String(data.message ?? data.code)}`
  const content: Content[] = [{ type: 'text', text }]
  // The same picture twice: as image content, and as an embedded resource for hosts that pass only that through.
  if (data.ok && picture) content.push({ type: 'image', data: picture.data, mimeType: picture.mimeType }, { type: 'resource', resource: { uri: picture.uri, mimeType: picture.mimeType, blob: picture.data } })
  // A host may hand the model structuredContent in place of content, which would drop the image; the text has the data.
  if (data.ok && picture) return { content }
  return { structuredContent: data as Record<string, unknown>, content }
}

const lastTouch = new Map<string, number>()

export function createEngineServer(ctx: ServerContext): McpServer {
  const env = ctx.env as EngineEnv
  // Hosts render the notebook only when the server declares MCP Apps here.
  const server = new McpServer({ name: 'NOVA Ink Notebook', version: ENGINE_VERSION }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } })
  const assetOrigin = (() => { try { return new URL(String(env.PUBLIC_ORIGIN)).origin } catch { return '' } })()
  const library = () => env.ENGINE_LIBRARY.get(env.ENGINE_LIBRARY.idFromName(`engine-library:${ctx.userId}`)) as any
  const page = (id: string) => env.PAGE.get(env.PAGE.idFromName(`page:${id}`)) as any
  const notFound = (): Data => ({ ok: false, code: 'NOT_FOUND', message: 'That page was not found.' })
  const inTrash = (): Data => ({ ok: false, code: 'IN_TRASH', message: 'That page is in the trash. Restore it before editing.' })

  async function run(tool: string, scope: 'mcp:read' | 'mcp:write', operation: () => Promise<Data>, say?: (data: Data) => string) {
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
    // `picture` travels as image content only, never inside the JSON.
    const { stats, picture, ...clean } = data
    console.log(JSON.stringify({ evt: 'tool', tool, ok: data.ok, code: data.code, ms: Date.now() - started, bytesIn: ctx.bytesIn, rows: stats?.rowsWritten, picture: picture ? String(picture.data).length : undefined }))
    return result(clean as Data, say, picture)
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
    _meta: { ui: { resourceUri: ENGINE_UI_URI } },
  }, async () => ({
    content: [{ type: 'text', text: `Opening NOVA Ink notebook v${ENGINE_VERSION}. Saving is asynchronous; the notebook shows Saved only after the server confirms each change. To see the student's work and which page they are on, call nova_look (no arguments needed).` }],
    structuredContent: { application: 'nova-ink-engine', version: ENGINE_VERSION },
  }))

  const app = { ui: { visibility: ['app' as const] } }
  const tool = <S extends z.ZodObject<any>>(toolName: string, description: string, schema: S, scope: 'mcp:read' | 'mcp:write', body: (args: z.infer<S>) => Promise<Data>) =>
    registerAppTool(server, toolName, { description, inputSchema: schema, _meta: app }, ((args: z.infer<S>) => run(toolName, scope, () => body(args))) as any)

  tool('nb_list', 'List notebooks and pages', z.object({}), 'mcp:read', () => library().list())

  tool('nb_create_notebook', 'Create a notebook after an explicit user action', z.object({ name, folderId: uuid.nullable().optional(), color: color.nullable().optional() }), 'mcp:write', a => library().createNotebook(a))
  tool('nb_update_notebook', 'Move a notebook to a folder (null = top level) or change its cover color', z.object({ notebookId: uuid, folderId: uuid.nullable().optional(), color: color.nullable().optional() }), 'mcp:write', a => library().updateNotebook(a))
  tool('nb_create_folder', 'Create a folder for notebooks', z.object({ name }), 'mcp:write', a => library().createFolder(a))
  tool('nb_rename_folder', 'Rename a folder', z.object({ folderId: uuid, name }), 'mcp:write', a => library().renameFolder(a))
  tool('nb_remove_folder', 'Move a folder to the trash; its notebooks move to the top level', z.object({ folderId: uuid }), 'mcp:write', a => library().removeFolder(a))
  tool('nb_restore_folder', 'Restore a folder from the trash', z.object({ folderId: uuid }), 'mcp:write', a => library().restoreFolder(a))
  tool('nb_rename_notebook', 'Rename a notebook', z.object({ notebookId: uuid, name }), 'mcp:write', a => library().renameNotebook(a))
  tool('nb_remove_notebook', 'Move a notebook to the trash (restorable)', z.object({ notebookId: uuid }), 'mcp:write', a => library().removeNotebook(a))
  tool('nb_restore_notebook', 'Restore a notebook from the trash', z.object({ notebookId: uuid }), 'mcp:write', a => library().restoreNotebook(a))

  tool('nb_add_page', 'Add a page; it starts with the given paper, else the paper of the page it follows', z.object({ notebookId: uuid, afterPageId: uuid.nullable().optional(), title: z.string().max(80).optional(), paper: paper.optional() }), 'mcp:write', async a => {
    if (a.paper && !isPaper(a.paper)) return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown paper style.' }
    const added = await library().addPage({ notebookId: a.notebookId, afterPageId: a.afterPageId, title: a.title })
    if (!added.ok) return added
    if (a.paper) await page(added.pageId).init({ paper: a.paper })
    else if (added.previousPageId) {
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
    paper: paper.optional(), camera: camera.optional(), appliedOps: z.array(z.string().max(64)).max(50).optional(),
  }), 'mcp:write', async a => {
    const own = await owned(a.pageId, true)
    if ('error' in own) return own.error
    const pictures = (a.adds ?? []).filter(x => x.stroke.kind === 'image').map(x => String(x.stroke.image))
    if (pictures.length) {
      const missing = await library().missingImages(pictures) as string[]
      if (missing.length) return { ok: false, code: 'MISSING_IMAGE', message: 'A picture on this page was not uploaded completely. Nothing was saved.', missing }
    }
    const saved = await page(a.pageId).save(a)
    if (saved.ok && !saved.replayed) await touch(a.pageId, saved.revision, saved.savedAt, own.meta.revision === 0)
    return saved
  })

  tool('nb_put_image', 'Store one piece of a picture the user chose to insert', z.object({
    imageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    width: z.number().int().positive(), height: z.number().int().positive(), bytes: z.number().int().positive(),
    count: z.number().int().positive().max(64), index: z.number().int().nonnegative(), data: z.string().max(270_000),
  }), 'mcp:write', a => library().putImageChunk(a))
  tool('nb_get_image', 'Read one piece of a stored picture', z.object({ imageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), index: z.number().int().nonnegative() }), 'mcp:read', a => library().getImageChunk(a))

  tool('nb_heartbeat', 'Renew editing control of a page; returns requests from NOVA waiting to be applied', z.object({ pageId: uuid, clientId: uuid, applied: z.array(z.string().max(64)).max(50).optional() }), 'mcp:read', async a => {
    const own = await owned(a.pageId, false)
    return 'error' in own ? own.error : page(a.pageId).heartbeat({ clientId: a.clientId, applied: a.applied })
  })
  tool('nb_put_view', 'Store the picture of what the student is showing Claude (null when nothing is shown)', z.object({
    pageId: uuid, clientId: uuid,
    view: z.object({
      seen: z.enum(['screen', 'area', 'page']), mime: z.enum(['image/png', 'image/jpeg']), data: z.string().min(1).max(MAX_VIEW_BASE64),
      width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
    }).nullable(),
  }), 'mcp:write', async a => {
    const own = await owned(a.pageId, false)
    return 'error' in own ? own.error : page(a.pageId).putView({ clientId: a.clientId, view: a.view })
  })
  tool('nb_report_ops', 'Tell the server which of NOVA\'s requests the open notebook could not apply or found already applied', z.object({
    pageId: uuid, clientId: uuid,
    results: z.array(z.object({ requestId: z.string().max(64), status: z.enum(['failed', 'noop']), message: z.string().max(400).optional() })).max(50),
  }), 'mcp:write', async a => {
    const own = await owned(a.pageId, true)
    return 'error' in own ? own.error : page(a.pageId).reportOps({ clientId: a.clientId, results: a.results })
  })

  // ---- widget-only: source documents and the render jobs NOVA asks the open notebook to run ----
  const ref = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  tool('nb_put_source_chunk', 'Store one piece of a PDF the user chose to keep as a source document', z.object({
    sourceId: ref, name: z.string().min(1).max(120), bytes: z.number().int().positive(), count: z.number().int().positive().max(130), index: z.number().int().nonnegative(),
    data: z.string().max(270_000), pages: z.number().int().positive().max(5000).optional(),
  }), 'mcp:write', a => library().putSourceChunk(a))
  tool('nb_set_image_meta', 'Record which document, page and crop a picture came from', z.object({
    imageId: ref, meta: z.object({ sourceId: ref, sourceName: z.string().max(120), page: z.number().int().positive().max(5000), crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).optional() }),
  }), 'mcp:write', a => library().setImageMeta(a))
  tool('nb_get_source_chunk', 'Read one piece of a stored source document', z.object({ sourceId: ref, index: z.number().int().nonnegative() }), 'mcp:read', a => library().getSourceChunk(a))
  tool('nb_jobs', 'List rendering jobs waiting for the open notebook', z.object({}), 'mcp:read', async () => {
    const pending = await library().pendingJobs() as Data
    const jobs = await Promise.all((pending.jobs as any[]).map(async j => ({ ...j, source: await library().getSource(j.params.sourceId) })))
    return { ok: true, jobs }
  })
  tool('nb_job_done', 'Report the pictures the open notebook rendered for a job (or why it could not)', z.object({
    jobId: uuid, failure: z.string().max(300).optional(),
    outputs: z.array(z.object({ imageId: ref, width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192) })).max(MAX_ITEMS).optional(),
    pages: z.number().int().positive().max(5000).optional(),
  }), 'mcp:write', async a => {
    const job = await library().getJob(a.jobId)
    if (!job) return notFound()
    if (job.status !== 'pending') return { ...job.result, ok: true, duplicate: true, jobId: job.id, status: job.status }
    const fail = async (message: string): Promise<Data> => { await library().finishJob({ jobId: job.id, status: 'failed', result: { message } }); return { ok: true, jobId: job.id, status: 'failed', message } }
    if (a.failure || !a.outputs) return fail(a.failure ?? 'The notebook could not render the pages.')
    const placed = await placeSource(job, a.outputs)
    if (!placed.ok) return fail(String(placed.message ?? placed.code))
    await library().finishJob({ jobId: job.id, status: 'done', result: placed })
    return { ...placed, jobId: job.id, status: 'done' }
  })

  /** Pages (or one stacked page) of pictures from rendered source pages, with where each came from recorded. */
  async function placeSource(job: { id: string; params: any }, outputs: Output[]): Promise<Data> {
    const p = job.params as { sourceId: string; notebookId: string; mode: 'page_per_item' | 'stack_on_page'; layout: Layout; items: Item[]; pageId?: string; afterPageId?: string | null; titlePrefix?: string }
    if (outputs.length !== p.items.length) return { ok: false, code: 'INVALID_REQUEST', message: 'The notebook returned a different number of pictures than were asked for.' }
    const missing = await library().missingImages(outputs.map(o => o.imageId)) as string[]
    if (missing.length) return { ok: false, code: 'MISSING_IMAGE', message: 'A rendered picture was not uploaded completely.' }
    const source = await library().getSource(p.sourceId) as { name: string } | null
    if (!source) return { ok: false, code: 'NOT_FOUND', message: 'The source document was not found.' }
    const prefix = (p.titlePrefix ?? source.name.replace(/\.pdf$/i, '')).slice(0, 50)
    const names = p.items.map(i => (i.title ?? `${prefix} p.${i.page}${i.crop ? ' (crop)' : ''}`).slice(0, 60))
    for (let i = 0; i < outputs.length; i++) {
      await library().setImageMeta({ imageId: outputs[i].imageId, meta: { sourceId: p.sourceId, sourceName: source.name, page: p.items[i].page, ...(p.items[i].crop ? { crop: p.items[i].crop } : {}) } })
    }
    const newPage = async (key: string, title: string, after: string | null): Promise<Data> => {
      const made = await library().organize({ requestId: key, action: 'add_page', notebookId: p.notebookId, afterPageId: after, title }) as Data
      if (made.ok && made.previousPageId) { const info = await page(made.previousPageId).info(); if (info.ok) await page(made.pageId).init({ paper: info.paper }) }
      return made
    }
    const apply = async (pageId: string, key: string, ops: unknown[]): Promise<Data> => {
      const queued = await page(pageId).enqueue({ requestId: key, ops }) as Data
      if (queued.ok && queued.advanced) await touch(pageId, queued.advanced.revision, queued.advanced.savedAt, true)
      return queued
    }
    const pages: Array<Record<string, unknown>> = []
    if (p.mode === 'page_per_item') {
      let after: string | null = p.afterPageId ?? null
      for (let i = 0; i < outputs.length; i++) {
        const made = await newPage(`${job.id}-pg${i}`, names[i].slice(0, 80), after)
        if (!made.ok) return made
        after = made.pageId
        const queued = await apply(made.pageId, `${job.id}-op${i}`, [pictureOp(p.layout, p.items[i], outputs[i], names[i], { x: MARGIN, y: MARGIN }).op])
        if (!queued.ok) return queued
        pages.push({ pageId: made.pageId, title: names[i], sourcePage: p.items[i].page, imageId: outputs[i].imageId, status: queued.status, groups: queued.groups })
      }
    } else {
      let pageId = p.pageId
      if (!pageId) {
        const made = await newPage(`${job.id}-pg0`, prefix.slice(0, 80), p.afterPageId ?? null)
        if (!made.ok) return made
        pageId = made.pageId as string
      }
      const scene = await page(pageId).scene() as Data
      if (!scene.ok) return scene
      const startY = scene.bounds ? Math.round(scene.bounds.maxY + 120) : MARGIN
      const queued = await apply(pageId, `${job.id}-op`, stackOps(p.layout, p.items, outputs, names, startY))
      if (!queued.ok) return queued
      pages.push({ pageId, title: prefix, sourcePages: p.items.map(i => i.page), status: queued.status, groups: queued.groups })
    }
    return { ok: true, pages }
  }

  // ---- visible to the model: read the notebook, edit a page, organize, and bring in source documents ----
  // Everything here needs the same sign-in as the notebook; reading needs mcp:read, changing needs mcp:write.
  // NOVA only changes a page when the user asked it to in conversation; nothing here deletes anything.

  const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).describe('A fresh unique id you choose for this request (8 to 64 letters, digits, - or _). Repeating a request with the SAME id never repeats its effect, so retry with the same id; use a NEW id for each new action.')
  const crop = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.02).max(1), h: z.number().min(0.02).max(1) })
    .describe('A rectangle on the PDF page as fractions of its width and height (x, y = top-left; w, h = size)')
  // The model may see only the text of a result, so it carries the full data after the one-line summary.
  const modelTool = <S extends z.ZodObject<any>>(toolName: string, title: string, description: string, schema: S, scope: 'mcp:read' | 'mcp:write', body: (args: z.infer<S>) => Promise<Data>, say?: (data: Data) => string) =>
    registerAppTool(server, toolName, {
      title, description, inputSchema: schema, _meta: {},
      annotations: { readOnlyHint: scope === 'mcp:read', destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ((args: z.infer<S>) => run(toolName, scope, () => body(args), d => `${say ? say(d) : 'Done.'}\n${JSON.stringify(d)}`)) as any)
  const live = async (): Promise<Array<{ id: string; name: string; folderId: string | null; pages: Array<{ id: string; title: string; revision: number }> }>> => {
    const data = await library().list() as Data
    return (data.notebooks as any[]).filter(n => !n.deletedAt).map(n => ({
      id: n.id, name: n.name, folderId: n.folderId,
      pages: (n.pages as any[]).filter(p => !p.deletedAt).map(p => ({ id: p.id, title: p.title, revision: p.revision })),
    }))
  }

  modelTool('nova_list_notebooks', 'List NOVA Ink notebooks', 'List the notebooks and pages in the user\'s NOVA Ink notebook (ids and titles) and the source documents (PDFs) available to place into it, and which page the student has open (openPage). Does not read page contents.',
    z.object({}), 'mcp:read', async () => {
      const [notebooks, sources, openId] = await Promise.all([live(), library().listSources() as Promise<Data>, openPageId()])
      return { ok: true, openPage: openId ? await whereIs(openId) : null, notebooks, sources: sources.sources }
    }, d => `${d.openPage ? `The student is on ${placeText(d.openPage as Data)}. ` : ''}${(d.notebooks as unknown[]).length} notebook(s), ${(d.sources as unknown[]).length} source document(s).`)

  /** The page the student last opened in the notebook (the one on screen while it is open). */
  async function openPageId(): Promise<string | undefined> {
    return ((await library().list()) as Data).last?.pageId ?? undefined
  }

  /** Which notebook a page is in and its place there, for telling Claude where the student is. */
  async function whereIs(pageId: string) {
    const books = await live()
    const book = books.find(b => b.pages.some(p => p.id === pageId))
    const index = book ? book.pages.findIndex(p => p.id === pageId) : -1
    return { pageId, title: book?.pages[index]?.title ?? null, pageNumber: index + 1 || null, pageCount: book?.pages.length ?? null, notebookId: book?.id ?? null, notebook: book?.name ?? null }
  }
  const placeText = (d: Data) => `page ${d.pageNumber ?? '?'} of ${d.pageCount ?? '?'}, "${d.title}", in notebook "${d.notebook}"`

  /** The picture the editing notebook stored for Claude, described, and as image content. */
  async function storedView(pageId: string) {
    const shown = await page(pageId).view() as { seen: string; mime: string; data: string; width: number; height: number; at: string; transcript?: { text: string; model: string } } | null
    if (!shown) return null
    return {
      at: shown.at, transcript: shown.transcript ?? null,
      view: { shows: SEEN[shown.seen] ?? shown.seen, width: shown.width, height: shown.height, takenAt: shown.at, ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(shown.at)) / 1000)) },
      picture: { data: shown.data, mimeType: shown.mime, uri: `nova-ink://pages/${pageId}/view.${shown.mime === 'image/jpeg' ? 'jpg' : 'png'}` },
    }
  }

  modelTool('nova_look', 'Look at the student\'s NOVA Ink screen', 'See what the student is showing you in NOVA Ink right now, as an image: their screen, or the area they snipped, handwriting included, with the notebook and page they are on. The result also has a text transcription of the picture, for when images do not reach you (such as in voice conversation). Call this whenever the student refers to their work ("look at this", "is this right?", "what did I do wrong?"), in text or voice conversation, and again for each new question, since the work changes. pageId is optional and usually left out: it defaults to the page the student has open, so do not ask them which page they are on.',
    z.object({ pageId: uuid.optional() }), 'mcp:read', async a => {
      const pageId = a.pageId ?? await openPageId()
      if (!pageId) return notFound()
      const own = await owned(pageId, false)
      if ('error' in own) return own.error
      const [shown, where] = await Promise.all([storedView(pageId), whereIs(pageId)])
      if (!shown) return { ok: true, ...where, shows: null }
      // Text for hosts that pass no images to the model (Claude's voice mode); made once per picture.
      let transcript = shown.transcript
      let transcriptError: string | null = null
      if (!transcript) {
        const made = env.AI ? await transcribe(env.AI, shown.picture) : { error: 'transcription is not set up on this server' }
        if ('text' in made) { transcript = made; ctx.waitUntil(Promise.resolve(page(pageId).putTranscript({ at: shown.at, transcript: made })).catch(() => {})) }
        else { transcriptError = made.error; console.log(JSON.stringify({ evt: 'transcribe-failed', error: made.error.slice(0, 200) })) }
      }
      return { ok: true, ...where, ...shown.view, transcript: transcript?.text ?? null, transcribedBy: transcript?.model ?? null, transcriptError, picture: shown.picture }
    }, d => {
      if (!d.shows) return `The student is on ${placeText(d)}. No picture: the notebook is closed, paused, or showing an empty screen. Ask the student to open NOVA Ink or describe their work.`
      const head = `The student is on ${placeText(d)}. The attached image is ${d.shows}, taken ${d.ageSeconds} s ago.`
      return d.transcript
        ? `${head} If you cannot see the image, use this transcription of it, made by a vision model (it can misread handwriting; check unclear parts with the student):\n---\n${d.transcript}\n---`
        : `${head} No transcription is available (${d.transcriptError}); if you cannot see the image, ask the student to read out their work.`
    })

  modelTool('nova_read_page', 'Read a NOVA Ink page', 'Describe what is on one page: its revision, groups (NOVA drawings carry a "N" tag and author "nova"), pictures with their size, position and where they came from (document, page number, crop), and regions of the student\'s handwriting. Every item has an id and bounds in page units (x right, y down, about 1 CSS pixel at 100% zoom). Use these ids in nova_edit_page. The student\'s handwriting is listed as regions (refs like "ink:..."), not as text. While the notebook is open and showing you the page, the result also includes an image of what the student is showing you (their screen, or an area they snipped): read their handwriting from that image. To just look at the work, use nova_look. Also reports whether the notebook is open and how many of your requests are still waiting. pageId is optional; it defaults to the page the student has open, so do not ask them which page they are on.',
    z.object({ pageId: uuid.optional() }), 'mcp:read', async args => {
      const pageId = args.pageId ?? await openPageId()
      if (!pageId) return notFound()
      const a = { pageId }
      const own = await owned(a.pageId, false)
      if ('error' in own) return own.error
      const [scene, shown, where] = await Promise.all([page(a.pageId).scene() as Promise<Data>, storedView(a.pageId), whereIs(a.pageId)])
      if (!scene.ok) return scene
      if (scene.advanced) await touch(a.pageId, scene.advanced.revision, scene.advanced.savedAt, true)
      const metas = await library().imageMetas((scene.pictures as any[]).map(p => p.picture)) as Record<string, unknown>
      const { advanced: _advanced, ...rest } = scene
      return {
        ...rest, page: { id: own.meta.id, title: own.meta.title, notebookId: own.meta.notebookId, number: where.pageNumber, of: where.pageCount, notebook: where.notebook }, pictures: (scene.pictures as any[]).map(p => ({ ...p, source: metas[p.picture] ?? null })),
        view: shown?.view ?? null, ...(shown ? { picture: shown.picture } : {}),
      }
    }, d => {
      const p = d.page as { number: number | null; of: number | null; title: string; notebook: string | null }
      const counts = `Page ${p.number ?? '?'} of ${p.of ?? '?'}, "${p.title}", in notebook "${p.notebook}", at revision ${d.revision}: ${(d.groups as unknown[]).length} group(s), ${(d.pictures as unknown[]).length} picture(s), ${(d.regions as unknown[]).length} handwriting region(s).`
      const view = d.view as { shows: string; ageSeconds: number } | null
      return view ? `${counts} The attached image is ${view.shows}, taken ${view.ageSeconds} s ago.` : `${counts} No image: the notebook is closed, paused, or showing an empty screen.`
    })

  modelTool('nova_edit_page', 'Draw on or arrange a NOVA Ink page', `Change one page with a batch of operations (up to 40, applied together or not at all, as ONE undo step for the student). Use it only when the student asked you to draw, label, move or arrange something. It never deletes the student's handwriting. Everything you draw is tagged as NOVA's (author "nova", a boxed N, a purple color) and can be selected, moved, undone and erased like the student's own marks.
Coordinates are page units; x grows right, y grows down. Prefer "place": { relativeTo: <id or group or "ink:..." ref from nova_read_page>, side: right|left|below|above, gap?, align?: start|center|end } over raw numbers; NOVA nudges clear of existing work.
Operations (each an object with "op"):
- draw { name?, place, shapes: [...] } shapes are drawn in a local frame starting near (0,0) and moved to "place": line {x1,y1,x2,y2,dashed?}, arrow {x1,y1,x2,y2,both?}, polyline {points:[[x,y],...],closed?}, rect {x,y,w,h}, ellipse {cx,cy,rx,ry}, arc {cx,cy,r,from,to,arrow?} (degrees), text {x,y,text,size?}, equation {x,y,text,size?} (math: ^ _ {} \\frac{a}{b} \\sqrt{x} \\Sigma \\theta ... and \\\\ for a new line). Optional color (#rrggbb), width, dashed on shapes. Use real geometry: free-body diagrams are arrows from the body outward with text labels, equations go beneath.
- move { targets, dx?, dy? | place }, make_room { below: ref, amount }, align { targets, edge: left|right|top|bottom|centerX|centerY }, distribute { targets, axis: x|y, gap? }, group { targets, name? }, ungroup { targets }, duplicate { targets, place }, remove { targets } (only NOVA's own marks), picture { image, w, h, name?, place } (a stored picture id).
Targets are ids from nova_read_page: a group id moves the whole group. After a draw, the result lists the new group ids to use in later requests. Pass expectedRevision from your last read to refuse the change if the page has changed since. The result says whether the change is "queued" (the notebook is open and will apply it within seconds), "applied" or "saved" (stored on the server). If the notebook is closed the change is saved directly. Check nova_op_status to confirm "saved".`, z.object({
      pageId: uuid, requestId, expectedRevision: z.number().int().nonnegative().optional(),
      operations: z.array(z.record(z.string(), z.unknown())).min(1).max(40),
    }), 'mcp:write', async a => {
      const own = await owned(a.pageId, true)
      if ('error' in own) return own.error
      const queued = await page(a.pageId).enqueue({ requestId: a.requestId, ops: a.operations, expectedRevision: a.expectedRevision }) as Data
      if (queued.ok && queued.advanced) await touch(a.pageId, queued.advanced.revision, queued.advanced.savedAt, true)
      if (!queued.ok) return queued
      const { advanced: _advanced, ...rest } = queued
      return { ...rest, note: queued.status === 'saved' ? 'Saved on the server.' : queued.editorOpen
        ? 'The notebook is open; it applies this within a few seconds and saves it. Check nova_op_status until it says "saved".'
        : 'Waiting for the notebook; it will be applied when the notebook next opens.' }
    }, d => `Request ${d.status}${(d.summary as string[] | undefined)?.length ? ': ' + (d.summary as string[]).join(' ') : ''}`)

  modelTool('nova_op_status', 'Check NOVA Ink requests', 'Where your earlier requests stand: queued (accepted, waiting for the open notebook), applied (shown in the notebook, not yet saved), saved (stored on the server), or failed (with the reason). Pass pageId with requestIds for page edits, jobIds for source placements. A request left waiting while the notebook is closed is applied by this call.',
    z.object({ pageId: uuid.optional(), requestIds: z.array(requestId).max(50).optional(), jobIds: z.array(uuid).max(20).optional() }), 'mcp:read', async a => {
      const out: Data = { ok: true }
      if (a.pageId) {
        const own = await owned(a.pageId, false)
        if ('error' in own) return own.error
        const status = await page(a.pageId).opStatus({ requestIds: a.requestIds }) as Data
        if (status.advanced) await touch(a.pageId, status.advanced.revision, status.advanced.savedAt, true)
        out.requests = status.ops; out.editorOpen = status.editorOpen
      }
      if (a.jobIds?.length) out.jobs = await Promise.all(a.jobIds.map(async id => { const j = await library().getJob(id); return j ? { jobId: j.id, kind: j.kind, status: j.status, ...j.result } : { jobId: id, status: 'unknown' } }))
      return out
    })

  modelTool('nova_organize', 'Organize NOVA Ink notebooks', 'Create a notebook, add a page, rename a notebook or page, or move a page (within or between notebooks). Never deletes anything. Needs the ids from nova_list_notebooks.',
    z.object({
      requestId, action: z.enum(['create_notebook', 'rename_notebook', 'add_page', 'rename_page', 'move_page']),
      notebookId: uuid.optional(), pageId: uuid.optional(), afterPageId: uuid.nullable().optional(), name: name.optional(), title: z.string().min(1).max(80).optional(),
      folderId: uuid.nullable().optional(), paper: paper.optional(),
    }), 'mcp:write', async a => {
      if (a.paper && !isPaper(a.paper)) return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown paper style.' }
      const need = (ok: boolean, what: string): Data | null => ok ? null : { ok: false, code: 'INVALID_REQUEST', message: `${a.action} needs ${what}.` }
      const bad = a.action === 'create_notebook' ? need(!!a.name, 'name')
        : a.action === 'rename_notebook' ? need(!!a.notebookId && !!a.name, 'notebookId and name')
        : a.action === 'add_page' ? need(!!a.notebookId, 'notebookId')
        : a.action === 'rename_page' ? need(!!a.pageId && !!(a.title ?? a.name), 'pageId and title')
        : need(!!a.pageId && a.afterPageId !== undefined, 'pageId and afterPageId (null for first)')
      if (bad) return bad
      const done = await library().organize({ ...a, title: a.title ?? a.name }) as Data
      if (done.ok && a.action === 'add_page') {
        if (a.paper) await page(done.pageId).init({ paper: a.paper })
        else if (done.previousPageId) { const info = await page(done.previousPageId).info(); if (info.ok) await page(done.pageId).init({ paper: info.paper }) }
      }
      return done
    })

  modelTool('nova_place_source', 'Put PDF pages or problems into a notebook', `Bring pages, or rectangular crops (problems), of a stored source PDF (see nova_list_notebooks "sources"; the student adds PDFs by inserting them in the notebook) into a notebook as pictures of the original, never retyped. Each picture records its document, page number and crop. Modes: "page_per_item" gives each page/crop its own new page with free room below and beside it; "stack_on_page" puts them one under another on one page, each followed by a generous blank working space. layout "top_left" makes the picture narrower (about half a page) so there is room for a free-body diagram beside it; "full" fills the page width. Pages are numbered from 1. Rendering happens in the open NOVA Ink notebook, so this returns a job (status pending) and the student's notebook must be open (call open_nova_notebook if it is not); check nova_op_status with jobIds. Give "pages" (like "5-7" or [5,6,7]) or "items" (with optional crop rectangles and titles).`,
    z.object({
      requestId, sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), notebookId: uuid,
      pages: z.union([z.string().max(60), z.array(z.number().int().min(1).max(5000)).max(MAX_ITEMS)]).optional(),
      items: z.array(z.object({ page: z.number().int().min(1).max(5000), crop: crop.optional(), title: z.string().min(1).max(60).optional() })).max(MAX_ITEMS).optional(),
      mode: z.enum(['page_per_item', 'stack_on_page']).default('page_per_item'), layout: z.enum(['full', 'top_left']).default('full'),
      pageId: uuid.optional().describe('stack_on_page only: an existing page to add to (default: a new page)'), afterPageId: uuid.nullable().optional().describe('Insert new pages after this page (default: at the end)'),
      titlePrefix: z.string().min(1).max(50).optional(),
    }), 'mcp:write', async a => {
      const books = await live()
      const book = books.find(b => b.id === a.notebookId)
      if (!book) return notFound()
      if (a.pageId && !book.pages.some(p => p.id === a.pageId)) return notFound()
      if (a.afterPageId && !book.pages.some(p => p.id === a.afterPageId)) return notFound()
      const source = await library().getSource(a.sourceId)
      if (!source) return { ok: false, code: 'NOT_FOUND', message: 'That source document was not found. Use nova_list_notebooks to see the available documents.' }
      let items: Item[]
      if (a.items?.length) items = a.items
      else {
        const list = typeof a.pages === 'string' ? parsePageList(a.pages) : a.pages
        if (!list?.length) return { ok: false, code: 'INVALID_REQUEST', message: 'Give pages (like "5-7") or items.' }
        items = list.map(page => ({ page }))
      }
      if (items.some(i => !cropOk(i.crop))) return { ok: false, code: 'INVALID_REQUEST', message: 'A crop rectangle must lie inside the page.' }
      if (source.pages && items.some(i => i.page > source.pages!)) return { ok: false, code: 'INVALID_REQUEST', message: `That document has ${source.pages} pages.` }
      const job = await library().createJob({ requestId: a.requestId, kind: 'place_source', params: {
        sourceId: a.sourceId, notebookId: a.notebookId, mode: a.mode, layout: a.layout, items, pageId: a.pageId, afterPageId: a.afterPageId ?? null, titlePrefix: a.titlePrefix,
      } }) as Data
      return job.ok ? { ...job, note: 'The open notebook renders these and places them. Check nova_op_status with this jobId.' } : job
    }, d => `Placement ${d.status} (job ${d.jobId}).`)

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
    // One line per fetch of the notebook UI, so a host's use of it can be seen in the Worker's logs.
    console.log(JSON.stringify({ evt: 'ui-resource', uri: ENGINE_UI_URI, bytes: ENGINE_WIDGET_HTML.length }))
    return {
      contents: [{
        uri: ENGINE_UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: ENGINE_WIDGET_HTML.replaceAll(ASSET_ORIGIN_MARK, assetOrigin),
        _meta: { ui: { prefersBorder: false, csp: { resourceDomains: assetOrigin ? [assetOrigin, 'data:'] : [], connectDomains: assetOrigin ? [assetOrigin] : [] } } },
      }],
    }
  })

  return server
}
