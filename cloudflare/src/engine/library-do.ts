/**
 * NotebookLibraryDO: one per user ("engine-library:<userId>"). Notebooks and their ordered pages; the page
 * strokes live in PageDO objects. It is also the ownership check: a page id that is not in this user's
 * library is NOT_FOUND, so the MCP layer never touches a page object it did not create for this user.
 *
 * Nothing is destroyed: removing a notebook or page sets deleted_at (the trash), and restoring clears it.
 * Page order uses the engine's z-order keys, so a move rewrites one row.
 */
import { DurableObject } from 'cloudflare:workers'
import { keyBetween } from '../../../engine/src/core/order'

export type PageMeta = { id: string; notebookId: string; title: string; createdAt: string; updatedAt: string; revision: number; deletedAt: string | null }
/** `editedAt`: the latest change to the notebook or any of its pages. `folderId` and `color` are null for older notebooks. */
export type NotebookMeta = { id: string; name: string; folderId: string | null; color: string | null; createdAt: string; updatedAt: string; editedAt: string; deletedAt: string | null; pages: PageMeta[] }
export type FolderMeta = { id: string; name: string; createdAt: string; deletedAt: string | null }
type Result = { ok: boolean; code?: string; message?: string; [key: string]: unknown }

const isUuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const clean = (name: unknown, max = 80) => typeof name === 'string' ? name.trim().slice(0, max) : ''
const fail = (code: string, message: string): Result => ({ ok: false, code, message })
const missing = () => fail('NOT_FOUND', 'That notebook, folder or page was not found.')
const COLOR = /^#[0-9a-f]{6}$/

/** Pictures are stored in pieces small enough for one tool call each. */
export const IMAGE_CHUNK_BYTES = 192 * 1024
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_SOURCE_BYTES = 24 * 1024 * 1024
const MAX_PENDING_JOBS = 20
const MAX_IMAGE_PIXELS_SIDE = 8192
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp']
const IMAGE_REF = /^[A-Za-z0-9_-]{1,64}$/
type ImageRow = { id: string; mime: string; width: number; height: number; bytes: number; count: number; complete: number; created_at: string }

function hasSignature(b: Uint8Array, mime: string): boolean {
  const ascii = (from: number, text: string) => [...text].every((c, i) => b[from + i] === c.charCodeAt(0))
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (mime === 'image/png') return b[0] === 0x89 && ascii(1, 'PNG')
  return ascii(0, 'RIFF') && ascii(8, 'WEBP')
}
function fromBase64(text: unknown): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('base64')
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
function toBase64(bytes: Uint8Array): string {
  let raw = ''
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(raw)
}

type NotebookRow = { id: string; name: string; sort_key: string; created_at: string; updated_at: string; deleted_at: string | null; folder_id: string | null; color: string | null }
type FolderRow = { id: string; name: string; sort_key: string; created_at: string; deleted_at: string | null }
type PageRow = { id: string; notebook_id: string; title: string; sort_key: string; created_at: string; updated_at: string; revision: number; deleted_at: string | null }

const toPage = (r: PageRow): PageMeta => ({ id: r.id, notebookId: r.notebook_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, revision: r.revision, deletedAt: r.deleted_at })

