import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serializeStroke } from '../../engine/src/core/format'
import type { Paper } from '../../engine/src/core/paper'
import { createStroke } from '../../engine/src/core/stroke'
import type { Camera, Stroke } from '../../engine/src/core/types'
import { NotebookSession } from '../session'
import type { PageEditor } from '../session'
import { MockServer } from '../mock-server'

class FakeEditor implements PageEditor {
  list: Stroke[] = []
  page: Paper = { color: 'white', pattern: 'blank' }
  view: Camera = { x: 0, y: 0, z: 1 }
  readOnly = false
  strokes() { return this.list }
  paper() { return this.page }
  camera() { return this.view }
  load(strokes: Stroke[], paper: Paper, camera: Camera | null) { this.list = strokes; this.page = paper; this.view = camera ?? { x: 0, y: 0, z: 1 } }
  setReadOnly(readOnly: boolean) { this.readOnly = readOnly }
}

const line = (x: number) => createStroke({ points: [x, 0, 0.5, 0, x + 10, 10, 0.5, 16], style: { color: '#1b1f24', width: 2.6 } })

async function rig(server = new MockServer(), clientId = server.id()) {
  const editor = new FakeEditor()
  const session = new NotebookSession({ api: server.api, clientId, editor, autosaveMs: 60_000, cameraSaveMs: 60_000, heartbeatMs: 0, retryDelaysMs: [60_000] })
  await session.start()
  const draw = (x: number) => { editor.list = [...editor.list, line(x)]; session.changed() }
  return { server, editor, session, draw, done: () => session.dispose() }
}

test('Saved only after the server confirms, and the page reopens with the same strokes', async () => {
  const { server, session, draw, done } = await rig()
  assert.equal(session.getState().status, 'saved')
  draw(0); draw(20)
  assert.equal(session.getState().status, 'unsaved')
  const saving = session.save()
  assert.equal(session.getState().status === 'saved', false)
  await saving
  assert.equal(session.getState().status, 'saved')
  assert.equal(server.pages.get(server.first)!.rows.size, 2)
  done()

  const other = await rig(server)
  assert.equal(other.editor.list.length, 2)
  const wire = (s: unknown) => JSON.stringify(s)
  assert.deepEqual(other.editor.list.map(s => wire(serializeStroke(s))).sort(), [...server.pages.get(server.first)!.rows.values()].map(r => wire(r.stroke)).sort())
  other.done()
})

test('offline: "Not synced", changes kept, then saved on retry', async () => {
  const { server, session, draw, done } = await rig()
  draw(0)
  server.offline = true
  await session.save()
  assert.equal(session.getState().status, 'notSynced')
  assert.match(session.getState().message, /Not synced/)
  assert.equal(session.hasUnsavedChanges, true)
  draw(30)
  server.offline = false
  await session.save()
  assert.equal(session.getState().status, 'saved')
  assert.equal(server.pages.get(server.first)!.rows.size, 2)
  done()
})

test('a lost reply is retried with the same saveId and is not applied twice', async () => {
  const { server, session, draw, editor, done } = await rig()
  draw(0)
  server.dropNextReply = true
  await session.save()
  assert.equal(session.getState().status, 'notSynced')
  const page = server.pages.get(server.first)!
  assert.equal(page.revision, 1)
  await session.save()
  assert.equal(session.getState().status, 'saved')
  assert.equal(page.revision, 1)
  editor.list = []
  session.changed()
  await session.save()
  assert.equal(page.rows.size, 0)
  assert.equal(page.revision, 2)
  done()
})

test('another device opening the page makes this one read-only; strokes cannot be saved over it', async () => {
  const server = new MockServer()
  const a = await rig(server)
  a.draw(0)
  await a.session.save()
  server.now += 50_000
  const b = await rig(server)
  assert.equal(b.session.getState().editable, true)
  a.draw(40)
  await a.session.heartbeat()
  assert.equal(a.session.getState().status, 'conflict')
  assert.equal(a.session.getState().conflict, 'lease')
  assert.equal(a.editor.readOnly, true)
  assert.equal(await a.session.openPage(server.addPage(server.notebookId, 'Other')), false, 'does not leave the page with stranded changes')

  assert.equal(await a.session.copyToNewPage(), true)
  assert.equal(a.session.getState().status, 'saved')
  const copy = server.pages.get(a.session.getState().pageId!)!
  assert.equal(copy.rows.size, 2)
  assert.equal(server.pages.get(server.first)!.rows.size, 1, 'the original page is untouched')
  a.done(); b.done()
})

