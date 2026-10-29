/**
 * CanvasDO: one SQLite-backed Durable Object per canvas (tldraw document).
 *
 * Storage layout (all tables WITHOUT ROWID so each logical row is exactly one billed row write):
 *   records(id PK, type, json)          one row per tldraw record (shape/page/binding/asset/document)
 *   kv(key PK, value)                   'head' (revision + save bookkeeping), 'schema', 'session', 'lease'
 *   blob_index(hash PK, chunks, bytes)  one row per stored image payload
 *   blobs(hash, idx, data)              image payload in <= 1,000,000-byte chunks (row limit is 2 MB)
 *   checkpoint_index / checkpoint_chunks   gzip'd full-document checkpoints, chunked the same way
 *   quarantine(...)                     evidence kept when a damaged canvas is recovered
 *
 * The commit point of a save is the single transactionSync() that writes records + head together.
 */
import { DurableObject } from 'cloudflare:workers'
import type { ApiResult, Changes, CheckpointInfo, SaveRequest, Snapshot, TLRecord } from './protocol'
import { lateIndexKey, makeDiagSnapshot, movedSession, strokeRecord, type DiagSnapshot } from './diag-data'

export interface Env { CANVAS: DurableObjectNamespace<CanvasDO> }

export const FORMAT_VERSION = 1
export const LEASE_MS = 45_000
export const CHUNK_BYTES = 1_000_000
export const MAX_RECORD_BYTES = 1_900_000
export const MAX_SAVE_BYTES = 12 * 1024 * 1024
export const INLINE_SRC_MAX = 100_000
export const BLOB_PREFIX = 'nova-blob:'

type Head = {
  format: number
  revision: number
  saveId: string | null
  savedBy: string | null
  savedAt: string | null
  recordCount: number
  createdAt: string
  lastCheckpointAt: string | null
  lastCheckpointRevision: number | null
  restoredFrom?: number
}
type Lease = { clientId: string; until: number }
type Prepared = { id: string; type: string; json: string; blob?: { hash: string; bytes: Uint8Array } }
type Sql = SqlStorage
type Bind = string | number | null | ArrayBuffer

const isUuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const isSaveId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const fail = (code: string, message: string, extra: Record<string, unknown> = {}): ApiResult => ({ ok: false, code, message, ...extra })

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let out = ''
  for (const b of digest) out += b.toString(16).padStart(2, '0')
  return out
}
async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer
function concat(parts: ArrayBuffer[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength }
  return out
}

export function hasSnapshotShape(snapshot: unknown): snapshot is Snapshot {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  const { document, session } = snapshot as Record<string, any>
  if (!document || typeof document !== 'object' || !session || typeof session !== 'object') return false
  return !!document.store && typeof document.store === 'object' && !Array.isArray(document.store)
    && !!document.schema && typeof document.schema === 'object'
}

export class CanvasDO extends DurableObject<Env> {
  /** Test seams: tests replace these through runInDurableObject. */
  clock: () => number = () => Date.now()
  policy = { checkpointMinIntervalMs: 10 * 60_000, checkpointKeep: 10 }
  faults: { beforeCommit?: boolean; afterCommit?: boolean } = {}

