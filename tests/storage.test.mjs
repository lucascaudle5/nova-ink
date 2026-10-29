import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NotebookStore } from '../storage.mjs'

const sample = (label) => ({ document: { schema: { version: 2 }, store: { label } }, session: { camera: { x: 10, y: 30, z: 2 } } })
const withStore = async cb => {
 const dir = await mkdtemp(join(tmpdir(), 'nova-ink-test-'))
 try { return await cb(new NotebookStore(dir), dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('first launch creates a named canvas and resumes it after restart', async () => withStore(async (store, dir) => {
 const list = await store.list(); assert.equal(list.canvases.length, 1)
 const first = list.lastOpenedId; assert.equal(first, list.canvases[0].id)
 const restarted = new NotebookStore(dir)
 assert.equal((await restarted.list()).lastOpenedId, first)
}))

test('snapshot and camera survive restart; revision increments only on acknowledged saves', async () => withStore(async (store, dir) => {
 const id = (await store.list()).lastOpenedId, client = randomUUID()
 const opened = await store.open(id, client); assert.equal(opened.revision, 0)
 const saved = await store.save(id, client, 0, sample('ink'))
 assert.equal(saved.ok, true); assert.equal(saved.revision, 1)
 const restarted = new NotebookStore(dir)
 const loaded = await restarted.open(id, randomUUID())
 assert.equal(loaded.snapshot.document.store.label, 'ink')
 assert.equal(loaded.snapshot.session.camera.z, 2)
 assert.equal(loaded.revision, 1)
}))

test('second device is read only while first owns lease', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, one = randomUUID(), two = randomUUID()
 assert.equal((await store.open(id, one)).readOnly, false)
 assert.equal((await store.open(id, two)).readOnly, true)
 assert.equal((await store.save(id, two, 0, sample('bad'))).code, 'LEASE_LOST')
 await store.release(id, one)
 assert.equal((await store.heartbeat(id, two)).readOnly, false)
}))

test('stale edits conflict and never overwrite the server snapshot', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, client = randomUUID()
 await store.open(id, client)
 assert.equal((await store.save(id, client, 0, sample('one'))).revision, 1)
 assert.equal((await store.save(id, client, 0, sample('stale'))).code, 'CONFLICT')
 assert.equal((await store.open(id, client)).snapshot.document.store.label, 'one')
}))

test('new canvas becomes the resume default and existing canvas remains', async () => withStore(async store => {
 const first = (await store.list()).lastOpenedId
 const made = await store.create('Dynamics — Practice')
 const list = await store.list()
 assert.equal(list.lastOpenedId, made.canvas.id)
 assert.equal(list.canvases.length, 2)
 assert.notEqual(first, made.canvas.id)
}))

test('rejects malformed snapshot without pretending it was saved', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, c = randomUUID()
 await store.open(id,c)
 assert.equal((await store.save(id,c,0,{foo:'bar'})).code,'INVALID_SNAPSHOT')
 assert.equal((await store.open(id,c)).revision,0)
}))

test('previous successful revision is retained as a backup', async () => withStore(async (store, dir) => {
 const id = (await store.list()).lastOpenedId, c = randomUUID()
 await store.open(id,c)
 assert.equal((await store.save(id,c,0,sample('first'))).ok,true)
 assert.equal((await store.save(id,c,1,sample('second'))).ok,true)
 const prior = JSON.parse(await readFile(join(dir,'backups',`${id}-1.json`),'utf8'))
 assert.equal(prior.snapshot.document.store.label,'first')
}))


test('simultaneous editor opens grant exactly one lease and non-owners cannot release it', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, one = randomUUID(), two = randomUUID()
 const [a, b] = await Promise.all([store.open(id, one), store.open(id, two)])
 assert.notEqual(a.readOnly, b.readOnly)
 const owner = a.readOnly ? two : one, observer = owner === one ? two : one
 assert.equal((await store.release(id, observer)).ok, true)
 assert.equal((await store.heartbeat(id, observer)).readOnly, true)
 assert.equal((await store.save(id, observer, 0, sample('stale'))).code, 'LEASE_LOST')
 assert.equal((await store.heartbeat(id, owner)).readOnly, false)
}))

test('an expired editor cannot save until it reacquires the lease', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, client = randomUUID()
 await store.open(id, client)
 store.leases.get(id).until = Date.now() - 1
 assert.equal((await store.save(id, client, 0, sample('expired'))).code, 'LEASE_LOST')
 assert.equal((await store.heartbeat(id, client)).readOnly, false)
 assert.equal((await store.save(id, client, 0, sample('reacquired'))).ok, true)
}))

test('restoring a valid backup creates a new revision and preserves the current revision', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, client = randomUUID()
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
 const id = (await store.list()).lastOpenedId, client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('first'))
 await store.save(id, client, 1, sample('second'))
 const damaged = '{"revision":2,"snapshot":'
 await writeFile(join(dir, 'canvases', `${id}.json`), damaged)
 assert.equal((await store.open(id, randomUUID())).code, 'CORRUPT_RECORD')
 assert.deepEqual((await store.listBackups(id)).backups.map(item => item.revision), [1])
 const restored = await store.restoreBackup(id, client, 1, null)
 assert.equal(restored.ok, true)
 assert.equal(restored.recoveryCopyPreserved, true)
 const loaded = await store.open(id, client)
 assert.equal(loaded.snapshot.document.store.label, 'first')
 assert.equal(loaded.revision, 2)
 const recoveryFiles = await readdir(join(dir, 'recovery'))
 assert.equal(recoveryFiles.length, 1)
 assert.equal(await readFile(join(dir, 'recovery', recoveryFiles[0]), 'utf8'), damaged)
}))



test('only the five newest valid backups are retained', async () => withStore(async (store, dir) => {
 const id = (await store.list()).lastOpenedId, client = randomUUID()
 await store.open(id, client)
 for (let revision = 0; revision < 7; revision++) {
   const result = await store.save(id, client, revision, sample(`revision-${revision + 1}`))
   assert.equal(result.ok, true)
 }
 assert.deepEqual((await store.listBackups(id)).backups.map(item => item.revision), [6, 5, 4, 3, 2])
}))

test('backup listing omits malformed records instead of offering them for restore', async () => withStore(async (store, dir) => {
 const id = (await store.list()).lastOpenedId, client = randomUUID()
 await store.open(id, client)
 await store.save(id, client, 0, sample('first'))
 await store.save(id, client, 1, sample('second'))
 await writeFile(join(dir, 'backups', `${id}-1.json`), 'null')
 const listed = await store.listBackups(id)
 assert.deepEqual(listed.backups, [])
 assert.equal((await store.restoreBackup(id, client, 1, 2)).code, 'BACKUP_UNAVAILABLE')
}))

test('backup restoration cannot take control from another active editor', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, owner = randomUUID(), other = randomUUID()
 await store.open(id, owner)
 await store.save(id, owner, 0, sample('first'))
 await store.save(id, owner, 1, sample('second'))
 const result = await store.restoreBackup(id, other, 1, 2)
 assert.equal(result.code, 'LEASE_HELD')
 assert.equal((await store.open(id, owner)).snapshot.document.store.label, 'second')
}))

test('an expired editor lease can be recovered by a new device without overwriting stale work', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, first = randomUUID(), next = randomUUID()
 await store.open(id,first)
 store.leases.get(id).until = Date.now()-1
 assert.equal((await store.open(id,next)).readOnly,false)
 assert.equal((await store.save(id,first,0,sample('stale'))).code,'LEASE_LOST')
 assert.equal((await store.save(id,next,0,sample('new'))).ok,true)
}))
