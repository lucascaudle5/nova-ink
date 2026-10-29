import { env, runInDurableObject, evictDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../../src/diff'
import type { Snapshot } from '../../src/protocol'
import small from '../fixtures/small.json'
import s100 from '../fixtures/s100.json'
import s1500 from '../fixtures/s1500.json'
import s1500plus3 from '../fixtures/s1500-plus3.json'
import s1500camera from '../fixtures/s1500-camera.json'
import img3mb from '../fixtures/img3mb.json'

const E = env as any
const newCanvas = () => {
  const id = crypto.randomUUID()
  const stub = E.CANVAS.get(E.CANVAS.idFromName(id)) as any
  return { id, stub }
}
const A = crypto.randomUUID()
const B = crypto.randomUUID()
let n = 0
const sid = () => `save-${++n}`
const snap = (x: unknown) => x as Snapshot

/** Saves `next` relative to `base` the way a client would. */
const saveDiff = (stub: any, clientId: string, base: unknown, next: unknown, baseRevision: number, saveId = sid()) =>
  stub.save({ clientId, saveId, baseRevision, ...diffSnapshots((base ?? null) as Snapshot | null, snap(next)) })
const setClock = (stub: any, fn: () => number) => runInDurableObject(stub, (o: any) => { o.clock = fn })
const policy = (stub: any, minMs: number) => runInDurableObject(stub, (o: any) => { o.policy.checkpointMinIntervalMs = minMs })
const sqlOf = (stub: any, fn: (sql: any) => unknown) => runInDurableObject(stub, (_o: any, state: any) => fn(state.storage.sql))

describe('round trips with real tldraw snapshots', () => {
  it('a small canvas saves and loads back identical', async () => {
    const { stub } = newCanvas()
    expect((await stub.open({ clientId: A })).snapshot).toBeNull()
    const saved = await saveDiff(stub, A, null, small, 0)
    expect(saved).toMatchObject({ ok: true, revision: 1 })
    const loaded = await stub.open({ clientId: A })
    expect(loaded.revision).toBe(1)
    expect(loaded.snapshot).toEqual(small)
  })

  it('a 1,500-stroke canvas round-trips and a later edit saves only the changes', async () => {
    const { stub } = newCanvas()
    const full = await saveDiff(stub, A, null, s1500, 0)
    expect(full.ok).toBe(true)
    console.log(`[measure] full-canvas first save, 1,500 strokes: rowsWritten=${full.stats.rowsWritten} rowsRead=${full.stats.rowsRead}`)
    expect((await stub.open({ clientId: A })).snapshot).toEqual(s1500)

    const edit = await saveDiff(stub, A, s1500, s1500plus3, 1)
    expect(edit).toMatchObject({ ok: true, revision: 2 })
    console.log(`[measure] +3 strokes on 1,500-stroke canvas: rowsWritten=${edit.stats.rowsWritten} rowsRead=${edit.stats.rowsRead}`)
    expect(edit.stats.rowsWritten).toBeLessThan(15)
    expect((await stub.open({ clientId: A })).snapshot).toEqual(s1500plus3)

    const camera = await saveDiff(stub, A, s1500plus3, { ...s1500camera, document: s1500plus3.document }, 2)
    console.log(`[measure] camera-only save: rowsWritten=${camera.stats.rowsWritten}`)
    expect(camera.stats.rowsWritten).toBeLessThanOrEqual(3)
  })

  it('an image larger than 2 MB is stored in chunks, every row stays under 2 MB, and it loads back whole', async () => {
    const { stub } = newCanvas()
    const asset = Object.values(img3mb.document.store).find((r: any) => r.typeName === 'asset') as any
    expect(asset.props.src.length).toBeGreaterThan(2 * 1024 * 1024)
    const saved = await saveDiff(stub, A, null, img3mb, 0)
    expect(saved.ok).toBe(true)
    console.log(`[measure] 3 MB image first save: rowsWritten=${saved.stats.rowsWritten}`)
    const d = await stub.diagnostics()
    expect(d.blobs).toBe(1)
    expect(d.blobChunks).toBe(4)
    expect(d.maxChunkBytes).toBeLessThanOrEqual(1_000_000)
    expect(d.maxRecordBytes).toBeLessThan(2_000_000)
    expect((await stub.open({ clientId: A })).snapshot).toEqual(img3mb)
  })

  it('the same image on two assets is stored once', async () => {
    const { stub } = newCanvas()
    const copy = JSON.parse(JSON.stringify(img3mb))
    const [id, asset] = Object.entries(copy.document.store).find(([, r]: any) => r.typeName === 'asset') as [string, any]
    copy.document.store['asset:second'] = { ...asset, id: 'asset:second' }
    expect(id).not.toBe('asset:second')
    await saveDiff(stub, A, null, copy, 0)
    expect((await stub.diagnostics()).blobs).toBe(1)
    expect((await stub.open({ clientId: A })).snapshot).toEqual(copy)
  })

  it('an unreferenced image is garbage-collected once no live record or checkpoint needs it', async () => {
    const { stub } = newCanvas()
    await policy(stub, Number.MAX_SAFE_INTEGER)
    await saveDiff(stub, A, null, img3mb, 0)
    const without = JSON.parse(JSON.stringify(img3mb))
    for (const [id, r] of Object.entries(without.document.store)) if ((r as any).typeName === 'asset' || (r as any).type === 'image') delete without.document.store[id]
    await saveDiff(stub, A, img3mb, without, 1)
    expect((await stub.diagnostics()).blobs).toBe(1) // checkpoint of revision 1 still needs it
    await runInDurableObject(stub, (o: any) => { o.policy.checkpointKeep = 0 })
    await saveDiff(stub, A, without, small, 2) // prunes the checkpoint, so the image is collected
    expect((await stub.diagnostics()).blobs).toBe(0)
  })

  it('rejects a malformed record and a record over the row limit without saving', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    expect(await stub.save({ clientId: A, saveId: sid(), baseRevision: 1, puts: [{ id: 'nope', typeName: 'shape' }] })).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' })
    const huge = { id: 'shape:huge', typeName: 'shape', meta: { blob: 'x'.repeat(2_100_000) } }
    expect(await stub.save({ clientId: A, saveId: sid(), baseRevision: 1, puts: [huge] })).toMatchObject({ ok: false, code: 'RECORD_TOO_LARGE' })
    expect((await stub.open({ clientId: A })).revision).toBe(1)
  })
})

