// Client save/lifecycle behavior against the real MCP server and store, with injected faults.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Backend, deferred, draw, mount, newSession } from './helpers/harness.mjs'
import { makeSnapshot, shapeCount } from './helpers/snapshots.mjs'

async function withBackend(cb) {
  const backend = await Backend.create()
  const sessions = []
  const make = options => { const s = newSession(backend, options); sessions.push(s); return s }
  try { return await cb(backend, make) }
  finally { sessions.forEach(s => s.dispose()); await backend.close() }
}

async function started(make, options) {
  const session = make(options)
  await session.start()
  return { session, editor: mount(session), id: session.getState().canvas.id }
}

const statusesOf = session => {
  const seen = []
  session.subscribe(() => { const s = session.getState().status; if (seen.at(-1) !== s) seen.push(s) })
  return seen
}

test('Saved appears only after the server acknowledges the save', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  const seen = statusesOf(session)
  const gate = deferred()
  backend.wrap = async (name, _args, call) => { if (name === 'ink_save_canvas') await gate.promise; return call() }
  draw(session, editor, 3)
  assert.equal(session.getState().status, 'unsaved')
  const saving = session.save()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(session.getState().status, 'saving')
  assert.equal(await backend.serverShapes(id), 0)
  gate.resolve()
  assert.equal(await saving, true)
  assert.deepEqual(seen, ['unsaved', 'saving', 'saved'])
  assert.equal(await backend.serverShapes(id), 3)
}))

test('autosave runs after the quiet period', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make, { autosaveMs: 10 })
  draw(session, editor, 2)
  await new Promise(r => setTimeout(r, 300))
  await session.save()
  assert.equal(session.getState().status, 'saved')
  assert.equal(await backend.serverShapes(id), 2)
}))

test('edits made while a slow save is in flight are saved too, without a false conflict', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  const gate = deferred()
  let first = true
  backend.wrap = async (name, _args, call) => { if (name === 'ink_save_canvas' && first) { first = false; await gate.promise } return call() }
  draw(session, editor, 1)
  const pending = session.save()
  await new Promise(r => setTimeout(r, 20))
  draw(session, editor, 5)
  gate.resolve()
  await pending
  assert.equal(await session.save(), true)
  assert.equal(session.getState().status, 'saved')
  assert.equal(await backend.serverShapes(id), 5)
  assert.equal(session.getState().conflict, null)
}))

test('re-selecting the current canvas never discards unsaved edits', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  const key = session.getState().mount.key
  draw(session, editor, 4)
  assert.equal(await session.openCanvas(id), true)
  assert.equal(session.getState().mount.key, key, 'editor was not remounted')
  assert.equal(session.getState().hasUnsavedChanges, true)
  assert.notEqual(session.getState().status, 'saved')
  assert.equal(await session.save(), true)
  assert.equal(await backend.serverShapes(id), 4)
}))

test('switching canvases saves pending edits first', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  const other = (await backend.api('ink_create_canvas', { name: 'Other' })).canvas.id
  draw(session, editor, 3)
  assert.equal(await session.openCanvas(other), true)
  assert.equal(session.getState().canvas.id, other)
  assert.equal(await backend.serverShapes(id), 3)
}))

test('switching is refused while edits cannot be saved, and the edits stay put', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  const other = (await backend.api('ink_create_canvas', { name: 'Other' })).canvas.id
  draw(session, editor, 3)
  backend.wrap = async (name, _args, call) => { if (name === 'ink_save_canvas') throw new Error('network down'); return call() }
  assert.equal(await session.openCanvas(other), false)
  const state = session.getState()
  assert.equal(state.canvas.id, id)
  assert.equal(state.hasUnsavedChanges, true)
  assert.equal(state.status, 'failed')
  assert.match(state.message, /Can't switch canvases yet/)
  assert.ok(!backend.calls.includes('ink_release_editor'), 'lease kept while work is unsaved')
  backend.wrap = (_n, _a, call) => call()
  assert.equal(await session.save(), true)
  assert.equal(await backend.serverShapes(id), 3)
}))

