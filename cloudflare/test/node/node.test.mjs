// Node-side tests: real process restart with on-disk Durable Object storage, tldraw acceptance of what the
// Worker returns, and the non-destructive v0.2.x import. Generated test data only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startWorker, root } from './harness.mjs'
import { applyImport, readV02 } from '../../src/import-v02.mjs'
import { loadsInTldraw, shapeCount } from '../helpers/snapshots.mjs'
import { diffSnapshots } from '../../src/diff.ts'

const fixture = async name => JSON.parse(await readFile(path.join(root, 'test', 'fixtures', `${name}.json`), 'utf8'))
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'nova-spike-'))
const A = randomUUID()

async function treeHash(dir) {
  const hash = createHash('sha256')
  const walk = async d => {
    for (const entry of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) { hash.update(`D:${entry.name}\n`); await walk(full) } else { hash.update(`F:${entry.name}\n`); hash.update(await readFile(full)) }
    }
  }
  await walk(dir)
  return hash.digest('hex')
}

test('a saved canvas survives a real worker process restart, and real tldraw loads what comes back', async () => {
  const persist = await tmp()
  const id = randomUUID()
  const s1500 = await fixture('s1500'), img = await fixture('img3mb')
  let w = await startWorker(persist)
  try {
    assert.equal((await w.call('save', id, { clientId: A, saveId: 's1', baseRevision: 0, ...diffSnapshots(null, s1500) })).ok, true)
    assert.equal((await w.call('save', id, { clientId: A, saveId: 's2', baseRevision: 1, ...diffSnapshots(s1500, img) })).ok, true)
  } finally { await w.dispose() }

  w = await startWorker(persist) // brand-new workerd process, same disk
  try {
    const opened = await w.call('open', id, { clientId: A })
    assert.equal(opened.ok, true)
    assert.equal(opened.revision, 2)
    assert.deepEqual(opened.snapshot, img)
    assert.equal(loadsInTldraw(opened.snapshot), shapeCount(img)) // tldraw itself accepts the reassembled snapshot
    const first = await w.call('open', id, { clientId: randomUUID() })
    assert.equal(first.readOnly, true) // lease persisted across the restart
  } finally { await w.dispose(); await rm(persist, { recursive: true, force: true }) }
})

async function makeV02Dir() {
  const dir = await tmp()
  await mkdir(path.join(dir, 'canvases')); await mkdir(path.join(dir, 'backups'))
  const small = await fixture('small'), s100 = await fixture('s100'), img = await fixture('img3mb')
  const ids = { notes: randomUUID(), pics: randomUUID(), blank: randomUUID(), broken: randomUUID(), orphan: randomUUID() }
  const stamp = '2026-10-01T10:00:00.000Z'
  const w = (...p) => path.join(dir, ...p)
  const record = (revision, snapshot) => ({ revision, snapshot, saveId: `x${revision}`, savedBy: A, savedAt: stamp, meta: { name: 'n', createdAt: stamp } })
  await writeFile(w('canvases', `${ids.notes}.json`), JSON.stringify(record(3, s100)))
  await writeFile(w('backups', `${ids.notes}-2.json`), JSON.stringify(record(2, small)))
  await writeFile(w('backups', `${ids.notes}-1.json`), JSON.stringify(record(1, small)))
  await writeFile(w('canvases', `${ids.pics}.json`), JSON.stringify(record(1, img)))
  await writeFile(w('canvases', `${ids.blank}.json`), JSON.stringify({ revision: 0, snapshot: null, meta: { name: 'Blank', createdAt: stamp } }))
  await writeFile(w('canvases', `${ids.broken}.json`), '{"revision": 4, "snapshot": {oops')
  await writeFile(w('backups', `${ids.broken}-3.json`), JSON.stringify(record(3, small)))
  await writeFile(w('canvases', `${ids.orphan}.json`), JSON.stringify(record(1, small))) // not in manifest
  const entry = (id, name, revision) => ({ id, name, createdAt: stamp, updatedAt: stamp, revision })
  await writeFile(w('manifest.json'), JSON.stringify({ version: 1, lastOpenedId: ids.notes, canvases: [entry(ids.notes, 'Notes', 3), entry(ids.pics, 'Pictures', 1), entry(ids.blank, 'Blank', 0), entry(ids.broken, 'Broken', 4)] }))
  return { dir, ids, small, s100, img }
}

test('v0.2.x import is non-destructive, idempotent, preserves ids, and survives a restart', async () => {
  const { dir, ids, small, s100, img } = await makeV02Dir()
  const persist = await tmp()
  const before = await treeHash(dir)
  const plan = await readV02(dir)
  assert.equal(await treeHash(dir), before, 'reading must not change the source directory')
  assert.equal(plan.canvases.length, 5)
  assert.deepEqual(plan.problems.map(p => `${p.kind}:${p.id}`), [`canvas:${ids.broken}`])

  let w = await startWorker(persist)
  try {
    const api = (op, id, body) => w.call(op, id, body)
    const first = await applyImport(plan, api)
    assert.deepEqual(first.report, { imported: 3, checkpoints: 3, emptyCanvases: 1, damagedCanvases: 1, errors: [] })
    assert.equal(first.library.find(e => e.id === ids.broken).status, 'needs-recovery')
    assert.equal(first.library.find(e => e.id === ids.orphan).name.startsWith('Recovered canvas'), true)
    const again = await applyImport(plan, api)
    assert.equal(again.report.errors.length, 0) // replays are acknowledged, nothing is duplicated
  } finally { await w.dispose() }

  w = await startWorker(persist)
  try {
    const notes = await w.call('open', ids.notes, { clientId: A })
    assert.equal(notes.revision, 3)
    assert.deepEqual(notes.snapshot, s100)
    assert.equal(loadsInTldraw(notes.snapshot), shapeCount(s100))
    assert.deepEqual((await w.call('listCheckpoints', ids.notes)).checkpoints.map(c => c.revision), [2, 1])
    assert.deepEqual((await w.call('open', ids.pics, { clientId: A })).snapshot, img)
    assert.deepEqual((await w.call('open', ids.orphan, { clientId: A })).snapshot, small)
    // The canvas whose current file was damaged opens as "missing" (recovery), and restores from its imported backup.
    assert.equal((await w.call('open', ids.broken, { clientId: A, knownRevision: 4 })).code, 'MISSING_RECORD')
    const restored = await w.call('restoreCheckpoint', ids.broken, { clientId: A, saveId: 'r1', checkpointRevision: 3, expectedRevision: null, knownRevision: 4 })
    assert.equal(restored.ok, true)
    assert.equal(restored.revision, 5)
    assert.deepEqual((await w.call('open', ids.broken, { clientId: A })).snapshot, small)
    // Restoring an imported checkpoint of a good canvas works too (new revision, history kept).
    const back = await w.call('restoreCheckpoint', ids.notes, { clientId: A, saveId: 'r2', checkpointRevision: 1, expectedRevision: 3 })
    assert.deepEqual([back.ok, back.revision], [true, 4])
  } finally { await w.dispose(); await rm(persist, { recursive: true, force: true }) }
  assert.equal(await treeHash(dir), before, 'importing must not change the source directory')
  await rm(dir, { recursive: true, force: true })
})