describe('durability across restart', () => {
  it('a saved canvas (rows, images, checkpoints, lease) still loads after the object is evicted and restarted', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    await saveDiff(stub, A, null, img3mb, 0)
    await saveDiff(stub, A, img3mb, s1500, 1) // replaces everything; checkpoint of rev 1 is taken
    await evictDurableObject(stub)
    const loaded = await stub.open({ clientId: A })
    expect(loaded.revision).toBe(2)
    expect(loaded.snapshot).toEqual(s1500)
    expect((await stub.listCheckpoints()).checkpoints.map((c: any) => c.revision)).toEqual([1])
    // The lease survived the restart: another client is read-only.
    expect((await stub.open({ clientId: B })).readOnly).toBe(true)
  })

  it('after a restart the editor can save without renewing its lease first', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    await evictDurableObject(stub)
    expect((await saveDiff(stub, A, small, s100, 1)).ok).toBe(true)
  })
})

describe('revision check, idempotence and lost acknowledgements', () => {
  it('a stale save conflicts and never overwrites', async () => {
    const { stub } = newCanvas()
    let t = 1_000_000
    await setClock(stub, () => t)
    await saveDiff(stub, A, null, small, 0)
    t += 60_000 // A's lease lapses; B takes the free lease by opening
    const b = await stub.open({ clientId: B })
    await saveDiff(stub, B, small, s100, b.revision)
    t += 60_000
    const stale = await saveDiff(stub, A, null, small, 1) // A still thinks revision is 1
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', revision: 2, ownLastSaveId: null }) // B made the last save, not A
    expect((await stub.open({ clientId: A })).snapshot).toEqual(s100) // B's work is intact
  })

  it('a conflict from a genuinely different writer reports no ownLastSaveId', async () => {
    const { stub } = newCanvas()
    let t = 1_000_000
    await setClock(stub, () => t)
    await saveDiff(stub, A, null, small, 0)
    t += 60_000
    await saveDiff(stub, B, small, s100, 1)
    t += 60_000
    const conflict = await saveDiff(stub, A, small, s1500, 1)
    expect(conflict).toMatchObject({ ok: false, code: 'CONFLICT', ownLastSaveId: null })
  })

  it('retrying a committed save with the same saveId is acknowledged without writing again', async () => {
    const { stub } = newCanvas()
    const saveId = sid()
    const first = await saveDiff(stub, A, null, small, 0, saveId)
    const again = await saveDiff(stub, A, null, small, 0, saveId)
    expect(again).toMatchObject({ ok: true, revision: first.revision, replayed: true })
    expect(again.stats.rowsWritten).toBe(0)
    expect((await stub.open({ clientId: A })).revision).toBe(1)
  })

  it('lost acknowledgement: the client retries with a NEW saveId and gets ownLastSaveId to reconcile', async () => {
    const { stub } = newCanvas()
    const lost = sid()
    await saveDiff(stub, A, null, small, 0, lost) // committed; the reply never reached the client
    const retry = await saveDiff(stub, A, null, small, 0, sid())
    expect(retry).toMatchObject({ ok: false, code: 'CONFLICT', revision: 1, ownLastSaveId: lost })
  })

  it('the save protocol survives a restart between the commit and the retry', async () => {
    const { stub } = newCanvas()
    const saveId = sid()
    await saveDiff(stub, A, null, small, 0, saveId)
    await evictDurableObject(stub)
    expect(await saveDiff(stub, A, null, small, 0, saveId)).toMatchObject({ ok: true, replayed: true, revision: 1 })
  })
})