test('the editor is frozen while a canvas transition is in progress', () => withBackend(async (backend, make) => {
  const { session, editor } = await started(make)
  const other = (await backend.api('ink_create_canvas', { name: 'Other' })).canvas.id
  const gate = deferred()
  backend.wrap = async (name, _args, call) => { if (name === 'ink_open_canvas') await gate.promise; return call() }
  const opening = session.openCanvas(other)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(editor.readOnly, true)
  gate.resolve()
  await opening
}))

test('a lost save acknowledgement is reconciled instead of reported as a conflict', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  let dropNext = true
  backend.wrap = async (name, _args, call) => {
    const result = await call()
    if (name === 'ink_save_canvas' && dropNext) { dropNext = false; throw new Error('response lost') }
    return result
  }
  draw(session, editor, 2)
  assert.equal(await session.save(), false)
  assert.equal(session.getState().status, 'failed')
  assert.equal((await backend.record(id)).revision, 1, 'the save did commit on the server')
  draw(session, editor, 6)
  assert.equal(await session.save(), true)
  const state = session.getState()
  assert.equal(state.status, 'saved')
  assert.equal(state.conflict, null)
  assert.equal(state.revision, 2)
  assert.equal(await backend.serverShapes(id), 6)
}))

test('after a server restart, pending edits save without a lease error', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  draw(session, editor, 1)
  await session.save()
  backend.wrap = async () => { throw new Error('server down') }
  draw(session, editor, 3)
  assert.equal(await session.save(), false)
  await backend.restart()
  backend.wrap = (_n, _a, call) => call()
  assert.equal(await session.save(), true)
  assert.equal(session.getState().status, 'saved')
  assert.equal(await backend.serverShapes(id), 3)
}))

test('a device that lost editing control can preserve its version as a new canvas', () => withBackend(async (backend, make) => {
  const a = await started(make)
  draw(a.session, a.editor, 2)
  await a.session.save()
  const b = make()
  await b.start()
  assert.equal(b.getState().status, 'readOnly')
  draw(a.session, a.editor, 7)
  assert.equal(await b.reconnect({ takeOver: true }), true)
  const bEditor = mount(b)
  draw(b, bEditor, 9)
  await b.save()
  assert.equal(await a.session.save(), false)
  assert.equal(a.session.getState().status, 'conflict')
  assert.equal(a.session.getState().conflict, 'lease')
  assert.equal(a.editor.readOnly, true, 'no more edits are stranded')
  assert.equal(await a.session.openCanvas(b.getState().canvas.id), true, 'same canvas is a no-op')
  assert.equal(await a.session.saveAsNewCanvas(), true)
  const rescued = a.session.getState().canvas
  assert.notEqual(rescued.id, a.id)
  assert.equal(await backend.serverShapes(rescued.id), 7)
  assert.equal(await backend.serverShapes(a.id), 9, 'the other device\'s work is untouched')
  assert.equal(a.session.getState().status, 'saved')
  assert.equal(a.editor.readOnly, false)
}))

test('a genuine revision conflict is reported and never overwrites the newer version', () => withBackend(async (backend, make) => {
  const a = await started(make)
  draw(a.session, a.editor, 2)
  await a.session.save()
  backend.store.leases.get(a.id).until = Date.now() - 1
  const b = make()
  await b.start()
  const bEditor = mount(b)
  draw(b, bEditor, 5)
  await b.save()
  await b.release()
  draw(a.session, a.editor, 3)
  assert.equal(await a.session.save(), false)
  assert.equal(a.session.getState().conflict, 'revision')
  assert.equal(await backend.serverShapes(a.id), 5)
  assert.equal(await a.session.reconnect(), false, 'refresh keeps local edits while they conflict')
  assert.equal(a.session.getState().hasUnsavedChanges, true)
}))

