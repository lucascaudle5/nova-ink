/**
 * PageDO: one SQLite-backed Durable Object per engine notebook page (an infinite canvas of strokes).
 *
 * Tables (WITHOUT ROWID, so one logical row is one billed row write):
 *   strokes(id PK, key, json)        one row per stroke; `key` is its z-order key, `json` the nova-ink v1 stroke
 *   kv(key PK, value)                'head', 'paper', 'camera', 'lease'
 *   checkpoint_index / checkpoint_chunks   gzip'd whole-page checkpoints in <= 1,000,000-byte chunks
 *   quarantine(at, source, id, json) damaged rows kept when a page is restored from a checkpoint
 *
 * Strokes are immutable, so a save is a delta: strokes to add (with keys) and ids to remove. Checks run in the
 * same order as v0.2 storage.mjs: replay, lease, revision, validation; then one transaction is the commit point.
 */
import { DurableObject } from 'cloudflare:workers'
import { MAX_ZOOM, MIN_ZOOM } from '../../../engine/src/core/camera'
import { parseStroke, STROKE_ID } from '../../../engine/src/core/format'
import { isOrderKey } from '../../../engine/src/core/order'
import { DEFAULT_PAPER, isPaper } from '../../../engine/src/core/paper'
import type { Paper } from '../../../engine/src/core/paper'
import type { Camera } from '../../../engine/src/core/types'

export const PAGE_FORMAT = 1
export const LEASE_MS = 45_000
export const CHUNK_BYTES = 1_000_000
export const MAX_STROKE_BYTES = 1_900_000
export const MAX_SAVE_STROKES = 5_000

export type Result = { ok: boolean; code?: string; message?: string; [key: string]: unknown }
export type AddedStroke = { key: string; stroke: unknown }
export type PageSave = {
  clientId: string
  saveId: string
  baseRevision: number
  adds?: AddedStroke[]
  removes?: string[]
  paper?: Paper
  camera?: Camera
}

type Head = {
  format: number
  revision: number
  saveId: string | null
  savedBy: string | null
  savedAt: string | null
  strokeCount: number
  lastCheckpointAt: string | null
  restoredFrom?: number
}
type Lease = { clientId: string; until: number }
type Row = { id: string; key: string; json: string }
type Checkpoint = { rows: Row[]; paper: Paper; camera: Camera | null }

const isUuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const isSaveId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64
const fail = (code: string, message: string, extra: Record<string, unknown> = {}): Result => ({ ok: false, code, message, ...extra })
const encoder = new TextEncoder()

export function isCamera(value: unknown): value is Camera {
  const c = value as Camera | null
  return !!c && typeof c === 'object' && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)
    && Math.abs(c.x) < 1e12 && Math.abs(c.y) < 1e12 && c.z >= MIN_ZOOM && c.z <= MAX_ZOOM
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

/** Rows as the JSON text of `[{ key, stroke }]`, built without parsing the stored stroke JSON. */
function rowsText(rows: Row[]): string {
  return `[${rows.map(r => `{"key":${JSON.stringify(r.key)},"stroke":${r.json}}`).join(',')}]`
}

export class PageDO extends DurableObject {
  /** Test seams. */
  clock: () => number = () => Date.now()
  policy = { checkpointMinIntervalMs: 10 * 60_000, checkpointKeep: 10 }
  faults: { beforeCommit?: boolean } = {}