describe('editor lease', () => {
  it('a second client is read-only while the first holds the lease and cannot save', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    expect((await stub.open({ clientId: B })).readOnly).toBe(true)
    expect(await saveDiff(stub, B, small, s100, 1)).toMatchObject({ ok: false, code: 'LEASE_HELD' })
    expect((await stub.release({ clientId: B })).ok).toBe(true) // a non-owner cannot release it
    expect((await stub.open({ clientId: B })).readOnly).toBe(true)
    await stub.release({ clientId: A })
    expect((await stub.open({ clientId: B })).readOnly).toBe(false)
  })

  it('simultaneous opens grant exactly one lease', async () => {
    const { stub } = newCanvas()
    const results = await Promise.all([stub.open({ clientId: A }), stub.open({ clientId: B })])
    expect(results.filter(r => !r.readOnly)).toHaveLength(1)
  })

  it('heartbeats keep the lease for 45 s; it lapses afterwards; take-over still respects the revision check', async () => {
    const { stub } = newCanvas()
    let t = 5_000_000
    await setClock(stub, () => t)
    await stub.open({ clientId: A })
    t += 40_000
    await stub.heartbeat({ clientId: A })
    t += 40_000
    expect((await stub.open({ clientId: B })).readOnly).toBe(true) // renewed, still held
    t += 46_000
    expect((await stub.open({ clientId: B })).readOnly).toBe(false) // lapsed
    expect((await stub.open({ clientId: A, takeOver: true })).readOnly).toBe(false)
  })

  it('a save can take a lease nobody holds', async () => {
    const { stub } = newCanvas()
    expect((await saveDiff(stub, A, null, small, 0)).ok).toBe(true)
    expect((await stub.open({ clientId: B })).readOnly).toBe(true)
  })
})