test('heartbeat stops for a device without editing control and ignores stale replies', () => withBackend(async (backend, make) => {
  const { session } = await started(make)
  const other = (await backend.api('ink_create_canvas', { name: 'Other' })).canvas.id
  const gate = deferred()
  backend.wrap = async (name, args, call) => {
    if (name === 'ink_heartbeat') { await gate.promise; return { ok: true, readOnly: true } }
    return call()
  }
  const beat = session.heartbeat()
  await session.openCanvas(other)
  gate.resolve()
  await beat
  assert.equal(session.getState().editable, true, 'reply for the previous canvas was ignored')
  await session.release()
  backend.calls.length = 0
  await session.heartbeat()
  assert.ok(!backend.calls.includes('ink_heartbeat'))
}))

test('restore waits for an in-flight save and uses the acknowledged revision', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  draw(session, editor, 1); await session.save()
  draw(session, editor, 2); await session.save()
  const gate = deferred()
  backend.wrap = async (name, _args, call) => { if (name === 'ink_save_canvas') await gate.promise; return call() }
  draw(session, editor, 4)
  const saving = session.save()
  const restoring = session.restoreBackup(1)
  gate.resolve()
  assert.equal(await saving, true)
  assert.equal(await restoring, true)
  assert.equal(await backend.serverShapes(id), 1)
  assert.equal(session.getState().status, 'saved')
  const backups = (await backend.api('ink_list_backups', { canvasId: id })).backups.map(b => b.revision)
  assert.ok(backups.includes(3), 'the version saved just before restore is kept as a backup')
}))

test('restore is refused while local edits cannot be saved', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  draw(session, editor, 1); await session.save()
  draw(session, editor, 2); await session.save()
  backend.wrap = async (name, _args, call) => { if (name === 'ink_save_canvas') throw new Error('offline'); return call() }
  draw(session, editor, 8)
  assert.equal(await session.restoreBackup(1), false)
  assert.equal(session.getState().hasUnsavedChanges, true)
  assert.equal(await backend.serverShapes(id), 2)
}))

test('a damaged canvas opens in recovery and can be restored from a backup', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  draw(session, editor, 1); await session.save()
  draw(session, editor, 2); await session.save()
  const other = (await backend.api('ink_create_canvas', { name: 'Other' })).canvas.id
  await session.openCanvas(other)
  await writeFile(join(backend.dir, 'canvases', `${id}.json`), '{"broken"')
  assert.equal(await session.openCanvas(id), false)
  let state = session.getState()
  assert.equal(state.status, 'recovery')
  assert.equal(state.recovery.kind, 'CORRUPT_RECORD')
  assert.equal(state.mount, null)
  assert.deepEqual((await session.listBackups()).map(b => b.revision), [1])
  assert.equal(await session.restoreBackup(1), true)
  state = session.getState()
  assert.equal(state.status, 'saved')
  assert.equal(shapeCount(state.mount.snapshot), 1)
}))

test('a missing canvas file opens in recovery instead of as a blank canvas', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  draw(session, editor, 3); await session.save()
  await unlink(join(backend.dir, 'canvases', `${id}.json`))
  session.dispose()
  await backend.restart()
  const fresh = make()
  await fresh.start()
  assert.equal(fresh.getState().status, 'recovery')
  assert.equal(fresh.getState().recovery.kind, 'MISSING_RECORD')
  assert.equal(await fresh.startFresh(), true)
  assert.equal(fresh.getState().status, 'saved')
}))

test('a snapshot this tldraw version cannot load is never mounted or saved over', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  draw(session, editor, 2); await session.save()
  const record = await backend.record(id)
  const sequence = Object.keys(record.snapshot.document.schema.sequences)[0]
  record.snapshot.document.schema.sequences[sequence] = 999
  await writeFile(join(backend.dir, 'canvases', `${id}.json`), JSON.stringify(record))
  const fresh = make()
  await fresh.start()
  const state = fresh.getState()
  assert.equal(state.status, 'recovery')
  assert.equal(state.recovery.kind, 'INCOMPATIBLE')
  assert.equal(state.mount, null)
  assert.equal(await fresh.save(), true, 'nothing to save')
  assert.equal((await backend.record(id)).snapshot.document.schema.sequences[sequence], 999)
}))

