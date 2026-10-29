import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

test('an expired editor lease can be recovered by a new device without overwriting stale work', async () => withStore(async store => {
 const id = (await store.list()).lastOpenedId, first = randomUUID(), next = randomUUID()
 await store.open(id,first)
 store.leases.get(id).until = Date.now()-1
 assert.equal((await store.open(id,next)).readOnly,false)
 assert.equal((await store.save(id,first,0,sample('stale'))).code,'LEASE_LOST')
 assert.equal((await store.save(id,next,0,sample('new'))).ok,true)
}))
