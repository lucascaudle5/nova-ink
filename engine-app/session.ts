/**
 * Notebook session for the engine app: which page is open, editing control, and saving deltas to the server.
 * DOM-free and host-free (the host's tool call is injected as `api`), so it is tested in Node.
 *
 * Rules carried over from v0.2.3 (src/session.ts):
 * - "Saved" only after the server confirmed the save; on failure "Not synced" and the changes stay here.
 * - One save in flight. A save whose reply was lost is retried with the same saveId, so the server replays it.
 * - Another device's newer version or editing control is a conflict, never overwritten.
 */
import { parseItem } from '../engine/src/core/format'
import { planOps } from '../engine/src/core/ops'
import type { Op, Plan } from '../engine/src/core/ops'
import type { Paper } from '../engine/src/core/paper'
import { PageSync } from '../engine/src/core/sync'
import type { PageDelta } from '../engine/src/core/sync'
import { isImage } from '../engine/src/core/types'
import type { Camera, ImageItem, PageItem, Stroke } from '../engine/src/core/types'

/** Must match the server's piece size (cloudflare/src/engine/library-do.ts IMAGE_CHUNK_BYTES). */
export const IMAGE_CHUNK_BYTES = 192 * 1024
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** Must match the server (library-do.ts MAX_SOURCE_BYTES). */
export const MAX_SOURCE_BYTES = 24 * 1024 * 1024
export interface StoredPicture { bytes: Uint8Array; mime: string; width: number; height: number }

export type Data = Record<string, any> & { ok: boolean; code?: string; message?: string }
export type Api = (name: string, args: Record<string, unknown>) => Promise<Data>

export interface PageEditor {
  /** Everything on the page in stored order: image placements first (they are under the ink), then strokes. */
  items(): readonly PageItem[]
  paper(): Paper
  camera(): Camera
  /** Replaces the page (clears undo) and shows it; a null camera fits the content. */
  load(strokes: Stroke[], images: ImageItem[], paper: Paper, camera: Camera | null): void
  setReadOnly(readOnly: boolean): void
  /** Applies NOVA's planned operations as ONE undo step (and shows them). Optional: an editor without it ignores NOVA's requests. */
  applyPlan?(plan: Plan): number
  /** True while the user is writing, dragging or panning; NOVA's changes wait until it is false. */
  busy?(): boolean
}

/** A request from NOVA (the model) waiting to be applied to the open page. */
export interface PendingOp { requestId: string; opId: string; ops: Op[] }

export type Status = 'loading' | 'saved' | 'unsaved' | 'saving' | 'notSynced' | 'conflict' | 'readOnly' | 'recovery' | 'trash'
export type Conflict = 'revision' | 'lease' | 'damaged' | 'gone' | null

export interface PageInfo { id: string; notebookId: string; title: string; revision: number; deletedAt: string | null }
/** `folderId` and `color` are null for notebooks without them (and from servers older than folders). */
export interface NotebookInfo { id: string; name: string; folderId?: string | null; color?: string | null; editedAt?: string; deletedAt: string | null; pages: PageInfo[] }
export interface FolderInfo { id: string; name: string; deletedAt: string | null }

export interface SessionState {
  status: Status
  message: string
  folders: FolderInfo[]
  notebooks: NotebookInfo[]
  notebookId: string | null
  pageId: string | null
  revision: number
  editable: boolean
  conflict: Conflict
  busy: boolean
  lastSavedAt: string | null
}

export interface SessionOptions {
  api: Api
  clientId: string
  editor: PageEditor
  newId?: () => string
  autosaveMs?: number
  cameraSaveMs?: number
  heartbeatMs?: number
  retryDelaysMs?: number[]
}

type Pending = { saveId: string; baseRevision: number; delta: PageDelta; paper?: Paper; camera?: Camera; appliedOps: string[] }

function base64(bytes: Uint8Array): string {
  let raw = ''
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(raw)
}
function unbase64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const samePaper = (a: Paper | null, b: Paper) => !!a && a.color === b.color && a.pattern === b.pattern
const round = (v: number, digits: number) => Number(v.toFixed(digits))
const cameraKey = (c: Camera | null) => c ? `${round(c.x, 1)}|${round(c.y, 1)}|${round(c.z, 4)}` : ''