describe('commit point and bookkeeping failures', () => {
  it('a failure before the commit point leaves the previous revision intact', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    await runInDurableObject(stub, (o: any) => { o.faults.beforeCommit = true })
    expect(await saveDiff(stub, A, small, s100, 1)).toMatchObject({ ok: false, code: 'STORAGE_ERROR' })
    await runInDurableObject(stub, (o: any) => { o.faults.beforeCommit = false })
    const loaded = await stub.open({ clientId: A })
    expect(loaded.revision).toBe(1)
    expect(loaded.snapshot).toEqual(small)
  })

  it('a failure after the commit point is reported as saved, with a warning', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    await runInDurableObject(stub, (o: any) => { o.faults.afterCommit = true })
    const saved = await saveDiff(stub, A, small, s100, 1)
    expect(saved).toMatchObject({ ok: true, revision: 2 })
    expect(saved.warning).toMatch(/Saved, but/)
    await runInDurableObject(stub, (o: any) => { o.faults.afterCommit = false })
    expect((await stub.open({ clientId: A })).snapshot).toEqual(s100)
  })

  it('the transaction is atomic: a storage error mid-commit rolls every row back', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    // Force the commit transaction to fail partway by making a later statement invalid.
    await sqlOf(stub, sql => sql.exec('CREATE TRIGGER boom BEFORE INSERT ON kv WHEN NEW.key = \'head\' BEGIN SELECT RAISE(ABORT, \'boom\'); END'))
    expect(await saveDiff(stub, A, small, s100, 1)).toMatchObject({ ok: false, code: 'STORAGE_ERROR' })
    await sqlOf(stub, sql => sql.exec('DROP TRIGGER boom'))
    const loaded = await stub.open({ clientId: A })
    expect(loaded.revision).toBe(1)
    expect(loaded.snapshot).toEqual(small) // none of s100's records leaked in
  })
})

