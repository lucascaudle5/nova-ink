import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BACKUP_COUNT, NotebookStore } from '../storage.mjs'
import { loadsInTldraw, makeSnapshot } from './helpers/snapshots.mjs'

const sample = (label, camera = { x: 10, y: 30, z: 2 }) => ({ document: { schema: { schemaVersion: 2 }, store: { label } }, session: { camera } })
const quiet = { log: () => {} }
const withStore = async cb => {
 const dir = await mkdtemp(join(tmpdir(), 'nova-ink-test-'))
 try { return await cb(new NotebookStore(dir, quiet), dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const firstCanvas = async store => (await store.list()).lastOpenedId

test('first launch creates a named canvas and resumes it after restart', async () => withStore(async (store, dir) => {
 const list = await store.list(); assert.equal(list.canvases.length, 1)
 const first = list.lastOpenedId; assert.equal(first, list.canvases[0].id)
 const restarted = new NotebookStore(dir, quiet)
 assert.equal((await restarted.list()).lastOpenedId, first)
}))

test('snapshot and camera survive restart; revision increments only on acknowledged saves', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 const opened = await store.open(id, client); assert.equal(opened.revision, 0)
 const saved = await store.save(id, client, 0, sample('ink'))
 assert.equal(saved.ok, true); assert.equal(saved.revision, 1)
 const restarted = new NotebookStore(dir, quiet)
 const loaded = await restarted.open(id, randomUUID())
 assert.equal(loaded.snapshot.document.store.label, 'ink')
 assert.equal(loaded.snapshot.session.camera.z, 2)
 assert.equal(loaded.revision, 1)
}))

test('a real tldraw snapshot and its backup both load in tldraw', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 assert.equal((await store.save(id, client, 0, makeSnapshot({ strokes: 4 }))).ok, true)
 assert.equal((await store.save(id, client, 1, makeSnapshot({ strokes: 6 }))).ok, true)
 assert.equal(loadsInTldraw((await store.open(id, client)).snapshot), 6)
 const backup = JSON.parse(await readFile(join(dir, 'backups', `${id}-1.json`), 'utf8'))
 assert.equal(loadsInTldraw(backup.snapshot), 4)
}))

test('second device is read only while first owns lease and cannot save over it', async () => withStore(async store => {
 const id = await firstCanvas(store), one = randomUUID(), two = randomUUID()
 assert.equal((await store.open(id, one)).readOnly, false)
 assert.equal((await store.open(id, two)).readOnly, true)
 assert.equal((await store.save(id, two, 0, sample('bad'))).code, 'LEASE_HELD')
 await store.release(id, one)
 assert.equal((await store.heartbeat(id, two)).readOnly, false)
}))

test('stale edits conflict and never overwrite the server snapshot', async () => withStore(async store => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 assert.equal((await store.save(id, client, 0, sample('one'))).revision, 1)
 assert.equal((await store.save(id, client, 0, sample('stale'))).code, 'CONFLICT')
 assert.equal((await store.open(id, client)).snapshot.document.store.label, 'one')
}))

test('new canvas becomes the resume default and existing canvas remains', async () => withStore(async store => {
 const first = await firstCanvas(store)
 const made = await store.create('Dynamics — Practice')
 const list = await store.list()
 assert.equal(list.lastOpenedId, made.canvas.id)
 assert.equal(list.canvases.length, 2)
 assert.notEqual(first, made.canvas.id)
}))

test('rejects malformed snapshot without pretending it was saved', async () => withStore(async store => {
 const id = await firstCanvas(store), c = randomUUID()
 await store.open(id,c)
 assert.equal((await store.save(id,c,0,{foo:'bar'})).code,'INVALID_SNAPSHOT')
 assert.equal((await store.save(id,c,0,{document:{store:{}},session:{}})).code,'INVALID_SNAPSHOT')
 assert.equal((await store.open(id,c)).revision,0)
}))

test('previous successful revision is retained as a backup', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), c = randomUUID()
 await store.open(id,c)
 assert.equal((await store.save(id,c,0,sample('first'))).ok,true)
 assert.equal((await store.save(id,c,1,sample('second'))).ok,true)
 const prior = JSON.parse(await readFile(join(dir,'backups',`${id}-1.json`),'utf8'))
 assert.equal(prior.snapshot.document.store.label,'first')
}))

test('camera-only saves do not push real edits out of the backup history', async () => withStore(async store => {
 const id = await firstCanvas(store), c = randomUUID()
 await store.open(id, c)
 await store.save(id, c, 0, sample('before erase'))
 await store.save(id, c, 1, sample('after erase'))
 for (let r = 2; r < 2 + BACKUP_COUNT + 3; r++) assert.equal((await store.save(id, c, r, sample('after erase', { x: r, y: 0, z: 1 }))).ok, true)
 const revisions = (await store.listBackups(id)).backups.map(b => b.revision)
 assert.deepEqual(revisions, [1])
}))