test('a newer revision from another device is a conflict, not an overwrite', async () => {
  const server = new MockServer()
  const a = await rig(server)
  a.draw(0)
  await a.session.save()
  await a.session.teardown()
  const b = await rig(server)
  b.draw(100)
  await b.session.save()
  await b.session.teardown()
  a.draw(50)
  await a.session.save()
  assert.equal(a.session.getState().conflict, 'revision')
  assert.equal(server.pages.get(server.first)!.rows.size, 2)
  assert.equal(a.session.stranded, true)
  a.done(); b.done()
})

test('opening a page held by another device shows it read-only and never saves', async () => {
  const server = new MockServer()
  const a = await rig(server)
  const b = await rig(server)
  assert.equal(b.session.getState().status, 'readOnly')
  assert.equal(b.editor.readOnly, true)
  b.editor.list = [line(0)]
  b.session.changed()
  await b.session.save()
  assert.equal(server.calls.filter(c => c === 'nb_save_page').length, 0)

  await b.session.takeOver()
  assert.equal(b.session.getState().editable, true)
  assert.equal(b.editor.readOnly, false)
  a.done(); b.done()
})

test('switching pages saves first, releases the old page and keeps the paper of the new one', async () => {
  const server = new MockServer()
  const second = server.addPage(server.notebookId, 'Page 2', { color: 'cream', pattern: 'graph' })
  const { session, draw, editor, done } = await rig(server)
  draw(0)
  assert.equal(await session.openPage(second), true)
  assert.equal(server.pages.get(server.first)!.rows.size, 1)
  assert.equal(server.pages.get(server.first)!.lease, null)
  assert.deepEqual(editor.page, { color: 'cream', pattern: 'graph' })
  editor.page = { color: 'cream', pattern: 'dots' }
  session.changed()
  await session.save()
  assert.deepEqual(server.pages.get(second)!.paper, { color: 'cream', pattern: 'dots' })
  done()
})

test('camera-only changes are saved without touching strokes', async () => {
  const { server, session, editor, done } = await rig()
  editor.view = { x: 120.04, y: -3, z: 1.5 }
  session.changed()
  assert.equal(session.getState().status, 'saved', 'moving the view is not shown as unsaved work')
  assert.equal(session.hasUnsavedChanges, true)
  await session.save()
  assert.deepEqual(server.pages.get(server.first)!.camera, { x: 120, y: -3, z: 1.5 })
  assert.equal(session.getState().status, 'saved')
  done()
})

test('library: folders and cover colors; a notebook reopens on the page asked for; unsaved ink is saved before switching', async () => {
  const { server, session, draw, done } = await rig()
  const physics = (await session.createFolder('Physics')).folderId
  assert.ok(await session.createNotebook('Lab 1', { folderId: physics, color: '#1f7a5c' }))
  let state = session.getState()
  const lab = state.notebooks.find(n => n.name === 'Lab 1')!
  assert.deepEqual([state.folders.map(f => f.name), lab.folderId, lab.color, state.notebookId], [['Physics'], physics, '#1f7a5c', lab.id])

  const second = server.addPage(server.notebookId, 'Page 2')
  await session.refreshList()
  draw(0)
  assert.ok(await session.openNotebook(server.notebookId, second))
  assert.equal(session.getState().pageId, second)
  assert.equal(server.pages.get(lab.pages[0].id)!.rows.size, 1, 'the ink on Lab 1 was saved before switching')

  assert.equal((await session.updateNotebook(lab.id, { color: 'green' })).code, 'INVALID_COLOR')
  await session.updateNotebook(server.notebookId, { folderId: physics })
  await session.removeFolder(physics)
  state = session.getState()
  assert.deepEqual(state.notebooks.map(n => n.folderId), [null, null])
  assert.ok(state.folders[0].deletedAt)
  done()
})
