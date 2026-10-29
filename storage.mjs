/** NOVA Ink v0.2 private, single-process development notebook store. */
import { copyFile, mkdir, readFile, rename, readdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_DATA_DIR = process.env.NOVA_INK_DATA_DIR || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NOVA-Ink', 'data',
)
export const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024
export const LEASE_MS = 45_000

const isId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const now = () => new Date().toISOString()

function hasSnapshotShape(snapshot) {
  return !!snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && !!snapshot.document && !!snapshot.session
}

function isSnapshot(snapshot) {
  if (!hasSnapshotShape(snapshot)) return false
  try {
    const serialized = JSON.stringify(snapshot)
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= MAX_SNAPSHOT_BYTES
  } catch { return false }
}

function isRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Number.isSafeInteger(record.revision) || record.revision < 0) return false
  return record.revision === 0 ? record.snapshot === null : isSnapshot(record.snapshot)
}

function corruptRecordError() {
  const error = new Error('Saved canvas record is unreadable or invalid.')
  error.code = 'CORRUPT_RECORD'
  return error
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}

export class NotebookStore {
  constructor(dir = DEFAULT_DATA_DIR) {
    this.dir = dir
    this.leases = new Map()
    this.tail = Promise.resolve()
  }

  async serialize(task) {
    const prev = this.tail
    let unlock
    this.tail = new Promise(resolve => { unlock = resolve })
    await prev
    try { return await task() } finally { unlock() }
  }

