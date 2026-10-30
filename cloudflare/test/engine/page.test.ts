/** PageDO in the local Workers runtime (workerd): delta saves, the v0.2 save checks, checkpoints and recovery. */
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { parseStroke } from '../../../engine/src/core/format'
import { keyBetween } from '../../../engine/src/core/order'
import type { PageDO } from '../../src/engine/page-do'
import { E, strokeData } from './helpers'

const newPage = () => {
  const id = E.PAGE.idFromName(`page:${crypto.randomUUID()}`)
  return { id, stub: E.PAGE.get(id) as any }
}
const keys = (n: number) => { const out: string[] = []; let k: string | null = null; for (let i = 0; i < n; i++) out.push(k = keyBetween(k, null)); return out }
const ids = (opened: any) => (JSON.parse(opened.rows) as Array<{ key: string; stroke: any }>).map(r => r.stroke.id)

describe('a page saves only what changed', () => {
  it('opens blank, saves strokes, and reopens them in z-order', async () => {
    const { stub } = newPage()
    const client = crypto.randomUUID()
    const blank = await stub.open({ clientId: client })
    expect(blank).toMatchObject({ ok: true, revision: 0, rows: '[]', strokeCount: 0, paper: { color: 'white', pattern: 'blank' }, camera: null, readOnly: false })

    const [k1, k2, k3] = keys(3)
    const saved = await stub.save({ clientId: client, saveId: 's1', baseRevision: 0, adds: [{ key: k3, stroke: strokeData('c') }, { key: k1, stroke: strokeData('a') }, { key: k2, stroke: strokeData('b') }] })
    expect(saved).toMatchObject({ ok: true, revision: 1, strokeCount: 3 })
    expect(saved.stats.rowsWritten).toBeLessThanOrEqual(5) // 3 strokes + head (+ lease on first open)

    const reopened = await stub.open({ clientId: client })
    expect(reopened).toMatchObject({ ok: true, revision: 1, strokeCount: 3 })
    expect(ids(reopened)).toEqual(['a', 'b', 'c'])
    for (const row of JSON.parse(reopened.rows)) expect(parseStroke(row.stroke).ok).toBe(true)
  })

  it('a partial erase (removes + adds) is one atomic revision that keeps the piece positions', async () => {
    const { stub } = newPage()
    const client = crypto.randomUUID()
    await stub.open({ clientId: client })
    const [k1, k2, k3] = keys(3)
    await stub.save({ clientId: client, saveId: 's1', baseRevision: 0, adds: [{ key: k1, stroke: strokeData('a') }, { key: k2, stroke: strokeData('b') }, { key: k3, stroke: strokeData('c') }] })
    const p1 = keyBetween(k1, k3), p2 = keyBetween(p1, k3)
    const erase = await stub.save({ clientId: client, saveId: 's2', baseRevision: 1, removes: ['b'], adds: [{ key: p1, stroke: strokeData('b1') }, { key: p2, stroke: strokeData('b2') }] })
    expect(erase).toMatchObject({ ok: true, revision: 2, strokeCount: 4 })
    expect(ids(await stub.open({ clientId: client }))).toEqual(['a', 'b1', 'b2', 'c'])
  })

  it('paper and camera are stored; a camera-only save is a revision without touching strokes', async () => {
    const { stub } = newPage()
    const client = crypto.randomUUID()
    await stub.open({ clientId: client })
    const [k1] = keys(1)
    await stub.save({ clientId: client, saveId: 's1', baseRevision: 0, adds: [{ key: k1, stroke: strokeData('a') }], paper: { color: 'dark', pattern: 'graph' } })
    const cam = await stub.save({ clientId: client, saveId: 's2', baseRevision: 1, camera: { x: 10, y: -20, z: 0.5 } })
    expect(cam).toMatchObject({ ok: true, revision: 2, strokeCount: 1 })
    expect(cam.stats.rowsWritten).toBeLessThanOrEqual(2)
    expect(await stub.open({ clientId: client })).toMatchObject({ paper: { color: 'dark', pattern: 'graph' }, camera: { x: 10, y: -20, z: 0.5 } })
  })
})