describe('checkpoints and recovery', () => {
  it('checkpoints the prior revision only when the document changed, rate-limited', async () => {
    const { stub } = newCanvas()
    let t = 10_000_000
    await setClock(stub, () => t)
    await saveDiff(stub, A, null, s1500, 0)
    const cameraOnly = await saveDiff(stub, A, s1500, s1500camera, 1)
    expect(cameraOnly.checkpointed).toBe(false)
    expect((await stub.listCheckpoints()).checkpoints).toHaveLength(0)
    const edit = await saveDiff(stub, A, s1500camera, s1500plus3, 2)
    expect(edit.checkpointed).toBe(true)
    expect((await stub.listCheckpoints()).checkpoints.map((c: any) => c.revision)).toEqual([2])
    t += 60_000
    const soon = await saveDiff(stub, A, s1500plus3, s1500, 3) // within the 10-minute window
    expect(soon.checkpointed).toBe(false)
    t += 11 * 60_000
    const later = await saveDiff(stub, A, s1500, s1500plus3, 4)
    expect(later.checkpointed).toBe(true)
    console.log(`[measure] save that also writes a checkpoint (1,500 strokes): rowsWritten=${later.stats.rowsWritten}; checkpoint bytes=${(await stub.listCheckpoints()).checkpoints[0].bytes}`)
  })

  it('keeps only the newest checkpoints', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    await runInDurableObject(stub, (o: any) => { o.policy.checkpointKeep = 3 })
    let prev: unknown = null
    let rev = 0
    for (let i = 0; i < 7; i++) {
      const next = i % 2 ? s100 : small
      await saveDiff(stub, A, prev, next, rev)
      prev = next; rev++
    }
    expect((await stub.listCheckpoints()).checkpoints.map((c: any) => c.revision)).toEqual([6, 5, 4])
  })

  it('restoring a checkpoint creates a new revision and preserves the current one', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    await saveDiff(stub, A, null, small, 0)
    await saveDiff(stub, A, small, s100, 1) // checkpoint of rev 1 (= small)
    const restored = await stub.restoreCheckpoint({ clientId: A, saveId: sid(), checkpointRevision: 1, expectedRevision: 2 })
    expect(restored).toMatchObject({ ok: true, revision: 3, restoredRevision: 1 })
    expect((await stub.open({ clientId: A })).snapshot).toEqual(small)
    expect((await stub.listCheckpoints()).checkpoints.map((c: any) => c.revision)).toEqual([2, 1]) // s100 kept as rev 2
    expect(await stub.restoreCheckpoint({ clientId: A, saveId: sid(), checkpointRevision: 2, expectedRevision: 2 })).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('restore cannot take control from another active editor', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    await saveDiff(stub, A, null, small, 0)
    await saveDiff(stub, A, small, s100, 1)
    expect(await stub.restoreCheckpoint({ clientId: B, saveId: sid(), checkpointRevision: 1, expectedRevision: 2 })).toMatchObject({ ok: false, code: 'LEASE_HELD' })
  })

  it('a damaged record is reported, quarantined and restorable from a checkpoint', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    await saveDiff(stub, A, null, small, 0)
    await saveDiff(stub, A, small, s100, 1)
    const victim = Object.values(s100.document.store).find((r: any) => r.typeName === 'shape') as any
    await sqlOf(stub, sql => sql.exec('UPDATE records SET json = ? WHERE id = ?', '{not json', victim.id))
    const opened = await stub.open({ clientId: A })
    expect(opened).toMatchObject({ ok: false, code: 'CORRUPT_RECORD' })
    expect(opened.snapshot).toBeUndefined()
    const restored = await stub.restoreCheckpoint({ clientId: A, saveId: sid(), checkpointRevision: 1, expectedRevision: null })
    expect(restored).toMatchObject({ ok: true, recoveryCopyPreserved: true })
    expect((await stub.open({ clientId: A })).snapshot).toEqual(small)
    expect((await stub.diagnostics()).quarantined).toBeGreaterThan(0)
  })

  it('a damaged canvas refuses ordinary reads and can be restored from a valid checkpoint', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    await saveDiff(stub, A, null, small, 0)
    await saveDiff(stub, A, small, s100, 1)
    await sqlOf(stub, sql => sql.exec("UPDATE kv SET value = '{broken' WHERE key = 'head'"))
    expect(await stub.open({ clientId: A })).toMatchObject({ ok: false, code: 'CORRUPT_RECORD' })
    expect(await saveDiff(stub, A, s100, small, 2)).toMatchObject({ ok: false, code: 'CORRUPT_RECORD' })
    const restored = await stub.restoreCheckpoint({ clientId: A, saveId: sid(), checkpointRevision: 1, expectedRevision: null, knownRevision: 2 })
    expect(restored).toMatchObject({ ok: true, recoveryCopyPreserved: true })
    expect(restored.revision).toBe(3) // never reuses revision 2, which the client may hold
    expect((await stub.open({ clientId: A })).snapshot).toEqual(small)
    expect((await stub.diagnostics()).quarantined).toBeGreaterThan(0)
  })

  it('a canvas whose rows vanished is reported missing, never blank', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    await saveDiff(stub, A, null, small, 0)
    await saveDiff(stub, A, small, s100, 1)
    await sqlOf(stub, sql => { sql.exec('DELETE FROM records'); sql.exec("DELETE FROM kv WHERE key = 'head'") })
    expect(await stub.open({ clientId: A })).toMatchObject({ ok: false, code: 'MISSING_RECORD' })
    expect(await saveDiff(stub, A, null, small, 0)).toMatchObject({ ok: false, code: 'MISSING_RECORD' })
  })

  it('deleted records alone (head intact) are detected as missing', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    const victim = Object.values(small.document.store).find((r: any) => r.typeName === 'shape') as any
    await sqlOf(stub, sql => sql.exec('DELETE FROM records WHERE id = ?', victim.id))
    expect(await stub.open({ clientId: A })).toMatchObject({ ok: false, code: 'MISSING_RECORD' })
  })

  it('an unsaved canvas the library knows was saved before is missing, not blank', async () => {
    const { stub } = newCanvas()
    expect(await stub.open({ clientId: A, knownRevision: 4 })).toMatchObject({ ok: false, code: 'MISSING_RECORD' })
    expect(await stub.open({ clientId: A })).toMatchObject({ ok: true, revision: 0, snapshot: null })
  })

  it('refuses data written by a newer storage format', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    await sqlOf(stub, sql => {
      const head = JSON.parse(sql.exec("SELECT value FROM kv WHERE key = 'head'").one().value)
      sql.exec("UPDATE kv SET value = ? WHERE key = 'head'", JSON.stringify({ ...head, format: 99 }))
    })
    expect(await stub.open({ clientId: A })).toMatchObject({ ok: false, code: 'FORMAT_NEWER' })
  })
})

