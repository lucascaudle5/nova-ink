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
export type NotebookMeta = { id: string; name: string; createdAt: string; updatedAt: string; deletedAt: string | null; pages: PageMeta[] }
type Result = { ok: boolean; code?: string; message?: string; [key: string]: unknown }

const isUuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const clean = (name: unknown, max = 80) => typeof name === 'string' ? name.trim().slice(0, max) : ''
const fail = (code: string, message: string): Result => ({ ok: false, code, message })
const missing = () => fail('NOT_FOUND', 'That notebook or page was not found.')

type NotebookRow = { id: string; name: string; sort_key: string; created_at: string; updated_at: string; deleted_at: string | null }
type PageRow = { id: string; notebook_id: string; title: string; sort_key: string; created_at: string; updated_at: string; revision: number; deleted_at: string | null }

const toPage = (r: PageRow): PageMeta => ({ id: r.id, notebookId: r.notebook_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, revision: r.revision, deletedAt: r.deleted_at })

export class NotebookLibraryDO extends DurableObject {
  clock: () => number = () => Date.now()
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) WITHOUT ROWID')
      this.sql.exec('CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, title TEXT NOT NULL, sort_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, deleted_at TEXT) WITHOUT ROWID')
      this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID')
    })
  }

  private iso() { return new Date(this.clock()).toISOString() }
  private notebookRows() { return this.sql.exec<NotebookRow>('SELECT * FROM notebooks ORDER BY sort_key, id').toArray() }
  private pageRows(notebookId: string) { return this.sql.exec<PageRow>('SELECT * FROM pages WHERE notebook_id = ? ORDER BY sort_key, id', notebookId).toArray() }
  private notebookRow(id: string) { return this.sql.exec<NotebookRow>('SELECT * FROM notebooks WHERE id = ?', id).toArray()[0] ?? null }
  private pageRow(id: string) { return this.sql.exec<PageRow>('SELECT * FROM pages WHERE id = ?', id).toArray()[0] ?? null }
  private setKv(key: string, value: string) { this.sql.exec('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value) }
  private kv(key: string) { return this.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key).toArray()[0]?.value ?? null }

  private insertNotebook(name: string): string {
    const rows = this.notebookRows()
    const id = crypto.randomUUID(), t = this.iso()
    this.sql.exec('INSERT INTO notebooks (id, name, sort_key, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)', id, name, keyBetween(rows.at(-1)?.sort_key ?? null, null), t, t)
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
    const out: NotebookMeta[] = notebooks.map(n => ({
      id: n.id, name: n.name, createdAt: n.created_at, updatedAt: n.updated_at, deletedAt: n.deleted_at,
      pages: this.pageRows(n.id).map(toPage),
    }))
    let last: { notebookId?: string; pageId?: string } = {}
    try { last = JSON.parse(this.kv('last') ?? '{}') } catch { /* fall back below */ }
    const liveBook = (id?: string) => out.find(n => n.id === id && !n.deletedAt)
    const book = liveBook(last.notebookId) ?? out.find(n => !n.deletedAt && n.pages.some(p => !p.deletedAt)) ?? out.find(n => !n.deletedAt) ?? null
    const page = book?.pages.find(p => p.id === last.pageId && !p.deletedAt) ?? book?.pages.find(p => !p.deletedAt) ?? null
    return { ok: true, notebooks: out, last: { notebookId: book?.id ?? null, pageId: page?.id ?? null } }
  }

  /** Ownership and state of one page. */
  getPage(id: string): PageMeta | null {
    const row = isUuid(id) ? this.pageRow(id) : null
    if (!row) return null
    const book = this.notebookRow(row.notebook_id)
    const page = toPage(row)
    return book?.deleted_at && !page.deletedAt ? { ...page, deletedAt: book.deleted_at } : page
  }

  createNotebook(req: { name: string }): Result {
    const name = clean(req?.name)
    if (!name) return fail('INVALID_NAME', 'Enter a notebook name.')
    const id = this.insertNotebook(name)
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