export class NotebookSession {
  private readonly api: Api
  private readonly clientId: string
  private readonly editor: PageEditor
  private readonly newId: () => string
  private readonly autosaveMs: number
  private readonly cameraSaveMs: number
  private readonly heartbeatMs: number
  private readonly retryDelaysMs: number[]

  private state: SessionState = {
    status: 'loading', message: 'Connecting to NOVA Ink…', folders: [], notebooks: [], notebookId: null, pageId: null,
    revision: 0, editable: false, conflict: null, busy: false, lastSavedAt: null,
  }
  private listeners = new Set<() => void>()
  private sync = new PageSync()
  private ackPaper: Paper | null = null
  private ackCamera = ''
  private pending: Pending | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** NOVA's requests applied in this editor and not yet part of a confirmed save, and ones already reported as failed or unchanged. */
  private applied = new Set<string>()
  private reported = new Set<string>()
  private disposed = false

  constructor(options: SessionOptions) {
    this.api = options.api
    this.clientId = options.clientId
    this.editor = options.editor
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.autosaveMs = options.autosaveMs ?? 650
    this.cameraSaveMs = options.cameraSaveMs ?? 3000
    this.heartbeatMs = options.heartbeatMs ?? 6_000
    this.retryDelaysMs = options.retryDelaysMs ?? [2000, 5000, 10000, 20000, 30000]
  }

  // ---- observation ----

  getState = (): SessionState => this.state
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private status(status: Status, message: string, patch: Partial<SessionState> = {}) { this.set({ status, message, ...patch }) }
  /** Shows a progress or result message without changing the save status. */
  say(message: string) { this.set({ message }) }

  get currentPage(): PageInfo | null {
    for (const n of this.state.notebooks) for (const p of n.pages) if (p.id === this.state.pageId) return p
    return null
  }

  /** Strokes, paper or camera differ from the last confirmed save. */
  get hasUnsavedChanges(): boolean {
    if (!this.state.pageId || this.state.status === 'loading') return false
    return !!this.pending || this.sync.hasChanges(this.editor.items()) || !samePaper(this.ackPaper, this.editor.paper()) || cameraKey(this.editor.camera()) !== this.ackCamera
  }

  /** Changes that are not saved and cannot be saved here as things stand (conflict, damage, trash). */
  get stranded(): boolean {
    return this.hasStrokeChanges && (!!this.state.conflict || !this.state.editable)
  }
  private get hasStrokeChanges() {
    return !!this.pending?.delta.adds.length || !!this.pending?.delta.removes.length || this.sync.hasChanges(this.editor.items()) || !samePaper(this.ackPaper, this.editor.paper())
  }

