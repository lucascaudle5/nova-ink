import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { NotebookStore } from './storage.mjs'

export const BACKUP_FORMAT = 1
const INFO_FILE = 'backup-info.json'
const DATA_SUBDIR = 'data'

async function sha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function listFiles(root, rel = '') {
  const out = []
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(root, child))
    else if (entry.isFile() && !entry.name.endsWith('.tmp')) out.push(child)
  }
  return out.sort()
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function isEmptyOrMissing(dir) {
  try { return (await fs.readdir(dir)).length === 0 } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Copies the notebook directory into a new, timestamped folder under destRoot and verifies every file by hash.
 * Read-only on the source. Files that change mid-copy (an autosave landing) are re-copied until stable.
 */
export async function createBackup(dataDir, destRoot, { version = 'unknown', now = new Date() } = {}) {
  const source = path.resolve(dataDir)
  await fs.access(path.join(source, 'manifest.json')).catch(() => {
    throw Object.assign(new Error(`No NOVA Ink manifest found in ${source}`), { code: 'NO_SOURCE' })
  })
  if (isInside(destRoot, source)) throw Object.assign(new Error('Backups must be stored outside the data directory.'), { code: 'DEST_INSIDE_SOURCE' })
  const target = path.join(path.resolve(destRoot), `nova-ink-backup-${stamp(now)}`)
  if (!await isEmptyOrMissing(target)) throw Object.assign(new Error(`${target} already exists.`), { code: 'DEST_EXISTS' })
  const dataTarget = path.join(target, DATA_SUBDIR)
  const files = []
  for (const rel of await listFiles(source)) {
    const from = path.join(source, rel)
    const to = path.join(dataTarget, rel)
    await fs.mkdir(path.dirname(to), { recursive: true })
    let entry = null
    for (let attempt = 0; attempt < 5 && !entry; attempt++) {
      try {
        await fs.copyFile(from, to)
        const [copied, original] = await Promise.all([sha256(to), sha256(from)])
        if (copied === original) entry = { path: rel.split(path.sep).join('/'), bytes: (await fs.stat(to)).size, sha256: copied }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await fs.rm(to, { force: true })
        break
      }
    }
    if (entry) files.push(entry)
    else if (await fs.stat(from).then(() => true, () => false)) {
      throw Object.assign(new Error(`${rel} kept changing during backup; stop NOVA Ink and try again.`), { code: 'UNSTABLE_SOURCE' })
    }
  }
  const info = { format: BACKUP_FORMAT, app: 'nova-ink', version, createdAt: now.toISOString(), fileCount: files.length, files }
  await fs.writeFile(path.join(target, INFO_FILE), JSON.stringify(info, null, 2))
  const check = await verifyBackup(target)
  if (!check.ok) throw Object.assign(new Error(`Backup verification failed: ${check.problems.join('; ')}`), { code: 'VERIFY_FAILED' })
  return { dir: target, fileCount: files.length, canvases: check.canvases }
}

/** Confirms every listed file is present with the recorded hash, JSON parses, and the copy opens as a notebook. */
export async function verifyBackup(backupDir) {
  const problems = []
  let info
  try { info = JSON.parse(await fs.readFile(path.join(backupDir, INFO_FILE), 'utf8')) } catch {
    return { ok: false, problems: [`${INFO_FILE} is missing or unreadable`], canvases: 0 }
  }
  if (info.format > BACKUP_FORMAT) return { ok: false, problems: [`backup format ${info.format} is newer than this tool supports`], canvases: 0 }
  const dataDir = path.join(backupDir, DATA_SUBDIR)
  for (const file of info.files ?? []) {
    const full = path.join(dataDir, ...file.path.split('/'))
    try {
      if (await sha256(full) !== file.sha256) problems.push(`${file.path} does not match its recorded hash`)
      else if (file.path.endsWith('.json')) JSON.parse(await fs.readFile(full, 'utf8'))
    } catch (error) {
      problems.push(error.code === 'ENOENT' ? `${file.path} is missing` : `${file.path} is not valid JSON`)
    }
  }
  let canvases = 0
  if (!problems.length) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'manifest.json'), 'utf8'))
      canvases = manifest.canvases?.length ?? 0
    } catch { problems.push('manifest.json is missing or unreadable') }
  }
  return { ok: problems.length === 0, problems, canvases, info }
}

/**
 * Restores a verified backup into targetDir. Never overwrites: the target must be missing or empty.
 * After copying, the result is re-verified by hash and opened with NotebookStore.
 */
export async function restoreBackup(backupDir, targetDir) {
  const check = await verifyBackup(backupDir)
  if (!check.ok) throw Object.assign(new Error(`Backup is not usable: ${check.problems.join('; ')}`), { code: 'VERIFY_FAILED' })
  const target = path.resolve(targetDir)
  if (!await isEmptyOrMissing(target)) {
    throw Object.assign(new Error(`${target} is not empty. Restore only into an empty or new folder; nothing was changed.`), { code: 'TARGET_NOT_EMPTY' })
  }
  const source = path.join(backupDir, DATA_SUBDIR)
  for (const file of check.info.files) {
    const to = path.join(target, ...file.path.split('/'))
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(path.join(source, ...file.path.split('/')), to)
    if (await sha256(to) !== file.sha256) throw Object.assign(new Error(`${file.path} did not copy correctly`), { code: 'VERIFY_FAILED' })
  }
  const store = new NotebookStore(target, { log: () => {} })
  const listed = await store.list()
  if (!listed.ok) throw Object.assign(new Error(`Restored notebook did not open: ${listed.message}`), { code: 'OPEN_FAILED' })
  return { dir: target, fileCount: check.info.files.length, canvases: listed.canvases.length }
}