test('simultaneous editor opens grant exactly one lease and non-owners cannot release it', async () => withStore(async store => {
 const id = await firstCanvas(store), one = randomUUID(), two = randomUUID()
 const [a, b] = await Promise.all([store.open(id, one), store.open(id, two)])
 assert.notEqual(a.readOnly, b.readOnly)
 const owner = a.readOnly ? two : one, observer = owner === one ? two : one
 assert.equal((await store.release(id, observer)).ok, true)
 assert.equal((await store.heartbeat(id, observer)).readOnly, true)
 assert.equal((await store.save(id, observer, 0, sample('stale'))).code, 'LEASE_HELD')
 assert.equal((await store.heartbeat(id, owner)).readOnly, false)
}))

test('after a server restart the editor can save without first renewing its lease', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('before restart'))
 const restarted = new NotebookStore(dir, quiet)
 const saved = await restarted.save(id, client, 1, sample('after restart'))
 assert.equal(saved.ok, true)
 assert.equal(saved.revision, 2)
 assert.equal((await restarted.open(id, randomUUID())).readOnly, true, 'the save re-established the lease')
}))

test('an expired editor may save again only if nobody saved in between', async () => withStore(async store => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 store.leases.get(id).until = Date.now() - 1
 assert.equal((await store.save(id, client, 0, sample('resumed'))).ok, true)
}))

test('an expired editor cannot overwrite work saved by the device that took over', async () => withStore(async store => {
 const id = await firstCanvas(store), first = randomUUID(), next = randomUUID()
 await store.open(id,first)
 store.leases.get(id).until = Date.now()-1
 assert.equal((await store.open(id,next)).readOnly,false)
 assert.equal((await store.save(id,first,0,sample('stale'))).code,'LEASE_HELD')
 assert.equal((await store.save(id,next,0,sample('new'))).ok,true)
 store.leases.get(id).until = Date.now()-1
 const late = await store.save(id,first,0,sample('stale'))
 assert.equal(late.code,'CONFLICT')
 assert.equal(late.ownLastSaveId,null)
 assert.equal((await store.open(id,next)).snapshot.document.store.label,'new')
}))

test('take over grants control while the revision check still protects the other device', async () => withStore(async store => {
 const id = await firstCanvas(store), a = randomUUID(), b = randomUUID()
 await store.open(id, a)
 assert.equal((await store.open(id, b)).readOnly, true)
 assert.equal((await store.open(id, b, { takeOver: true })).readOnly, false)
 assert.equal((await store.save(id, a, 0, sample('from a'))).code, 'LEASE_HELD')
}))

test('retrying a committed save with the same save id is acknowledged without a second write', async () => withStore(async store => {
 const id = await firstCanvas(store), client = randomUUID(), saveId = randomUUID()
 await store.open(id, client)
 assert.equal((await store.save(id, client, 0, sample('once'), saveId)).revision, 1)
 const retry = await store.save(id, client, 0, sample('once'), saveId)
 assert.equal(retry.ok, true)
 assert.equal(retry.replayed, true)
 assert.equal(retry.revision, 1)
 assert.equal((await store.open(id, client)).revision, 1)
}))

test('a lost acknowledgement is reconcilable: the conflict names the client\'s own committed save', async () => withStore(async store => {
 const id = await firstCanvas(store), client = randomUUID(), lost = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('acknowledgement lost'), lost)
 const next = await store.save(id, client, 0, sample('newer local work'), randomUUID())
 assert.equal(next.code, 'CONFLICT')
 assert.equal(next.revision, 1)
 assert.equal(next.ownLastSaveId, lost)
 assert.equal((await store.save(id, client, next.revision, sample('newer local work'), randomUUID())).revision, 2)
}))

test('a failure after the commit point is reported as saved with a warning', async () => withStore(async store => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 store.trimBackups = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
 const saved = await store.save(id, client, 0, sample('committed'))
 assert.equal(saved.ok, true)
 assert.match(saved.warning, /backup cleanup: EBUSY/)
 const realWrite = store.writeManifest.bind(store)
 store.writeManifest = async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }
 const second = await store.save(id, client, 1, sample('committed again'))
 store.writeManifest = realWrite
 assert.equal(second.ok, true)
 assert.match(second.warning, /library index: EPERM/)
 assert.equal((await store.open(id, client)).snapshot.document.store.label, 'committed again')
}))