describe('save my version as a new canvas', () => {
  it('is atomic and safe to retry through the Worker', async () => {
    const body = JSON.stringify({ name: 'Copy', clientId: A, saveId: 'sa-1', snapshot: small })
    const post = () => SELF.fetch('https://x/api/save-as-new', { method: 'POST', body }).then(r => r.json()) as Promise<any>
    const first = await post()
    expect(first).toMatchObject({ ok: true, revision: 1, canvas: { name: 'Copy' } })
    const retry = await post()
    expect(retry).toMatchObject({ ok: true, revision: 1, replayed: true, canvas: { id: first.canvas.id } })
    const opened = await (await SELF.fetch(`https://x/api/canvas/${first.canvas.id}/open`, { method: 'POST', body: JSON.stringify({ clientId: A }) })).json() as any
    expect(opened.snapshot).toEqual(small)
    const bad = await (await SELF.fetch('https://x/api/save-as-new', { method: 'POST', body: JSON.stringify({ name: 'x', clientId: A, saveId: 'sa-2', snapshot: { nope: 1 } }) })).json() as any
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' })
  })
})

describe('fast load (openRaw)', () => {
  it('returns exactly what open() returns, including chunked images', async () => {
    for (const fx of [small, s1500, img3mb]) {
      const { stub } = newCanvas()
      await saveDiff(stub, A, null, fx, 0)
      const raw = JSON.parse(await stub.openRaw({ clientId: A }))
      expect(raw).toMatchObject({ ok: true, revision: 1, readOnly: false })
      expect(raw.snapshot).toEqual(fx)
    }
  })

  it('reports damaged and missing data instead of a blank canvas', async () => {
    const { stub } = newCanvas()
    await saveDiff(stub, A, null, small, 0)
    const victim = Object.values(small.document.store).find((r: any) => r.typeName === 'shape') as any
    await sqlOf(stub, sql => sql.exec('UPDATE records SET json = ? WHERE id = ?', '{not json', victim.id))
    expect(JSON.parse(await stub.openRaw({ clientId: A }))).toMatchObject({ ok: false, code: 'CORRUPT_RECORD' })
    // Garbage that still looks like an object is caught by the client's JSON.parse (documented contract).
    await sqlOf(stub, sql => sql.exec('UPDATE records SET json = ? WHERE id = ?', '{"a":}', victim.id))
    const garbage = await stub.openRaw({ clientId: A })
    expect(() => JSON.parse(garbage)).toThrow()
    await sqlOf(stub, sql => sql.exec('DELETE FROM records WHERE id = ?', victim.id))
    expect(JSON.parse(await stub.openRaw({ clientId: A }))).toMatchObject({ ok: false, code: 'MISSING_RECORD' })
  })
})
describe('imported PDF page provenance', () => {
  it('a locked background image with source provenance in record meta survives save, load, checkpoint and restore', async () => {
    const { stub } = newCanvas()
    await policy(stub, 0)
    const pdfPage = JSON.parse(JSON.stringify(img3mb))
    const prov = { novaSource: { sourceId: 'src-1', sourceSha256: 'a'.repeat(64), page: 7 } }
    for (const r of Object.values(pdfPage.document.store) as any[]) {
      if (r.typeName === 'asset' || (r.typeName === 'shape' && r.type === 'image')) r.meta = { ...r.meta, ...prov }
      if (r.typeName === 'shape' && r.type === 'image') r.isLocked = true
    }
    await saveDiff(stub, A, null, pdfPage, 0)
    const opened = await stub.open({ clientId: A })
    expect(opened.snapshot).toEqual(pdfPage)
    const metas = Object.values(opened.snapshot.document.store).filter((r: any) => r.meta?.novaSource)
    expect(metas).toHaveLength(2) // the asset and the locked image shape
    // Ink drawn over the page is separate records: annotate, then restore the un-annotated checkpoint.
    const annotated = JSON.parse(JSON.stringify(pdfPage))
    Object.assign(annotated.document.store, Object.fromEntries(Object.entries(s100.document.store).filter(([, r]: any) => r.typeName === 'shape').slice(0, 5)))
    await saveDiff(stub, A, pdfPage, annotated, 1)
    const restored = await stub.restoreCheckpoint({ clientId: A, saveId: sid(), checkpointRevision: 1, expectedRevision: 2 })
    expect(restored.ok).toBe(true)
    expect((await stub.open({ clientId: A })).snapshot).toEqual(pdfPage)
    expect((await stub.diagnostics()).blobs).toBe(1) // the rendered page is still stored once
  })
})