test('an oversized canvas is reported without sending it and the edits stay local', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make, { maxSnapshotBytes: 20_000 })
  backend.calls.length = 0
  draw(session, editor, 60)
  assert.equal(await session.save(), false)
  const state = session.getState()
  assert.equal(state.status, 'failed')
  assert.match(state.message, /over the 0 MB save limit|save limit/)
  assert.equal(state.hasUnsavedChanges, true)
  assert.ok(!backend.calls.includes('ink_save_canvas'))
  assert.equal(await backend.serverShapes(id), 0)
}))

test('closing the widget saves first and releases only after the save is acknowledged', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  draw(session, editor, 2)
  await session.teardown()
  assert.equal(await backend.serverShapes(id), 2)
  assert.ok(backend.calls.includes('ink_release_editor'))
  const second = await started(make)
  draw(second.session, second.editor, 5)
  backend.calls.length = 0
  backend.wrap = async (name, _args, call) => { if (name === 'ink_save_canvas') throw new Error('offline'); return call() }
  await second.session.teardown()
  assert.ok(!backend.calls.includes('ink_release_editor'), 'unsaved work keeps its lease')
}))

test('discarding local changes is explicit and shows the server version', () => withBackend(async (backend, make) => {
  const { session, editor } = await started(make)
  draw(session, editor, 2); await session.save()
  backend.wrap = async (name, _args, call) => { if (name === 'ink_save_canvas') throw new Error('offline'); return call() }
  draw(session, editor, 9)
  backend.wrap = (_n, _a, call) => call()
  assert.equal(await session.discardAndReload(), true)
  const state = session.getState()
  assert.equal(state.hasUnsavedChanges, false)
  assert.equal(state.status, 'saved')
  assert.equal(shapeCount(state.mount.snapshot), 2)
}))

test('a reopened widget can take over a lease left behind by an abrupt close', () => withBackend(async (backend, make) => {
  const first = await started(make)
  draw(first.session, first.editor, 2)
  await first.session.save()
  first.session.dispose()
  const reopened = make()
  await reopened.start()
  assert.equal(reopened.getState().status, 'readOnly')
  assert.equal(await reopened.reconnect({ takeOver: true }), true)
  assert.equal(reopened.getState().editable, true)
  assert.equal(shapeCount(reopened.getState().mount.snapshot), 2)
}))

test('a reopened widget that keeps its client id resumes editing immediately', () => withBackend(async (backend, make) => {
  const first = await started(make, { clientId: '9b4f0f9e-8f43-4c8f-9b8e-5a2f8f0c1d11' })
  first.session.dispose()
  const reopened = make({ clientId: '9b4f0f9e-8f43-4c8f-9b8e-5a2f8f0c1d11' })
  await reopened.start()
  assert.equal(reopened.getState().editable, true)
}))

test('library notices from storage recovery reach the UI state', () => withBackend(async (backend, make) => {
  await backend.api('ink_create_canvas', { name: 'Keep me' })
  await writeFile(join(backend.dir, 'manifest.json'), 'not json')
  await backend.restart()
  const session = make()
  await session.start()
  assert.match(session.getState().notice, /restored from its automatic copy/)
  assert.ok(session.getState().library.some(c => c.name === 'Keep me'))
}))

test('a large real canvas round-trips through the session', () => withBackend(async (backend, make) => {
  const { session, editor, id } = await started(make)
  editor.snapshot = makeSnapshot({ strokes: 800 })
  session.noteChange('document')
  assert.equal(await session.save(), true)
  assert.equal(await backend.serverShapes(id), 800)
}))