test('a failure before the commit point leaves the previous revision intact', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('safe'))
 await rm(join(dir, 'backups'), { recursive: true })
 await writeFile(join(dir, 'backups'), 'not a directory')
 await assert.rejects(store.save(id, client, 1, sample('never committed')))
 await rm(join(dir, 'backups'))
 const loaded = await store.open(id, client)
 assert.equal(loaded.revision, 1)
 assert.equal(loaded.snapshot.document.store.label, 'safe')
 assert.deepEqual((await readdir(join(dir, 'canvases'))).filter(n => n.endsWith('.tmp')), [])
}))

test('restoring a valid backup creates a new revision and preserves the current revision', async () => withStore(async store => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('first'))
 await store.save(id, client, 1, sample('second'))
 const listed = await store.listBackups(id)
 assert.deepEqual(listed.backups.map(item => item.revision), [1])
 const restored = await store.restoreBackup(id, client, 1, 2)
 assert.equal(restored.ok, true)
 assert.equal(restored.revision, 3)
 assert.equal(restored.restoredRevision, 1)
 const loaded = await store.open(id, client)
 assert.equal(loaded.snapshot.document.store.label, 'first')
 assert.equal(loaded.revision, 3)
 assert.deepEqual((await store.listBackups(id)).backups.map(item => item.revision), [2, 1])
}))

test('a damaged current record can be restored from a valid backup and is quarantined', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('first'))
 await store.save(id, client, 1, sample('second'))
 const damaged = '{"revision":2,"snapshot":'
 await writeFile(join(dir, 'canvases', `${id}.json`), damaged)
 assert.equal((await store.open(id, randomUUID())).code, 'CORRUPT_RECORD')
 assert.equal((await store.save(id, client, 2, sample('blind write'))).code, 'CORRUPT_RECORD')
 assert.deepEqual((await store.listBackups(id)).backups.map(item => item.revision), [1])
 const restored = await store.restoreBackup(id, client, 1, null)
 assert.equal(restored.ok, true)
 assert.equal(restored.recoveryCopyPreserved, true)
 const loaded = await store.open(id, client)
 assert.equal(loaded.snapshot.document.store.label, 'first')
 assert.ok(loaded.revision > 2, 'restored revision is newer than any revision a stale client might hold')
 const recoveryFiles = await readdir(join(dir, 'recovery'))
 assert.equal(recoveryFiles.length, 1)
 assert.equal(await readFile(join(dir, 'recovery', recoveryFiles[0]), 'utf8'), damaged)
}))

test('a previously saved canvas whose file disappeared is reported missing, not blank', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('first'))
 await store.save(id, client, 1, sample('second'))
 await unlink(join(dir, 'canvases', `${id}.json`))
 const opened = await store.open(id, client)
 assert.equal(opened.code, 'MISSING_RECORD')
 assert.equal(opened.canvas.id, id)
 assert.equal((await store.save(id, client, 0, sample('blank overwrite'))).code, 'MISSING_RECORD')
 assert.equal((await store.restoreBackup(id, client, 1, null)).ok, true)
 assert.equal((await store.open(id, client)).snapshot.document.store.label, 'first')
}))

test('a canvas saved once with no backups is still reported missing when its file disappears', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('only revision'))
 await unlink(join(dir, 'canvases', `${id}.json`))
 assert.equal((await store.open(id, client)).code, 'MISSING_RECORD')
 assert.equal((await store.startFresh(id, client)).ok, true)
 assert.equal((await store.open(id, client)).revision, 0)
}))

test('legacy never-saved canvases without a file still open as blank', async () => withStore(async (store, dir) => {
 const id = randomUUID(), stamp = new Date().toISOString()
 await store.list()
 const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
 manifest.canvases.push({ id, name: 'Legacy blank', createdAt: stamp, updatedAt: stamp })
 await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
 const fresh = new NotebookStore(dir, quiet)
 const opened = await fresh.open(id, randomUUID())
 assert.equal(opened.ok, true)
 assert.equal(opened.revision, 0)
}))

test('starting a damaged canvas fresh keeps the damaged file and old backups in recovery', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('first'))
 await store.save(id, client, 1, sample('second'))
 await writeFile(join(dir, 'canvases', `${id}.json`), 'garbage')
 assert.equal((await store.startFresh(id, client)).ok, true)
 const folders = await readdir(join(dir, 'recovery'))
 const kept = await readdir(join(dir, 'recovery', folders[0]))
 assert.ok(kept.includes(`${id}.json.corrupt`))
 assert.ok(kept.includes(`${id}-1.json`))
 assert.equal((await store.open(id, client)).revision, 0)
 assert.equal((await store.startFresh(id, client)).code, 'CONFLICT', 'readable canvases are never reset')
}))