describe('the same checks as v0.2: replay, lease, revision, validation', () => {
  it('a retried save replays without writing; a stale revision is a CONFLICT that names our own last save', async () => {
    const { stub } = newPage()
    const client = crypto.randomUUID()
    await stub.open({ clientId: client })
    const [k1, k2] = keys(2)
    const req = { clientId: client, saveId: 's1', baseRevision: 0, adds: [{ key: k1, stroke: strokeData('a') }] }
    expect(await stub.save(req)).toMatchObject({ ok: true, revision: 1 })
    expect(await stub.save(req)).toMatchObject({ ok: true, revision: 1, replayed: true })
    const stale = await stub.save({ clientId: client, saveId: 's2', baseRevision: 0, adds: [{ key: k2, stroke: strokeData('b') }] })
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', revision: 1, ownLastSaveId: 's1' })
    expect((await stub.open({ clientId: client })).strokeCount).toBe(1)
  })

  it('one editor at a time: another device reads only, cannot save, and can take over', async () => {
    const { stub } = newPage()
    const a = crypto.randomUUID(), b = crypto.randomUUID()
    expect(await stub.open({ clientId: a })).toMatchObject({ readOnly: false })
    expect(await stub.open({ clientId: b })).toMatchObject({ ok: true, readOnly: true })
    expect(await stub.save({ clientId: b, saveId: 'x', baseRevision: 0, adds: [{ key: keys(1)[0], stroke: strokeData('z') }] })).toMatchObject({ ok: false, code: 'LEASE_HELD' })
    expect(await stub.heartbeat({ clientId: b })).toMatchObject({ ok: true, readOnly: true })
    expect(await stub.open({ clientId: b, takeOver: true })).toMatchObject({ readOnly: false })
    expect(await stub.save({ clientId: a, saveId: 'y', baseRevision: 0 })).toMatchObject({ ok: false, code: 'LEASE_HELD' })
    await stub.release({ clientId: b })
    expect(await stub.open({ clientId: a })).toMatchObject({ readOnly: false })
  })

  it('an expired lease is free again', async () => {
    const { id, stub } = newPage()
    const a = crypto.randomUUID(), b = crypto.randomUUID()
    await stub.open({ clientId: a })
    await runInDurableObject(E.PAGE.get(id), async (page: PageDO) => { const now = Date.now(); page.clock = () => now + 46_000 })
    expect(await stub.open({ clientId: b })).toMatchObject({ readOnly: false })
  })

  it('refuses bad strokes, keys, paper and camera without changing anything', async () => {
    const { stub } = newPage()
    const client = crypto.randomUUID()
    await stub.open({ clientId: client })
    const [k1] = keys(1)
    const base = { clientId: client, baseRevision: 0 }
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ adds: [{ key: k1, stroke: { ...strokeData('a'), n: 99 } }] }, 'INVALID_STROKE'],
      [{ adds: [{ key: k1, stroke: { ...strokeData('a'), id: 'no spaces' } }] }, 'INVALID_STROKE'],
      [{ adds: [{ key: 'not-a-key', stroke: strokeData('a') }] }, 'INVALID_STROKE'],
      [{ adds: [{ key: k1, stroke: strokeData('a') }, { key: keyBetween(k1, null), stroke: strokeData('a') }] }, 'INVALID_STROKE'],
      [{ removes: ['bad id!'] }, 'INVALID_REQUEST'],
      [{ paper: { color: 'neon', pattern: 'dots' } }, 'INVALID_REQUEST'],
      [{ camera: { x: 0, y: 0, z: 100 } }, 'INVALID_REQUEST'],
    ]
    for (const [i, [change, code]] of bad.entries()) expect(await stub.save({ ...base, saveId: `bad${i}`, ...change }), JSON.stringify(change)).toMatchObject({ ok: false, code })
    expect(await stub.open({ clientId: client })).toMatchObject({ revision: 0, strokeCount: 0 })
  })

  it('a failure before the commit point leaves the previous revision intact', async () => {
    const { id, stub } = newPage()
    const client = crypto.randomUUID()
    await stub.open({ clientId: client })
    const [k1, k2] = keys(2)
    await stub.save({ clientId: client, saveId: 's1', baseRevision: 0, adds: [{ key: k1, stroke: strokeData('a') }] })
    await runInDurableObject(E.PAGE.get(id), async (page: PageDO) => { page.faults.beforeCommit = true })
    expect(await stub.save({ clientId: client, saveId: 's2', baseRevision: 1, adds: [{ key: k2, stroke: strokeData('b') }] })).toMatchObject({ ok: false, code: 'STORAGE_ERROR' })
    await runInDurableObject(E.PAGE.get(id), async (page: PageDO) => { page.faults.beforeCommit = false })
    expect(await stub.open({ clientId: client })).toMatchObject({ revision: 1, strokeCount: 1 })
  })
})

