/**
 * The open notebook's side of NOVA's canvas work: applying NOVA's requests as one undo step, reporting what it cannot apply,
 * never applying twice, waiting for the pen, and the render-job runner. Uses the real document, history and planner;
 * the server is the in-memory mock (the real Worker side is tested in cloudflare/test/engine). Disposable fixtures only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InkDocument } from '../../engine/src/core/document'
import { History } from '../../engine/src/core/history'
import type { Op, Plan } from '../../engine/src/core/ops'
import type { Paper } from '../../engine/src/core/paper'
import { createStroke } from '../../engine/src/core/stroke'
import type { Camera, ImageItem, Stroke } from '../../engine/src/core/types'
import { JobRunner } from '../jobs'
import type { RenderedSource } from '../jobs'
import { MockServer } from '../mock-server'
import { NotebookSession } from '../session'
import type { PageEditor } from '../session'

class DocEditor implements PageEditor {
  doc = new InkDocument()
  history = new History(this.doc)
  page: Paper = { color: 'white', pattern: 'blank' }
  view: Camera = { x: 0, y: 0, z: 1 }
  pen = false
  items() { return [...this.doc.images, ...this.doc.strokes] }
  paper() { return this.page }
  camera() { return this.view }
  load(strokes: Stroke[], images: ImageItem[], paper: Paper, camera: Camera | null) { this.doc.load(strokes, images); this.history.clear(); this.page = paper; this.view = camera ?? { x: 0, y: 0, z: 1 } }
  setReadOnly() {}
  applyPlan(plan: Plan) { return this.history.applyPlan(plan) }
  busy() { return this.pen }
}

const mine = (id: string, x: number) => createStroke({ id, points: [x, 0, 0.5, 0, x + 40, 20, 0.5, 16], style: { color: '#1b1f24', width: 2.6 } })
const draw = (name = 'FBD', x = 400): Op[] => [{ op: 'draw', name, place: { x, y: 0 }, shapes: [{ type: 'rect', x: 0, y: 0, w: 60, h: 40 }, { type: 'arrow', x1: 30, y1: 20, x2: 120, y2: 20 }, { type: 'text', x: 0, y: 60, text: 'T' }] }]

async function rig(server = new MockServer(), clientId = server.id()) {
  const editor = new DocEditor()
  const session = new NotebookSession({ api: server.api, clientId, editor, autosaveMs: 60_000, cameraSaveMs: 60_000, heartbeatMs: 0, retryDelaysMs: [60_000] })
  await session.start()
  const write = (id: string, x: number) => { editor.history.addStrokes([mine(id, x)]); session.changed() }
  return { server, editor, session, write, done: () => session.dispose() }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const aiCount = (strokes: readonly Stroke[]) => strokes.filter(s => s.author === 'ai').length

test('a request waiting when the page opens is applied as one undo step, saved, and settled', async () => {
  const server = new MockServer()
  const pageId = server.first
  server.enqueueOps(pageId, 'request-0001', draw())
  const { editor, session, done } = await rig(server)
  await tick()
  assert.ok(aiCount(editor.doc.strokes) > 5, 'NOVA marks are on the page')
  assert.ok(editor.doc.strokes.filter(s => s.author === 'ai').every(s => !!s.group && s.group.startsWith('nova-fbd-')))
  assert.equal(session.getState().status, 'unsaved')
  assert.equal(server.opStatus(pageId, 'request-0001')!.status, 'queued', 'applied here is not durable yet')
  await session.save()
  assert.equal(session.getState().status, 'saved')
  assert.equal(server.opStatus(pageId, 'request-0001')!.status, 'saved')
  assert.ok(server.pages.get(pageId)!.rows.size > 5)
  // one undo removes all of it; one redo brings it back
  assert.ok(editor.history.undo())
  assert.equal(aiCount(editor.doc.strokes), 0)
  assert.equal(editor.history.undo(), false)
  assert.ok(editor.history.redo())
  assert.ok(aiCount(editor.doc.strokes) > 5)
  done()
})

test('requests that arrive while writing are picked up on the heartbeat, after the pen lifts, and only once', async () => {
  const { server, editor, session, write, done } = await rig()
  const pageId = server.first
  write('a', 0)
  await session.save()
  server.enqueueOps(pageId, 'request-0002', draw())
  editor.pen = true
  await session.heartbeat()
  assert.equal(aiCount(editor.doc.strokes), 0, 'nothing is changed under the pen')
  editor.pen = false
  await session.heartbeat()
  const first = aiCount(editor.doc.strokes)
  assert.ok(first > 5)
  await session.heartbeat(); await session.heartbeat()
  assert.equal(aiCount(editor.doc.strokes), first, 'delivered again, applied once')
  assert.equal(server.opStatus(pageId, 'request-0002')!.status, 'applied')
  await session.save()
  assert.equal(server.opStatus(pageId, 'request-0002')!.status, 'saved')
  assert.deepEqual(editor.doc.strokes.filter(s => s.author !== 'ai').map(s => s.id), ['a'], "the student's work is untouched")
  done()
})

test('the student keeps writing: their strokes and NOVA\'s both end up saved, and one undo only takes NOVA\'s back', async () => {
  const { server, editor, session, write, done } = await rig()
  const pageId = server.first
  write('before', 0)
  server.enqueueOps(pageId, 'request-0003', draw())
  await session.heartbeat()
  write('after', 20)
  await session.save()
  const stored = [...server.pages.get(pageId)!.rows.values()].map(r => (r.stroke as { id: string; author: string }))
  assert.deepEqual(stored.filter(s => s.author !== 'ai').map(s => s.id).sort(), ['after', 'before'])
  assert.ok(stored.filter(s => s.author === 'ai').length > 5)
  assert.ok(editor.history.undo())     // the newest step is the student's own stroke
  assert.ok(editor.history.undo())     // then NOVA's drawing, as one step
  assert.equal(aiCount(editor.doc.strokes), 0)
  assert.deepEqual(editor.doc.strokes.map(s => s.id), ['before'])
  done()
})

test('a request whose targets are gone, or that changes nothing, is reported and never applied or retried', async () => {
  const { server, editor, session, write, done } = await rig()
  const pageId = server.first
  write('a', 0)
  await session.save()
  server.enqueueOps(pageId, 'request-bad01', [{ op: 'move', targets: ['ghost'], dx: 5 }])
  await session.heartbeat()
  assert.equal(server.opStatus(pageId, 'request-bad01')!.status, 'failed')
  assert.match(server.opStatus(pageId, 'request-bad01')!.message!, /not on this page/)
  const calls = server.calls.length
  await session.heartbeat()
  assert.equal(server.calls.filter((c, i) => i >= calls && c === 'nb_report_ops').length, 0, 'reported once')
  assert.deepEqual(editor.doc.strokes.map(s => s.id), ['a'], 'nothing was applied')
  done()
})

test('a lost save reply: the retry replays, the request is settled once, nothing is duplicated', async () => {
  const { server, editor, session, done } = await rig()
  const pageId = server.first
  server.enqueueOps(pageId, 'request-0004', draw())
  await session.heartbeat()
  const strokes = editor.doc.strokes.length
  server.dropNextReply = true
  await session.save()
  assert.equal(session.getState().status, 'notSynced')
  assert.equal(server.opStatus(pageId, 'request-0004')!.status, 'saved', 'the server did commit it')
  await session.save()
  assert.equal(session.getState().status, 'saved')
  assert.equal(server.pages.get(pageId)!.rows.size, strokes)
  assert.equal(editor.doc.strokes.length, strokes)
  done()
})

test('a request applied by the server while this editor was away is shown, not overwritten', async () => {
  const server = new MockServer()
  const pageId = server.first
  const a = await rig(server)
  a.write('x', 0)
  await a.session.save()
  // another editor opens, saves a stroke and lets go
  const other = server.id()
  await server.api('nb_open_page', { pageId, clientId: other, takeOver: true })
  const rows = [...server.pages.get(pageId)!.rows.values()]
  await server.api('nb_save_page', { pageId, clientId: other, saveId: 'zz', baseRevision: server.pages.get(pageId)!.revision, adds: [{ key: 'zzzzzzzz1', stroke: { ...(rows[0].stroke as object), id: 'from-server' } }], removes: [] })
  await server.api('nb_release', { pageId, clientId: other })
  await a.session.heartbeat()
  await tick(); await tick()
  assert.deepEqual(a.editor.doc.strokes.map(s => s.id).sort(), ['from-server', 'x'])
  assert.equal(a.session.getState().revision, server.pages.get(pageId)!.revision)
  a.done()
})

test('keeping a PDF: the original is stored once (same file, same id) and a picture can be given its origin', async () => {
  const { server, session, done } = await rig()
  const pdf = new Uint8Array(400_000).map((_, i) => (i * 13) & 0xff)
  pdf.set([...'%PDF-1.7'].map(c => c.charCodeAt(0)), 0)
  const id = await session.uploadSource(pdf, 'Review.pdf', 12)
  assert.match(id!, /^src_[0-9a-f]{40}$/)
  assert.equal(await session.uploadSource(pdf, 'Review.pdf', 12), id)
  assert.equal(server.sources.size, 1)
  assert.equal(server.sources.get(id!)!.pages, 12)
  await session.setImageMeta('pic', { sourceId: id!, sourceName: 'Review.pdf', page: 3 })
  assert.deepEqual(server.imageMeta.get('pic'), { sourceId: id, sourceName: 'Review.pdf', page: 3 })
  assert.equal(await session.uploadSource(new Uint8Array(25 * 1024 * 1024), 'Huge.pdf', 1), null)
  done()
})

// ---- the render-job runner ----

const b64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
async function jobRig(pages = 8) {
  const r = await rig()
  const pdf = new Uint8Array(1000); pdf.set([...'%PDF-1.7'].map(c => c.charCodeAt(0)), 0)
  const sourceId = (await r.session.uploadSource(pdf, 'Exam_Review.pdf', pages))!
  const rendered: Array<[number, unknown]> = []
  const runner = new JobRunner({
    rpc: (name, args) => r.session.rpc(name, args),
    uploadImage: picture => r.session.uploadImage(picture),
    say: () => {}, changed: () => {},
    async open(bytes): Promise<RenderedSource> {
      assert.deepEqual([...bytes.subarray(0, 5)], [...'%PDF-'].map(c => c.charCodeAt(0)))
      return {
        pageCount: pages,
        async render(page, crop) { rendered.push([page, crop]); return { bytes: Uint8Array.from([0xff, 0xd8, 0xff, page]), mime: 'image/jpeg', width: crop ? 600 : 1236, height: crop ? 300 : 1600 } },
        close: async () => {},
      }
    },
  })
  return { ...r, sourceId, rendered, runner }
}

test('a render job: the stored original is fetched, each page or crop rendered and stored, and the result reported', async () => {
  const { server, sourceId, rendered, runner, done } = await jobRig()
  const jobId = server.addJob({ sourceId, notebookId: server.notebookId, mode: 'page_per_item', layout: 'top_left', items: [{ page: 5 }, { page: 6, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 } }] })
  assert.equal(await runner.poll(), true)
  assert.deepEqual(rendered, [[5, undefined], [6, { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }]])
  const job = server.jobs.find(j => j.jobId === jobId)!
  assert.equal(job.status, 'done')
  const outputs = job.outputs as Array<{ imageId: string; width: number; height: number }>
  assert.equal(outputs.length, 2)
  assert.deepEqual([outputs[1].width, outputs[1].height], [600, 300])
  assert.ok(outputs.every(o => server.images.get(o.imageId)?.pieces.size === 1), 'every picture is stored before it is reported')
  assert.equal(await runner.poll(), false, 'nothing left to do')
  done()
})

test('a render job that cannot be done is reported as failed with the reason, and the pages are not touched', async () => {
  const { server, sourceId, runner, done } = await jobRig(4)
  const jobId = server.addJob({ sourceId, notebookId: server.notebookId, mode: 'page_per_item', layout: 'full', items: [{ page: 9 }] })
  await runner.poll()
  const job = server.jobs.find(j => j.jobId === jobId)!
  assert.equal(job.status, 'failed')
  assert.match(job.message!, /4 pages/)
  const missing = server.addJob({ sourceId: 'src_nope', notebookId: server.notebookId, mode: 'page_per_item', layout: 'full', items: [{ page: 1 }] })
  await runner.poll()
  assert.equal(server.jobs.find(j => j.jobId === missing)!.status, 'failed')
  done()
})

test('a render job interrupted by a lost connection stays waiting and is done on the next poll', async () => {
  const { server, sourceId, runner, done } = await jobRig()
  const jobId = server.addJob({ sourceId, notebookId: server.notebookId, mode: 'page_per_item', layout: 'full', items: [{ page: 2 }] })
  server.offline = true
  await runner.poll()
  server.offline = false
  assert.equal(server.jobs.find(j => j.jobId === jobId)!.status, 'pending')
  await runner.poll()
  assert.equal(server.jobs.find(j => j.jobId === jobId)!.status, 'done')
  void b64
  done()
})