  private sql: SqlStorage
  private tail: Promise<unknown> = Promise.resolve()
  private lease: Lease | null | undefined = undefined
  private rowsWritten = 0

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS strokes (id TEXT PRIMARY KEY, key TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID')
      this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID')
      this.sql.exec('CREATE TABLE IF NOT EXISTS checkpoint_index (revision INTEGER PRIMARY KEY, saved_at TEXT NOT NULL, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL, strokes INTEGER NOT NULL) WITHOUT ROWID')
      this.sql.exec('CREATE TABLE IF NOT EXISTS checkpoint_chunks (revision INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (revision, idx)) WITHOUT ROWID')
      this.sql.exec('CREATE TABLE IF NOT EXISTS quarantine (at TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (at, source, id)) WITHOUT ROWID')
    })
  }

  // ---------------------------------------------------------------- plumbing

  /** One operation at a time; a storage exception becomes a structured failure (its transaction rolled back). */
  private serialize<T>(task: () => Promise<T> | T): Promise<T> {
    const guarded = async () => {
      try { return await task() } catch (error) {
        console.error(`page operation failed: ${(error as Error).message}`)
        return fail('STORAGE_ERROR', 'The storage layer failed. Nothing was saved.') as unknown as T
      }
    }
    const run = this.tail.then(guarded, guarded)
    this.tail = run.catch(() => {})
    return run
  }

  private run<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: (string | number | null | ArrayBuffer)[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings)
    const rows = cursor.toArray()
    this.rowsWritten += cursor.rowsWritten
    return rows
  }
  private kvGet(key: string): string | null { return this.run<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)[0]?.value ?? null }
  private kvPut(key: string, value: string) { this.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value) }
  private iso(t = this.clock()) { return new Date(t).toISOString() }
  private stats() { return { rowsWritten: this.rowsWritten } }

  private readHead(): { head: Head | null } | { error: Result } {
    const raw = this.kvGet('head')
    if (raw === null) return { head: null }
    try {
      const head = JSON.parse(raw) as Head
      if (!head || typeof head !== 'object' || !Number.isSafeInteger(head.revision) || head.revision < 0 || !Number.isSafeInteger(head.strokeCount) || typeof head.format !== 'number') throw new Error('shape')
      if (head.format > PAGE_FORMAT) return { error: fail('FORMAT_NEWER', 'This page was saved by a newer NOVA Ink. Update NOVA Ink before opening it.') }
      return { head }
    } catch {
      return { error: fail('CORRUPT_RECORD', 'This page is damaged. Choose a checkpoint to restore it.') }
    }
  }

  /** A missing head means "blank" only for a page that was never saved. */
  private missingHead(knownRevision: unknown): boolean {
    return (Number.isSafeInteger(knownRevision) && (knownRevision as number) > 0)
      || this.run('SELECT 1 FROM checkpoint_index LIMIT 1').length > 0
      || this.run('SELECT 1 FROM strokes LIMIT 1').length > 0
  }

  private paper(): Paper {
    const raw = this.kvGet('paper')
    try { const p = raw ? JSON.parse(raw) : null; return isPaper(p) ? p : { ...DEFAULT_PAPER } } catch { return { ...DEFAULT_PAPER } }
  }
  private camera(): Camera | null {
    const raw = this.kvGet('camera')
    try { const c = raw ? JSON.parse(raw) : null; return isCamera(c) ? c : null } catch { return null }
  }

  /** All stroke rows in z-order, after checking they are all present and look like JSON objects. */
  private readRows(head: Head): { rows: Row[] } | { error: Result } {
    const rows = this.run<Row>('SELECT id, key, json FROM strokes ORDER BY key, id')
    if (rows.length < head.strokeCount) return { error: fail('MISSING_RECORD', 'Some saved strokes are missing. Choose a checkpoint to restore the page.') }
    if (rows.length > head.strokeCount) return { error: fail('CORRUPT_RECORD', 'This page has unexpected strokes. Choose a checkpoint to restore it.') }
    for (const r of rows) if (r.json.charCodeAt(0) !== 123 || r.json.charCodeAt(r.json.length - 1) !== 125) return { error: fail('CORRUPT_RECORD', 'A saved stroke is damaged. Choose a checkpoint to restore the page.') }
    return { rows }
  }

  // ---------------------------------------------------------------- lease (in memory; persisted only when the holder changes)

  private getLease(): Lease | null {
    if (this.lease === undefined) {
      const raw = this.kvGet('lease')
      try { this.lease = raw ? JSON.parse(raw) as Lease : null } catch { this.lease = null }
    }
    return this.lease
  }
  private setLease(lease: Lease | null, persist: boolean) {
    this.lease = lease
    if (!persist) return
    if (lease) this.kvPut('lease', JSON.stringify(lease))
    else this.run("DELETE FROM kv WHERE key = 'lease'")
  }
  private takeLease(clientId: string, takeOver = false) {
    const current = this.getLease()
    const t = this.clock()
    if (takeOver || !current || current.until <= t || current.clientId === clientId) {
      this.setLease({ clientId, until: t + LEASE_MS }, !current || current.clientId !== clientId)
      return { readOnly: false, leaseExpiresAt: this.iso(t + LEASE_MS) }
    }
    return { readOnly: true, leaseExpiresAt: this.iso(current.until) }
  }
  private heldByOther(clientId: string) {
    const lease = this.getLease()
    return !!lease && lease.clientId !== clientId && lease.until > this.clock()
  }

  // ---------------------------------------------------------------- public API

  /** Sets the paper of a page that was never saved (a new page copies its neighbour's paper). */
  init(req: { paper: Paper }): Promise<Result> {
    return this.serialize(() => {
      this.rowsWritten = 0
      if (!isPaper(req?.paper)) return fail('INVALID_REQUEST', 'Unknown paper style.')
      const state = this.readHead()
      if ('error' in state) return state.error
      if (state.head || this.missingHead(undefined)) return { ok: true, unchanged: true }
      this.kvPut('paper', JSON.stringify({ color: req.paper.color, pattern: req.paper.pattern }))
      return { ok: true }
    })
  }

  /** Paper and stroke count without taking the lease. */
  info(): Promise<Result> {
    return this.serialize(() => {
      const state = this.readHead()
      if ('error' in state) return state.error
      return { ok: true, revision: state.head?.revision ?? 0, strokeCount: state.head?.strokeCount ?? 0, paper: this.paper() }
    })
  }

  /**
   * Loads the page and takes the editing lease if it is free. `rows` is the JSON text of `[{ key, stroke }]`
   * (assembled without parsing; the client parses and validates every stroke with the engine's parser).
   */
  open(req: { clientId: string; takeOver?: boolean; knownRevision?: number }): Promise<Result> {
    return this.serialize(() => {
      this.rowsWritten = 0
      if (!isUuid(req?.clientId)) return fail('INVALID_REQUEST', 'Invalid editor client id.')
      const state = this.readHead()
      if ('error' in state) return state.error
      const { head } = state
      if (!head) {
        if (this.missingHead(req.knownRevision)) return fail('MISSING_RECORD', 'This page was saved before, but its data is missing. Choose a checkpoint to restore it.')
        return { ok: true, revision: 0, rows: '[]', strokeCount: 0, paper: this.paper(), camera: null, ...this.takeLease(req.clientId, !!req.takeOver) }
      }
      const read = this.readRows(head)
      if ('error' in read) return read.error
      return {
        ok: true, revision: head.revision, rows: rowsText(read.rows), strokeCount: read.rows.length,
        paper: this.paper(), camera: this.camera(), ...this.takeLease(req.clientId, !!req.takeOver),
      }
    })
  }

  heartbeat(req: { clientId: string }): Promise<Result> {
    return this.serialize(() => {
      if (!isUuid(req?.clientId)) return fail('INVALID_REQUEST', 'Invalid editor client id.')
      const current = this.getLease()
      if (current && current.clientId !== req.clientId && current.until > this.clock()) return { ok: true, readOnly: true, leaseExpiresAt: this.iso(current.until) }
      return { ok: true, ...this.takeLease(req.clientId) }
    })
  }

  release(req: { clientId: string }): Promise<Result> {
    return this.serialize(() => {
      if (!isUuid(req?.clientId)) return fail('INVALID_REQUEST', 'Invalid editor client id.')
      if (this.getLease()?.clientId === req.clientId) this.setLease(null, true)
      return { ok: true }
    })
  }

  save(req: PageSave): Promise<Result> {
    return this.serialize(async () => {
      this.rowsWritten = 0
      if (!isUuid(req?.clientId)) return fail('INVALID_REQUEST', 'Invalid editor client id.')
      const state = this.readHead()
      if ('error' in state) return state.error.code === 'FORMAT_NEWER' ? state.error : fail(state.error.code!, 'This page is damaged. Nothing was saved.')
      const { head } = state
      if (!head && this.missingHead(undefined)) return fail('MISSING_RECORD', 'The saved page data is missing. Nothing was saved.')
      if (head && head.saveId === req.saveId && head.savedBy === req.clientId) return { ok: true, revision: head.revision, savedAt: head.savedAt, replayed: true }
      if (this.heldByOther(req.clientId)) return fail('LEASE_HELD', 'Another device is editing this page. Nothing was saved.')
      const current = head?.revision ?? 0
      if (!Number.isSafeInteger(req.baseRevision) || req.baseRevision !== current) {
        return fail('CONFLICT', 'The server has a newer version of this page. Nothing was overwritten.', {
          revision: current, ownLastSaveId: head && head.savedBy === req.clientId ? head.saveId : null,
        })
      }
      if (!isSaveId(req.saveId)) return fail('INVALID_REQUEST', 'Missing save id.')

      const adds = req.adds ?? [], removes = req.removes ?? []
      if (!Array.isArray(adds) || !Array.isArray(removes) || adds.length + removes.length > MAX_SAVE_STROKES) return fail('INVALID_REQUEST', 'Invalid or oversized change list. Nothing was saved.')
      if (!removes.every(id => typeof id === 'string' && STROKE_ID.test(id))) return fail('INVALID_REQUEST', 'Invalid stroke id. Nothing was saved.')
      if (req.paper !== undefined && !isPaper(req.paper)) return fail('INVALID_REQUEST', 'Unknown paper style. Nothing was saved.')
      if (req.camera !== undefined && !isCamera(req.camera)) return fail('INVALID_REQUEST', 'Invalid camera. Nothing was saved.')
      const rows: Row[] = []
      const ids = new Set<string>()
      for (let i = 0; i < adds.length; i++) {
        const add = adds[i]
        if (!add || !isOrderKey(add.key)) return fail('INVALID_STROKE', `Added stroke ${i + 1} has an invalid order key. Nothing was saved.`)
        const parsed = parseStroke(add.stroke, `Added stroke ${i + 1}`)
        if (!parsed.ok) return fail('INVALID_STROKE', `${parsed.message} Nothing was saved.`)
        if (ids.has(parsed.stroke.id)) return fail('INVALID_STROKE', `Added stroke ${i + 1} repeats an id. Nothing was saved.`)
        ids.add(parsed.stroke.id)
        const s = add.stroke as Record<string, unknown>
        const json = JSON.stringify({ id: s.id, author: s.author, color: s.color, width: s.width, createdAt: s.createdAt, n: s.n, points: s.points })
        if (encoder.encode(json).length > MAX_STROKE_BYTES) return fail('INVALID_STROKE', `Added stroke ${i + 1} is too large. Nothing was saved.`)
        rows.push({ id: parsed.stroke.id, key: add.key, json })
      }

      const strokesChanged = rows.length > 0 || removes.length > 0
      if (head && strokesChanged && this.checkpointDue(head)) await this.writeCheckpoint(head)
      if (this.faults.beforeCommit) throw new Error('injected fault before commit')

      const savedAt = this.iso()
      const revision = current + 1
      let count = 0
      this.ctx.storage.transactionSync(() => {
        for (const id of removes) this.run('DELETE FROM strokes WHERE id = ?', id)
        for (const r of rows) this.run('INSERT OR REPLACE INTO strokes (id, key, json) VALUES (?, ?, ?)', r.id, r.key, r.json)
        if (req.paper) this.kvPut('paper', JSON.stringify({ color: req.paper.color, pattern: req.paper.pattern }))
        if (req.camera) this.kvPut('camera', JSON.stringify({ x: req.camera.x, y: req.camera.y, z: req.camera.z }))
        count = this.run<{ n: number }>('SELECT COUNT(*) AS n FROM strokes')[0].n
        const next: Head = {
          format: PAGE_FORMAT, revision, saveId: req.saveId, savedBy: req.clientId, savedAt, strokeCount: count,
          lastCheckpointAt: head?.lastCheckpointAt ?? null,
        }
        this.kvPut('head', JSON.stringify(next))
      })
      this.takeLease(req.clientId)
      return { ok: true, revision, savedAt, strokeCount: count, stats: this.stats() }
    })
  }

  listCheckpoints(): Promise<Result> {
    return this.serialize(() => ({
      ok: true,
      checkpoints: this.run<{ revision: number; saved_at: string; strokes: number }>('SELECT revision, saved_at, strokes FROM checkpoint_index ORDER BY revision DESC')
        .map(r => ({ revision: r.revision, savedAt: r.saved_at, strokeCount: r.strokes })),
    }))
  }

  /** Restores a checkpoint as a NEW revision. The current state is checkpointed first, or quarantined if damaged. */
  restoreCheckpoint(req: { clientId: string; saveId: string; checkpointRevision: number; expectedRevision: number | null; knownRevision?: number }): Promise<Result> {
    return this.serialize(async () => {
      this.rowsWritten = 0
      if (!isUuid(req?.clientId) || !isSaveId(req.saveId) || !Number.isSafeInteger(req.checkpointRevision)
        || !(req.expectedRevision === null || Number.isSafeInteger(req.expectedRevision))) return fail('INVALID_REQUEST', 'Checkpoint revision or save id is invalid.')
      const checkpoint = await this.readCheckpoint(req.checkpointRevision)
      if (!checkpoint) return fail('BACKUP_UNAVAILABLE', 'That checkpoint is missing or invalid.')

      let head: Head | null = null
      let damaged = false
      const state = this.readHead()
      if ('error' in state) { if (state.error.code === 'FORMAT_NEWER') return state.error; damaged = true }
      else if (!state.head) damaged = this.missingHead(req.knownRevision)
      else { head = state.head; damaged = 'error' in this.readRows(head) }

      if (head && head.saveId === req.saveId && head.savedBy === req.clientId) return { ok: true, revision: head.revision, savedAt: head.savedAt, replayed: true }
      if (req.expectedRevision === null ? !damaged : (damaged || head?.revision !== req.expectedRevision)) {
        return fail('CONFLICT', 'The page changed after checkpoints were listed. Reload before restoring.')
      }
      if (this.heldByOther(req.clientId)) return fail('LEASE_HELD', 'Another device is editing this page. No checkpoint was restored.')

      // Never reuse a revision number a client may hold, even when the head row is unreadable.
      const rawRevision = Number(/"revision":(\d+)/.exec(this.kvGet('head') ?? '')?.[1] ?? 0)
      const known = Number.isSafeInteger(req.knownRevision) ? req.knownRevision! : 0
      const highest = Math.max(head?.revision ?? 0, rawRevision, known, req.checkpointRevision,
        this.run<{ r: number | null }>('SELECT MAX(revision) AS r FROM checkpoint_index')[0]?.r ?? 0)
      if (damaged) this.quarantineAll()
      else if (head && head.revision > 0) await this.writeCheckpoint(head)

      const savedAt = this.iso()
      const revision = highest + 1
      this.ctx.storage.transactionSync(() => {
        this.run('DELETE FROM strokes')
        for (const r of checkpoint.rows) this.run('INSERT INTO strokes (id, key, json) VALUES (?, ?, ?)', r.id, r.key, r.json)
        this.kvPut('paper', JSON.stringify(checkpoint.paper))
        if (checkpoint.camera) this.kvPut('camera', JSON.stringify(checkpoint.camera))
        this.kvPut('head', JSON.stringify({
          format: PAGE_FORMAT, revision, saveId: req.saveId, savedBy: req.clientId, savedAt, strokeCount: checkpoint.rows.length,
          lastCheckpointAt: savedAt, restoredFrom: req.checkpointRevision,
        } satisfies Head))
      })
      this.takeLease(req.clientId)
      return { ok: true, revision, savedAt, restoredRevision: req.checkpointRevision, recoveryCopyPreserved: damaged }
    })
  }

  // ---------------------------------------------------------------- checkpoints

  private checkpointDue(head: Head): boolean {
    if (head.revision < 1) return false
    if (!head.lastCheckpointAt) return true
    return this.clock() - Date.parse(head.lastCheckpointAt) >= this.policy.checkpointMinIntervalMs
  }

  /** Gzips the current page (as of `head`) into chunks, then keeps the newest `checkpointKeep`. */
  private async writeCheckpoint(head: Head) {
    const read = this.readRows(head)
    if ('error' in read) return
    const text = JSON.stringify({ rows: read.rows, paper: this.paper(), camera: this.camera() } satisfies Checkpoint)
    const bytes = await gzip(text)
    const savedAt = this.iso()
    this.ctx.storage.transactionSync(() => {
      this.run('DELETE FROM checkpoint_chunks WHERE revision = ?', head.revision)
      const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES))
      for (let i = 0; i < chunks; i++) this.run('INSERT INTO checkpoint_chunks (revision, idx, data) VALUES (?, ?, ?)', head.revision, i, bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).buffer as ArrayBuffer)
      this.run('INSERT OR REPLACE INTO checkpoint_index (revision, saved_at, chunks, bytes, strokes) VALUES (?, ?, ?, ?, ?)', head.revision, savedAt, chunks, bytes.length, read.rows.length)
      const old = this.run<{ revision: number }>('SELECT revision FROM checkpoint_index ORDER BY revision DESC LIMIT -1 OFFSET ?', this.policy.checkpointKeep)
      for (const { revision } of old) {
        this.run('DELETE FROM checkpoint_chunks WHERE revision = ?', revision)
        this.run('DELETE FROM checkpoint_index WHERE revision = ?', revision)
      }
      this.kvPut('head', JSON.stringify({ ...head, lastCheckpointAt: savedAt }))
    })
    head.lastCheckpointAt = savedAt
  }

  private async readCheckpoint(revision: number): Promise<Checkpoint | null> {
    try {
      const index = this.run<{ chunks: number; bytes: number }>('SELECT chunks, bytes FROM checkpoint_index WHERE revision = ?', revision)[0]
      if (!index) return null
      const parts = this.run<{ data: ArrayBuffer }>('SELECT data FROM checkpoint_chunks WHERE revision = ? ORDER BY idx', revision)
      if (parts.length !== index.chunks) return null
      const bytes = new Uint8Array(index.bytes)
      let at = 0
      for (const p of parts) { bytes.set(new Uint8Array(p.data), at); at += p.data.byteLength }
      if (at !== index.bytes) return null
      const cp = JSON.parse(await gunzip(bytes)) as Checkpoint
      if (!Array.isArray(cp.rows) || !isPaper(cp.paper)) return null
      for (const r of cp.rows) if (typeof r.id !== 'string' || !isOrderKey(r.key) || typeof r.json !== 'string') return null
      return cp
    } catch { return null }
  }

  private quarantineAll() {
    const at = this.iso()
    this.ctx.storage.transactionSync(() => {
      for (const r of this.run<Row>('SELECT id, key, json FROM strokes')) this.run('INSERT OR REPLACE INTO quarantine (at, source, id, json) VALUES (?, ?, ?, ?)', at, 'stroke', r.id, JSON.stringify(r))
      for (const r of this.run<{ key: string; value: string }>('SELECT key, value FROM kv')) this.run('INSERT OR REPLACE INTO quarantine (at, source, id, json) VALUES (?, ?, ?, ?)', at, 'kv', r.key, r.value)
    })
  }
}
