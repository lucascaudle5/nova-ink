/**
 * NOVA's canvas operations in PageDO (workerd): queueing, applying with nobody editing, handing work to an open
 * editor, idempotent retries, stale revisions, and what happens to the student's own ink. Disposable fixtures only.
 */
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { keyBetween } from '../../../engine/src/core/order'
import { planOps } from '../../../engine/src/core/ops'
import type { Op } from '../../../engine/src/core/ops'
import { serializeItem } from '../../../engine/src/core/format'
import { E, strokeData } from './helpers'

const newPage = () => E.PAGE.get(E.PAGE.idFromName(`page:${crypto.randomUUID()}`)) as any
const rid = () => `req_${crypto.randomUUID()}`
const parsedRows = (opened: any) => (JSON.parse(opened.rows) as Array<{ key: string; stroke: any }>).map(r => r.stroke)
const draw = (name = 'Free body diagram', place: any = { x: 400, y: 0 }): Op[] => [{ op: 'draw', name, place, shapes: [{ type: 'rect', x: 0, y: 0, w: 60, h: 40 }, { type: 'arrow', x1: 30, y1: 20, x2: 120, y2: 20 }] }]
const withStudentInk = async (stub: any, n = 2) => {
  const client = crypto.randomUUID()
  await stub.open({ clientId: client })
  let k: string | null = null
  const adds = Array.from({ length: n }, (_, i) => ({ key: (k = keyBetween(k, null)), stroke: strokeData(`mine${i}`, i * 15) }))
  await stub.save({ clientId: client, saveId: 's1', baseRevision: 0, adds })
  return client
}

