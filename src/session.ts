/**
 * Canvas session controller: owns save, lease and lifecycle state for the embedded notebook.
 * Invariant: no transition discards local changes that the server has not acknowledged,
 * except discardAndReload(), which the user must explicitly confirm.
 */

export type CanvasMeta = { id: string; name: string; createdAt: string; updatedAt: string; revision?: number }
export type ApiData = {
  ok: boolean; code?: string; message?: string; warning?: string; notice?: { kind: string; message: string }
  revision?: number; ownLastSaveId?: string | null; readOnly?: boolean; savedAt?: string
  canvas?: CanvasMeta; canvases?: CanvasMeta[]; lastOpenedId?: string | null
  snapshot?: unknown; backups?: Array<{ revision: number; savedAt?: string }>
  restoredRevision?: number; recoveryCopyPreserved?: boolean
}
export type Api = (name: string, args: Record<string, unknown>) => Promise<ApiData>

export type SaveStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'failed' | 'conflict' | 'readOnly' | 'recovery' | 'unavailable'
export type ConflictKind = 'revision' | 'lease' | 'damaged'
export type RecoveryKind = 'CORRUPT_RECORD' | 'MISSING_RECORD' | 'INCOMPATIBLE'

export interface SessionState {
  library: CanvasMeta[]
  canvas: CanvasMeta | null
  revision: number
  /** This client holds editing rights for the canvas. */
  editable: boolean
  status: SaveStatus
  message: string
  hasUnsavedChanges: boolean
  /** The editor to render. A new key means a new editor instance with this snapshot. */
  mount: { key: string; snapshot: unknown } | null
  conflict: ConflictKind | null
  recovery: { canvas: CanvasMeta; kind: RecoveryKind } | null
  busy: string | null
  offline: boolean
  notice: string | null
  lastSavedAt: string | null
}

export interface EditorPort {
  getSnapshot(): unknown
  setReadOnly(readOnly: boolean): void
}

export interface SessionOptions {
  api: Api
  clientId: string
  newId?: () => string
  autosaveMs?: number
  retryDelaysMs?: number[]
  heartbeatMs?: number
  maxSnapshotBytes?: number
  /** Returns a reason when tldraw cannot load the snapshot; null when it can. */
  validateSnapshot?: (snapshot: unknown) => string | null
}

const MB = 1024 * 1024
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const encoder = new TextEncoder()

export class CanvasSession {
  private readonly api: Api
  private readonly clientId: string
  private readonly newId: () => string
  private readonly autosaveMs: number
  private readonly retryDelaysMs: number[]
  private readonly heartbeatMs: number
  private readonly maxBytes: number
  private readonly validate: (snapshot: unknown) => string | null

  private state: SessionState = {
    library: [], canvas: null, revision: 0, editable: false, status: 'loading', message: 'Connecting to notebook storage…',
    hasUnsavedChanges: false, mount: null, conflict: null, recovery: null, busy: null, offline: false, notice: null, lastSavedAt: null,
  }
  private listeners = new Set<() => void>()
  private editor: EditorPort | null = null
  private editorKey: string | null = null
  private dirty = false
  private frozen = false
  private generation = 0
  private unconfirmed = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(options: SessionOptions) {
    this.api = options.api
    this.clientId = options.clientId
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.autosaveMs = options.autosaveMs ?? 650
    this.retryDelaysMs = options.retryDelaysMs ?? [2000, 5000, 10000, 20000, 30000]
    this.heartbeatMs = options.heartbeatMs ?? 15_000
    this.maxBytes = options.maxSnapshotBytes ?? 12 * MB
    this.validate = options.validateSnapshot ?? (() => null)
  }

  // ---- observation -------------------------------------------------------

