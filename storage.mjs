/** NOVA Ink v0.2 private, single-process development notebook store. */
import { mkdir, readFile, rename, readdir, unlink, writeFile } from 'node:fs/promises'
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
    try { return JSON.parse(await readFile(this.canvasFile(id), 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return { revision: 0, snapshot: null }; throw e }
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

  async open(id, clientId) { return this.serialize(async () => {
    this.checkClient(clientId)
    const m = await this.loadManifest()
    const canvas = m.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
    const record = await this.loadRecord(id)
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

  async save(id, clientId, expectedRevision, snapshot) { return this.serialize(async () => {
    this.checkClient(clientId)
    const manifest = await this.loadManifest()
    const canvas = manifest.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas not found.' }
    if (this.leaseInfo(id, clientId, false).readOnly || this.leases.get(id)?.clientId !== clientId) {
      return { ok: false, code: 'LEASE_LOST', message: 'Another editor has control. No changes were saved.' }
    }
    const current = await this.loadRecord(id)
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
      return { ok: false, code: 'CONFLICT', revision: current.revision, message: 'The server has a newer revision. Nothing was overwritten.' }
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !snapshot.document || !snapshot.session) {
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
    // Retain 5 backup revisions, so a mistake or bad write is recoverable manually.
    const files = (await readdir(path.join(this.dir, 'backups'))).filter(f => f.startsWith(`${id}-`) && f.endsWith('.json'))
    const older = files.map(f => ({ name: f, n: Number(f.slice(id.length + 1, -5)) })).sort((a,b) => b.n - a.n).slice(5)
    for (const file of older) await unlink(path.join(this.dir, 'backups', file.name))
    return { ok: true, revision: next.revision, savedAt: canvas.updatedAt }
  }) }
}