describe('with nobody editing, a request is applied straight to the page', () => {
  it('saves one revision, marks everything as NOVA, leaves the student ink alone, and reopens identically', async () => {
    const stub = newPage()
    const editor = await withStudentInk(stub)
    await stub.release({ clientId: editor })
    const before = await stub.scene()
    expect(before).toMatchObject({ ok: true, revision: 1, editorOpen: false })

    const sent = await stub.enqueue({ requestId: rid(), ops: draw(), expectedRevision: 1 })
    expect(sent).toMatchObject({ ok: true, status: 'saved', revision: 2, via: 'server' })
    expect(sent.groups[0].id).toMatch(/^nova-free-body-diagram-[0-9a-f]{8}$/)

    const after = await stub.scene()
    expect(after.revision).toBe(2)
    expect(after.groups).toEqual([expect.objectContaining({ id: sent.groups[0].id, author: 'nova', label: 'free body diagram' })])
    const reopened = await stub.open({ clientId: crypto.randomUUID() })
    const strokes = parsedRows(reopened)
    expect(strokes.filter(s => s.author !== 'ai').map(s => s.id)).toEqual(['mine0', 'mine1'])
    expect(strokes.filter(s => s.author === 'ai').every((s: any) => s.group === sent.groups[0].id)).toBe(true)
    expect(strokes.slice(0, 2).map(s => s.id)).toEqual(['mine0', 'mine1'])
  })

  it('a retry with the same request id never applies twice', async () => {
    const stub = newPage()
    const requestId = rid()
    const first = await stub.enqueue({ requestId, ops: draw() })
    const again = await stub.enqueue({ requestId, ops: draw() })
    expect(first.status).toBe('saved')
    expect(again).toMatchObject({ ok: true, duplicate: true, status: 'saved', revision: first.revision })
    const rows = parsedRows(await stub.open({ clientId: crypto.randomUUID() }))
    const groups = new Set(rows.map(r => r.group))
    expect(groups.size).toBe(1)
    expect((await stub.scene()).revision).toBe(first.revision)
  })

  it('a different request id is a different action', async () => {
    const stub = newPage()
    await stub.enqueue({ requestId: rid(), ops: draw('one') })
    await stub.enqueue({ requestId: rid(), ops: draw('two', { x: 400, y: 200 }) })
    expect((await stub.scene()).groups).toHaveLength(2)
  })

  it('refuses bad requests with a message and stores nothing: unknown ids, bad shapes, stale revision, bad request id', async () => {
    const stub = newPage()
    await withStudentInk(stub).then(c => stub.release({ clientId: c }))
    const missing = await stub.enqueue({ requestId: rid(), ops: [{ op: 'move', targets: ['ghost'], dx: 5 }] })
    expect(missing).toMatchObject({ ok: false, code: 'INVALID_OPS' })
    expect(missing.message).toMatch(/not on this page/)
    expect(await stub.enqueue({ requestId: rid(), ops: [{ op: 'draw', place: {}, shapes: [] }] })).toMatchObject({ ok: false, code: 'INVALID_OPS' })
    expect(await stub.enqueue({ requestId: rid(), ops: draw(), expectedRevision: 7 })).toMatchObject({ ok: false, code: 'STALE_REVISION', revision: 1 })
    expect(await stub.enqueue({ requestId: 'x', ops: draw() })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    const remove = await stub.enqueue({ requestId: rid(), ops: [{ op: 'remove', targets: ['ink:mine0'] }] })
    expect(remove).toMatchObject({ ok: false, code: 'INVALID_OPS' })
    expect((await stub.scene()).revision).toBe(1)
  })

  it('an operation that fails is all-or-nothing', async () => {
    const stub = newPage()
    const bad = await stub.enqueue({ requestId: rid(), ops: [...draw(), { op: 'move', targets: ['ghost'], dx: 1 }] })
    expect(bad.ok).toBe(false)
    expect((await stub.scene()).groups).toHaveLength(0)
  })
})

describe('with an editor open, the editor applies the request and the save makes it durable', () => {
  it('queued -> applied -> saved, only through the editor, and nothing is written meanwhile', async () => {
    const stub = newPage()
    const editor = await withStudentInk(stub)
    const requestId = rid()
    const queued = await stub.enqueue({ requestId, ops: draw() })
    expect(queued).toMatchObject({ ok: true, status: 'queued', editorOpen: true })
    expect((await stub.scene()).revision).toBe(1)

    const beat = await stub.heartbeat({ clientId: editor })
    expect(beat).toMatchObject({ ok: true, readOnly: false, revision: 1 })
    expect(beat.pendingOps).toEqual([expect.objectContaining({ requestId, ops: draw() })])

    // the editor applies it locally and says so on its next heartbeat
    await stub.heartbeat({ clientId: editor, applied: [requestId] })
    expect((await stub.opStatus({ requestIds: [requestId] })).ops[0].status).toBe('applied')

    // the editor's own planner makes the same batch (same ids) and the next save settles it
    const opened = await stub.open({ clientId: editor })
    const mine = beat.pendingOps[0]
    const strokes = parsedRows(opened)
    expect(strokes).toHaveLength(2)
    const plan = planOps({ strokes: [], images: [] }, mine.ops, { opId: mine.opId, now: 1 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    let k = JSON.parse(opened.rows).at(-1).key as string
    const adds = plan.adds.map(item => ({ key: (k = keyBetween(k, null)), stroke: serializeItem(item) }))
    const saved = await stub.save({ clientId: editor, saveId: 's2', baseRevision: 1, adds, appliedOps: [requestId] })
    expect(saved).toMatchObject({ ok: true, revision: 2 })
    expect((await stub.opStatus({ requestIds: [requestId] })).ops[0]).toMatchObject({ status: 'saved', revision: 2 })
    expect((await stub.scene()).pendingRequests).toBe(0)
  })

  it('a follow-up can name what a still-waiting request will create', async () => {
    const stub = newPage()
    await withStudentInk(stub)
    const first = await stub.enqueue({ requestId: rid(), ops: draw() })
    expect(first.status).toBe('queued')
    const second = await stub.enqueue({ requestId: rid(), ops: [{ op: 'move', targets: [first.groups[0].id], dx: 300, dy: 0 }] })
    expect(second).toMatchObject({ ok: true, status: 'queued' })
    expect((await stub.opStatus({})).ops.map((o: any) => o.status)).toEqual(['queued', 'queued'])
  })

  it('the student keeps writing while a request waits: both survive', async () => {
    const stub = newPage()
    const editor = await withStudentInk(stub)
    const requestId = rid()
    await stub.enqueue({ requestId, ops: draw() })
    // Pencil work lands first (revision 2) ...
    const opened = await stub.open({ clientId: editor })
    const k = keyBetween(JSON.parse(opened.rows).at(-1).key, null)
    expect(await stub.save({ clientId: editor, saveId: 's2', baseRevision: 1, adds: [{ key: k, stroke: strokeData('later', 90) }] })).toMatchObject({ ok: true, revision: 2 })
    // ... the request is still waiting and applies on top of it
    const pending = (await stub.heartbeat({ clientId: editor })).pendingOps[0]
    const plan = planOps({ strokes: [], images: [] }, pending.ops, { opId: pending.opId, now: 1 })
    if (!plan.ok) throw new Error(plan.message)
    let key = k
    const saved = await stub.save({ clientId: editor, saveId: 's3', baseRevision: 2, adds: plan.adds.map(i => ({ key: (key = keyBetween(key, null)), stroke: serializeItem(i) })), appliedOps: [requestId] })
    expect(saved).toMatchObject({ ok: true, revision: 3 })
    const ids = parsedRows(await stub.open({ clientId: editor })).filter(s => s.author !== 'ai').map(s => s.id)
    expect(ids).toEqual(['mine0', 'mine1', 'later'])
  })

  it('a save without the settled id leaves the request waiting; the editor can report one it could not apply', async () => {
    const stub = newPage()
    const editor = await withStudentInk(stub)
    const a = rid(), b = rid()
    await stub.enqueue({ requestId: a, ops: draw('a') })
    await stub.enqueue({ requestId: b, ops: draw('b', { x: 400, y: 300 }) })
    expect(await stub.reportOps({ clientId: editor, results: [{ requestId: b, status: 'failed', message: 'Operation 1: nothing fits.' }] })).toMatchObject({ ok: true })
    const status = await stub.opStatus({ requestIds: [a, b] })
    expect(status.ops.map((o: any) => o.status)).toEqual(['queued', 'failed'])
    expect(status.ops[1].reason).toMatch(/nothing fits/)
    expect(await stub.reportOps({ clientId: crypto.randomUUID(), results: [] })).toMatchObject({ ok: false, code: 'LEASE_HELD' })
  })
})

describe('closed or vanished editors', () => {
  it('when the editor stops renewing, the next status read applies what waited, once', async () => {
    const stub = newPage()
    const editor = await withStudentInk(stub)
    const requestId = rid()
    expect((await stub.enqueue({ requestId, ops: draw() })).status).toBe('queued')
    await runInDurableObject(stub, (instance: any) => { const start = Date.now(); instance.clock = () => start + 120_000 })
    const status = await stub.opStatus({ requestIds: [requestId] })
    expect(status.ops[0]).toMatchObject({ status: 'saved', via: 'server' })
    expect(status.editorOpen).toBe(false)
    const again = await stub.opStatus({ requestIds: [requestId] })
    expect(again.ops[0].revision).toBe(status.ops[0].revision)
    // the old editor now meets the newer revision instead of overwriting it
    const late = await stub.save({ clientId: editor, saveId: 's9', baseRevision: 1, adds: [] })
    expect(late).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('opening the page applies waiting work before the editor loads it', async () => {
    const stub = newPage()
    const requestId = rid()
    expect((await stub.enqueue({ requestId, ops: draw() })).status).toBe('saved')
    const opened = await stub.open({ clientId: crypto.randomUUID() })
    expect(opened.pendingOps).toEqual([])
    expect(parsedRows(opened).some(s => s.author === 'ai')).toBe(true)
  })

  it('a second device does not drain work that belongs to the live editor', async () => {
    const stub = newPage()
    await withStudentInk(stub)
    const requestId = rid()
    await stub.enqueue({ requestId, ops: draw() })
    const other = await stub.open({ clientId: crypto.randomUUID() })
    expect(other.readOnly).toBe(true)
    expect(other.pendingOps).toHaveLength(1)
    expect((await stub.opStatus({ requestIds: [requestId] })).ops[0].status).toBe('queued')
  })

  it('too many waiting requests are refused with a clear message', async () => {
    const stub = newPage()
    await withStudentInk(stub)
    let last: any
    for (let i = 0; i < 31; i++) last = await stub.enqueue({ requestId: rid(), ops: draw(`d${i}`, { x: 400 + i * 200, y: 0 }) })
    expect(last).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
  })
})