describe('checkpoints and recovery', () => {
  it('keeps checkpoints of earlier revisions and restores one as a new revision', async () => {
    const { id, stub } = newPage()
    const client = crypto.randomUUID()
    await runInDurableObject(E.PAGE.get(id), async (page: PageDO) => { page.policy = { checkpointMinIntervalMs: 0, checkpointKeep: 3 } })
    await stub.open({ clientId: client })
    const ks = keys(6)
    for (let i = 0; i < 6; i++) await stub.save({ clientId: client, saveId: `s${i}`, baseRevision: i, adds: [{ key: ks[i], stroke: strokeData(`k${i}`) }] })
    const cameraOnly = await stub.save({ clientId: client, saveId: 'cam', baseRevision: 6, camera: { x: 1, y: 2, z: 1 } })
    expect(cameraOnly.revision).toBe(7)
    const listed = await stub.listCheckpoints()
    expect(listed.checkpoints.map((c: any) => c.revision)).toEqual([5, 4, 3]) // newest 3; no checkpoint for a camera-only save
    expect(listed.checkpoints[0].strokeCount).toBe(5)

    const restored = await stub.restoreCheckpoint({ clientId: client, saveId: 'r1', checkpointRevision: 3, expectedRevision: 7 })
    expect(restored).toMatchObject({ ok: true, revision: 8, restoredRevision: 3 })
    expect(ids(await stub.open({ clientId: client }))).toEqual(['k0', 'k1', 'k2'])
    expect((await stub.listCheckpoints()).checkpoints[0].revision).toBe(7) // the state before the restore was kept
    expect(await stub.restoreCheckpoint({ clientId: client, saveId: 'r2', checkpointRevision: 4, expectedRevision: 7 })).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('a damaged stroke row is reported, never shown as a blank page, and a checkpoint restores it with the damage kept aside', async () => {
    const { id, stub } = newPage()
    const client = crypto.randomUUID()
    await runInDurableObject(E.PAGE.get(id), async (page: PageDO) => { page.policy = { checkpointMinIntervalMs: 0, checkpointKeep: 10 } })
    await stub.open({ clientId: client })
    const [k1, k2] = keys(2)
    await stub.save({ clientId: client, saveId: 's1', baseRevision: 0, adds: [{ key: k1, stroke: strokeData('a') }] })
    await stub.save({ clientId: client, saveId: 's2', baseRevision: 1, adds: [{ key: k2, stroke: strokeData('b') }] })
    await runInDurableObject(E.PAGE.get(id), async (_page: PageDO, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE strokes SET json = 'garbage' WHERE id = 'b'")
    })
    expect(await stub.open({ clientId: client })).toMatchObject({ ok: false, code: 'CORRUPT_RECORD' })
    const restored = await stub.restoreCheckpoint({ clientId: client, saveId: 'r', checkpointRevision: 1, expectedRevision: null })
    expect(restored).toMatchObject({ ok: true, revision: 3, recoveryCopyPreserved: true })
    expect(ids(await stub.open({ clientId: client }))).toEqual(['a'])
    await runInDurableObject(E.PAGE.get(id), async (_page: PageDO, state: DurableObjectState) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM quarantine WHERE source = 'stroke'").one().n).toBe(2)
    })
  })

  it('a page the library says was saved, but whose data is gone, is MISSING_RECORD, not blank', async () => {
    const { stub } = newPage()
    expect(await stub.open({ clientId: crypto.randomUUID(), knownRevision: 4 })).toMatchObject({ ok: false, code: 'MISSING_RECORD' })
  })

  it('a page written by a newer format is refused', async () => {
    const { id, stub } = newPage()
    await runInDurableObject(E.PAGE.get(id), async (_page: PageDO, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO kv (key, value) VALUES ('head', ?)", JSON.stringify({ format: 2, revision: 3, saveId: 'x', savedBy: null, savedAt: null, strokeCount: 0, lastCheckpointAt: null }))
    })
    expect(await stub.open({ clientId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'FORMAT_NEWER' })
  })

  it('init sets the paper of a new page only', async () => {
    const { stub } = newPage()
    const client = crypto.randomUUID()
    expect(await stub.init({ paper: { color: 'cream', pattern: 'lined' } })).toMatchObject({ ok: true })
    expect(await stub.info()).toMatchObject({ ok: true, revision: 0, paper: { color: 'cream', pattern: 'lined' } })
    await stub.open({ clientId: client })
    await stub.save({ clientId: client, saveId: 's1', baseRevision: 0, adds: [{ key: keys(1)[0], stroke: strokeData('a') }] })
    expect(await stub.init({ paper: { color: 'dark', pattern: 'dots' } })).toMatchObject({ ok: true, unchanged: true })
    expect((await stub.info()).paper).toEqual({ color: 'cream', pattern: 'lined' })
  })
})