test(`only the ${BACKUP_COUNT} newest backups are retained`, async () => withStore(async store => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 const saves = BACKUP_COUNT + 3
 for (let revision = 0; revision < saves; revision++) {
   const result = await store.save(id, client, revision, sample(`revision-${revision + 1}`))
   assert.equal(result.ok, true)
 }
 const expected = Array.from({ length: BACKUP_COUNT }, (_, i) => saves - 1 - i)
 assert.deepEqual((await store.listBackups(id)).backups.map(item => item.revision), expected)
}))

test('backup listing omits malformed records instead of offering them for restore', async () => withStore(async (store, dir) => {
 const id = await firstCanvas(store), client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('first'))
 await store.save(id, client, 1, sample('second'))
 await writeFile(join(dir, 'backups', `${id}-1.json`), 'null')
 const listed = await store.listBackups(id)
 assert.deepEqual(listed.backups, [])
 assert.equal((await store.restoreBackup(id, client, 1, 2)).code, 'BACKUP_UNAVAILABLE')
}))

test('backup restoration cannot take control from another active editor', async () => withStore(async store => {
 const id = await firstCanvas(store), owner = randomUUID(), other = randomUUID()
 await store.open(id, owner)
 await store.save(id, owner, 0, sample('first'))
 await store.save(id, owner, 1, sample('second'))
 const result = await store.restoreBackup(id, other, 1, 2)
 assert.equal(result.code, 'LEASE_HELD')
 assert.equal((await store.open(id, owner)).snapshot.document.store.label, 'second')
}))

test('save my version as a new canvas is atomic and safe to retry', async () => withStore(async store => {
 const client = randomUUID(), saveId = randomUUID()
 await store.list()
 const made = await store.saveAsNew('Statics (my version)', client, sample('rescued'), saveId)
 assert.equal(made.ok, true)
 assert.equal(made.revision, 1)
 assert.equal(made.readOnly, false)
 const retry = await store.saveAsNew('Statics (my version)', client, sample('rescued'), saveId)
 assert.equal(retry.canvas.id, made.canvas.id)
 assert.equal((await store.list()).canvases.length, 2)
 assert.equal((await store.open(made.canvas.id, client)).snapshot.document.store.label, 'rescued')
}))

test('a corrupt manifest is restored from its automatic copy and the damaged one is kept', async () => withStore(async (store, dir) => {
 const made = await store.create('Thermo')
 await writeFile(join(dir, 'manifest.json'), '{"version":1,"canv')
 const fresh = new NotebookStore(dir, quiet)
 const list = await fresh.list()
 assert.ok(list.canvases.some(c => c.id === made.canvas.id && c.name === 'Thermo'))
 assert.equal(list.notice.kind, 'MANIFEST_RESTORED')
 assert.equal((await readdir(join(dir, 'recovery'))).length, 1)
}))

test('a lost manifest and copy are rebuilt from saved canvas files with their names', async () => withStore(async (store, dir) => {
 const made = await store.create('Circuits')
 const client = randomUUID()
 await store.open(made.canvas.id, client)
 await store.save(made.canvas.id, client, 0, sample('kirchhoff'))
 await unlink(join(dir, 'manifest.json'))
 await unlink(join(dir, 'manifest.backup.json'))
 const fresh = new NotebookStore(dir, quiet)
 const list = await fresh.list()
 assert.equal(list.notice.kind, 'MANIFEST_REBUILT')
 const rebuilt = list.canvases.find(c => c.id === made.canvas.id)
 assert.equal(rebuilt.name, 'Circuits')
 assert.equal((await fresh.open(made.canvas.id, client)).snapshot.document.store.label, 'kirchhoff')
}))

test('canvas files missing from a valid manifest are added back on startup', async () => withStore(async (store, dir) => {
 const made = await store.create('Orphan')
 const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
 manifest.canvases = manifest.canvases.filter(c => c.id !== made.canvas.id)
 await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
 const list = await new NotebookStore(dir, quiet).list()
 assert.equal(list.notice.kind, 'ORPHANS_FOUND')
 assert.ok(list.canvases.some(c => c.id === made.canvas.id && c.name === 'Orphan'))
}))

test('a manifest from a newer NOVA Ink version is refused rather than rebuilt over', async () => withStore(async (store, dir) => {
 await store.list()
 const newer = JSON.stringify({ version: 99, lastOpenedId: null, canvases: [] })
 await writeFile(join(dir, 'manifest.json'), newer)
 await assert.rejects(new NotebookStore(dir, quiet).list(), error => error.code === 'MANIFEST_NEWER')
 assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8'), newer)
}))
