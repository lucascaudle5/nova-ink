/**
 * Non-destructive importer for v0.2.x data (manifest.json + canvases/*.json + backups/*.json).
 *
 *   readV02(dir)            READ-ONLY. Parses the directory into a plan; never writes, renames or deletes anything there.
 *   applyImport(plan, api)  Writes the plan into a FRESH store through the normal API. Safe to run twice (idempotent saveIds).
 *
 * Damaged or unreadable files are reported in plan.problems and are never guessed at or "repaired".
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const isId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
export const IMPORT_CLIENT_ID = '00000000-0000-4000-8000-000000000001'

function hasSnapshotShape(s) {
  return !!s && typeof s === 'object' && !!s.document?.store && typeof s.document.store === 'object' && !!s.document.schema && !!s.session && typeof s.session === 'object'
}
async function readJson(file) {
  try { return { value: JSON.parse(await readFile(file, 'utf8')) } } catch (error) { return { error: error.code || 'unparseable' } }
}
async function names(dir) { try { return await readdir(dir) } catch { return [] } }

export async function readV02(dir) {
  const problems = []
  const manifest = await readJson(path.join(dir, 'manifest.json'))
  let entries = []
  if (manifest.value && manifest.value.version === 1 && Array.isArray(manifest.value.canvases)) {
    entries = manifest.value.canvases.filter(e => isId(e?.id))
  } else if (manifest.value?.version > 1) {
    throw new Error('manifest.json was written by a newer NOVA Ink version; refusing to import')
  } else {
    problems.push({ kind: 'manifest', detail: manifest.error ?? 'invalid' })
  }
  const known = new Set(entries.map(e => e.id))
  const canvasFiles = (await names(path.join(dir, 'canvases'))).filter(n => /^[0-9a-f-]{36}\.json$/.test(n))
  const backupFiles = (await names(path.join(dir, 'backups'))).map(n => /^([0-9a-f-]{36})-(\d+)\.json$/.exec(n)).filter(Boolean)
  for (const n of canvasFiles) {
    const id = n.slice(0, -5)
    if (!known.has(id)) { entries.push({ id, name: `Recovered canvas ${id.slice(0, 8)}`, createdAt: null, updatedAt: null, orphan: true }); known.add(id) }
  }
  for (const [, id] of backupFiles) {
    if (!known.has(id)) { entries.push({ id, name: `Recovered canvas ${id.slice(0, 8)}`, createdAt: null, updatedAt: null, orphan: true }); known.add(id) }
  }

  const canvases = []
  for (const entry of entries) {
    const record = await readJson(path.join(dir, 'canvases', `${entry.id}.json`))
    let current = null
    if (record.value && Number.isSafeInteger(record.value.revision) && record.value.revision >= 0) {
      if (record.value.revision === 0 && record.value.snapshot === null) current = { revision: 0, snapshot: null }
      else if (hasSnapshotShape(record.value.snapshot)) current = { revision: record.value.revision, snapshot: record.value.snapshot, savedAt: record.value.savedAt }
    }
    if (!current) problems.push({ kind: 'canvas', id: entry.id, name: entry.name, detail: record.error ?? 'invalid record' })
    const backups = []
    for (const [file, id, rev] of backupFiles) {
      if (id !== entry.id) continue
      const b = await readJson(path.join(dir, 'backups', file))
      if (b.value && b.value.revision === Number(rev) && hasSnapshotShape(b.value.snapshot)) backups.push({ revision: Number(rev), savedAt: b.value.savedAt, snapshot: b.value.snapshot })
      else problems.push({ kind: 'backup', id: entry.id, detail: `${file}: ${b.error ?? 'invalid'}` })
    }
    backups.sort((a, b) => b.revision - a.revision)
    canvases.push({
      id: entry.id, name: entry.name, createdAt: entry.createdAt ?? record.value?.meta?.createdAt ?? null, updatedAt: entry.updatedAt ?? null,
      orphan: !!entry.orphan, current, backups,
    })
  }
  return { lastOpenedId: manifest.value?.lastOpenedId ?? null, canvases, problems }
}

/**
 * `api(op, canvasId, body)` calls the store. Returns a report and the library entries a LibraryDO should record.
 * Canvas ids are preserved. A canvas whose current record was damaged gets its backups as checkpoints only
 * (it then opens as MISSING_RECORD and can be restored, exactly as in v0.2).
 */
export async function applyImport(plan, api) {
  const report = { imported: 0, checkpoints: 0, emptyCanvases: 0, damagedCanvases: 0, errors: [] }
  const library = []
  for (const c of plan.canvases) {
    if (c.current && c.current.snapshot) {
      const r = await api('initFromSnapshot', c.id, { clientId: IMPORT_CLIENT_ID, saveId: `import-${c.id}`, snapshot: c.current.snapshot, importedRevision: c.current.revision })
      if (!r.ok) { report.errors.push({ id: c.id, code: r.code }); continue }
      report.imported++
    } else if (c.current) report.emptyCanvases++
    else report.damagedCanvases++
    if (c.current?.snapshot) await api('release', c.id, { clientId: IMPORT_CLIENT_ID }) // the importer must not keep editing rights
    for (const b of c.backups) {
      const r = await api('importCheckpoint', c.id, { clientId: IMPORT_CLIENT_ID, revision: b.revision, savedAt: b.savedAt, snapshot: b.snapshot })
      if (r.ok) report.checkpoints++; else report.errors.push({ id: c.id, backup: b.revision, code: r.code })
    }
    library.push({
      id: c.id, name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt, revision: c.current?.revision ?? null,
      status: c.current ? (c.current.snapshot ? 'ok' : 'empty') : 'needs-recovery',
    })
  }
  return { report, library, lastOpenedId: plan.lastOpenedId }
}
