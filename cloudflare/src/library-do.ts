/**
 * LibraryDO: the canvas list for one user ("library:<userId>"). Deliberately minimal for the test deployment:
 * canvases only (no notebooks, trash or PDF sources; see docs section 2). It is also the ownership check:
 * a canvas id that is not in this user's library is NOT_FOUND, so the MCP layer never touches a canvas id it
 * did not create or register for this user.
 */
import { DurableObject } from 'cloudflare:workers'

export type CanvasMeta = { id: string; name: string; createdAt: string; updatedAt: string; revision: number }

const isUuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const cleanName = (name: unknown) => typeof name === 'string' ? name.trim().slice(0, 80) : ''

export class LibraryDO extends DurableObject {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, created_by_save_id TEXT) WITHOUT ROWID`)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
    })
  }

  private rows(): CanvasMeta[] {
    return this.sql.exec<{ id: string; name: string; created_at: string; updated_at: string; revision: number }>(
      'SELECT id, name, created_at, updated_at, revision FROM canvases',
    ).toArray().map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, revision: r.revision }))
  }

  get(id: string): CanvasMeta | null {
    return this.rows().find(c => c.id === id) ?? null
  }

  list() {
    let canvases = this.rows()
    if (!canvases.length) {
      const stamp = new Date().toISOString()
      const id = crypto.randomUUID()
      this.sql.exec('INSERT INTO canvases (id, name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 0)', id, 'My First Canvas', stamp, stamp)
      this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('lastOpenedId', ?)", id)
      canvases = this.rows()
    }
    canvases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const last = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'lastOpenedId'").toArray()[0]?.value
    const lastOpenedId = canvases.some(c => c.id === last) ? last : canvases[0].id
    return { ok: true, lastOpenedId, canvases }
  }

  create(name: string, id: string = crypto.randomUUID()) {
    const cleaned = cleanName(name)
    if (!cleaned) return { ok: false, code: 'INVALID_NAME', message: 'Enter a canvas name.' }
    if (!isUuid(id)) return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid canvas id.' }
    const stamp = new Date().toISOString()
    this.sql.exec('INSERT INTO canvases (id, name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 0)', id, cleaned, stamp, stamp)
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('lastOpenedId', ?)", id)
    return { ok: true, canvas: this.get(id) }
  }

  /** Registers a canvas created by "save as new" (its id is derived from the saveId, so a retry lands here again). */
  register(req: { id: string; name: string; revision: number; savedAt: string; saveId: string }) {
    const cleaned = cleanName(req.name)
    if (!cleaned || !isUuid(req.id)) return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid canvas registration.' }
    this.sql.exec(
      'INSERT OR IGNORE INTO canvases (id, name, created_at, updated_at, revision, created_by_save_id) VALUES (?, ?, ?, ?, ?, ?)',
      req.id, cleaned, req.savedAt, req.savedAt, req.revision, req.saveId,
    )
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('lastOpenedId', ?)", req.id)
    return { ok: true, canvas: this.get(req.id) }
  }

  /** Records the latest revision. The caller debounces (the design allows a coarse updated_at to save row writes). */
  touch(req: { id: string; revision: number; savedAt: string }) {
    if (!Number.isSafeInteger(req.revision)) return { ok: false }
    this.sql.exec('UPDATE canvases SET revision = MAX(revision, ?), updated_at = ? WHERE id = ?', req.revision, req.savedAt, req.id)
    return { ok: true }
  }

  setLastOpened(id: string) {
    if (this.get(id)) this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('lastOpenedId', ?)", id)
    return { ok: true }
  }
}