  async loadManifest() {
    await mkdir(path.join(this.dir, 'canvases'), { recursive: true })
    await mkdir(path.join(this.dir, 'backups'), { recursive: true })
    try { return JSON.parse(await readFile(path.join(this.dir, 'manifest.json'), 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return { version: 1, lastOpenedId: null, canvases: [] }; throw e }
  }

  async writeManifest(manifest) { await atomicJson(path.join(this.dir, 'manifest.json'), manifest) }
  canvasFile(id) {
    if (!isId(id)) throw new Error('Invalid canvas id')
    return path.join(this.dir, 'canvases', `${id}.json`)
  }
  async loadRecord(id) {
    let raw
    try { raw = await readFile(this.canvasFile(id), 'utf8') }
    catch (e) { if (e.code === 'ENOENT') return { revision: 0, snapshot: null }; throw e }
    let record
    try { record = JSON.parse(raw) } catch { throw corruptRecordError() }
    if (!isRecord(record)) throw corruptRecordError()
    return record
  }

  async readValidBackups(id) {
    const directory = path.join(this.dir, 'backups')
    const files = await readdir(directory)
    const prefix = `${id}-`
    const backups = []
    for (const name of files) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      const revisionText = name.slice(prefix.length, -5)
      if (!/^\d+$/.test(revisionText)) continue
      const revision = Number(revisionText)
      if (!Number.isSafeInteger(revision) || revision < 1) continue
      let record
      try { record = JSON.parse(await readFile(path.join(directory, name), 'utf8')) }
      catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) continue; throw e }
      if (isRecord(record) && record.revision === revision) backups.push({ revision, record })
    }
    return backups.sort((a, b) => b.revision - a.revision)
  }

  async trimBackups(id) {
    const directory = path.join(this.dir, 'backups')
    const prefix = `${id}-`
    const keep = new Set((await this.readValidBackups(id)).slice(0, 5).map(backup => backup.revision))
    for (const name of await readdir(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      const revisionText = name.slice(prefix.length, -5)
      if (!/^\d+$/.test(revisionText)) continue
      const revision = Number(revisionText)
      if (Number.isSafeInteger(revision) && revision > 0 && !keep.has(revision)) await unlink(path.join(directory, name))
    }
  }

  leaseInfo(id, clientId, acquire) {
    const current = this.leases.get(id)
    const t = Date.now()
    if (!current || current.until <= t || current.clientId === clientId) {
      if (acquire) this.leases.set(id, { clientId, until: t + LEASE_MS })
      return { readOnly: false, leaseExpiresAt: new Date(t + LEASE_MS).toISOString() }
    }
    return { readOnly: true, leaseExpiresAt: new Date(current.until).toISOString() }
  }
  checkClient(clientId) { if (!isId(clientId)) throw new Error('Invalid editor client id') }

  async list() { return this.serialize(async () => {
    const manifest = await this.loadManifest()
    if (!manifest.canvases.length) {
      const id = randomUUID()
      manifest.canvases.push({ id, name: 'My First Canvas', createdAt: now(), updatedAt: now() })
      manifest.lastOpenedId = id
      await this.writeManifest(manifest)
    }
    return { ok: true, lastOpenedId: manifest.lastOpenedId, canvases: [...manifest.canvases].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)) }
  }) }

  async create(name) { return this.serialize(async () => {
    const cleaned = typeof name === 'string' ? name.trim().slice(0, 80) : ''
    if (!cleaned) return { ok: false, code: 'INVALID_NAME', message: 'Enter a canvas name.' }
    const m = await this.loadManifest()
    const id = randomUUID()
    const metadata = { id, name: cleaned, createdAt: now(), updatedAt: now() }
    m.canvases.push(metadata)
    m.lastOpenedId = id
    await this.writeManifest(m)
    return { ok: true, canvas: metadata }
  }) }

  async listBackups(id) { return this.serialize(async () => {
    if (!isId(id)) return { ok: false, code: 'INVALID_ID', message: 'Canvas id is invalid.' }
    const manifest = await this.loadManifest()
    if (!manifest.canvases.some(canvas => canvas.id === id)) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
    const backups = await this.readValidBackups(id)
    return { ok: true, backups: backups.map(({ revision }) => ({ revision })) }
  }) }

  async open(id, clientId) { return this.serialize(async () => {
    this.checkClient(clientId)
    const m = await this.loadManifest()
    const canvas = m.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
    let record
    try { record = await this.loadRecord(id) }
    catch (error) {
      if (error.code === 'CORRUPT_RECORD') return { ok: false, code: 'CORRUPT_RECORD', message: 'This canvas file is damaged. Choose a valid backup to restore it.' }
      throw error
    }
    const lease = this.leaseInfo(id, clientId, true)
    m.lastOpenedId = id
    await this.writeManifest(m)
    return { ok: true, canvas, revision: record.revision, snapshot: record.snapshot, ...lease }
  }) }

  async heartbeat(id, clientId) { return this.serialize(async () => {
    this.checkClient(clientId)
    const m = await this.loadManifest()
    if (!m.canvases.some(c => c.id === id)) return { ok: false, code: 'NOT_FOUND' }
    return { ok: true, ...this.leaseInfo(id, clientId, true) }
  }) }

  async release(id, clientId) { return this.serialize(async () => {
    this.checkClient(clientId)
    if (this.leases.get(id)?.clientId === clientId) this.leases.delete(id)
    return { ok: true }
  }) }

  async restoreBackup(id, clientId, backupRevision, expectedCurrentRevision) { return this.serialize(async () => {
    this.checkClient(clientId)
    if (!isId(id) || !Number.isSafeInteger(backupRevision) || backupRevision < 1 || !(expectedCurrentRevision === null || (Number.isSafeInteger(expectedCurrentRevision) && expectedCurrentRevision >= 0))) {
      return { ok: false, code: 'INVALID_REQUEST', message: 'Canvas or backup revision is invalid.' }
    }
    const manifest = await this.loadManifest()
    const canvas = manifest.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
    const backups = await this.readValidBackups(id)
    const selected = backups.find(backup => backup.revision === backupRevision)
    if (!selected) return { ok: false, code: 'BACKUP_UNAVAILABLE', message: 'That backup is missing or invalid.' }

    let current
    let currentCorrupt = false
    try { current = await this.loadRecord(id) }
    catch (error) {
      if (error.code !== 'CORRUPT_RECORD') throw error
      currentCorrupt = true
    }
    if (expectedCurrentRevision === null ? !currentCorrupt : (currentCorrupt || current.revision !== expectedCurrentRevision)) {
      return { ok: false, code: 'CONFLICT', message: 'The canvas changed after backups were listed. Reload before restoring.' }
    }

    const lease = this.leaseInfo(id, clientId, true)
    if (lease.readOnly) return { ok: false, code: 'LEASE_HELD', message: 'Another editor has control. No backup was restored.' }
    const nextRevision = Math.max(current?.revision ?? 0, ...backups.map(backup => backup.revision)) + 1
    if (!Number.isSafeInteger(nextRevision)) return { ok: false, code: 'REVISION_LIMIT', message: 'Canvas revision limit reached.' }

    let recoveryCopyPreserved = false
    if (currentCorrupt) {
      const recoveryDirectory = path.join(this.dir, 'recovery')
      await mkdir(recoveryDirectory, { recursive: true })
      const preserved = path.join(recoveryDirectory, `${id}-${Date.now()}-${randomUUID()}.corrupt`)
      await copyFile(this.canvasFile(id), preserved)
      recoveryCopyPreserved = true
    } else if (current && current.revision > 0) {
      await atomicJson(path.join(this.dir, 'backups', `${id}-${current.revision}.json`), current)
    }

    const restored = { revision: nextRevision, snapshot: selected.record.snapshot }
    await atomicJson(this.canvasFile(id), restored)
    canvas.updatedAt = now()
    manifest.lastOpenedId = id
    await this.writeManifest(manifest)
    await this.trimBackups(id)
    this.leaseInfo(id, clientId, true)
    return { ok: true, revision: nextRevision, restoredRevision: backupRevision, recoveryCopyPreserved, savedAt: canvas.updatedAt }
  }) }

  async save(id, clientId, expectedRevision, snapshot) { return this.serialize(async () => {
    this.checkClient(clientId)
    const manifest = await this.loadManifest()
    const canvas = manifest.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas not found.' }
    const lease = this.leases.get(id)
    if (!lease || lease.clientId !== clientId || lease.until <= Date.now()) {
      return { ok: false, code: 'LEASE_LOST', message: 'Your editing lease expired or another editor has control. No changes were saved.' }
    }
    let current
    try { current = await this.loadRecord(id) }
    catch (error) {
      if (error.code === 'CORRUPT_RECORD') return { ok: false, code: 'CORRUPT_RECORD', message: 'Saved canvas data is damaged. Restore a valid backup before saving.' }
      throw error
    }
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
      return { ok: false, code: 'CONFLICT', revision: current.revision, message: 'The server has a newer revision. Nothing was overwritten.' }
    }
    if (!hasSnapshotShape(snapshot)) {
      return { ok: false, code: 'INVALID_SNAPSHOT', message: 'Expected a tldraw snapshot with document and session.' }
    }
    const serialized = JSON.stringify(snapshot)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
      return { ok: false, code: 'TOO_LARGE', message: 'Canvas exceeds the 12 MB prototype snapshot limit.' }
    }
    if (current.revision > 0) {
      // Keep the previous revision in a separate backup file before replacing it.
      await atomicJson(path.join(this.dir, 'backups', `${id}-${current.revision}.json`), current)
    }
    const next = { revision: current.revision + 1, snapshot }
    await atomicJson(this.canvasFile(id), next)
    canvas.updatedAt = now()
    await this.writeManifest(manifest)
    this.leaseInfo(id, clientId, true)
    // Retain 5 prior revisions so a mistake or bad write can be recovered manually.
    await this.trimBackups(id)
    return { ok: true, revision: next.revision, savedAt: canvas.updatedAt }
  }) }
}
