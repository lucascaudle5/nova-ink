/** NOVA Ink private, single-process notebook store. */
import { copyFile, mkdir, open, readFile, rename, readdir, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_DATA_DIR = process.env.NOVA_INK_DATA_DIR || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NOVA-Ink', 'data',
)
export const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024
export const LEASE_MS = 45_000
export const BACKUP_COUNT = 10
export const MANIFEST_VERSION = 1

const MANIFEST = 'manifest.json'
const MANIFEST_BACKUP = 'manifest.backup.json'
const isId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const isSaveId = id => typeof id === 'string' && id.length > 0 && id.length <= 64
const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function storageError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function hasSnapshotShape(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  const { document, session } = snapshot
  if (!document || typeof document !== 'object' || !session || typeof session !== 'object') return false
  return !!document.store && typeof document.store === 'object' && !Array.isArray(document.store)
    && !!document.schema && typeof document.schema === 'object'
}

function snapshotBytes(snapshot) {
  try { return Buffer.byteLength(JSON.stringify(snapshot), 'utf8') } catch { return Infinity }
}

function isSnapshot(snapshot) {
  return hasSnapshotShape(snapshot) && snapshotBytes(snapshot) <= MAX_SNAPSHOT_BYTES
}

function isRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Number.isSafeInteger(record.revision) || record.revision < 0) return false
  return record.revision === 0 ? record.snapshot === null : isSnapshot(record.snapshot)
}

function isManifestEntry(entry) {
  return !!entry && typeof entry === 'object' && isId(entry.id) && typeof entry.name === 'string'
    && typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string'
}

function checkManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return 'invalid'
  if (typeof manifest.version === 'number' && manifest.version > MANIFEST_VERSION) return 'newer'
  if (manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.canvases)) return 'invalid'
  if (!manifest.canvases.every(isManifestEntry)) return 'invalid'
  if (!(manifest.lastOpenedId === null || typeof manifest.lastOpenedId === 'string')) return 'invalid'
  return 'ok'
}