  private sql: Sql
  private tail: Promise<unknown> = Promise.resolve()
  private lease: Lease | null | undefined = undefined
  private diagSnap: DiagSnapshot | null = null
  private rowsWritten = 0
  private rowsRead = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => this.migrate())
  }

  // ---------------------------------------------------------------- plumbing

  private migrate() {
    const s = this.sql
    s.exec(`CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, type TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID`)
    s.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
    s.exec(`CREATE TABLE IF NOT EXISTS blob_index (hash TEXT PRIMARY KEY, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL) WITHOUT ROWID`)
    s.exec(`CREATE TABLE IF NOT EXISTS blobs (hash TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (hash, idx)) WITHOUT ROWID`)
    s.exec(`CREATE TABLE IF NOT EXISTS checkpoint_index (revision INTEGER PRIMARY KEY, saved_at TEXT NOT NULL, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL, refs TEXT NOT NULL) WITHOUT ROWID`)
    s.exec(`CREATE TABLE IF NOT EXISTS checkpoint_chunks (revision INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (revision, idx)) WITHOUT ROWID`)
    s.exec(`CREATE TABLE IF NOT EXISTS quarantine (at TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (at, source, id)) WITHOUT ROWID`)
  }

  /** Serializes work; an unexpected storage error becomes a structured failure (the transaction already rolled back). */
  private serialize<T>(task: () => Promise<T> | T): Promise<T> {
    const guarded = async () => {
      try { return await task() } catch (error) {
        console.error(`operation failed: ${(error as Error).message}`)
        return fail('STORAGE_ERROR', 'The storage layer failed. Nothing was saved.', { detail: (error as Error).message }) as unknown as T
      }
    }
    const run = this.tail.then(guarded, guarded)
    this.tail = run.catch(() => {})
    return run
  }

  /** Executes and fully consumes a statement so row counters are final. */
  private run<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: Bind[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings)
    const rows = cursor.toArray()
    this.rowsWritten += cursor.rowsWritten
    this.rowsRead += cursor.rowsRead
    return rows
  }

  private begin() { this.rowsWritten = 0; this.rowsRead = 0 }
  private stats() { return { rowsWritten: this.rowsWritten, rowsRead: this.rowsRead } }
  private iso(t = this.clock()) { return new Date(t).toISOString() }
  private checkClient(clientId: unknown) { return isUuid(clientId) ? null : fail('INVALID_REQUEST', 'Invalid editor client id.') }

  private kvGet(key: string): string | null {
    const rows = this.run<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)
    return rows.length ? rows[0].value : null
  }
  private kvPut(key: string, value: string) { this.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value) }

  // ---------------------------------------------------------------- head / state classification

  private readHead(): { head: Head | null } | { error: ApiResult } {
    const raw = this.kvGet('head')
    if (raw === null) return { head: null }
    try {
      const head = JSON.parse(raw) as Head
      if (!head || typeof head !== 'object' || !Number.isSafeInteger(head.revision) || head.revision < 0 || !Number.isSafeInteger(head.recordCount) || typeof head.format !== 'number') throw new Error('shape')
      if (head.format > FORMAT_VERSION) return { error: fail('FORMAT_NEWER', 'This canvas was written by a newer NOVA Ink version. Update NOVA Ink before opening it.') }
      return { head }
    } catch {
      return { error: fail('CORRUPT_RECORD', 'Saved canvas record is unreadable.') }
    }
  }

  private checkpointRevisions(): number[] {
    return this.run<{ revision: number }>('SELECT revision FROM checkpoint_index ORDER BY revision DESC').map(r => r.revision)
  }

  /** A missing head is blank only for a canvas that was never saved. */
  private missingHead(knownRevision: unknown): boolean {
    return (Number.isSafeInteger(knownRevision) && (knownRevision as number) > 0) || this.checkpointRevisions().length > 0
      || this.run('SELECT 1 FROM records LIMIT 1').length > 0
  }

  // ---------------------------------------------------------------- reading the document

  private readBlob(ref: string): string {
    const match = /^nova-blob:([0-9a-f]{64})$/.exec(ref)
    if (!match) throw new Error('bad blob reference')
    const hash = match[1]
    const index = this.run<{ chunks: number; bytes: number }>('SELECT chunks, bytes FROM blob_index WHERE hash = ?', hash)
    if (!index.length) throw new Error('blob missing')
    const rows = this.run<{ data: ArrayBuffer }>('SELECT data FROM blobs WHERE hash = ? ORDER BY idx', hash)
    if (rows.length !== index[0].chunks) throw new Error('blob chunks missing')
    const bytes = concat(rows.map(r => r.data))
    if (bytes.length !== index[0].bytes) throw new Error('blob size mismatch')
    return decoder.decode(bytes)
  }

  /** Reassembles the full snapshot. Returns an error result if any row is damaged or absent. */
  private assemble(head: Head): { snapshot: Snapshot } | { error: ApiResult } {
    try {
      const rows = this.run<{ id: string; json: string }>('SELECT id, json FROM records')
      if (rows.length < head.recordCount) return { error: fail('MISSING_RECORD', 'Some saved records are missing.') }
      if (rows.length > head.recordCount) return { error: fail('CORRUPT_RECORD', 'Saved canvas has unexpected records.') }
      const store: Record<string, TLRecord> = {}
      for (const row of rows) {
        const record = JSON.parse(row.json) as TLRecord
        if (!record || record.id !== row.id) throw new Error('id mismatch')
        const src = (record as any).props?.src
        if (record.typeName === 'asset' && typeof src === 'string' && src.startsWith(BLOB_PREFIX)) (record as any).props.src = this.readBlob(src)
        store[row.id] = record
      }
      const schema = this.kvGet('schema')
      const session = this.kvGet('session')
      if (schema === null || session === null) return { error: fail('MISSING_RECORD', 'Saved schema or session is missing.') }
      return { snapshot: { document: { store, schema: JSON.parse(schema) }, session: JSON.parse(session) } }
    } catch {
      return { error: fail('CORRUPT_RECORD', 'Saved canvas record is invalid.') }
    }
  }

  // ---------------------------------------------------------------- lease (in memory, persisted only when the holder changes)

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
  private leaseInfo(clientId: string, acquire: boolean, takeOver = false) {
    const current = this.getLease()
    const t = this.clock()
    if (takeOver || !current || current.until <= t || current.clientId === clientId) {
      if (acquire) this.setLease({ clientId, until: t + LEASE_MS }, !current || current.clientId !== clientId)
      return { readOnly: false, leaseExpiresAt: this.iso(t + LEASE_MS) }
    }
    return { readOnly: true, leaseExpiresAt: this.iso(current.until) }
  }
  private heldByOther(clientId: string) {
    const lease = this.getLease()
    return !!lease && lease.clientId !== clientId && lease.until > this.clock()
  }

  // ---------------------------------------------------------------- public API

  open(req: { clientId: string; takeOver?: boolean; knownRevision?: number }): Promise<ApiResult> {
    return this.serialize(() => {
      this.begin()
      const bad = this.checkClient(req?.clientId)
      if (bad) return bad
      const state = this.readHead()
      if ('error' in state) return { ...state.error, message: state.error.code === 'CORRUPT_RECORD' ? 'This canvas is damaged. Choose a valid checkpoint to restore it.' : state.error.message }
      const { head } = state
      if (!head) {
        if (this.missingHead(req.knownRevision)) return fail('MISSING_RECORD', 'This canvas was saved before, but its data is missing. Choose a checkpoint to restore it.')
        const lease = this.leaseInfo(req.clientId, true, !!req.takeOver)
        return { ok: true, revision: 0, snapshot: null, ...lease, stats: this.stats() }
      }
      const loaded = this.assemble(head)
      if ('error' in loaded) return loaded.error
      const lease = this.leaseInfo(req.clientId, true, !!req.takeOver)
      return { ok: true, revision: head.revision, snapshot: loaded.snapshot, ...lease, stats: this.stats() }
    })
  }

  /**
   * Fast load: returns the finished JSON response TEXT, assembled by concatenating stored row JSON without
   * parsing or re-serialising it. Integrity is checked cheaply (row count, each row looks like a JSON object,
   * blob chunks complete); a row that is garbage inside still makes the client's JSON.parse fail, which the
   * client must treat as CORRUPT_RECORD. Use open() when the server must validate every record.
   */
  openRaw(req: { clientId: string; takeOver?: boolean; knownRevision?: number }): Promise<string> {
    return this.serialize(() => {
      this.begin()
      const out = (value: ApiResult) => JSON.stringify(value)
      const bad = this.checkClient(req?.clientId)
      if (bad) return out(bad)
      const state = this.readHead()
      if ('error' in state) return out(state.error)
      const { head } = state
      if (!head) {
        if (this.missingHead(req.knownRevision)) return out(fail('MISSING_RECORD', 'This canvas was saved before, but its data is missing. Choose a checkpoint to restore it.'))
        return out({ ok: true, revision: 0, snapshot: null, ...this.leaseInfo(req.clientId, true, !!req.takeOver) })
      }
      const rows = this.run<{ id: string; json: string }>('SELECT id, json FROM records')
      if (rows.length < head.recordCount) return out(fail('MISSING_RECORD', 'Some saved records are missing.'))
      if (rows.length > head.recordCount) return out(fail('CORRUPT_RECORD', 'Saved canvas has unexpected records.'))
      const schema = this.kvGet('schema'), session = this.kvGet('session')
      if (schema === null || session === null) return out(fail('MISSING_RECORD', 'Saved schema or session is missing.'))
      const parts: string[] = []
      for (const row of rows) {
        let json = row.json
        if (json.charCodeAt(0) !== 123 || json.charCodeAt(json.length - 1) !== 125) return out(fail('CORRUPT_RECORD', 'Saved canvas record is invalid.'))
        if (json.includes(BLOB_PREFIX)) {
          try { json = json.replace(/"nova-blob:[0-9a-f]{64}"/, m => JSON.stringify(this.readBlob(m.slice(1, -1)))) }
          catch { return out(fail('CORRUPT_RECORD', 'Saved canvas record is invalid.')) }
        }
        parts.push(`${JSON.stringify(row.id)}:${json}`)
      }
      const lease = this.leaseInfo(req.clientId, true, !!req.takeOver)
      return `{"ok":true,"revision":${head.revision},"snapshot":{"document":{"store":{${parts.join(',')}},"schema":${schema}},"session":${session}},"readOnly":${lease.readOnly},"leaseExpiresAt":"${lease.leaseExpiresAt}","stats":${JSON.stringify(this.stats())}}`
    })
  }

  heartbeat(req: { clientId: string }): Promise<ApiResult> {
    return this.serialize(() => {
      this.begin()
      const bad = this.checkClient(req?.clientId)
      if (bad) return bad
      return { ok: true, ...this.leaseInfo(req.clientId, true), stats: this.stats() }
    })
  }

  release(req: { clientId: string }): Promise<ApiResult> {
    return this.serialize(() => {
      this.begin()
      const bad = this.checkClient(req?.clientId)
      if (bad) return bad
      if (this.getLease()?.clientId === req.clientId) this.setLease(null, true)
      return { ok: true, stats: this.stats() }
    })
  }

  save(req: SaveRequest): Promise<ApiResult> {
    return this.serialize(() => this.saveChecked(req, false))
  }

  /**
   * Save a WHOLE snapshot (the v0.2 widget contract): every record in the snapshot is put (unchanged rows are
   * skipped by commit's effective-change-set), and records not in the snapshot are removed. All the usual checks
   * (replay, lease, revision) run first, in the same order as save().
   */
  saveSnapshot(req: { clientId: string; saveId: string; baseRevision: number; snapshot: unknown }): Promise<ApiResult> {
    return this.serialize(() => {
      if (!hasSnapshotShape(req?.snapshot)) {
        this.begin()
        return fail('INVALID_SNAPSHOT', 'Expected a tldraw snapshot with document and session. Nothing was saved.')
      }
      const snap = req.snapshot
      return this.saveChecked({
        clientId: req.clientId, saveId: req.saveId, baseRevision: req.baseRevision,
        puts: Object.values(snap.document.store), schema: snap.document.schema, session: snap.session,
      }, true)
    })
  }

  /** Shared body of save()/saveSnapshot(). `whole`: removes = every stored record the request does not put. */
  private async saveChecked(req: SaveRequest, whole: boolean): Promise<ApiResult> {
    {
      this.begin()
      const bad = this.checkClient(req?.clientId)
      if (bad) return bad
      const state = this.readHead()
      if ('error' in state) return fail(state.error.code!, state.error.code === 'CORRUPT_RECORD' ? 'Saved canvas data is damaged. Nothing was saved.' : state.error.message!)
      const { head } = state
      if (!head && this.missingHead(undefined)) return fail('MISSING_RECORD', 'The saved canvas data is missing. Nothing was saved.')
      if (head && isSaveId(req.saveId) && head.saveId === req.saveId && head.savedBy === req.clientId) {
        return { ok: true, revision: head.revision, savedAt: head.savedAt!, replayed: true, stats: this.stats() }
      }
      if (this.heldByOther(req.clientId)) return fail('LEASE_HELD', 'Another device has editing control. Nothing was saved.')
      const current = head?.revision ?? 0
      if (!Number.isSafeInteger(req.baseRevision) || req.baseRevision !== current) {
        return fail('CONFLICT', 'The server has a newer version of this canvas. Nothing was overwritten.', {
          revision: current, ownLastSaveId: head && head.savedBy === req.clientId ? head.saveId ?? null : null,
        })
      }
      if (!isSaveId(req.saveId)) return fail('INVALID_REQUEST', 'Missing save id.')
      if (whole) {
        const keep = new Set((req.puts ?? []).map(r => r?.id))
        const removes = this.run<{ id: string }>('SELECT id FROM records').map(r => r.id).filter(id => !keep.has(id))
        return this.commit(head, req.clientId, req.saveId, { ...req, removes })
      }
      return this.commit(head, req.clientId, req.saveId, req)
    }
  }

  /** Creates this (fresh) canvas from a whole snapshot. Retrying the same saveId is safe. */
  initFromSnapshot(req: { clientId: string; saveId: string; snapshot: unknown; importedRevision?: number; savedAt?: string }): Promise<ApiResult> {
    return this.serialize(async () => {
      this.begin()
      const bad = this.checkClient(req?.clientId)
      if (bad) return bad
      if (!isSaveId(req.saveId)) return fail('INVALID_REQUEST', 'Missing save id.')
      if (!hasSnapshotShape(req.snapshot)) return fail('INVALID_SNAPSHOT', 'Expected a tldraw snapshot with document and session. Nothing was saved.')
      const state = this.readHead()
      if ('error' in state) return state.error
      if (state.head) {
        if (state.head.saveId === req.saveId && state.head.savedBy === req.clientId) return { ok: true, revision: state.head.revision, savedAt: state.head.savedAt!, replayed: true, stats: this.stats() }
        return fail('CONFLICT', 'This canvas already exists.', { revision: state.head.revision })
      }
      const snap = req.snapshot
      const changes: Changes = { puts: Object.values(snap.document.store), schema: snap.document.schema, session: snap.session }
      const imported = Number.isSafeInteger(req.importedRevision) && req.importedRevision! >= 1 ? req.importedRevision : undefined
      return this.commit(null, req.clientId, req.saveId, changes, imported ? { revision: imported } : {})
    })
  }

  listCheckpoints(): Promise<ApiResult> {
    return this.serialize(() => {
      this.begin()
      const checkpoints = this.run<{ revision: number; saved_at: string; bytes: number }>('SELECT revision, saved_at, bytes FROM checkpoint_index ORDER BY revision DESC')
        .map((r): CheckpointInfo => ({ revision: r.revision, savedAt: r.saved_at, bytes: r.bytes }))
      return { ok: true, checkpoints, stats: this.stats() }
    })
  }

  /** Restores a checkpoint as a NEW revision. The current state is checkpointed first (or quarantined if damaged). */
  restoreCheckpoint(req: { clientId: string; saveId: string; checkpointRevision: number; expectedRevision: number | null; knownRevision?: number }): Promise<ApiResult> {
    return this.serialize(async () => {
      this.begin()
      const bad = this.checkClient(req?.clientId)
      if (bad) return bad
      if (!isSaveId(req.saveId) || !Number.isSafeInteger(req.checkpointRevision) || req.checkpointRevision < 1
        || !(req.expectedRevision === null || (Number.isSafeInteger(req.expectedRevision) && req.expectedRevision >= 0))) {
        return fail('INVALID_REQUEST', 'Checkpoint revision or save id is invalid.')
      }
      const checkpoint = await this.readCheckpoint(req.checkpointRevision)
      if (!checkpoint) return fail('BACKUP_UNAVAILABLE', 'That checkpoint is missing or invalid.')

      let head: Head | null = null
      let unavailable: string | null = null
      const state = this.readHead()
      if ('error' in state) { if (state.error.code === 'FORMAT_NEWER') return state.error; unavailable = state.error.code! }
      else if (!state.head) { if (this.missingHead(req.knownRevision)) unavailable = 'MISSING_RECORD' }
      else {
        head = state.head
        const loaded = this.assemble(head)
        if ('error' in loaded) unavailable = loaded.error.code!
      }
      if (head && head.saveId === req.saveId && head.savedBy === req.clientId) return { ok: true, revision: head.revision, savedAt: head.savedAt!, replayed: true, restoredRevision: req.checkpointRevision, stats: this.stats() }
      if (req.expectedRevision === null ? !unavailable : (unavailable || head?.revision !== req.expectedRevision)) {
        return fail('CONFLICT', 'The canvas changed after checkpoints were listed. Reload before restoring.')
      }
      if (this.heldByOther(req.clientId)) return fail('LEASE_HELD', 'Another editor has control. No checkpoint was restored.')

      // Never reuse a revision number a client may hold, even when the head row is unreadable.
      const rawRevision = Number(/"revision":(\d+)/.exec(this.kvGet('head') ?? '')?.[1] ?? 0)
      const known = Number.isSafeInteger(req.knownRevision) ? req.knownRevision! : 0
      const highest = Math.max(head?.revision ?? 0, rawRevision, known, ...this.checkpointRevisions(), req.checkpointRevision)
      let recoveryCopyPreserved = false
      if (unavailable === 'CORRUPT_RECORD' || unavailable === 'MISSING_RECORD') {
        this.quarantineEverything()
        recoveryCopyPreserved = true
      } else if (head && head.revision > 0) {
        await this.writeCheckpoint(head) // preserve the current state before replacing it
      }
      const desired = new Set(checkpoint.records.map(r => r.id))
      const removes = this.run<{ id: string }>('SELECT id FROM records').map(r => r.id).filter(id => !desired.has(id))
      const baseHead: Head | null = head ?? null
      const result = await this.commit(baseHead, req.clientId, req.saveId, {
        puts: checkpoint.records, removes, schema: checkpoint.schema, session: checkpoint.session,
      }, { trusted: true, revision: highest + 1, recordCount: checkpoint.records.length, restoredFrom: req.checkpointRevision, skipCheckpoint: true })
      return result.ok ? { ...result, restoredRevision: req.checkpointRevision, recoveryCopyPreserved } : result
    })
  }

  diagnostics(): Promise<Record<string, number | boolean>> {
    return this.serialize(() => {
      this.begin()
      const one = (q: string) => (this.run<{ n: number }>(q)[0]?.n ?? 0)
      return {
        ok: true,
        records: one('SELECT COUNT(*) AS n FROM records'),
        recordBytes: one('SELECT COALESCE(SUM(LENGTH(json)),0) AS n FROM records'),
        blobs: one('SELECT COUNT(*) AS n FROM blob_index'),
        blobChunks: one('SELECT COUNT(*) AS n FROM blobs'),
        blobBytes: one('SELECT COALESCE(SUM(bytes),0) AS n FROM blob_index'),
        checkpoints: one('SELECT COUNT(*) AS n FROM checkpoint_index'),
        checkpointBytes: one('SELECT COALESCE(SUM(bytes),0) AS n FROM checkpoint_index'),
        quarantined: one('SELECT COUNT(*) AS n FROM quarantine'),
        maxChunkBytes: Math.max(one('SELECT COALESCE(MAX(LENGTH(data)),0) AS n FROM blobs'), one('SELECT COALESCE(MAX(LENGTH(data)),0) AS n FROM checkpoint_chunks')),
        maxRecordBytes: one('SELECT COALESCE(MAX(LENGTH(json)),0) AS n FROM records'),
      }
    })
  }

  // ---------------------------------------------------------------- commit

  private async prepare(record: TLRecord, trusted: boolean): Promise<Prepared | ApiResult> {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || typeof record.typeName !== 'string'
      || !record.id.startsWith(`${record.typeName}:`)) return fail('INVALID_SNAPSHOT', 'A record has an invalid id or type. Nothing was saved.')
    let blob: Prepared['blob']
    let stored: TLRecord = record
    const src = (record as any).props?.src
    if (record.typeName === 'asset' && typeof src === 'string') {
      if (src.startsWith(BLOB_PREFIX)) {
        if (!trusted) return fail('INVALID_SNAPSHOT', 'Image references cannot be supplied by a client. Nothing was saved.')
      } else if (src.length > INLINE_SRC_MAX) {
        const bytes = encoder.encode(src)
        const hash = await sha256Hex(bytes)
        blob = { hash, bytes }
        stored = { ...record, props: { ...(record as any).props, src: `${BLOB_PREFIX}${hash}` } }
      }
    }
    const json = JSON.stringify(stored)
    if (json.length * 3 > MAX_RECORD_BYTES && encoder.encode(json).length > MAX_RECORD_BYTES) {
      return fail('RECORD_TOO_LARGE', `Record ${record.id} is larger than ${MAX_RECORD_BYTES} bytes. Nothing was saved.`)
    }
    return { id: record.id, type: record.typeName, json, blob }
  }

  private async commit(
    head: Head | null, clientId: string, saveId: string, changes: Changes,
    opts: { trusted?: boolean; revision?: number; recordCount?: number; restoredFrom?: number; skipCheckpoint?: boolean } = {},
  ): Promise<ApiResult> {
    const trusted = !!opts.trusted
    const putsIn = changes.puts ?? []
    const removesIn = changes.removes ?? []
    if (!Array.isArray(putsIn) || !Array.isArray(removesIn) || removesIn.some(id => typeof id !== 'string')) return fail('INVALID_REQUEST', 'puts and removes must be arrays.')

    const firstSave = !head || this.kvGet('schema') === null
    if (firstSave && (changes.schema === undefined || changes.session === undefined)) {
      return fail('INVALID_SNAPSHOT', 'The first save of a canvas must include schema and session. Nothing was saved.')
    }
    if (changes.schema !== undefined && (typeof changes.schema !== 'object' || changes.schema === null)) return fail('INVALID_SNAPSHOT', 'Invalid schema. Nothing was saved.')
    if (changes.session !== undefined && (typeof changes.session !== 'object' || changes.session === null)) return fail('INVALID_SNAPSHOT', 'Invalid session. Nothing was saved.')

    const prepared = new Map<string, Prepared>()
    let totalBytes = 0
    for (const record of putsIn) {
      const p = await this.prepare(record, trusted)
      if ('ok' in p) return p
      prepared.set(p.id, p)
      totalBytes += p.json.length + (p.blob?.bytes.length ?? 0)
    }
    if (totalBytes > MAX_SAVE_BYTES * 4) return fail('TOO_LARGE', 'This save is too large. Nothing was saved.', { bytes: totalBytes, limit: MAX_SAVE_BYTES })
    for (const id of removesIn) if (prepared.has(id)) return fail('INVALID_REQUEST', `Record ${id} is both put and removed.`)

    // Effective change set: skip puts identical to what is stored (saves row writes), and removes of absent ids.
    const effectivePuts: Prepared[] = []
    let newRecords = 0
    for (const p of prepared.values()) {
      const existing = this.run<{ json: string }>('SELECT json FROM records WHERE id = ?', p.id)
      if (!existing.length) newRecords++
      if (!existing.length || existing[0].json !== p.json) effectivePuts.push(p)
    }
    const effectiveRemoves: string[] = []
    let removedAssets = false
    for (const id of removesIn) {
      const existing = this.run<{ type: string }>('SELECT type FROM records WHERE id = ?', id)
      if (existing.length) { effectiveRemoves.push(id); if (existing[0].type === 'asset') removedAssets = true }
    }
    const schemaRaw = changes.schema !== undefined ? JSON.stringify(changes.schema) : undefined
    const sessionRaw = changes.session !== undefined ? JSON.stringify(changes.session) : undefined
    const writeSchema = schemaRaw !== undefined && schemaRaw !== this.kvGet('schema')
    const writeSession = sessionRaw !== undefined && sessionRaw !== this.kvGet('session')

    const documentChanged = effectivePuts.length > 0 || effectiveRemoves.length > 0 || writeSchema
    const savedAt = this.iso()
    let lastCheckpointAt = head?.lastCheckpointAt ?? null
    let lastCheckpointRevision = head?.lastCheckpointRevision ?? null
    let checkpointed = false
    if (head && head.revision > 0 && documentChanged && !opts.skipCheckpoint) {
      const due = lastCheckpointAt === null || this.clock() - Date.parse(lastCheckpointAt) >= this.policy.checkpointMinIntervalMs
      if (due) {
        // Backup of the prior revision, before the commit point. A failure here leaves the previous revision intact.
        await this.writeCheckpoint(head)
        lastCheckpointAt = savedAt
        lastCheckpointRevision = head.revision
        checkpointed = true
      }
    } else if (opts.skipCheckpoint && head) {
      lastCheckpointAt = savedAt; lastCheckpointRevision = head.revision
    }

    const revision = opts.revision ?? (head?.revision ?? 0) + 1
    const nextHead: Head = {
      format: FORMAT_VERSION, revision, saveId, savedBy: clientId, savedAt,
      recordCount: opts.recordCount ?? (head?.recordCount ?? 0) + newRecords - effectiveRemoves.length,
      createdAt: head?.createdAt ?? savedAt, lastCheckpointAt, lastCheckpointRevision,
      ...(opts.restoredFrom ? { restoredFrom: opts.restoredFrom } : {}),
    }

    if (this.faults.beforeCommit) throw new Error('injected failure before commit')

    // ---- COMMIT POINT: one atomic transaction. Either every row of this save lands, or none.
    this.ctx.storage.transactionSync(() => {
      for (const p of effectivePuts) {
        if (p.blob) this.storeBlob(p.blob)
        this.run('INSERT OR REPLACE INTO records (id, type, json) VALUES (?, ?, ?)', p.id, p.type, p.json)
      }
      for (const id of effectiveRemoves) this.run('DELETE FROM records WHERE id = ?', id)
      if (writeSchema) this.kvPut('schema', schemaRaw!)
      if (writeSession) this.kvPut('session', sessionRaw!)
      this.kvPut('head', JSON.stringify(nextHead))
    })

    // ---- After the commit point: failures here must not turn a committed save into a reported failure.
    const warnings: string[] = []
    try { this.leaseInfo(clientId, true) } catch (error) { warnings.push(`lease: ${(error as Error).message}`) }
    try {
      if (this.faults.afterCommit) throw new Error('injected failure after commit')
      const pruned = this.pruneCheckpoints()
      if (removedAssets || pruned) this.collectBlobs()
    } catch (error) {
      warnings.push(`cleanup: ${(error as Error).message}`)
      console.error(`revision ${revision} committed; follow-up failed (${(error as Error).message})`)
    }
    return {
      ok: true, revision, savedAt, checkpointed, stats: this.stats(),
      ...(warnings.length ? { warning: `Saved, but ${warnings.join(' and ')} failed.` } : {}),
    }
  }

  // ---------------------------------------------------------------- checkpoints

  /** Inserts an image payload (chunked) unless a blob with the same hash is already stored. Call inside a transaction. */
  private storeBlob(blob: { hash: string; bytes: Uint8Array }) {
    if (this.run('SELECT 1 FROM blob_index WHERE hash = ?', blob.hash).length) return
    const chunks = Math.ceil(blob.bytes.length / CHUNK_BYTES)
    for (let i = 0; i < chunks; i++) {
      this.run('INSERT INTO blobs (hash, idx, data) VALUES (?, ?, ?)', blob.hash, i, toBuffer(blob.bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)))
    }
    this.run('INSERT INTO blob_index (hash, chunks, bytes) VALUES (?, ?, ?)', blob.hash, chunks, blob.bytes.length)
  }

  private async storeCheckpoint(revision: number, savedAt: string, text: string, refs: Iterable<string>, blobs: Array<{ hash: string; bytes: Uint8Array }> = []) {
    const bytes = await gzip(text)
    const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES))
    this.ctx.storage.transactionSync(() => {
      for (const blob of blobs) this.storeBlob(blob)
      this.run('DELETE FROM checkpoint_chunks WHERE revision = ?', revision)
      for (let i = 0; i < chunks; i++) {
        this.run('INSERT INTO checkpoint_chunks (revision, idx, data) VALUES (?, ?, ?)', revision, i, toBuffer(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)))
      }
      this.run('INSERT OR REPLACE INTO checkpoint_index (revision, saved_at, chunks, bytes, refs) VALUES (?, ?, ?, ?, ?)', revision, savedAt, chunks, bytes.length, JSON.stringify([...refs]))
    })
  }

  private async writeCheckpoint(head: Head) {
    const rows = this.run<{ json: string }>('SELECT json FROM records')
    const refs = new Set<string>()
    for (const row of rows) {
      if (!row.json.includes(BLOB_PREFIX)) continue // one pass over the rows already read; no second table scan
      for (const m of row.json.matchAll(/nova-blob:([0-9a-f]{64})/g)) refs.add(m[1])
    }
    const text = `{"revision":${head.revision},"schema":${this.kvGet('schema') ?? 'null'},"session":${this.kvGet('session') ?? 'null'},"records":[${rows.map(r => r.json).join(',')}]}`
    await this.storeCheckpoint(head.revision, head.savedAt ?? this.iso(), text, refs)
  }

  /** Migration: stores an old (v0.2.x) backup snapshot as a checkpoint at its original revision. */
  importCheckpoint(req: { clientId: string; revision: number; savedAt?: string; snapshot: unknown }): Promise<ApiResult> {
    return this.serialize(async () => {
      this.begin()
      const bad = this.checkClient(req?.clientId)
      if (bad) return bad
      if (!Number.isSafeInteger(req.revision) || req.revision < 1) return fail('INVALID_REQUEST', 'Invalid revision.')
      if (!hasSnapshotShape(req.snapshot)) return fail('INVALID_SNAPSHOT', 'Expected a tldraw snapshot with document and session.')
      const records: string[] = []
      const blobs: Array<{ hash: string; bytes: Uint8Array }> = []
      const refs = new Set<string>()
      for (const record of Object.values(req.snapshot.document.store)) {
        const p = await this.prepare(record, false)
        if ('ok' in p) return p
        records.push(p.json)
        if (p.blob) { blobs.push(p.blob); refs.add(p.blob.hash) }
      }
      const text = `{"revision":${req.revision},"schema":${JSON.stringify(req.snapshot.document.schema)},"session":${JSON.stringify(req.snapshot.session)},"records":[${records.join(',')}]}`
      await this.storeCheckpoint(req.revision, typeof req.savedAt === 'string' ? req.savedAt : this.iso(), text, refs, blobs)
      this.pruneCheckpoints()
      return { ok: true, revision: req.revision, stats: this.stats() }
    })
  }

  private async readCheckpoint(revision: number): Promise<{ schema: unknown; session: unknown; records: TLRecord[] } | null> {
    try {
      const index = this.run<{ chunks: number; bytes: number }>('SELECT chunks, bytes FROM checkpoint_index WHERE revision = ?', revision)
      if (!index.length) return null
      const rows = this.run<{ data: ArrayBuffer }>('SELECT data FROM checkpoint_chunks WHERE revision = ? ORDER BY idx', revision)
      if (rows.length !== index[0].chunks) return null
      const bytes = concat(rows.map(r => r.data))
      if (bytes.length !== index[0].bytes) return null
      const doc = JSON.parse(await gunzip(bytes))
      if (!Array.isArray(doc.records) || !doc.schema || !doc.session) return null
      for (const record of doc.records) {
        const src = record?.props?.src
        if (record.typeName === 'asset' && typeof src === 'string' && src.startsWith(BLOB_PREFIX)
          && !this.run('SELECT 1 FROM blob_index WHERE hash = ?', src.slice(BLOB_PREFIX.length)).length) return null
      }
      return doc
    } catch { return null }
  }

  private pruneCheckpoints(): number {
    const doomed = this.checkpointRevisions().slice(this.policy.checkpointKeep)
    for (const revision of doomed) {
      this.run('DELETE FROM checkpoint_chunks WHERE revision = ?', revision)
      this.run('DELETE FROM checkpoint_index WHERE revision = ?', revision)
    }
    return doomed.length
  }

  /** Deletes image payloads no live asset record and no retained checkpoint refers to. */
  private collectBlobs() {
    const live = new Set<string>()
    for (const row of this.run<{ json: string }>("SELECT json FROM records WHERE type = 'asset'")) {
      for (const m of row.json.matchAll(/nova-blob:([0-9a-f]{64})/g)) live.add(m[1])
    }
    for (const row of this.run<{ refs: string }>('SELECT refs FROM checkpoint_index')) for (const h of JSON.parse(row.refs) as string[]) live.add(h)
    for (const { hash } of this.run<{ hash: string }>('SELECT hash FROM blob_index')) {
      if (live.has(hash)) continue
      this.run('DELETE FROM blobs WHERE hash = ?', hash)
      this.run('DELETE FROM blob_index WHERE hash = ?', hash)
    }
  }

  private quarantineEverything() {
    const at = this.iso()
    this.ctx.storage.transactionSync(() => {
      this.run("INSERT OR REPLACE INTO quarantine (at, source, id, json) SELECT ?, 'records', id, json FROM records", at)
      this.run("INSERT OR REPLACE INTO quarantine (at, source, id, json) SELECT ?, 'kv', key, value FROM kv WHERE key != 'lease'", at)
    })
  }

  // ---------------------------------------------------------------- diagnostics (generated data only)

  /**
   * One measured step of the go/no-go diagnostics. Each call is its own Durable Object invocation, so `wrangler tail`
   * reports a separate cpuTime/wallTime for it; the console.log line lets tools/tail-report.mjs match the two.
   * SAFETY: only runs on a canvas that is empty (never saved) or already marked as diagnostic, and `purge` only
   * deletes a marked canvas. A real canvas can therefore never be generated over, saved to, or deleted by this.
   */
  async diagOp(a: { op: string; label?: string; run: string; size: string; strokes?: number; imageBytes?: number }): Promise<Record<string, any>> {
    const clientId = '00000000-0000-4000-8000-0000000000d1'
    const known = ['generate', 'fullSave', 'open', 'openRaw', 'incrementalSave', 'cameraSave', 'checkpoint', 'heartbeat', 'purge']
    if (!known.includes(a?.op)) return fail('INVALID_REQUEST', 'Unknown diagnostic step.')
    const marked = await this.serialize(() => {
      this.begin()
      if (this.kvGet('diag') === '1') return true
      const state = this.readHead()
      if ('error' in state || state.head || this.missingHead(undefined)) return false
      this.kvPut('diag', '1')
      return true
    })
    if (marked !== true) return fail('NOT_DIAGNOSTIC', 'Refusing: this canvas is not a generated diagnostic canvas.')
    console.log(JSON.stringify({ diag: 1, run: a.run, size: a.size, op: a.label ?? a.op }))

    const strip = (r: ApiResult) => ({ ok: r.ok, ...(r.code ? { code: r.code, message: r.message } : {}), revision: r.revision, stats: r.stats })
    const revision = () => { const s = this.readHead(); return 'head' in s && s.head ? s.head.revision : 0 }
    const spec = { strokes: a.strokes ?? 0, imageBytes: a.imageBytes }
    switch (a.op) {
      case 'generate':
        this.diagSnap = makeDiagSnapshot(spec)
        return { ok: true, records: Object.keys(this.diagSnap.document.store).length }
      case 'fullSave': {
        const snapshot = this.diagSnap ?? makeDiagSnapshot(spec)
        return strip(await this.saveSnapshot({ clientId, saveId: `diag-${a.run}-full`.slice(0, 64), baseRevision: revision(), snapshot }))
      }
      case 'open': {
        const r = await this.open({ clientId })
        return { ...strip(r), records: r.snapshot ? Object.keys(r.snapshot.document.store).length : 0 } // the snapshot itself stays here
      }
      case 'openRaw': {
        const text = await this.openRaw({ clientId })
        return { ok: text.startsWith('{"ok":true'), bytes: text.length }
      }
      case 'incrementalSave': {
        const base = revision()
        const puts = [0, 1, 2].map(i => { const n = base * 10 + i; const p = strokeRecord(n, 120, 'x', lateIndexKey(n)); p.x = 900 + i * 30; p.y = 900; return p })
        return strip(await this.save({ clientId, saveId: `diag-${a.run}-inc${base}`.slice(0, 64), baseRevision: base, puts, session: movedSession(this.diagSnap?.session ?? makeDiagSnapshot({ strokes: 0 }).session, base) }))
      }
      case 'cameraSave': {
        const base = revision()
        return strip(await this.save({ clientId, saveId: `diag-${a.run}-cam${base}`.slice(0, 64), baseRevision: base, session: movedSession(makeDiagSnapshot({ strokes: 0 }).session, base + 7) }))
      }
      case 'checkpoint':
        return this.serialize(async () => {
          this.begin()
          const state = this.readHead()
          if ('error' in state || !state.head) return fail('NOT_FOUND', 'Nothing to checkpoint.')
          await this.writeCheckpoint(state.head)
          return { ok: true, stats: this.stats() }
        })
      case 'heartbeat':
        return strip(await this.heartbeat({ clientId }))
      case 'purge':
        return this.serialize(async () => {
          if (this.kvGet('diag') !== '1') return fail('NOT_DIAGNOSTIC', 'Refusing to delete a canvas that is not a generated diagnostic canvas.')
          await this.ctx.storage.deleteAll()
          this.lease = undefined
          this.diagSnap = null
          this.migrate()
          return { ok: true }
        })
    }
    return fail('INVALID_REQUEST', 'Unknown diagnostic step.')
  }
}
