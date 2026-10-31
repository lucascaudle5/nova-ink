/**
 * In-memory stand-in for the nb_* tools, for tests and for previewing the app outside Claude. It follows
 * PageDO's order of save checks (replay, editing control, revision). Holds test data only, never saved anywhere.
 */
import { isPaper } from '../engine/src/core/paper'
import type { Paper } from '../engine/src/core/paper'
import type { Camera } from '../engine/src/core/types'
import type { Data } from './session'

type Lease = { clientId: string; until: number }
type MockPage = {
  notebookId: string; title: string; deletedAt: string | null; revision: number
  rows: Map<string, { key: string; stroke: unknown }>; paper: Paper; camera: Camera | null
  lease: Lease | null; last: { saveId: string; clientId: string; revision: number } | null
  ops: Map<string, MockOp>
}
type MockOp = { opId: string; ops: unknown[]; status: 'queued' | 'applied' | 'saved' | 'failed'; revision: number | null; message?: string }
type MockNotebook = { id: string; name: string; folderId: string | null; color: string | null; editedAt: string; deletedAt: string | null }
type MockFolder = { id: string; name: string; deletedAt: string | null }
const COLOR = /^#[0-9a-f]{6}$/

const LEASE_MS = 45_000
const DEFAULT_PAPER: Paper = { color: 'white', pattern: 'blank' }

export class MockServer {
  folders: MockFolder[] = []
  /** Source documents (original PDFs), render jobs NOVA asked for, and where pictures came from. */
  sources = new Map<string, { name: string; bytes: number; count: number; pages: number | null; pieces: Map<number, string> }>()
  jobs: Array<{ jobId: string; kind: string; params: any; status: 'pending' | 'done' | 'failed'; outputs?: unknown[]; message?: string }> = []
  imageMeta = new Map<string, unknown>()
  images = new Map<string, { mime: string; width: number; height: number; bytes: number; count: number; pieces: Map<number, string> }>()
  notebooks: MockNotebook[] = []
  pages = new Map<string, MockPage>()
  /** The picture each page's notebook last stored for Claude, as nova_read_page would attach it. */
  views = new Map<string, { seen: string; mime: string; data: string; width: number; height: number; at: string }>()
  /** Test seam: refuse every nb_put_view. */
  failViews = false
  last: { notebookId: string; pageId: string } | null = null
  now = 0
  offline = false
  dropNextReply = false
  latencyMs = 0
  calls: string[] = []
  private n = 0

  constructor(options: { clock?: () => number } = {}) {
    if (options.clock) Object.defineProperty(this, 'now', { get: options.clock })
    this.addPage(this.addNotebook('My Notebook'), 'Page 1')
  }

  addNotebook(name: string, folderId: string | null = null, color: string | null = null): string {
    const id = this.id()
    this.notebooks.push({ id, name, folderId, color, editedAt: new Date().toISOString(), deletedAt: null })
    return id
  }