export class NotebookLibraryDO extends DurableObject {
  clock: () => number = () => Date.now()
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => this.ensureSchema())
  }

  /** Creates missing tables and columns; never changes existing rows. */
  ensureSchema() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, title TEXT NOT NULL, sort_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, deleted_at TEXT) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_key TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, count INTEGER NOT NULL, complete INTEGER NOT NULL, created_at TEXT NOT NULL) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_chunks (id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx)) WITHOUT ROWID')
    // NOVA's canvas work (all additive): original source documents, jobs the open notebook runs for them, and request memory.
    this.sql.exec('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, count INTEGER NOT NULL, pages INTEGER, complete INTEGER NOT NULL, created_at TEXT NOT NULL) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS source_chunks (id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx)) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT) WITHOUT ROWID')
    this.sql.exec('CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL) WITHOUT ROWID')
    // Added after the first deployment: nullable, so existing notebooks read as "no folder, default color".
    const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(notebooks)').toArray().map(c => c.name))
    if (!columns.has('folder_id')) this.sql.exec('ALTER TABLE notebooks ADD COLUMN folder_id TEXT')
    if (!columns.has('color')) this.sql.exec('ALTER TABLE notebooks ADD COLUMN color TEXT')
    const imageColumns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(images)').toArray().map(c => c.name))
    if (!imageColumns.has('meta')) this.sql.exec('ALTER TABLE images ADD COLUMN meta TEXT')
  }

  private folderRows() { return this.sql.exec<FolderRow>('SELECT * FROM folders ORDER BY sort_key, id').toArray() }
  private folderRow(id: string) { return this.sql.exec<FolderRow>('SELECT * FROM folders WHERE id = ?', id).toArray()[0] ?? null }
  /** A live folder id, null for "no folder", or undefined when the given id is not a live folder. */
  private liveFolder(id: unknown): string | null | undefined {
    if (id === null || id === undefined) return null
    const row = isUuid(id) ? this.folderRow(id) : null
    return row && !row.deleted_at ? row.id : undefined
  }

  private iso() { return new Date(this.clock()).toISOString() }
  private notebookRows() { return this.sql.exec<NotebookRow>('SELECT * FROM notebooks ORDER BY sort_key, id').toArray() }
  private pageRows(notebookId: string) { return this.sql.exec<PageRow>('SELECT * FROM pages WHERE notebook_id = ? ORDER BY sort_key, id', notebookId).toArray() }
  private notebookRow(id: string) { return this.sql.exec<NotebookRow>('SELECT * FROM notebooks WHERE id = ?', id).toArray()[0] ?? null }
  private pageRow(id: string) { return this.sql.exec<PageRow>('SELECT * FROM pages WHERE id = ?', id).toArray()[0] ?? null }
  private setKv(key: string, value: string) { this.sql.exec('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value) }
  private kv(key: string) { return this.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key).toArray()[0]?.value ?? null }

  private insertNotebook(name: string, folderId: string | null = null, color: string | null = null): string {
    const rows = this.notebookRows()
    const id = crypto.randomUUID(), t = this.iso()
    this.sql.exec('INSERT INTO notebooks (id, name, sort_key, created_at, updated_at, deleted_at, folder_id, color) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
      id, name, keyBetween(rows.at(-1)?.sort_key ?? null, null), t, t, folderId, color)
    return id
  }

  /** Inserts a page after `afterId` (or at the end). Returns its id and the page it follows, if any. */
  private insertPage(notebookId: string, title: string | null, afterId?: string | null): { id: string; previousId: string | null } {
    const live = this.pageRows(notebookId).filter(p => !p.deleted_at)
    const all = this.pageRows(notebookId)
    const at = afterId ? all.findIndex(p => p.id === afterId) : all.length - 1
    const before = at >= 0 ? all[at] : null
    const after = at + 1 < all.length ? all[at + 1] : null
    const id = crypto.randomUUID(), t = this.iso()
    const name = title || `Page ${live.length + 1}`
    this.sql.exec('INSERT INTO pages (id, notebook_id, title, sort_key, created_at, updated_at, revision, deleted_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)',
      id, notebookId, name, keyBetween(before?.sort_key ?? null, after?.sort_key ?? null), t, t)
    this.sql.exec('UPDATE notebooks SET updated_at = ? WHERE id = ?', t, notebookId)
    const previous = afterId ? before : live.at(-1) ?? null
    return { id, previousId: previous && !previous.deleted_at ? previous.id : null }
  }

  /** Everything the notebook picker needs. A brand-new library gets one notebook with one page. */
  list(): Result {
    let notebooks = this.notebookRows()
    if (!notebooks.length) {
      const id = this.insertNotebook('My Notebook')
      const page = this.insertPage(id, 'Page 1')
      this.setKv('last', JSON.stringify({ notebookId: id, pageId: page.id }))
      notebooks = this.notebookRows()
    }
    const out: NotebookMeta[] = notebooks.map(n => {
      const pages = this.pageRows(n.id).map(toPage)
      const editedAt = pages.reduce((latest, p) => p.updatedAt > latest ? p.updatedAt : latest, n.updated_at)
      return { id: n.id, name: n.name, folderId: n.folder_id, color: n.color, createdAt: n.created_at, updatedAt: n.updated_at, editedAt, deletedAt: n.deleted_at, pages }
    })
    const folders: FolderMeta[] = this.folderRows().map(f => ({ id: f.id, name: f.name, createdAt: f.created_at, deletedAt: f.deleted_at }))
    let last: { notebookId?: string; pageId?: string } = {}
    try { last = JSON.parse(this.kv('last') ?? '{}') } catch { /* fall back below */ }
    const liveBook = (id?: string) => out.find(n => n.id === id && !n.deletedAt)
    const book = liveBook(last.notebookId) ?? out.find(n => !n.deletedAt && n.pages.some(p => !p.deletedAt)) ?? out.find(n => !n.deletedAt) ?? null
    const page = book?.pages.find(p => p.id === last.pageId && !p.deletedAt) ?? book?.pages.find(p => !p.deletedAt) ?? null
    return { ok: true, folders, notebooks: out, last: { notebookId: book?.id ?? null, pageId: page?.id ?? null } }
  }

  /** Ownership and state of one page. */
  getPage(id: string): PageMeta | null {
    const row = isUuid(id) ? this.pageRow(id) : null
    if (!row) return null
    const book = this.notebookRow(row.notebook_id)
    const page = toPage(row)
    return book?.deleted_at && !page.deletedAt ? { ...page, deletedAt: book.deleted_at } : page
  }

  createNotebook(req: { name: string; folderId?: string | null; color?: string | null }): Result {
    const name = clean(req?.name)
    if (!name) return fail('INVALID_NAME', 'Enter a notebook name.')
    const folderId = this.liveFolder(req.folderId)
    if (folderId === undefined) return missing()
    if (req.color != null && !COLOR.test(req.color)) return fail('INVALID_COLOR', 'Choose a cover color.')
    const id = this.insertNotebook(name, folderId, req.color ?? null)
    const page = this.insertPage(id, 'Page 1')
    this.setKv('last', JSON.stringify({ notebookId: id, pageId: page.id }))
    return { ok: true, notebookId: id, pageId: page.id }
  }

  renameNotebook(req: { notebookId: string; name: string }): Result {
    const name = clean(req?.name)
    if (!name) return fail('INVALID_NAME', 'Enter a notebook name.')
    if (!isUuid(req.notebookId) || !this.notebookRow(req.notebookId)) return missing()
    this.sql.exec('UPDATE notebooks SET name = ?, updated_at = ? WHERE id = ?', name, this.iso(), req.notebookId)
    return { ok: true }
  }

  /** Changes a notebook's folder (null = top level) and/or cover color; fields left out stay as they are. */
  updateNotebook(req: { notebookId: string; folderId?: string | null; color?: string | null }): Result {
    const row = isUuid(req?.notebookId) ? this.notebookRow(req.notebookId) : null
    if (!row) return missing()
    let folderId = row.folder_id, color = row.color
    if ('folderId' in req) {
      const target = this.liveFolder(req.folderId)
      if (target === undefined) return missing()
      folderId = target
    }
    if ('color' in req) {
      if (req.color != null && !COLOR.test(req.color)) return fail('INVALID_COLOR', 'Choose a cover color.')
      color = req.color ?? null
    }
    this.sql.exec('UPDATE notebooks SET folder_id = ?, color = ?, updated_at = ? WHERE id = ?', folderId, color, this.iso(), row.id)
    return { ok: true }
  }

  createFolder(req: { name: string }): Result {
    const name = clean(req?.name)
    if (!name) return fail('INVALID_NAME', 'Enter a folder name.')
    const id = crypto.randomUUID()
    this.sql.exec('INSERT INTO folders (id, name, sort_key, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)', id, name, keyBetween(this.folderRows().at(-1)?.sort_key ?? null, null), this.iso())
    return { ok: true, folderId: id }
  }

  renameFolder(req: { folderId: string; name: string }): Result {
    const name = clean(req?.name)
    if (!name) return fail('INVALID_NAME', 'Enter a folder name.')
    if (!isUuid(req.folderId) || !this.folderRow(req.folderId)) return missing()
    this.sql.exec('UPDATE folders SET name = ? WHERE id = ?', name, req.folderId)
    return { ok: true }
  }

  /** Moves a folder to the trash. Its notebooks move to the top level, so nothing disappears with it. */
  removeFolder(req: { folderId: string }): Result {
    const row = isUuid(req?.folderId) ? this.folderRow(req.folderId) : null
    if (!row) return missing()
    const t = this.iso()
    this.sql.exec('UPDATE notebooks SET folder_id = NULL, updated_at = ? WHERE folder_id = ?', t, row.id)
    if (!row.deleted_at) this.sql.exec('UPDATE folders SET deleted_at = ? WHERE id = ?', t, row.id)
    return { ok: true }
  }

  restoreFolder(req: { folderId: string }): Result {
    const row = isUuid(req?.folderId) ? this.folderRow(req.folderId) : null
    if (!row) return missing()
    this.sql.exec('UPDATE folders SET deleted_at = NULL WHERE id = ?', row.id)
    return { ok: true }
  }

  /** Moves a notebook to the trash (its pages stay with it). Refused for the last notebook outside the trash. */
  removeNotebook(req: { notebookId: string }): Result {
    const row = isUuid(req?.notebookId) ? this.notebookRow(req.notebookId) : null
    if (!row) return missing()
    if (row.deleted_at) return { ok: true }
    if (this.notebookRows().filter(n => !n.deleted_at).length <= 1) return fail('LAST_NOTEBOOK', 'Keep at least one notebook. Create another before removing this one.')
    this.sql.exec('UPDATE notebooks SET deleted_at = ? WHERE id = ?', this.iso(), row.id)
    return { ok: true }
  }

  restoreNotebook(req: { notebookId: string }): Result {
    const row = isUuid(req?.notebookId) ? this.notebookRow(req.notebookId) : null
    if (!row) return missing()
    this.sql.exec('UPDATE notebooks SET deleted_at = NULL, updated_at = ? WHERE id = ?', this.iso(), row.id)
    return { ok: true }
  }

  addPage(req: { notebookId: string; afterPageId?: string | null; title?: string }): Result {
    const book = isUuid(req?.notebookId) ? this.notebookRow(req.notebookId) : null
    if (!book || book.deleted_at) return missing()
    if (req.afterPageId && this.pageRow(req.afterPageId)?.notebook_id !== book.id) return missing()
    const page = this.insertPage(book.id, clean(req.title) || null, req.afterPageId ?? null)
    this.setKv('last', JSON.stringify({ notebookId: book.id, pageId: page.id }))
    return { ok: true, pageId: page.id, previousPageId: page.previousId }
  }

  renamePage(req: { pageId: string; title: string }): Result {
    const title = clean(req?.title)
    if (!title) return fail('INVALID_NAME', 'Enter a page name.')
    if (!this.getPage(req.pageId)) return missing()
    this.sql.exec('UPDATE pages SET title = ?, updated_at = ? WHERE id = ?', title, this.iso(), req.pageId)
    return { ok: true }
  }

  /** Moves a page to just after `afterPageId` (null = first) in `notebookId` (default: its own notebook). */
  movePage(req: { pageId: string; afterPageId: string | null; notebookId?: string }): Result {
    const page = this.getPage(req?.pageId)
    if (!page) return missing()
    const target = req.notebookId ?? page.notebookId
    const book = isUuid(target) ? this.notebookRow(target) : null
    if (!book || book.deleted_at) return missing()
    const others = this.pageRows(book.id).filter(p => p.id !== page.id)
    const at = req.afterPageId ? others.findIndex(p => p.id === req.afterPageId) : -1
    if (req.afterPageId && at < 0) return missing()
    const key = keyBetween(at >= 0 ? others[at].sort_key : null, others[at + 1]?.sort_key ?? null)
    this.sql.exec('UPDATE pages SET notebook_id = ?, sort_key = ?, updated_at = ? WHERE id = ?', book.id, key, this.iso(), page.id)
    return { ok: true }
  }

  removePage(req: { pageId: string }): Result {
    const page = this.getPage(req?.pageId)
    if (!page) return missing()
    if (!page.deletedAt) this.sql.exec('UPDATE pages SET deleted_at = ? WHERE id = ?', this.iso(), page.id)
    return { ok: true }
  }

  restorePage(req: { pageId: string }): Result {
    const row = isUuid(req?.pageId) ? this.pageRow(req.pageId) : null
    if (!row) return missing()
    this.sql.exec('UPDATE pages SET deleted_at = NULL, updated_at = ? WHERE id = ?', this.iso(), row.id)
    const book = this.notebookRow(row.notebook_id)
    if (book?.deleted_at) this.sql.exec('UPDATE notebooks SET deleted_at = NULL WHERE id = ?', book.id)
    return { ok: true }
  }

  /** Records the latest revision (the "was this page ever saved" marker). Callers debounce. */
  // ---- pictures (image placements on pages refer to these by id) ----

  /**
   * Stores one piece of a picture. Pieces may arrive in any order and be re-sent; the picture is usable
   * once every piece is stored and the total matches. A complete picture is never changed.
   */
  putImageChunk(req: { imageId: string; mime: string; width: number; height: number; bytes: number; count: number; index: number; data: string }): Result {
    const { imageId, mime, width, height, bytes, count, index } = req ?? ({} as never)
    if (!IMAGE_REF.test(imageId ?? '')) return fail('INVALID_REQUEST', 'Invalid picture id.')
    if (!IMAGE_MIME.includes(mime)) return fail('INVALID_IMAGE', 'Only JPEG, PNG and WebP pictures can be stored.')
    if (![width, height, bytes, count, index].every(Number.isSafeInteger) || width < 1 || height < 1 || width > MAX_IMAGE_PIXELS_SIDE || height > MAX_IMAGE_PIXELS_SIDE
      || bytes < 1 || bytes > MAX_IMAGE_BYTES || count < 1 || count !== Math.ceil(bytes / IMAGE_CHUNK_BYTES) || index < 0 || index >= count) return fail('INVALID_REQUEST', 'Invalid picture size or piece number.')
    let chunk: Uint8Array
    try { chunk = fromBase64(req.data) } catch { return fail('INVALID_REQUEST', 'The picture data is not valid base64.') }
    const expected = index < count - 1 ? IMAGE_CHUNK_BYTES : bytes - IMAGE_CHUNK_BYTES * (count - 1)
    if (chunk.length !== expected) return fail('INVALID_REQUEST', `Picture piece ${index + 1} has ${chunk.length} bytes; expected ${expected}.`)
    if (index === 0 && !hasSignature(chunk, mime)) return fail('INVALID_IMAGE', 'The picture data does not match its type.')

    const existing = this.imageRow(imageId)
    if (existing && (existing.mime !== mime || existing.width !== width || existing.height !== height || existing.bytes !== bytes || existing.count !== count)) {
      return fail('INVALID_REQUEST', 'This picture id is already used by a different picture.')
    }
    if (existing?.complete) return { ok: true, complete: true }
    this.ctx.storage.transactionSync(() => {
      if (!existing) this.sql.exec('INSERT INTO images (id, mime, width, height, bytes, count, complete, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', imageId, mime, width, height, bytes, count, this.iso())
      this.sql.exec('INSERT OR REPLACE INTO image_chunks (id, idx, data) VALUES (?, ?, ?)', imageId, index, chunk.buffer as ArrayBuffer)
    })
    const stored = this.sql.exec<{ n: number; total: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS total FROM image_chunks WHERE id = ?', imageId).one()
    const complete = stored.n === count && stored.total === bytes
    if (complete) this.sql.exec('UPDATE images SET complete = 1 WHERE id = ?', imageId)
    return { ok: true, complete, stored: stored.n }
  }

  getImageChunk(req: { imageId: string; index: number }): Result {
    const row = IMAGE_REF.test(req?.imageId ?? '') ? this.imageRow(req.imageId) : null
    if (!row?.complete) return fail('NOT_FOUND', 'That picture was not found.')
    if (!Number.isSafeInteger(req.index) || req.index < 0 || req.index >= row.count) return fail('INVALID_REQUEST', 'Invalid picture piece number.')
    const chunk = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM image_chunks WHERE id = ? AND idx = ?', row.id, req.index).toArray()[0]
    if (!chunk) return fail('CORRUPT_RECORD', 'A piece of this picture is missing.')
    return { ok: true, mime: row.mime, width: row.width, height: row.height, bytes: row.bytes, count: row.count, index: req.index, data: toBase64(new Uint8Array(chunk.data)) }
  }

  /** Ids among `ids` that are not complete pictures of this library. */
  missingImages(ids: string[]): string[] {
    return [...new Set(ids)].filter(id => !IMAGE_REF.test(id) || !this.imageRow(id)?.complete)
  }

  // ---- provenance: where a placed picture came from (document, page, crop) ----

  /** Records provenance once for a complete picture; it is never rewritten. */
  setImageMeta(req: { imageId: string; meta: Record<string, unknown> }): Result {
    const row = IMAGE_REF.test(req?.imageId ?? '') ? this.imageRow(req.imageId) : null
    if (!row?.complete) return fail('NOT_FOUND', 'That picture was not found.')
    const m = req.meta as Record<string, any>
    const crop = m?.crop
    if (!m || typeof m !== 'object' || !IMAGE_REF.test(String(m.sourceId ?? '')) || !Number.isSafeInteger(m.page) || m.page < 1
      || (crop !== undefined && !(crop && ['x', 'y', 'w', 'h'].every(k => typeof crop[k] === 'number' && crop[k] >= 0 && crop[k] <= 1)))) return fail('INVALID_REQUEST', 'Invalid picture source details.')
    const meta = { sourceId: m.sourceId, sourceName: String(m.sourceName ?? '').slice(0, 120), page: m.page, ...(crop ? { crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } } : {}) }
    this.sql.exec('UPDATE images SET meta = ? WHERE id = ? AND meta IS NULL', JSON.stringify(meta), row.id)
    return { ok: true }
  }

  imageMetas(ids: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const id of [...new Set(ids)].filter(i => IMAGE_REF.test(i)).slice(0, 200)) {
      const raw = this.sql.exec<{ meta: string | null }>('SELECT meta FROM images WHERE id = ?', id).toArray()[0]?.meta
      if (raw) { try { out[id] = JSON.parse(raw) } catch { /* ignore */ } }
    }
    return out
  }

  // ---- source documents (the original file, kept as uploaded) ----

  putSourceChunk(req: { sourceId: string; name: string; bytes: number; count: number; index: number; data: string; pages?: number }): Result {
    const { sourceId, bytes, count, index } = req ?? ({} as never)
    if (!IMAGE_REF.test(sourceId ?? '')) return fail('INVALID_REQUEST', 'Invalid document id.')
    if (![bytes, count, index].every(Number.isSafeInteger) || bytes < 8 || bytes > MAX_SOURCE_BYTES || count < 1 || count !== Math.ceil(bytes / IMAGE_CHUNK_BYTES) || index < 0 || index >= count) return fail('INVALID_REQUEST', 'Invalid document size or piece number.')
    let chunk: Uint8Array
    try { chunk = fromBase64(req.data) } catch { return fail('INVALID_REQUEST', 'The document data is not valid base64.') }
    const expected = index < count - 1 ? IMAGE_CHUNK_BYTES : bytes - IMAGE_CHUNK_BYTES * (count - 1)
    if (chunk.length !== expected) return fail('INVALID_REQUEST', `Document piece ${index + 1} has ${chunk.length} bytes; expected ${expected}.`)
    if (index === 0 && ![...'%PDF-'].every((c, i) => chunk[i] === c.charCodeAt(0))) return fail('INVALID_DOCUMENT', 'Only PDF documents can be stored as sources.')
    const existing = this.sql.exec<{ bytes: number; count: number; complete: number }>('SELECT bytes, count, complete FROM sources WHERE id = ?', sourceId).toArray()[0]
    if (existing && (existing.bytes !== bytes || existing.count !== count)) return fail('INVALID_REQUEST', 'This document id is already used by a different document.')
    if (existing?.complete) return { ok: true, complete: true }
    const name = clean(req.name, 120) || 'Document.pdf'
    const pages = Number.isSafeInteger(req.pages) && req.pages! > 0 && req.pages! < 5000 ? req.pages! : null
    this.ctx.storage.transactionSync(() => {
      if (!existing) this.sql.exec('INSERT INTO sources (id, name, mime, bytes, count, pages, complete, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', sourceId, name, 'application/pdf', bytes, count, pages, this.iso())
      else if (pages) this.sql.exec('UPDATE sources SET pages = ? WHERE id = ?', pages, sourceId)
      this.sql.exec('INSERT OR REPLACE INTO source_chunks (id, idx, data) VALUES (?, ?, ?)', sourceId, index, chunk.buffer as ArrayBuffer)
    })
    const stored = this.sql.exec<{ n: number; total: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS total FROM source_chunks WHERE id = ?', sourceId).one()
    const complete = stored.n === count && stored.total === bytes
    if (complete) this.sql.exec('UPDATE sources SET complete = 1 WHERE id = ?', sourceId)
    return { ok: true, complete, stored: stored.n }
  }

  getSourceChunk(req: { sourceId: string; index: number }): Result {
    const row = IMAGE_REF.test(req?.sourceId ?? '') ? this.sql.exec<{ id: string; count: number; bytes: number; complete: number }>('SELECT id, count, bytes, complete FROM sources WHERE id = ?', req.sourceId).toArray()[0] : null
    if (!row?.complete) return fail('NOT_FOUND', 'That document was not found.')
    if (!Number.isSafeInteger(req.index) || req.index < 0 || req.index >= row.count) return fail('INVALID_REQUEST', 'Invalid document piece number.')
    const chunk = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM source_chunks WHERE id = ? AND idx = ?', row.id, req.index).toArray()[0]
    if (!chunk) return fail('CORRUPT_RECORD', 'A piece of this document is missing.')
    return { ok: true, bytes: row.bytes, count: row.count, index: req.index, data: toBase64(new Uint8Array(chunk.data)) }
  }

  listSources(): Result {
    const sources = this.sql.exec<{ id: string; name: string; bytes: number; pages: number | null; created_at: string }>('SELECT id, name, bytes, pages, created_at FROM sources WHERE complete = 1 ORDER BY created_at DESC, id LIMIT 100').toArray()
    return { ok: true, sources: sources.map(s => ({ id: s.id, name: s.name, bytes: s.bytes, pages: s.pages, createdAt: s.created_at })) }
  }

  getSource(id: string): { id: string; name: string; pages: number | null } | null {
    const s = IMAGE_REF.test(id ?? '') ? this.sql.exec<{ id: string; name: string; pages: number | null }>('SELECT id, name, pages FROM sources WHERE id = ? AND complete = 1', id).toArray()[0] : null
    return s ?? null
  }

  // ---- jobs: work only the open notebook can do (it renders PDF pages), asked for by NOVA ----

  /** The same request id returns the same job. */
  createJob(req: { requestId: string; kind: string; params: unknown }): Result {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(req?.requestId ?? '')) return fail('INVALID_REQUEST', 'requestId must be 8 to 64 letters, digits, - or _.')
    const prior = this.sql.exec<{ id: string; status: string }>('SELECT id, status FROM jobs WHERE request_id = ?', req.requestId).toArray()[0]
    if (prior) return { ok: true, duplicate: true, jobId: prior.id, status: prior.status }
    const pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").one().n
    if (pending >= MAX_PENDING_JOBS) return fail('TOO_MANY_PENDING', 'Many requests are already waiting for the notebook to open. Open the notebook first.')
    const id = crypto.randomUUID()
    this.sql.exec('INSERT INTO jobs (id, request_id, kind, params, status, result, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', id, req.requestId, req.kind, JSON.stringify(req.params), 'pending', '{}', this.iso())
    return { ok: true, jobId: id, status: 'pending' }
  }

  pendingJobs(): Result {
    const rows = this.sql.exec<{ id: string; kind: string; params: string }>("SELECT id, kind, params FROM jobs WHERE status = 'pending' ORDER BY created_at, id LIMIT 5").toArray()
    return { ok: true, jobs: rows.map(r => ({ jobId: r.id, kind: r.kind, params: JSON.parse(r.params) })) }
  }

  getJob(id: string): { id: string; kind: string; params: any; status: string; result: any } | null {
    const r = isUuid(id) ? this.sql.exec<{ id: string; kind: string; params: string; status: string; result: string }>('SELECT id, kind, params, status, result FROM jobs WHERE id = ?', id).toArray()[0] : null
    return r ? { id: r.id, kind: r.kind, params: JSON.parse(r.params), status: r.status, result: JSON.parse(r.result) } : null
  }

  /** Moves a pending job to a final state exactly once. Returns false if it was not pending. */
  finishJob(req: { jobId: string; status: 'done' | 'failed'; result: unknown }): boolean {
    if (!isUuid(req?.jobId)) return false
    const cursor = this.sql.exec("UPDATE jobs SET status = ?, result = ?, finished_at = ? WHERE id = ? AND status = 'pending'", req.status, JSON.stringify(req.result ?? {}), this.iso(), req.jobId)
    return cursor.rowsWritten > 0
  }

  // ---- organizing, with request memory so a retry never makes a second notebook or page ----

  organize(req: { requestId: string; action: string; [key: string]: unknown }): Result {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(req?.requestId ?? ''))) return fail('INVALID_REQUEST', 'requestId must be 8 to 64 letters, digits, - or _.')
    const prior = this.sql.exec<{ result: string }>('SELECT result FROM requests WHERE request_id = ?', req.requestId).toArray()[0]
    if (prior) return { ...JSON.parse(prior.result), duplicate: true }
    let result: Result
    switch (req.action) {
      case 'create_notebook': result = this.createNotebook(req as never); break
      case 'rename_notebook': result = this.renameNotebook(req as never); break
      case 'add_page': result = this.addPage(req as never); break
      case 'rename_page': result = this.renamePage(req as never); break
      case 'move_page': result = this.movePage(req as never); break
      default: result = fail('INVALID_REQUEST', 'Unknown organize action.')
    }
    if (result.ok) this.sql.exec('INSERT INTO requests (request_id, result, created_at) VALUES (?, ?, ?)', req.requestId, JSON.stringify(result), this.iso())
    return result
  }

  private imageRow(id: string) {
    return this.sql.exec<ImageRow>('SELECT * FROM images WHERE id = ?', id).toArray()[0] ?? null
  }

  touch(req: { pageId: string; revision: number; savedAt: string }): Result {
    if (!Number.isSafeInteger(req?.revision)) return { ok: false }
    this.sql.exec('UPDATE pages SET revision = MAX(revision, ?), updated_at = ? WHERE id = ?', req.revision, req.savedAt, req.pageId)
    return { ok: true }
  }

  setLast(req: { pageId: string }): Result {
    const page = this.getPage(req?.pageId)
    if (page && !page.deletedAt) this.setKv('last', JSON.stringify({ notebookId: page.notebookId, pageId: page.id }))
    return { ok: true }
  }
}