  getState = (): SessionState => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch, hasUnsavedChanges: this.dirty }
    for (const listener of this.listeners) listener()
  }

  private setStatus(status: SaveStatus, message: string, extra: Partial<SessionState> = {}) {
    this.set({ status, message, ...extra })
    this.applyEditorMode()
  }

  // ---- editor wiring -----------------------------------------------------

  /** Called when tldraw mounts. Editors from a superseded mount are ignored. */
  attachEditor(key: string, port: EditorPort) {
    if (this.state.mount?.key !== key) return
    this.editor = port
    this.editorKey = key
    this.applyEditorMode()
  }

  detachEditor(key: string) {
    if (this.editorKey === key) { this.editor = null; this.editorKey = null }
  }

  private canWrite() {
    const { editable, status } = this.state
    return editable && !this.frozen && status !== 'conflict' && status !== 'recovery' && status !== 'readOnly'
  }

  private applyEditorMode() { this.editor?.setReadOnly(!this.canWrite()) }

  /** The editor store changed because of the user. Session-only changes (camera) are saved too. */
  noteChange(scope: 'document' | 'session') {
    if (!this.editor || !this.state.canvas) return
    if (!this.state.editable && scope === 'session') return
    this.dirty = true
    if (!this.state.editable) {
      this.setStatus('conflict', 'This device no longer has editing control, so these changes were not saved. Save your version as a new canvas to keep them.', { conflict: this.state.conflict ?? 'lease' })
      return
    }
    if (this.state.status === 'saved' || this.state.status === 'loading') this.setStatus('unsaved', 'Changes waiting to be saved…')
    else this.set({})
    if (this.state.editable && this.state.status !== 'conflict') this.scheduleAutosave(this.autosaveMs)
  }

  // ---- serialization -----------------------------------------------------

  /** Runs operations one at a time. With a label, the editor is frozen so no edits can land mid-transition. */
  private exclusive<T>(label: string | null, task: () => Promise<T>): Promise<T> {
    const run = async () => {
      if (label) { this.frozen = true; this.set({ busy: label }); this.applyEditorMode() }
      try { return await task() }
      finally { if (label) { this.frozen = false; this.set({ busy: null }); this.applyEditorMode() } }
    }
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    return result
  }

  private scheduleAutosave(ms: number) {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = setTimeout(() => { this.autosaveTimer = null; void this.save() }, ms)
  }

  private scheduleRetry() {
    if (this.retryTimer || this.disposed) return
    const delay = this.retryDelaysMs[Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)]
    this.retryAttempt++
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.save() }, delay)
  }

  private clearTimers() {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.autosaveTimer = this.retryTimer = null
  }

  // ---- saving ------------------------------------------------------------

  /** Saves pending changes. Resolves true when everything local is acknowledged by the server. */
  save(): Promise<boolean> { return this.exclusive(null, () => this.flush()) }

  private async flush(): Promise<boolean> {
    if (this.autosaveTimer) { clearTimeout(this.autosaveTimer); this.autosaveTimer = null }
    for (let attempt = 0; this.dirty && attempt < 8; attempt++) {
      const outcome = await this.saveOnce()
      if (outcome !== 'saved' && outcome !== 'reconciled') return false
    }
    return !this.dirty
  }

  private measure(snapshot: unknown): number {
    try { return encoder.encode(JSON.stringify(snapshot)).length } catch { return Infinity }
  }

  private async saveOnce(): Promise<'saved' | 'reconciled' | 'failed' | 'conflict' | 'blocked'> {
    const canvas = this.state.canvas
    if (!canvas || !this.editor) return 'blocked'
    if (!this.state.editable || this.state.status === 'conflict' || this.state.status === 'recovery') return 'blocked'
    const snapshot = this.editor.getSnapshot()
    const bytes = this.measure(snapshot)
    if (bytes > this.maxBytes) {
      this.setStatus('failed', `This canvas is ${(bytes / MB).toFixed(1)} MB, over the ${(this.maxBytes / MB).toFixed(0)} MB save limit. Your changes are only on this device. Delete or shrink large images, then it will save again.`)
      return 'failed'
    }
    const saveId = this.newId()
    const generation = this.generation
    this.dirty = false
    this.unconfirmed.add(saveId)
    this.setStatus('saving', 'Saving to your notebook server…')
    let res: ApiData
    try {
      res = await this.api('ink_save_canvas', { canvasId: canvas.id, clientId: this.clientId, expectedRevision: this.state.revision, saveId, snapshot })
    } catch (error) {
      this.dirty = true
      if (generation !== this.generation) return 'failed'
      this.setStatus('failed', `Couldn't reach the notebook server (${errorText(error)}). Your changes are kept on this device and NOVA Ink will keep retrying. Don't close NOVA Ink yet.`, { offline: true })
      this.scheduleRetry()
      return 'failed'
    }
    if (generation !== this.generation) { this.dirty = true; return 'failed' }
    if (res.ok && Number.isSafeInteger(res.revision)) {
      this.unconfirmed.clear()
      this.retryAttempt = 0
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
      const warning = res.warning ? ` (${res.warning})` : ''
      const large = bytes > this.maxBytes * 0.75 ? ` This canvas is ${(bytes / MB).toFixed(1)} MB; the limit is ${(this.maxBytes / MB).toFixed(0)} MB.` : ''
      this.set({ revision: res.revision!, offline: false, lastSavedAt: res.savedAt ?? null })
      if (this.dirty) this.setStatus('unsaved', 'More changes waiting to be saved…')
      else this.setStatus('saved', `Saved to your notebook server${res.savedAt ? ` at ${new Date(res.savedAt).toLocaleTimeString()}` : ''}.${warning}${large}`)
      return 'saved'
    }
    this.dirty = true
    switch (res.code) {
      case 'CONFLICT':
        if (res.ownLastSaveId && this.unconfirmed.has(res.ownLastSaveId) && Number.isSafeInteger(res.revision)) {
          // An earlier save from this device committed but its acknowledgement was lost.
          this.unconfirmed.clear()
          this.set({ revision: res.revision! })
          return 'reconciled'
        }
        this.setStatus('conflict', 'This canvas was changed on another device, so your latest changes were not saved over it. Save your version as a new canvas to keep it.', { conflict: 'revision', offline: false })
        return 'conflict'
      case 'LEASE_HELD':
        this.setStatus('conflict', 'Another device is editing this canvas, so your latest changes were not saved. Save your version as a new canvas, or try again after the other device releases editing.', { conflict: 'lease', offline: false })
        return 'conflict'
      case 'CORRUPT_RECORD':
      case 'MISSING_RECORD':
        this.setStatus('conflict', 'The saved copy of this canvas on the server is damaged or missing. Save your version as a new canvas to keep it.', { conflict: 'damaged', offline: false })
        return 'conflict'
      case 'TOO_LARGE':
      case 'INVALID_SNAPSHOT':
        this.setStatus('failed', `${res.message ?? 'The server rejected this canvas.'} Your changes are only on this device.`, { offline: false })
        return 'failed'
      default:
        this.setStatus('failed', `${res.message ?? 'The server could not save this canvas.'} Your changes are kept on this device and NOVA Ink will retry.`, { offline: false })
        this.scheduleRetry()
        return 'failed'
    }
  }

  // ---- opening and switching --------------------------------------------

  async start(): Promise<void> {
    if (this.heartbeatMs > 0 && !this.heartbeatTimer) this.heartbeatTimer = setInterval(() => { void this.heartbeat() }, this.heartbeatMs)
    await this.exclusive('Opening your notebook…', async () => {
      let res: ApiData
      try { res = await this.api('ink_list_canvases', {}) }
      catch (error) { this.setStatus('unavailable', `Notebook server unavailable: ${errorText(error)}. Check that NOVA Ink's server is running, then reopen.`); return }
      if (!res.ok || !res.canvases?.length) { this.setStatus('unavailable', res.message ?? 'The notebook library could not be read.'); return }
      this.set({ library: res.canvases, notice: res.notice?.message ?? null })
      await this.openInternal(res.lastOpenedId ?? res.canvases[0].id)
    })
  }

  async refreshLibrary(): Promise<void> {
    try {
      const res = await this.api('ink_list_canvases', {})
      if (res.ok && res.canvases) this.set({ library: res.canvases, ...(res.notice ? { notice: res.notice.message } : {}) })
    } catch { /* the library list is advisory; the open canvas is unaffected */ }
  }

  dismissNotice() { this.set({ notice: null }) }

  /** Opens a canvas. Refuses to leave a canvas whose changes are not saved. */
  openCanvas(id: string): Promise<boolean> {
    return this.exclusive('Opening canvas…', async () => {
      if (this.state.canvas?.id === id && !this.state.recovery) return true
      if (!await this.ensureSafeToLeave('switch canvases')) return false
      return this.openInternal(id)
    })
  }

  private async ensureSafeToLeave(action: string): Promise<boolean> {
    if (this.dirty && this.state.editable && this.state.status !== 'conflict') await this.flush()
    if (!this.dirty) return true
    this.set({ message: `Can't ${action} yet: this canvas has changes that aren't saved. ${this.state.status === 'conflict' ? 'Save your version as a new canvas first.' : 'Wait for Saved, or save your version as a new canvas.'}` })
    return false
  }

  private async releaseCurrent() {
    const canvas = this.state.canvas
    if (!canvas || !this.state.editable) return
    try { await this.api('ink_release_editor', { canvasId: canvas.id, clientId: this.clientId }) } catch { /* the lease expires on its own */ }
  }

  private async openInternal(id: string, takeOver = false): Promise<boolean> {
    const previous = this.state.canvas
    if (previous && previous.id !== id) await this.releaseCurrent()
    let res: ApiData
    try { res = await this.api('ink_open_canvas', { canvasId: id, clientId: this.clientId, ...(takeOver ? { takeOver: true } : {}) }) }
    catch (error) {
      this.set({ message: `Couldn't open that canvas: ${errorText(error)}. You're still on the previous canvas.` })
      return false
    }
    if (!res.ok && (res.code === 'CORRUPT_RECORD' || res.code === 'MISSING_RECORD') && res.canvas) {
      this.enterRecovery(res.canvas, res.code)
      return false
    }
    if (!res.ok || !res.canvas || !Number.isSafeInteger(res.revision)) {
      this.set({ message: `Couldn't open that canvas: ${res.message ?? res.code ?? 'unknown error'}.` })
      return false
    }
    if (res.snapshot) {
      const reason = this.validate(res.snapshot)
      if (reason) {
        if (!res.readOnly) { try { await this.api('ink_release_editor', { canvasId: res.canvas.id, clientId: this.clientId }) } catch { /* expires */ } }
        this.enterRecovery(res.canvas, 'INCOMPATIBLE', reason, res.revision)
        return false
      }
    }
    this.loadCanvas(res.canvas, res.revision!, res.snapshot ?? null, !res.readOnly)
    return true
  }

  private loadCanvas(canvas: CanvasMeta, revision: number, snapshot: unknown, editable: boolean) {
    this.clearTimers()
    this.generation++
    this.dirty = false
    this.unconfirmed.clear()
    this.retryAttempt = 0
    this.editor = null
    this.editorKey = null
    this.set({ canvas, revision, editable, mount: { key: this.newId(), snapshot }, conflict: null, recovery: null, offline: false })
    if (editable) this.setStatus('saved', `Opened “${canvas.name}” (saved version ${revision}).`)
    else this.setStatus('readOnly', 'Another device is editing this canvas. You are viewing the last saved version.')
  }

  private enterRecovery(canvas: CanvasMeta, kind: RecoveryKind, reason?: string, revision = 0) {
    this.clearTimers()
    this.generation++
    this.dirty = false
    this.unconfirmed.clear()
    this.editor = null
    this.editorKey = null
    const message = kind === 'CORRUPT_RECORD'
      ? `The saved file for “${canvas.name}” is damaged. Restore a backup below; the damaged file will be kept.`
      : kind === 'MISSING_RECORD'
        ? `The saved file for “${canvas.name}” is missing. Restore a backup below.`
        : `“${canvas.name}” could not be loaded by this version of NOVA Ink (${reason}). Nothing was changed. Update NOVA Ink, or restore an older backup.`
    this.set({ canvas, revision, editable: false, mount: null, conflict: null, recovery: { canvas, kind } })
    this.setStatus('recovery', message)
  }

  createCanvas(name: string): Promise<boolean> {
    return this.exclusive('Creating canvas…', async () => {
      if (!await this.ensureSafeToLeave('create a canvas')) return false
      let res: ApiData
      try { res = await this.api('ink_create_canvas', { name }) }
      catch (error) { this.set({ message: `Couldn't create the canvas: ${errorText(error)}.` }); return false }
      if (!res.ok || !res.canvas) { this.set({ message: res.message ?? 'Couldn\'t create the canvas.' }); return false }
      await this.refreshLibrary()
      return this.openInternal(res.canvas.id)
    })
  }

  // ---- conflict, lease and recovery actions ------------------------------

  /** Reloads the server version or re-requests editing without ever discarding unsaved local changes. */
  reconnect({ takeOver = false } = {}): Promise<boolean> {
    return this.exclusive(takeOver ? 'Taking over editing…' : 'Checking the server version…', async () => {
      const canvas = this.state.canvas
      if (!canvas || this.state.recovery) return false
      let res: ApiData
      try { res = await this.api('ink_open_canvas', { canvasId: canvas.id, clientId: this.clientId, ...(takeOver ? { takeOver: true } : {}) }) }
      catch (error) { this.set({ message: `Couldn't reach the server: ${errorText(error)}.`, offline: true }); return false }
      if (!res.ok && (res.code === 'CORRUPT_RECORD' || res.code === 'MISSING_RECORD') && res.canvas) {
        if (this.dirty) { this.setStatus('conflict', 'The saved copy of this canvas is damaged or missing. Save your version as a new canvas to keep it.', { conflict: 'damaged' }); return false }
        this.enterRecovery(res.canvas, res.code)
        return false
      }
      if (!res.ok || !Number.isSafeInteger(res.revision)) { this.set({ message: res.message ?? 'Couldn\'t refresh this canvas.' }); return false }
      if (!this.dirty) {
        const reason = res.snapshot ? this.validate(res.snapshot) : null
        if (reason) { this.enterRecovery(res.canvas ?? canvas, 'INCOMPATIBLE', reason, res.revision); return false }
        this.loadCanvas(res.canvas ?? canvas, res.revision!, res.snapshot ?? null, !res.readOnly)
        return true
      }
      // Local changes exist: keep them on screen and only try to commit them.
      if (res.revision !== this.state.revision) {
        this.setStatus('conflict', 'The server has a newer version from another device. Save your version as a new canvas to keep your changes.', { conflict: 'revision', editable: !res.readOnly })
        return false
      }
      if (res.readOnly) {
        this.setStatus('conflict', 'Another device still has editing control. Your changes are kept here; save them as a new canvas, or take over editing.', { conflict: 'lease', editable: false })
        return false
      }
      this.set({ editable: true, conflict: null })
      this.setStatus('unsaved', 'Editing control regained. Saving your changes…')
      return this.flush()
    })
  }

  /** Preserves the local canvas as a new canvas. The editor stays mounted; nothing local is discarded. */
  saveAsNewCanvas(name?: string): Promise<boolean> {
    return this.exclusive('Saving your version as a new canvas…', async () => {
      const original = this.state.canvas
      if (!original || !this.editor) return false
      const snapshot = this.editor.getSnapshot()
      const bytes = this.measure(snapshot)
      if (bytes > this.maxBytes) {
        this.set({ message: `This canvas is ${(bytes / MB).toFixed(1)} MB, over the ${(this.maxBytes / MB).toFixed(0)} MB limit, so it can't be saved as a copy either. Delete or shrink large images first.` })
        return false
      }
      const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const fullName = (name?.trim() || `${original.name} (my version ${stamp})`).slice(0, 80)
      const saveId = this.newId()
      let res: ApiData | null = null
      for (let attempt = 0; attempt < 2 && !res; attempt++) {
        try { res = await this.api('ink_save_as_new_canvas', { name: fullName, clientId: this.clientId, saveId, snapshot }) }
        catch (error) { if (attempt === 1) { this.set({ message: `Couldn't save a copy: ${errorText(error)}. Your changes are still on this device; try again.` }); return false } }
      }
      if (!res?.ok || !res.canvas || !Number.isSafeInteger(res.revision)) {
        this.set({ message: `Couldn't save a copy: ${res?.message ?? 'unknown error'}. Your changes are still on this device.` })
        return false
      }
      if (this.state.editable && this.state.conflict !== 'lease') {
        try { await this.api('ink_release_editor', { canvasId: original.id, clientId: this.clientId }) } catch { /* expires */ }
      }
      this.clearTimers()
      this.generation++
      this.dirty = false
      this.unconfirmed.clear()
      this.set({ canvas: res.canvas, revision: res.revision!, editable: !res.readOnly, conflict: null, recovery: null, offline: false })
      this.setStatus('saved', `Your version was saved as “${res.canvas.name}”. “${original.name}” was left unchanged.`)
      await this.refreshLibrary()
      return true
    })
  }

  /** Explicitly drops local changes and shows the server version. Callers must confirm with the user. */
  discardAndReload(): Promise<boolean> {
    return this.exclusive('Loading the server version…', async () => {
      const canvas = this.state.canvas
      if (!canvas) return false
      const dirty = this.dirty
      this.dirty = false
      const opened = await this.openInternal(canvas.id)
      if (!opened && !this.state.recovery) { this.dirty = dirty; this.set({}) }
      return opened
    })
  }

  release(): Promise<boolean> {
    return this.exclusive('Releasing editing…', async () => {
      const canvas = this.state.canvas
      if (!canvas || !this.state.editable) return false
      if (!await this.ensureSafeToLeave('release editing')) return false
      try {
        const res = await this.api('ink_release_editor', { canvasId: canvas.id, clientId: this.clientId })
        if (!res.ok) throw new Error(res.message ?? res.code)
      } catch (error) { this.set({ message: `Couldn't release editing: ${errorText(error)}.` }); return false }
      this.set({ editable: false })
      this.setStatus('readOnly', 'Editing released. Another device can take control; tap Request editing to continue here.')
      return true
    })
  }

  async listBackups(): Promise<Array<{ revision: number; savedAt?: string }>> {
    const canvas = this.state.recovery?.canvas ?? this.state.canvas
    if (!canvas) return []
    const res = await this.api('ink_list_backups', { canvasId: canvas.id })
    if (!res.ok) throw new Error(res.message ?? res.code ?? 'Could not list backups')
    return res.backups ?? []
  }

  restoreBackup(backupRevision: number): Promise<boolean> {
    return this.exclusive(`Restoring saved version ${backupRevision}…`, async () => {
      const recovering = this.state.recovery
      const canvas = recovering?.canvas ?? this.state.canvas
      if (!canvas) return false
      if (!recovering && !await this.ensureSafeToLeave('restore a backup')) return false
      const expectedCurrentRevision = recovering && recovering.kind !== 'INCOMPATIBLE' ? null : this.state.revision
      let res: ApiData
      try { res = await this.api('ink_restore_backup', { canvasId: canvas.id, clientId: this.clientId, backupRevision, expectedCurrentRevision }) }
      catch (error) { this.set({ message: `Restore failed: ${errorText(error)}. Nothing was changed.` }); return false }
      if (!res.ok) { this.set({ message: `Restore failed: ${res.message ?? res.code}.` }); return false }
      this.dirty = false
      const opened = await this.openInternal(canvas.id)
      if (opened) this.set({ message: `Restored saved version ${backupRevision} as new version ${res.revision}.${res.recoveryCopyPreserved ? ' The damaged file was kept in the recovery folder.' : ''}` })
      return opened
    })
  }

  startFresh(): Promise<boolean> {
    return this.exclusive('Starting the canvas over…', async () => {
      const recovering = this.state.recovery
      if (!recovering || recovering.kind === 'INCOMPATIBLE') return false
      let res: ApiData
      try { res = await this.api('ink_start_canvas_fresh', { canvasId: recovering.canvas.id, clientId: this.clientId }) }
      catch (error) { this.set({ message: `Couldn't start over: ${errorText(error)}.` }); return false }
      if (!res.ok) { this.set({ message: res.message ?? 'Couldn\'t start over.' }); return false }
      return this.openInternal(recovering.canvas.id)
    })
  }

  // ---- background lifecycle ---------------------------------------------

  async heartbeat(): Promise<void> {
    const canvas = this.state.canvas
    if (!canvas || !this.state.editable || this.state.busy || this.state.recovery) return
    const generation = this.generation
    let res: ApiData
    try { res = await this.api('ink_heartbeat', { canvasId: canvas.id, clientId: this.clientId }) }
    catch { if (generation === this.generation) this.set({ offline: true }); return }
    if (generation !== this.generation || !this.state.editable) return
    this.set({ offline: false })
    if (!res.ok || !res.readOnly) return
    this.set({ editable: false })
    if (this.dirty) this.setStatus('conflict', 'Another device took over editing before your latest changes were saved. Save your version as a new canvas to keep them.', { conflict: 'lease' })
    else this.setStatus('readOnly', 'Another device took over editing. Tap Refresh to see its latest version.')
  }

  /** The page was hidden (app switch, iPad sleep). Save immediately rather than waiting for the debounce. */
  onHidden() { if (this.dirty && this.state.editable) void this.save() }

  onVisible() {
    void this.heartbeat()
    if (this.dirty && this.state.editable && this.state.status !== 'conflict') void this.save()
  }

  /** Stops timers without saving or releasing. */
  dispose() {
    this.disposed = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.clearTimers()
  }

  /** Best effort: the host may not wait for this to finish. */
  async teardown(): Promise<void> {
    this.disposed = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    const saved = this.dirty ? await this.save() : true
    this.clearTimers()
    if (saved) await this.exclusive(null, () => this.releaseCurrent())
  }
}