  id() { return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}` }
  get first(): string { return [...this.pages.keys()][0] }
  get notebookId(): string { return this.notebooks[0].id }

  addPage(notebookId: string, title: string, paper: Paper = DEFAULT_PAPER, afterPageId?: string | null): string {
    const id = this.id()
    const page: MockPage = { notebookId, title, deletedAt: null, revision: 0, rows: new Map(), paper: { ...paper }, camera: null, lease: null, last: null, ops: new Map() }
    const entries = [...this.pages]
    const at = afterPageId ? entries.findIndex(([key]) => key === afterPageId) : -1
    if (at < 0) this.pages.set(id, page)
    else this.pages = new Map([...entries.slice(0, at + 1), [id, page], ...entries.slice(at + 1)])
    return id
  }

  /** What NOVA's tools do on the real server: queue a batch for the page's open editor. */
  enqueueOps(pageId: string, requestId: string, ops: unknown[]): string {
    const p = this.pages.get(pageId)!
    const existing = p.ops.get(requestId)
    if (existing) return existing.opId
    const opId = crypto.randomUUID()
    p.ops.set(requestId, { opId, ops, status: 'queued', revision: null })
    return opId
  }
  opStatus(pageId: string, requestId: string) { return this.pages.get(pageId)?.ops.get(requestId) }
  addJob(params: unknown, kind = 'place_source'): string { const jobId = this.id(); this.jobs.push({ jobId, kind, params, status: 'pending' }); return jobId }
  private pendingOps(p: MockPage) {
    return [...p.ops].filter(([, o]) => o.status === 'queued' || o.status === 'applied').map(([requestId, o]) => ({ requestId, opId: o.opId, ops: o.ops }))
  }

  api = async (name: string, args: Record<string, unknown>): Promise<Data> => {
    this.calls.push(name)
    if (this.latencyMs) await new Promise(resolve => setTimeout(resolve, this.latencyMs))
    if (this.offline) throw new Error('offline')
    const result = this.handle(name, args as any)
    if (name === 'nb_save_page' && this.dropNextReply) { this.dropNextReply = false; throw new Error('connection reset') }
    return structuredClone(result)
  }

  private lease(p: MockPage, clientId: string, takeOver = false): boolean {
    if (p.lease && p.lease.clientId !== clientId && p.lease.until > this.now && !takeOver) return true
    p.lease = { clientId, until: this.now + LEASE_MS }
    return false
  }

  private meta(id: string, p: MockPage) {
    const book = this.notebooks.find(n => n.id === p.notebookId)
    return { id, notebookId: p.notebookId, title: p.title, revision: p.revision, deletedAt: p.deletedAt ?? book?.deletedAt ?? null }
  }

  private handle(name: string, a: any): Data {
    const ok = (extra: Record<string, unknown> = {}): Data => ({ ok: true, ...extra })
    const missing = (): Data => ({ ok: false, code: 'NOT_FOUND', message: 'That notebook or page was not found.' })
    const book = this.notebooks.find(n => n.id === a.notebookId)
    const folder = this.folders.find(f => f.id === a.folderId)
    const badCover = (): Data | null =>
      a.color != null && !COLOR.test(a.color) ? { ok: false, code: 'INVALID_COLOR', message: 'Choose a cover color.' }
        : a.folderId != null && (!folder || folder.deletedAt) ? missing() : null
    switch (name) {
      case 'nb_list': {
        const notebooks = this.notebooks.map(n => ({ ...n, pages: [...this.pages].filter(([, p]) => p.notebookId === n.id).map(([id, p]) => this.meta(id, p)) }))
        const live = notebooks.find(n => n.id === this.last?.notebookId && !n.deletedAt) ?? notebooks.find(n => !n.deletedAt)
        const page = live?.pages.find(p => p.id === this.last?.pageId && !p.deletedAt) ?? live?.pages.find(p => !p.deletedAt)
        return ok({ folders: this.folders, notebooks, last: { notebookId: live?.id ?? null, pageId: page?.id ?? null } })
      }
      case 'nb_create_notebook': {
        const bad = badCover()
        if (bad) return bad
        const id = this.addNotebook(a.name, a.folderId ?? null, a.color ?? null)
        return ok({ notebookId: id, pageId: this.addPage(id, 'Page 1') })
      }
      case 'nb_update_notebook': {
        if (!book) return missing()
        const bad = badCover()
        if (bad) return bad
        if ('folderId' in a) book.folderId = a.folderId
        if ('color' in a) book.color = a.color
        return ok()
      }
      case 'nb_create_folder': {
        const id = this.id()
        this.folders.push({ id, name: a.name, deletedAt: null })
        return ok({ folderId: id })
      }
      case 'nb_rename_folder': if (!folder) return missing(); folder.name = a.name; return ok()
      case 'nb_remove_folder':
        if (!folder) return missing()
        for (const n of this.notebooks) if (n.folderId === folder.id) n.folderId = null
        folder.deletedAt = new Date().toISOString(); return ok()
      case 'nb_restore_folder': if (!folder) return missing(); folder.deletedAt = null; return ok()
      case 'nb_put_image': {
        let entry = this.images.get(a.imageId)
        if (!entry) this.images.set(a.imageId, entry = { mime: a.mime, width: a.width, height: a.height, bytes: a.bytes, count: a.count, pieces: new Map() })
        entry.pieces.set(a.index, a.data)
        return ok({ complete: entry.pieces.size === entry.count })
      }
      case 'nb_get_image': {
        const entry = this.images.get(a.imageId)
        if (!entry || entry.pieces.size !== entry.count) return { ok: false, code: 'NOT_FOUND', message: 'That picture was not found.' }
        return ok({ mime: entry.mime, width: entry.width, height: entry.height, bytes: entry.bytes, count: entry.count, index: a.index, data: entry.pieces.get(a.index) })
      }
      case 'nb_set_image_meta': this.imageMeta.set(a.imageId, a.meta); return ok()
      case 'nb_put_source_chunk': {
        let entry = this.sources.get(a.sourceId)
        if (!entry) this.sources.set(a.sourceId, entry = { name: a.name, bytes: a.bytes, count: a.count, pages: a.pages ?? null, pieces: new Map() })
        entry.pieces.set(a.index, a.data)
        return ok({ complete: entry.pieces.size === entry.count })
      }
      case 'nb_get_source_chunk': {
        const entry = this.sources.get(a.sourceId)
        if (!entry || entry.pieces.size !== entry.count) return { ok: false, code: 'NOT_FOUND', message: 'That document was not found.' }
        return ok({ bytes: entry.bytes, count: entry.count, index: a.index, data: entry.pieces.get(a.index) })
      }
      case 'nb_jobs': return ok({ jobs: this.jobs.filter(j => j.status === 'pending').map(j => ({ jobId: j.jobId, kind: j.kind, params: j.params, source: { name: this.sources.get(j.params.sourceId)?.name } })) })
      case 'nb_job_done': {
        const job = this.jobs.find(j => j.jobId === a.jobId)
        if (!job) return missing()
        if (job.status !== 'pending') return ok({ duplicate: true, status: job.status })
        if (a.failure) { job.status = 'failed'; job.message = a.failure; return ok({ status: 'failed', message: a.failure }) }
        job.status = 'done'; job.outputs = a.outputs
        return ok({ status: 'done' })
      }
      case 'nb_rename_notebook': if (!book) return missing(); book.name = a.name; return ok()
      case 'nb_remove_notebook':
        if (!book) return missing()
        if (this.notebooks.filter(n => !n.deletedAt).length <= 1 && !book.deletedAt) return { ok: false, code: 'LAST_NOTEBOOK', message: 'Keep at least one notebook. Create another before removing this one.' }
        book.deletedAt = new Date().toISOString(); return ok()
      case 'nb_restore_notebook': if (!book) return missing(); book.deletedAt = null; return ok()
      case 'nb_add_page': {
        if (!book) return missing()
        const live = [...this.pages].filter(([, p]) => p.notebookId === book.id && !p.deletedAt)
        const previous = a.afterPageId ? this.pages.get(a.afterPageId) : live.at(-1)?.[1]
        if (a.paper && !isPaper(a.paper)) return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown paper style.' }
        const pageId = this.addPage(book.id, a.title ?? `Page ${live.length + 1}`, a.paper ?? previous?.paper, a.afterPageId)
        return ok({ pageId, previousPageId: a.afterPageId ?? live.at(-1)?.[0] ?? null })
      }
    }
    const p = this.pages.get(a.pageId)
    if (!p) return missing()
    const trashed = !!(p.deletedAt || this.notebooks.find(n => n.id === p.notebookId)?.deletedAt)
    const inTrash = (): Data => ({ ok: false, code: 'IN_TRASH', message: 'That page is in the trash. Restore it before editing.' })
    switch (name) {
      case 'nb_rename_page': p.title = a.title; return ok()
      case 'nb_move_page': return ok()
      case 'nb_remove_page': p.deletedAt = new Date().toISOString(); return ok()
      case 'nb_restore_page': {
        p.deletedAt = null
        const owner = this.notebooks.find(n => n.id === p.notebookId)
        if (owner) owner.deletedAt = null
        return ok()
      }
      case 'nb_open_page': {
        if (trashed) return inTrash()
        const readOnly = this.lease(p, a.clientId, a.takeOver)
        this.last = { notebookId: p.notebookId, pageId: a.pageId }
        const rows = [...p.rows.values()].sort((x, y) => x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
        return ok({ revision: p.revision, rows: JSON.stringify(rows), strokeCount: rows.length, paper: p.paper, camera: p.camera, readOnly, page: this.meta(a.pageId, p), pendingOps: this.pendingOps(p) })
      }
      case 'nb_heartbeat': {
        const readOnly = this.lease(p, a.clientId)
        if (readOnly) return ok({ readOnly })
        for (const id of a.applied ?? []) { const o = p.ops.get(id); if (o?.status === 'queued') o.status = 'applied' }
        return ok({ readOnly, revision: p.revision, pendingOps: this.pendingOps(p) })
      }
      case 'nb_report_ops': {
        for (const r of a.results ?? []) {
          const o = p.ops.get(r.requestId)
          if (!o || (o.status !== 'queued' && o.status !== 'applied')) continue
          if (r.status === 'failed') { o.status = 'failed'; o.message = r.message } else { o.status = 'saved'; o.revision = p.revision }
        }
        return ok()
      }
      case 'nb_put_view': {
        if (p.lease && p.lease.clientId !== a.clientId && p.lease.until > this.now) return { ok: false, code: 'LEASE_HELD', message: 'Another device is editing this page.' }
        if (this.failViews) return { ok: false, code: 'SERVER_ERROR', message: 'The preview server refused the picture.' }
        if (a.view) this.views.set(a.pageId, { ...a.view, at: new Date().toISOString() }); else this.views.delete(a.pageId)
        return ok()
      }
      case 'nb_release': if (p.lease?.clientId === a.clientId) p.lease = null; return ok()
      case 'nb_list_checkpoints': return ok({ checkpoints: [] })
      case 'nb_restore_checkpoint': return { ok: false, code: 'BACKUP_UNAVAILABLE', message: 'The preview server keeps no checkpoints.' }
      case 'nb_save_page': {
        if (trashed) return inTrash()
        if (p.last && p.last.saveId === a.saveId && p.last.clientId === a.clientId) return ok({ replayed: true, revision: p.last.revision, savedAt: new Date().toISOString() })
        if (p.lease && p.lease.clientId !== a.clientId && p.lease.until > this.now) return { ok: false, code: 'LEASE_HELD', message: 'Another device is editing this page.' }
        if (a.baseRevision !== p.revision) return { ok: false, code: 'CONFLICT', message: 'This page has a newer version.', revision: p.revision, ...(p.last && p.last.clientId === a.clientId ? { ownLastSaveId: p.last.saveId } : {}) }
        const missingImage = (a.adds ?? []).some((x: { stroke: { kind?: string; image?: string } }) => {
          const picture = x.stroke.kind === 'image' ? this.images.get(x.stroke.image ?? '') : null
          return picture === undefined || (!!picture && picture.pieces.size !== picture.count)
        })
        if (missingImage) return { ok: false, code: 'MISSING_IMAGE', message: 'A picture on this page was not uploaded completely. Nothing was saved.' }
        for (const id of a.removes ?? []) p.rows.delete(id)
        for (const add of a.adds ?? []) p.rows.set((add.stroke as { id: string }).id, add)
        if (a.paper) p.paper = a.paper
        if (a.camera) p.camera = a.camera
        p.revision++
        for (const id of a.appliedOps ?? []) { const o = p.ops.get(id); if (o && (o.status === 'queued' || o.status === 'applied')) { o.status = 'saved'; o.revision = p.revision } }
        const owner = this.notebooks.find(n => n.id === p.notebookId)
        if (owner) owner.editedAt = new Date().toISOString()
        p.last = { saveId: a.saveId, clientId: a.clientId, revision: p.revision }
        this.lease(p, a.clientId)
        return ok({ revision: p.revision, savedAt: new Date().toISOString(), strokeCount: p.rows.size })
      }
    }
    return { ok: false, code: 'INVALID_REQUEST', message: `Unknown tool ${name}` }
  }
}