  // ---- serialized work ----

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => {})
    return run
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Data> {
    try { return await this.api(name, args) } catch (error) { return { ok: false, code: 'NETWORK', message: errorText(error) } }
  }

  // ---- notebook list ----

  async start(): Promise<void> {
    const list = await this.refreshList()
    if (!list) return
    this.set({ notebookId: list.last?.notebookId ?? null })
    if (list.last?.pageId) await this.openPage(list.last.pageId)
    else this.status('saved', 'This notebook has no pages. Add a page to start.')
  }

  async refreshList(): Promise<Data | null> {
    const list = await this.call('nb_list', {})
    if (!list.ok) {
      this.status('notSynced', list.code === 'NETWORK' ? `Can't reach NOVA Ink (${list.message}). Nothing on this device is lost; try again.` : `${list.message ?? 'Could not load notebooks.'}`)
      return null
    }
    this.set({ notebooks: list.notebooks, folders: list.folders ?? [] })
    return list
  }

  // ---- opening pages ----

  /** Saves the current page first; refuses to switch when its changes cannot be saved. */
  openPage(pageId: string, options: { takeOver?: boolean } = {}): Promise<boolean> {
    return this.queue(async () => {
      if (this.state.pageId && this.state.pageId !== pageId) {
        if (this.hasUnsavedChanges && this.state.editable && !this.state.conflict) await this.saveNow()
        if (this.stranded || this.pending) {
          this.set({ message: 'This page has changes that are not saved yet, so NOVA Ink stays on it. Wait for Saved, or use "Copy to a new page".' })
          return false
        }
        if (this.state.editable) void this.call('nb_release', { pageId: this.state.pageId, clientId: this.clientId })
      }
      this.stopTimers()
      this.status('loading', 'Opening page…', { busy: true })
      const res = await this.call('nb_open_page', { pageId, clientId: this.clientId, takeOver: !!options.takeOver })
      this.set({ busy: false })
      if (!res.ok) { this.openFailed(pageId, res); return false }
      const loaded = this.decode(res.rows)
      if (!loaded) {
        this.status('recovery', 'This page on the server is damaged and was not loaded. Restore a checkpoint below.', { pageId, notebookId: res.page?.notebookId ?? null, editable: false, conflict: 'damaged' })
        return false
      }
      this.sync = new PageSync(loaded.keys)
      this.pending = null
      this.applied.clear(); this.reported.clear()
      this.retryAttempt = 0
      this.editor.load(loaded.strokes, loaded.images, res.paper, res.camera ?? null)
      this.ackPaper = { ...res.paper }
      this.ackCamera = cameraKey(this.editor.camera())
      const editable = !res.readOnly
      this.editor.setReadOnly(!editable)
      this.set({ pageId, notebookId: res.page.notebookId, revision: res.revision, editable, conflict: null })
      if (editable) {
        this.status('saved', 'Saved')
        this.startHeartbeat()
        void this.handleOps(res.pendingOps)
      } else this.status('readOnly', 'Another device is editing this page. You are viewing its last saved version.')
      return true
    })
  }

  /** Opens `pageId` if it is a live page of the notebook, else its first page; a notebook without pages shows an empty, locked page. */
  async openNotebook(notebookId: string, pageId?: string | null): Promise<boolean> {
    const book = this.state.notebooks.find(n => n.id === notebookId)
    const first = book?.pages.find(p => p.id === pageId && !p.deletedAt) ?? book?.pages.find(p => !p.deletedAt)
    if (first) return this.openPage(first.id)
    return this.queue(async () => {
      if (this.state.pageId) {
        if (this.hasUnsavedChanges && this.state.editable && !this.state.conflict) await this.saveNow()
        if (this.stranded || this.pending) { this.set({ message: 'This page has changes that are not saved yet, so NOVA Ink stays on it.' }); return false }
        if (this.state.editable) void this.call('nb_release', { pageId: this.state.pageId, clientId: this.clientId })
      }
      this.stopTimers()
      this.sync = new PageSync()
      this.editor.load([], [], this.editor.paper(), null)
      this.editor.setReadOnly(true)
      this.set({ notebookId, pageId: null, editable: false, conflict: null, revision: 0 })
      this.status('saved', 'This notebook has no pages. Add a page to start.')
      return true
    })
  }

  private openFailed(pageId: string, res: Data) {
    const at = { pageId, editable: false }
    switch (res.code) {
      case 'NETWORK': this.status('notSynced', `Can't reach NOVA Ink (${res.message}). Try again when you're online.`, at); break
      case 'IN_TRASH': this.status('trash', 'This page is in the trash. Restore it to keep writing on it.', at); break
      case 'CORRUPT_RECORD':
      case 'MISSING_RECORD': this.status('recovery', `${res.message} `, { ...at, conflict: 'damaged' }); break
      default: this.status('notSynced', res.message ?? 'The page could not be opened.', at)
    }
  }

  /** Parses the server's rows (strokes and image placements); null if any is damaged (the page is then not shown at all). */
  private decode(rows: unknown): { strokes: Stroke[]; images: ImageItem[]; keys: Array<{ id: string; key: string }> } | null {
    let list: Array<{ key: string; stroke: unknown }>
    try { list = JSON.parse(String(rows)) } catch { return null }
    if (!Array.isArray(list)) return null
    const strokes: Stroke[] = [], images: ImageItem[] = [], keys: Array<{ id: string; key: string }> = []
    for (const row of list) {
      const parsed = parseItem(row?.stroke)
      if (!parsed.ok || typeof row.key !== 'string') return null
      if (isImage(parsed.item)) images.push(parsed.item)
      else strokes.push(parsed.item)
      keys.push({ id: parsed.item.id, key: row.key })
    }
    return { strokes, images, keys }
  }

  // ---- editing and saving ----

  /** Call after every page change, including camera moves (those are saved quietly, less often). */
  changed(): void {
    if (!this.state.pageId || this.state.status === 'loading' || !this.state.editable || this.state.conflict) return
    if (!this.hasUnsavedChanges) { if (this.state.status === 'unsaved') this.status('saved', 'Saved'); return }
    const content = this.hasStrokeChanges
    if (content && this.state.status !== 'saving' && this.state.status !== 'notSynced') this.status('unsaved', 'Unsaved changes')
    this.schedule(content ? this.autosaveMs : this.cameraSaveMs)
  }

  private schedule(ms: number) {
    if (this.disposed || this.retryTimer) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save() }, ms)
  }

  save(): Promise<void> { return this.queue(() => this.saveNow()) }

  /** Saves until nothing is left or a save cannot succeed by retrying. Runs inside the queue. */
  private async saveNow(): Promise<void> {
    for (let rounds = 0; rounds < 5; rounds++) {
      const outcome = await this.saveOnce()
      if (outcome !== 'saved' || !this.hasUnsavedChanges) return
    }
  }

  private async saveOnce(): Promise<'saved' | 'nothing' | 'failed' | 'blocked'> {
    const { pageId, editable, conflict } = this.state
    if (!pageId || !editable || conflict) return 'blocked'
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    let req = this.pending
    if (!req) {
      if (!this.hasUnsavedChanges) { if (this.state.status !== 'saved') this.status('saved', 'Saved'); return 'nothing' }
      const paper = this.editor.paper(), camera = this.editor.camera()
      req = {
        saveId: this.newId(), baseRevision: this.state.revision, delta: this.sync.delta(this.editor.items()), appliedOps: [...this.applied],
        ...(samePaper(this.ackPaper, paper) ? {} : { paper: { ...paper } }),
        ...(cameraKey(camera) === this.ackCamera ? {} : { camera: { x: round(camera.x, 1), y: round(camera.y, 1), z: round(camera.z, 4) } }),
      }
      this.pending = req
    }
    const viewOnly = !req.delta.adds.length && !req.delta.removes.length && !req.paper && !req.appliedOps.length
    if (!viewOnly || this.state.status !== 'saved') this.status('saving', 'Saving…')
    const res = await this.call('nb_save_page', {
      pageId, clientId: this.clientId, saveId: req.saveId, baseRevision: req.baseRevision,
      adds: req.delta.adds, removes: req.delta.removes,
      ...(req.paper ? { paper: req.paper } : {}), ...(req.camera ? { camera: req.camera } : {}),
      ...(req.appliedOps.length ? { appliedOps: req.appliedOps } : {}),
    })
    if (this.state.pageId !== pageId) return 'blocked'
    if (res.ok || (res.code === 'CONFLICT' && res.ownLastSaveId === req.saveId && Number.isSafeInteger(res.revision))) {
      this.confirmed(req, res.revision, res.savedAt ?? null)
      return 'saved'
    }
    switch (res.code) {
      case 'NETWORK':
      case 'STORAGE_ERROR':
      case 'SERVER_ERROR':
        this.status('notSynced', `Not synced: ${res.code === 'NETWORK' ? `can't reach NOVA Ink (${res.message})` : res.message}. Your changes are kept on this device and NOVA Ink keeps retrying. Don't close NOVA Ink yet.`)
        this.scheduleRetry()
        return 'failed'
      case 'CONFLICT':
        this.status('conflict', 'This page was changed on another device, so your latest changes were not saved over it. Use "Copy to a new page" to keep them.', { conflict: 'revision' })
        return 'blocked'
      case 'LEASE_HELD':
        this.status('conflict', 'Another device is editing this page, so your latest changes were not saved. Take over editing, or use "Copy to a new page".', { conflict: 'lease' })
        return 'blocked'
      case 'CORRUPT_RECORD':
      case 'MISSING_RECORD':
        this.status('conflict', 'The saved copy of this page is damaged or missing. Use "Copy to a new page" to keep your version.', { conflict: 'damaged' })
        return 'blocked'
      case 'IN_TRASH':
      case 'NOT_FOUND':
        this.status('conflict', 'This page was moved to the trash or removed elsewhere. Use "Copy to a new page" to keep your changes.', { conflict: 'gone' })
        return 'blocked'
      default:
        this.pending = null
        this.status('notSynced', `Not synced: ${res.message ?? 'the server refused this change'}. Your changes are only on this device.`)
        return 'failed'
    }
  }

  private confirmed(req: Pending, revision: number, savedAt: string | null) {
    this.sync.acknowledge(req.delta)
    if (req.paper) this.ackPaper = req.paper
    if (req.camera) this.ackCamera = cameraKey(req.camera)
    for (const id of req.appliedOps) this.applied.delete(id)
    this.pending = null
    this.retryAttempt = 0
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.set({ revision, lastSavedAt: savedAt ?? new Date().toISOString() })
    if (this.hasUnsavedChanges) { this.status('unsaved', 'Unsaved changes'); this.schedule(this.hasStrokeChanges ? this.autosaveMs : this.cameraSaveMs) }
    else this.status('saved', 'Saved')
  }

  private scheduleRetry() {
    if (this.retryTimer || this.disposed) return
    const delay = this.retryDelaysMs[Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)]
    this.retryAttempt++
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.save() }, delay)
  }

  // ---- editing control ----

  private startHeartbeat() {
    if (this.heartbeatMs > 0 && !this.heartbeatTimer) this.heartbeatTimer = setInterval(() => { void this.heartbeat() }, this.heartbeatMs)
  }

  async heartbeat(): Promise<void> {
    const { pageId } = this.state
    if (!pageId || !this.state.editable) return
    const res = await this.call('nb_heartbeat', { pageId, clientId: this.clientId, ...(this.applied.size ? { applied: [...this.applied] } : {}) })
    if (!res.ok || this.state.pageId !== pageId) return
    if (!res.readOnly) {
      // The server moved ahead while this editor was away (for example NOVA saved while the notebook was asleep) and
      // nothing here is unsaved: show the newer page rather than meet a conflict on the next stroke.
      if (Number.isSafeInteger(res.revision) && res.revision > this.state.revision && !this.pending && !this.hasUnsavedChanges && !this.editor.busy?.()) { void this.reload(); return }
      await this.handleOps(res.pendingOps)
      return
    }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    this.editor.setReadOnly(true)
    if (this.hasStrokeChanges) this.status('conflict', 'Another device took over editing before your latest changes were saved. Use "Copy to a new page" to keep them.', { editable: false, conflict: 'lease' })
    else this.status('readOnly', 'Another device took over editing. You are viewing the last saved version.', { editable: false })
  }

  /**
   * Applies NOVA's waiting requests to this page, each as one undo step, using the same planner as the server. A request
   * that cannot apply (its targets are gone) or that changes nothing is reported, never retried forever. Waits while the
   * user is writing. Idempotent: a request already applied here, or already on the page, is not applied again.
   */
  private async handleOps(list: unknown): Promise<void> {
    const apply = this.editor.applyPlan
    const { pageId } = this.state
    if (!apply || !pageId || !this.state.editable || this.state.conflict || !Array.isArray(list) || !list.length) return
    if (this.editor.busy?.()) return
    const results: Array<{ requestId: string; status: 'failed' | 'noop'; message?: string }> = []
    for (const op of list as PendingOp[]) {
      if (this.applied.has(op.requestId) || this.reported.has(op.requestId)) continue
      const items = this.editor.items()
      const plan = planOps({ strokes: items.filter((i): i is Stroke => !isImage(i)), images: items.filter(isImage) }, op.ops, { opId: op.opId })
      if (!plan.ok) { this.reported.add(op.requestId); results.push({ requestId: op.requestId, status: 'failed', message: plan.message }); continue }
      if (plan.empty) { this.reported.add(op.requestId); results.push({ requestId: op.requestId, status: 'noop' }); continue }
      this.applied.add(op.requestId)
      if (apply.call(this.editor, plan) === 0) { this.applied.delete(op.requestId); this.reported.add(op.requestId); results.push({ requestId: op.requestId, status: 'failed', message: 'The notebook could not apply this change.' }) }
    }
    if (this.applied.size) this.changed()
    if (results.length) await this.call('nb_report_ops', { pageId, clientId: this.clientId, results })
  }

  /** Takes editing control back. Local changes are kept when nobody saved in between; otherwise it is a conflict. */
  takeOver(): Promise<void> {
    return this.queue(async () => {
      const { pageId } = this.state
      if (!pageId) return
      const local = this.hasStrokeChanges
      const res = await this.call('nb_open_page', { pageId, clientId: this.clientId, takeOver: true })
      if (!res.ok) { this.openFailed(pageId, res); return }
      if (res.revision === this.state.revision || !local) {
        if (res.revision !== this.state.revision) {
          const loaded = this.decode(res.rows)
          if (!loaded) { this.status('recovery', 'This page on the server is damaged and was not loaded.', { conflict: 'damaged', editable: false }); return }
          this.sync = new PageSync(loaded.keys)
          this.editor.load(loaded.strokes, loaded.images, res.paper, res.camera ?? null)
          this.ackPaper = { ...res.paper }
          this.ackCamera = cameraKey(this.editor.camera())
        }
        this.editor.setReadOnly(false)
        this.set({ editable: true, conflict: null, revision: res.revision })
        this.status('saved', 'Saved')
        this.startHeartbeat()
        if (this.hasUnsavedChanges) await this.saveNow()
      } else {
        this.editor.setReadOnly(false)
        this.set({ editable: true, revision: this.state.revision })
        this.status('conflict', 'This page was changed on another device while you were away. Use "Copy to a new page" to keep your version.', { conflict: 'revision' })
      }
    })
  }

  /** Discards changes on this device and shows the server's version. The caller confirms with the user first. */
  reload(): Promise<boolean> {
    const pageId = this.state.pageId
    if (!pageId) return Promise.resolve(false)
    this.pending = null
    this.set({ pageId: null, conflict: null })
    return this.openPage(pageId, { takeOver: false })
  }

  /** Saves everything on this page, as it is here, into a new page right after it. Resolves any conflict. */
  copyToNewPage(): Promise<boolean> {
    return this.queue(async () => {
      const from = this.currentPage
      const notebookId = this.state.notebookId
      if (!notebookId) return false
      this.status('saving', 'Copying to a new page…', { busy: true })
      const added = await this.call('nb_add_page', { notebookId, afterPageId: from?.id ?? null, title: `${from?.title ?? 'Page'} (copy)`.slice(0, 80) })
      if (!added.ok) { this.status('notSynced', `Could not create the copy: ${added.message}. Your changes are still on this device.`, { busy: false }); return false }
      const opened = await this.call('nb_open_page', { pageId: added.pageId, clientId: this.clientId })
      if (!opened.ok) { this.status('notSynced', `Could not open the copy: ${opened.message}. Your changes are still on this device.`, { busy: false }); return false }
      if (this.state.pageId && this.state.editable && !this.state.conflict) void this.call('nb_release', { pageId: this.state.pageId, clientId: this.clientId })
      this.stopTimers()
      this.sync = new PageSync()
      this.pending = null
      this.applied.clear(); this.reported.clear()
      this.ackPaper = { ...opened.paper }
      this.ackCamera = ''
      this.editor.setReadOnly(false)
      this.set({ pageId: added.pageId, revision: opened.revision, editable: true, conflict: null, busy: false })
      await this.refreshList()
      this.startHeartbeat()
      await this.saveNow()
      return true
    })
  }

  // ---- pictures ----

  /** A tool call for helpers that work beside the session (render jobs); never throws. */
  rpc(name: string, args: Record<string, unknown>): Promise<Data> { return this.call(name, args) }

  /**
   * Keeps the original PDF as a source document, so NOVA can place its pages and problems later. The id comes from the
   * file's content, so the same file is stored once. Returns null (the pages are still imported) if it cannot be kept.
   */
  async uploadSource(bytes: Uint8Array, name: string, pages: number): Promise<string | null> {
    if (bytes.length > MAX_SOURCE_BYTES) return null
    let sourceId: string
    try {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
      sourceId = 'src_' + [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
    } catch { return null }
    const count = Math.max(1, Math.ceil(bytes.length / IMAGE_CHUNK_BYTES))
    for (let index = 0; index < count; index++) {
      const data = base64(bytes.subarray(index * IMAGE_CHUNK_BYTES, (index + 1) * IMAGE_CHUNK_BYTES))
      let res: Data = { ok: false }
      for (let attempt = 0; attempt < 3 && !res.ok; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 800 * attempt))
        res = await this.call('nb_put_source_chunk', { sourceId, name: name.slice(0, 120) || 'Document.pdf', bytes: bytes.length, count, index, data, ...(index === 0 && pages > 0 ? { pages } : {}) })
        if (!res.ok && res.code !== 'NETWORK' && res.code !== 'SERVER_ERROR' && res.code !== 'STORAGE_ERROR') break
      }
      if (!res.ok) return null
      if (res.complete) return sourceId   // already stored (same file) or the last piece went in
    }
    return null
  }

  /** Records where a picture came from. Best effort: a failure never blocks the import. */
  async setImageMeta(imageId: string, meta: { sourceId: string; sourceName: string; page: number; crop?: { x: number; y: number; w: number; h: number } }): Promise<void> {
    await this.call('nb_set_image_meta', { imageId, meta })
  }

  /**
   * Stores a picture in pieces and returns its id once the server confirmed every piece, or null (with a
   * message) if it could not. Only then may a placement that uses it be added to a page. Failed pieces are
   * retried a few times; re-sending a piece is harmless.
   */
  async uploadImage(picture: StoredPicture, onProgress?: (done: number, count: number) => void): Promise<string | null> {
    const { bytes, mime, width, height } = picture
    if (bytes.length > MAX_IMAGE_BYTES) { this.set({ message: `That picture is too large to store (${(bytes.length / 1048576).toFixed(1)} MB; the limit is 8 MB).` }); return null }
    const imageId = this.newId()
    const count = Math.max(1, Math.ceil(bytes.length / IMAGE_CHUNK_BYTES))
    for (let index = 0; index < count; index++) {
      const data = base64(bytes.subarray(index * IMAGE_CHUNK_BYTES, (index + 1) * IMAGE_CHUNK_BYTES))
      let res: Data = { ok: false }
      for (let attempt = 0; attempt < 3 && !res.ok; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 800 * attempt))
        res = await this.call('nb_put_image', { imageId, mime, width, height, bytes: bytes.length, count, index, data })
        if (!res.ok && res.code !== 'NETWORK' && res.code !== 'SERVER_ERROR' && res.code !== 'STORAGE_ERROR') break
      }
      if (!res.ok) { this.set({ message: `The picture was not added: ${res.message ?? 'the server refused it'}. Nothing on the page changed.` }); return null }
      onProgress?.(index + 1, count)
      if (index === count - 1 && !res.complete) { this.set({ message: 'The picture was not added: the server did not confirm all of it. Nothing on the page changed.' }); return null }
    }
    return imageId
  }

  /** Reads a stored picture, or null if it is unavailable. */
  async fetchImage(imageId: string): Promise<StoredPicture | null> {
    const first = await this.call('nb_get_image', { imageId, index: 0 })
    if (!first.ok) return null
    const out = new Uint8Array(first.bytes)
    let offset = 0
    for (let index = 0; index < first.count; index++) {
      const piece = index === 0 ? first : await this.call('nb_get_image', { imageId, index })
      if (!piece.ok) return null
      const chunk = unbase64(piece.data)
      if (offset + chunk.length > out.length) return null
      out.set(chunk, offset)
      offset += chunk.length
    }
    return offset === out.length ? { bytes: out, mime: first.mime, width: first.width, height: first.height } : null
  }

  // ---- checkpoints ----

  async listCheckpoints(): Promise<Array<{ revision: number; savedAt: string; strokeCount: number }>> {
    if (!this.state.pageId) return []
    const res = await this.call('nb_list_checkpoints', { pageId: this.state.pageId })
    return res.ok ? res.checkpoints : []
  }

  /** Replaces the page with a checkpoint as a new revision; changes on this device are dropped (the caller confirms). */
  async restoreCheckpoint(revision: number): Promise<boolean> {
    const pageId = this.state.pageId
    if (!pageId) return false
    const expectedRevision = this.state.conflict === 'damaged' ? null : this.state.revision
    const res = await this.queue(() => this.call('nb_restore_checkpoint', { pageId, clientId: this.clientId, saveId: this.newId(), checkpointRevision: revision, expectedRevision }))
    if (!res.ok) { this.set({ message: `Not restored: ${res.message}` }); return false }
    this.pending = null
    return this.openPage(pageId)
  }

  // ---- notebook organisation ----

  private organising = 0
  /** Reloads the list once the last of several quick changes is answered, so a shown change never flickers back. */
  private async organise(name: string, args: Record<string, unknown>): Promise<Data> {
    this.organising++
    const res = await this.call(name, args)
    this.organising--
    if (!res.ok) this.set({ message: res.message ?? 'That did not work.' })
    if (!this.organising) await this.refreshList()
    return res
  }

  /** Adds a page after `afterPageId` (default: the open page; null: at the end) and opens it. */
  async addPage(options: { title?: string; paper?: Paper; afterPageId?: string | null } = {}): Promise<boolean> {
    const notebookId = this.state.notebookId
    if (!notebookId || this.state.busy) return false
    const afterPageId = options.afterPageId === undefined ? this.state.pageId : options.afterPageId
    this.set({ busy: true, message: 'Adding a page…' })
    const res = await this.call('nb_add_page', { notebookId, afterPageId, ...(options.title ? { title: options.title } : {}), ...(options.paper ? { paper: options.paper } : {}) })
    this.set({ busy: false })
    if (!res.ok) { this.set({ message: `The page was not added: ${res.message ?? 'the server refused it'}.` }); return false }
    await this.refreshList()
    return this.openPage(res.pageId)
  }
  async createNotebook(name: string, cover: { folderId?: string | null; color?: string | null } = {}): Promise<boolean> {
    const res = await this.organise('nb_create_notebook', { name, ...cover })
    return res.ok && await this.openPage(res.pageId)
  }
  /** Moves a notebook into a folder (null = top level) and/or sets its cover color; omitted fields stay. Shown at once. */
  updateNotebook(notebookId: string, change: { folderId?: string | null; color?: string | null }) {
    this.patchNotebook(notebookId, change)
    return this.organise('nb_update_notebook', { notebookId, ...change })
  }
  createFolder(name: string) { return this.organise('nb_create_folder', { name }) }
  renameFolder(folderId: string, name: string) {
    this.set({ folders: this.state.folders.map(f => f.id === folderId ? { ...f, name } : f) })
    return this.organise('nb_rename_folder', { folderId, name })
  }
  /** Local preview of a change the server is asked for; the list that `organise` reloads afterwards is what counts. */
  private patchNotebook(notebookId: string, change: Partial<NotebookInfo>) {
    this.set({ notebooks: this.state.notebooks.map(n => n.id === notebookId ? { ...n, ...change } : n) })
  }
  removeFolder(folderId: string) { return this.organise('nb_remove_folder', { folderId }) }
  restoreFolder(folderId: string) { return this.organise('nb_restore_folder', { folderId }) }
  renamePage(pageId: string, title: string) { return this.organise('nb_rename_page', { pageId, title }) }
  renameNotebook(notebookId: string, name: string) { this.patchNotebook(notebookId, { name }); return this.organise('nb_rename_notebook', { notebookId, name }) }
  movePage(pageId: string, afterPageId: string | null) { return this.organise('nb_move_page', { pageId, afterPageId }) }
  async removePage(pageId: string): Promise<void> {
    const book = this.state.notebooks.find(n => n.pages.some(p => p.id === pageId))
    const live = book?.pages.filter(p => !p.deletedAt) ?? []
    const index = live.findIndex(p => p.id === pageId)
    const res = await this.organise('nb_remove_page', { pageId })
    if (!res.ok || pageId !== this.state.pageId) return
    const next = live[index + 1] ?? live[index - 1]
    if (this.state.editable) await this.call('nb_release', { pageId, clientId: this.clientId })
    this.stopTimers()
    this.set({ pageId: null, editable: false })
    if (next) await this.openPage(next.id)
    else await this.addPage()
  }
  async restorePage(pageId: string): Promise<void> {
    const res = await this.organise('nb_restore_page', { pageId })
    if (res.ok) await this.openPage(pageId)
  }
  removeNotebook(notebookId: string) { return this.organise('nb_remove_notebook', { notebookId }) }
  restoreNotebook(notebookId: string) { return this.organise('nb_restore_notebook', { notebookId }) }

  // ---- lifecycle ----

  /** Best effort when the host hides or closes the app: save, then release editing control. */
  async teardown(): Promise<void> {
    if (this.hasUnsavedChanges && this.state.editable && !this.state.conflict) await this.save()
    const { pageId, editable } = this.state
    if (pageId && editable && !this.pending && !this.stranded) await this.call('nb_release', { pageId, clientId: this.clientId })
  }

  private stopTimers() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.saveTimer = this.retryTimer = this.heartbeatTimer = null
  }

  dispose(): void {
    this.disposed = true
    this.stopTimers()
    this.listeners.clear()
  }
}