async function renameWithRetry(from, to) {
  // Windows antivirus/indexers briefly hold new files open, failing rename with EPERM/EBUSY.
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to) }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      await sleep(40 * (attempt + 1))
    }
  }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally { await handle.close() }
    await renameWithRetry(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function readJson(file) {
  const raw = await readFile(file, 'utf8')
  try { return { raw, value: JSON.parse(raw) } } catch { return { raw, value: undefined } }
}

function documentsEqual(a, b) {
  try { return JSON.stringify(a?.document) === JSON.stringify(b?.document) } catch { return false }
}

export class NotebookStore {
  constructor(dir = DEFAULT_DATA_DIR, { log = (...args) => console.error('[nova-ink]', ...args) } = {}) {
    this.dir = dir
    this.log = log
    this.leases = new Map()
    this.tail = Promise.resolve()
    this.notice = null
    this.orphansChecked = false
  }

  async serialize(task) {
    const prev = this.tail
    let unlock
    this.tail = new Promise(resolve => { unlock = resolve })
    await prev
    try { return await task() } finally { unlock() }
  }

  file(...parts) { return path.join(this.dir, ...parts) }

  canvasFile(id) {
    if (!isId(id)) throw new Error('Invalid canvas id')
    return this.file('canvases', `${id}.json`)
  }

  async ensureDirs() {
    await mkdir(this.file('canvases'), { recursive: true })
    await mkdir(this.file('backups'), { recursive: true })
  }

  async quarantine(source, label) {
    await mkdir(this.file('recovery'), { recursive: true })
    const target = this.file('recovery', `${label}-${Date.now()}-${randomUUID()}.corrupt`)
    await copyFile(source, target)
    return target
  }

  async loadManifest() {
    await this.ensureDirs()
    let primary = null
    try { primary = await readJson(this.file(MANIFEST)) }
    catch (e) { if (e.code !== 'ENOENT') throw e }

    if (primary) {
      const state = checkManifest(primary.value)
      if (state === 'newer') throw storageError('MANIFEST_NEWER', 'This notebook library was written by a newer NOVA Ink version. Update NOVA Ink before opening it.')
      if (state === 'ok') return this.discoverOrphans(primary.value)
    }

    // The primary manifest is missing or unreadable; never treat existing canvases as a new library.
    let fallback = null
    try { fallback = await readJson(this.file(MANIFEST_BACKUP)) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if (primary) await this.quarantine(this.file(MANIFEST), 'manifest')

    if (fallback && checkManifest(fallback.value) === 'ok') {
      const manifest = await this.addOrphans(fallback.value)
      await this.writeManifest(manifest)
      this.notice = { kind: 'MANIFEST_RESTORED', message: 'The notebook index was unreadable and was restored from its automatic copy. A copy of the damaged index was kept in recovery.' }
      this.log('manifest restored from manifest.backup.json')
      return manifest
    }

    const rebuilt = await this.addOrphans({ version: MANIFEST_VERSION, lastOpenedId: null, canvases: [] })
    if (!rebuilt.canvases.length) return rebuilt
    if (fallback) await this.quarantine(this.file(MANIFEST_BACKUP), 'manifest-backup')
    rebuilt.lastOpenedId = rebuilt.canvases[0].id
    await this.writeManifest(rebuilt)
    this.notice = { kind: 'MANIFEST_REBUILT', message: `The notebook index was ${primary ? 'unreadable' : 'missing'}, so NOVA Ink rebuilt it from ${rebuilt.canvases.length} saved canvas file(s). Check canvas names.` }
    this.log(`manifest rebuilt from ${rebuilt.canvases.length} canvas file(s)`)
    return rebuilt
  }

  /** Adds canvases that have saved files or backups but no manifest entry. */
  async addOrphans(manifest) {
    const known = new Set(manifest.canvases.map(c => c.id))
    const found = new Map()
    for (const name of await readdir(this.file('canvases'))) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (isId(id) && !known.has(id)) found.set(id, { file: true })
    }
    for (const name of await readdir(this.file('backups'))) {
      const match = /^([0-9a-f-]{36})-\d+\.json$/.exec(name)
      if (match && !known.has(match[1]) && !found.has(match[1])) found.set(match[1], { file: false })
    }
    let added = 0
    for (const [id, { file }] of found) {
      let meta = null, revision
      if (file) {
        try {
          const { value } = await readJson(this.canvasFile(id))
          if (value && typeof value === 'object') { meta = value.meta; revision = value.revision }
        } catch { /* unreadable files are still listed so recovery can be offered */ }
      }
      const stamp = typeof meta?.createdAt === 'string' ? meta.createdAt : now()
      manifest.canvases.push({
        id, name: typeof meta?.name === 'string' && meta.name.trim() ? meta.name : `Recovered canvas ${id.slice(0, 8)}`,
        createdAt: stamp, updatedAt: now(), ...(Number.isSafeInteger(revision) ? { revision } : { revision: 1 }),
      })
      added++
    }
    if (added) this.log(`added ${added} canvas(es) missing from the manifest`)
    return manifest
  }

  async discoverOrphans(manifest) {
    if (this.orphansChecked) return manifest
    this.orphansChecked = true
    const before = manifest.canvases.length
    await this.addOrphans(manifest)
    if (manifest.canvases.length > before) {
      await this.writeManifest(manifest)
      this.notice = { kind: 'ORPHANS_FOUND', message: `Found ${manifest.canvases.length - before} saved canvas file(s) that were missing from the library and added them back.` }
    }
    return manifest
  }

  async writeManifest(manifest) {
    await atomicJson(this.file(MANIFEST), manifest)
    await atomicJson(this.file(MANIFEST_BACKUP), manifest)
  }

  async hasBackupFiles(id) {
    const prefix = `${id}-`
    return (await readdir(this.file('backups'))).some(name => name.startsWith(prefix) && name.endsWith('.json'))
  }

  /** Returns the saved record. Missing files are blank only for canvases that were never saved. */
  async loadRecord(id, entry) {
    let raw
    try { raw = await readFile(this.canvasFile(id), 'utf8') }
    catch (e) {
      if (e.code !== 'ENOENT') throw e
      const legacySaved = entry && entry.revision === undefined
        && (Date.parse(entry.updatedAt) - Date.parse(entry.createdAt) > 2000)
      if ((entry?.revision ?? 0) > 0 || legacySaved || await this.hasBackupFiles(id)) {
        throw storageError('MISSING_RECORD', 'This canvas was saved before, but its file is missing.')
      }
      return { revision: 0, snapshot: null }
    }
    let record
    try { record = JSON.parse(raw) } catch { throw storageError('CORRUPT_RECORD', 'Saved canvas record is unreadable.') }
    if (!isRecord(record)) throw storageError('CORRUPT_RECORD', 'Saved canvas record is invalid.')
    return record
  }

  async readValidBackups(id) {
    const directory = this.file('backups')
    const prefix = `${id}-`
    const backups = []
    for (const name of await readdir(directory)) {
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

  async backupRevisions(id) {
    const prefix = `${id}-`
    const revisions = []
    for (const name of await readdir(this.file('backups'))) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      const text = name.slice(prefix.length, -5)
      if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0) revisions.push(Number(text))
    }
    return revisions.sort((a, b) => b - a)
  }

  async trimBackups(id) {
    const revisions = await this.backupRevisions(id)
    for (const revision of revisions.slice(BACKUP_COUNT)) await unlink(this.file('backups', `${id}-${revision}.json`))
  }

  leaseInfo(id, clientId, acquire, takeOver = false) {
    const current = this.leases.get(id)
    const t = Date.now()
    if (takeOver || !current || current.until <= t || current.clientId === clientId) {
      if (acquire) this.leases.set(id, { clientId, until: t + LEASE_MS })
      return { readOnly: false, leaseExpiresAt: new Date(t + LEASE_MS).toISOString() }
    }
    return { readOnly: true, leaseExpiresAt: new Date(current.until).toISOString() }
  }

  heldByOther(id, clientId) {
    const lease = this.leases.get(id)
    return !!lease && lease.clientId !== clientId && lease.until > Date.now()
  }

  checkClient(clientId) { if (!isId(clientId)) throw new Error('Invalid editor client id') }

  takeNotice() { const notice = this.notice; this.notice = null; return notice }

  async list() { return this.serialize(async () => {
    const manifest = await this.loadManifest()
    if (!manifest.canvases.length) {
      const id = randomUUID(), stamp = now()
      const meta = { name: 'My First Canvas', createdAt: stamp }
      await atomicJson(this.canvasFile(id), { revision: 0, snapshot: null, meta })
      manifest.canvases.push({ id, name: meta.name, createdAt: stamp, updatedAt: stamp, revision: 0 })
      manifest.lastOpenedId = id
      await this.writeManifest(manifest)
    }
    const canvases = [...manifest.canvases].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const lastOpenedId = canvases.some(c => c.id === manifest.lastOpenedId) ? manifest.lastOpenedId : canvases[0].id
    const notice = this.takeNotice()
    return { ok: true, lastOpenedId, canvases, ...(notice ? { notice } : {}) }
  }) }

  async create(name) { return this.serialize(async () => {
    const cleaned = typeof name === 'string' ? name.trim().slice(0, 80) : ''
    if (!cleaned) return { ok: false, code: 'INVALID_NAME', message: 'Enter a canvas name.' }
    const m = await this.loadManifest()
    const id = randomUUID(), stamp = now()
    await atomicJson(this.canvasFile(id), { revision: 0, snapshot: null, meta: { name: cleaned, createdAt: stamp } })
    const metadata = { id, name: cleaned, createdAt: stamp, updatedAt: stamp, revision: 0 }
    m.canvases.push(metadata)
    m.lastOpenedId = id
    await this.writeManifest(m)
    return { ok: true, canvas: metadata }
  }) }

  /** Creates a canvas whose first revision is the given snapshot. Retrying the same saveId is safe. */
  async saveAsNew(name, clientId, snapshot, saveId) { return this.serialize(async () => {
    this.checkClient(clientId)
    if (!isSaveId(saveId)) return { ok: false, code: 'INVALID_REQUEST', message: 'Missing save id.' }
    const cleaned = typeof name === 'string' ? name.trim().slice(0, 80) : ''
    if (!cleaned) return { ok: false, code: 'INVALID_NAME', message: 'Enter a canvas name.' }
    const check = this.checkSnapshot(snapshot)
    if (check) return check
    const m = await this.loadManifest()
    const existing = m.canvases.find(c => c.createdBySaveId === saveId)
    if (existing) return { ok: true, canvas: existing, revision: existing.revision ?? 1, savedAt: existing.updatedAt, replayed: true, ...this.leaseInfo(existing.id, clientId, true) }
    const id = randomUUID(), stamp = now()
    const meta = { name: cleaned, createdAt: stamp }
    await atomicJson(this.canvasFile(id), { revision: 1, snapshot, saveId, savedBy: clientId, savedAt: stamp, meta })
    const metadata = { id, name: cleaned, createdAt: stamp, updatedAt: stamp, revision: 1, createdBySaveId: saveId }
    m.canvases.push(metadata)
    m.lastOpenedId = id
    await this.writeManifest(m)
    return { ok: true, canvas: metadata, revision: 1, savedAt: stamp, ...this.leaseInfo(id, clientId, true) }
  }) }

  async listBackups(id) { return this.serialize(async () => {
    if (!isId(id)) return { ok: false, code: 'INVALID_ID', message: 'Canvas id is invalid.' }
    const manifest = await this.loadManifest()
    if (!manifest.canvases.some(canvas => canvas.id === id)) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
    const backups = await this.readValidBackups(id)
    return { ok: true, backups: backups.map(({ revision, record }) => ({ revision, ...(record.savedAt ? { savedAt: record.savedAt } : {}) })) }
  }) }

  async open(id, clientId, { takeOver = false } = {}) { return this.serialize(async () => {
    this.checkClient(clientId)
    const m = await this.loadManifest()
    const canvas = m.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
    let record
    try { record = await this.loadRecord(id, canvas) }
    catch (error) {
      if (error.code === 'CORRUPT_RECORD') return { ok: false, code: 'CORRUPT_RECORD', canvas, message: 'This canvas file is damaged. Choose a valid backup to restore it.' }
      if (error.code === 'MISSING_RECORD') return { ok: false, code: 'MISSING_RECORD', canvas, message: 'This canvas was saved before, but its file is missing. Choose a backup to restore it.' }
      throw error
    }
    const lease = this.leaseInfo(id, clientId, true, takeOver)
    m.lastOpenedId = id
    await this.writeManifest(m)
    return { ok: true, canvas, revision: record.revision, snapshot: record.snapshot, ...lease }
  }) }

  async heartbeat(id, clientId) { return this.serialize(async () => {
    this.checkClient(clientId)
    const m = await this.loadManifest()
    if (!m.canvases.some(c => c.id === id)) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
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
    let unavailable = null
    try { current = await this.loadRecord(id, canvas) }
    catch (error) {
      if (error.code !== 'CORRUPT_RECORD' && error.code !== 'MISSING_RECORD') throw error
      unavailable = error.code
    }
    if (expectedCurrentRevision === null ? !unavailable : (unavailable || current.revision !== expectedCurrentRevision)) {
      return { ok: false, code: 'CONFLICT', message: 'The canvas changed after backups were listed. Reload before restoring.' }
    }

    if (this.heldByOther(id, clientId)) return { ok: false, code: 'LEASE_HELD', message: 'Another editor has control. No backup was restored.' }
    const nextRevision = Math.max(current?.revision ?? 0, canvas.revision ?? 0, ...backups.map(backup => backup.revision)) + 1
    if (!Number.isSafeInteger(nextRevision)) return { ok: false, code: 'REVISION_LIMIT', message: 'Canvas revision limit reached.' }

    let recoveryCopyPreserved = false
    if (unavailable === 'CORRUPT_RECORD') {
      await this.quarantine(this.canvasFile(id), id)
      recoveryCopyPreserved = true
    } else if (current && current.revision > 0) {
      await atomicJson(this.file('backups', `${id}-${current.revision}.json`), current)
    }

    const savedAt = now()
    const restored = { revision: nextRevision, snapshot: selected.record.snapshot, savedBy: clientId, savedAt, restoredFrom: backupRevision, meta: { name: canvas.name, createdAt: canvas.createdAt } }
    await atomicJson(this.canvasFile(id), restored)
    this.leaseInfo(id, clientId, true)
    const warning = await this.afterCommit(manifest, canvas, nextRevision, savedAt, id)
    return { ok: true, revision: nextRevision, restoredRevision: backupRevision, recoveryCopyPreserved, savedAt, ...(warning ? { warning } : {}) }
  }) }

  /** For a damaged or missing canvas with nothing to restore: keep the evidence, then start it blank. */
  async startFresh(id, clientId) { return this.serialize(async () => {
    this.checkClient(clientId)
    const manifest = await this.loadManifest()
    const canvas = manifest.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas was not found.' }
    let unavailable = null
    try { await this.loadRecord(id, canvas) }
    catch (error) {
      if (error.code !== 'CORRUPT_RECORD' && error.code !== 'MISSING_RECORD') throw error
      unavailable = error.code
    }
    if (!unavailable) return { ok: false, code: 'CONFLICT', message: 'This canvas is readable; it does not need to be started over.' }
    if (this.heldByOther(id, clientId)) return { ok: false, code: 'LEASE_HELD', message: 'Another editor has control.' }
    const folder = this.file('recovery', `${id}-${Date.now()}`)
    await mkdir(folder, { recursive: true })
    if (unavailable === 'CORRUPT_RECORD') await copyFile(this.canvasFile(id), path.join(folder, `${id}.json.corrupt`))
    for (const revision of await this.backupRevisions(id)) {
      await renameWithRetry(this.file('backups', `${id}-${revision}.json`), path.join(folder, `${id}-${revision}.json`))
    }
    await atomicJson(this.canvasFile(id), { revision: 0, snapshot: null, meta: { name: canvas.name, createdAt: canvas.createdAt } })
    canvas.revision = 0
    canvas.updatedAt = now()
    await this.writeManifest(manifest)
    return { ok: true, revision: 0 }
  }) }

  checkSnapshot(snapshot) {
    if (!hasSnapshotShape(snapshot)) return { ok: false, code: 'INVALID_SNAPSHOT', message: 'Expected a tldraw snapshot with document and session. Nothing was saved.' }
    const bytes = snapshotBytes(snapshot)
    if (bytes > MAX_SNAPSHOT_BYTES) {
      return { ok: false, code: 'TOO_LARGE', bytes, limit: MAX_SNAPSHOT_BYTES, message: `Canvas is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_SNAPSHOT_BYTES / 1048576} MB. Nothing was saved.` }
    }
    return null
  }

  /** Bookkeeping after the canvas file is committed. Failures here must not turn a committed save into a reported failure. */
  async afterCommit(manifest, canvas, revision, savedAt, id) {
    const problems = []
    canvas.updatedAt = savedAt
    canvas.revision = revision
    manifest.lastOpenedId = id
    try { await this.writeManifest(manifest) } catch (error) { problems.push(`library index: ${error.code || error.message}`) }
    try { await this.trimBackups(id) } catch (error) { problems.push(`backup cleanup: ${error.code || error.message}`) }
    if (!problems.length) return null
    this.log(`revision ${revision} of ${id} committed; follow-up failed (${problems.join('; ')})`)
    return `Saved, but ${problems.join(' and ')} failed.`
  }

  async save(id, clientId, expectedRevision, snapshot, saveId) { return this.serialize(async () => {
    this.checkClient(clientId)
    const manifest = await this.loadManifest()
    const canvas = manifest.canvases.find(c => c.id === id)
    if (!canvas) return { ok: false, code: 'NOT_FOUND', message: 'Canvas not found.' }
    let current
    try { current = await this.loadRecord(id, canvas) }
    catch (error) {
      if (error.code === 'CORRUPT_RECORD') return { ok: false, code: 'CORRUPT_RECORD', message: 'Saved canvas data is damaged. Nothing was saved.' }
      if (error.code === 'MISSING_RECORD') return { ok: false, code: 'MISSING_RECORD', message: 'The saved canvas file is missing. Nothing was saved.' }
      throw error
    }
    if (isSaveId(saveId) && current.saveId === saveId && current.savedBy === clientId) {
      return { ok: true, revision: current.revision, savedAt: current.savedAt, replayed: true }
    }
    if (this.heldByOther(id, clientId)) {
      return { ok: false, code: 'LEASE_HELD', message: 'Another device has editing control. Nothing was saved.' }
    }
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
      return {
        ok: false, code: 'CONFLICT', revision: current.revision,
        ownLastSaveId: current.savedBy === clientId ? current.saveId ?? null : null,
        message: 'The server has a newer version of this canvas. Nothing was overwritten.',
      }
    }
    const invalid = this.checkSnapshot(snapshot)
    if (invalid) return invalid
    if (current.revision > 0 && !documentsEqual(current.snapshot, snapshot)) {
      await atomicJson(this.file('backups', `${id}-${current.revision}.json`), current)
    }
    const savedAt = now()
    const next = { revision: current.revision + 1, snapshot, saveId: isSaveId(saveId) ? saveId : undefined, savedBy: clientId, savedAt, meta: { name: canvas.name, createdAt: canvas.createdAt } }
    // Commit point: once this rename succeeds the save is durable.
    await atomicJson(this.canvasFile(id), next)
    this.leaseInfo(id, clientId, true)
    const warning = await this.afterCommit(manifest, canvas, next.revision, savedAt, id)
    return { ok: true, revision: next.revision, savedAt, ...(warning ? { warning } : {}) }
  }) }
}
