// Independent backup and restore. Every test uses its own temporary folders; the real data directory is never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBackup, restoreBackup, verifyBackup } from '../backup.mjs'
import { NotebookStore } from '../storage.mjs'
import { loadsInTldraw, makeSnapshot } from './helpers/snapshots.mjs'

const quiet = { log: () => {} }
const c1 = randomUUID(), reader = randomUUID()

async function tempDir(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `nova-ink-${label}-`))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function populated(t) {
  const dataDir = await tempDir(t, 'data')
  const store = new NotebookStore(dataDir, quiet)
  const first = (await store.list()).canvases[0]
  await store.open(first.id, c1)
  await store.save(first.id, c1, 0, makeSnapshot({ strokes: 40 }))
  await store.save(first.id, c1, 1, makeSnapshot({ strokes: 60 }))
  const second = (await store.create('Physics', c1)).canvas
  await store.save(second.id, c1, 0, makeSnapshot({ strokes: 5, imageBytes: 200_000 }))
  return { dataDir, store, ids: [first.id, second.id] }
}

test('a backup restores into a clean folder with every canvas, revision and stroke intact', async t => {
  const { dataDir, store, ids } = await populated(t)
  const out = await tempDir(t, 'backups')
  const backup = await createBackup(dataDir, out, { version: 'test' })
  assert.equal(backup.canvases, 2)

  const target = path.join(await tempDir(t, 'restore'), 'restored')
  const restored = await restoreBackup(backup.dir, target)
  assert.equal(restored.canvases, 2)

  const copy = new NotebookStore(target, quiet)
  for (const id of ids) {
    const original = await store.open(id, reader)
    const back = await copy.open(id, reader)
    assert.equal(back.ok, true)
    assert.equal(back.revision, original.revision)
    assert.deepEqual(back.snapshot, original.snapshot)
    assert.ok(loadsInTldraw(back.snapshot) > 0)
  }
  const backups = await copy.listBackups(ids[0])
  assert.equal(backups.backups.length, 1, 'per-canvas revision history comes along too')
})

test('creating a backup leaves the data directory byte-for-byte unchanged', async t => {
  const { dataDir } = await populated(t)
  const snapshotOf = async () => {
    const out = {}
    const walk = async rel => {
      for (const e of await fs.readdir(path.join(dataDir, rel), { withFileTypes: true })) {
        const child = path.join(rel, e.name)
        if (e.isDirectory()) await walk(child)
        else out[child] = await fs.readFile(path.join(dataDir, child), 'utf8')
      }
    }
    await walk('')
    return out
  }
  const before = await snapshotOf()
  await createBackup(dataDir, await tempDir(t, 'backups'))
  assert.deepEqual(await snapshotOf(), before)
})

test('restore refuses a non-empty target and changes nothing in it', async t => {
  const { dataDir } = await populated(t)
  const backup = await createBackup(dataDir, await tempDir(t, 'backups'))
  const target = await tempDir(t, 'occupied')
  await fs.writeFile(path.join(target, 'manifest.json'), '{"keep":"me"}')
  await assert.rejects(restoreBackup(backup.dir, target), { code: 'TARGET_NOT_EMPTY' })
  assert.deepEqual(await fs.readdir(target), ['manifest.json'])
  assert.equal(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'), '{"keep":"me"}')
})

test('a damaged backup is detected before anything is restored', async t => {
  const { dataDir, ids } = await populated(t)
  const backup = await createBackup(dataDir, await tempDir(t, 'backups'))
  const file = path.join(backup.dir, 'data', 'canvases', `${ids[1]}.json`)
  const text = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, text.slice(0, text.length / 2))

  const check = await verifyBackup(backup.dir)
  assert.equal(check.ok, false)
  assert.match(check.problems.join(), new RegExp(ids[1]))
  const target = path.join(await tempDir(t, 'restore'), 'restored')
  await assert.rejects(restoreBackup(backup.dir, target), { code: 'VERIFY_FAILED' })
  await assert.rejects(fs.access(target), 'no partial restore is left behind')
})

test('a backup inside the data directory or from an empty folder is refused', async t => {
  const { dataDir } = await populated(t)
  await assert.rejects(createBackup(dataDir, path.join(dataDir, 'inner')), { code: 'DEST_INSIDE_SOURCE' })
  await assert.rejects(createBackup(await tempDir(t, 'empty'), await tempDir(t, 'backups')), { code: 'NO_SOURCE' })
})

test('leftover temp files from an interrupted write are not copied', async t => {
  const { dataDir } = await populated(t)
  await fs.writeFile(path.join(dataDir, 'canvases', 'half-written.json.tmp'), '{"revis')
  const backup = await createBackup(dataDir, await tempDir(t, 'backups'))
  const { info } = await verifyBackup(backup.dir)
  assert.ok(info.files.every(f => !f.path.endsWith('.tmp')))
})
