/**
 * Pictures on pages: stored in pieces in the user's library, then placed by an image row in a page save.
 * Test pictures are a few synthetic bytes with a JPEG or PNG signature (the server does not decode them).
 */
import { describe, expect, it } from 'vitest'
import { keyBetween } from '../../../engine/src/core/order'
import { signIn, strokeData, tool } from './helpers'

const CHUNK = 192 * 1024
const b64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
function fakeJpeg(size: number) {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31) & 0xff
  bytes.set([0xff, 0xd8, 0xff], 0)
  return bytes
}
const pieces = (bytes: Uint8Array) => Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, i) => b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)))
const imageRow = (id: string, image: string) => ({ id, kind: 'image', author: 'student', createdAt: 1, image, x: 10, y: 20, w: 300, h: 200 })

describe('pictures', () => {
  it('a picture uploaded in pieces (in any order, re-sent) can be placed, reopened and read back', async () => {
    const token = (await signIn())!
    const created = await tool(token, 'nb_create_notebook', { name: 'Pictures' })
    const pageId = created.pageId, client = crypto.randomUUID()
    const bytes = fakeJpeg(CHUNK * 2 + 1234)
    const parts = pieces(bytes)
    const meta = { imageId: 'pic-1', mime: 'image/jpeg', width: 1600, height: 1200, bytes: bytes.length, count: parts.length }

    expect(await tool(token, 'nb_put_image', { ...meta, index: 2, data: parts[2] })).toMatchObject({ ok: true, complete: false })
    expect(await tool(token, 'nb_get_image', { imageId: 'pic-1', index: 0 })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    await tool(token, 'nb_open_page', { pageId, clientId: client })
    const early = await tool(token, 'nb_save_page', { pageId, clientId: client, saveId: 'i0', baseRevision: 0, adds: [{ key: keyBetween(null, null), stroke: imageRow('p1', 'pic-1') }] })
    expect(early).toMatchObject({ ok: false, code: 'MISSING_IMAGE', missing: ['pic-1'] })

    expect(await tool(token, 'nb_put_image', { ...meta, index: 0, data: parts[0] })).toMatchObject({ ok: true, complete: false })
    expect(await tool(token, 'nb_put_image', { ...meta, index: 0, data: parts[0] })).toMatchObject({ ok: true, complete: false })
    expect(await tool(token, 'nb_put_image', { ...meta, index: 1, data: parts[1] })).toMatchObject({ ok: true, complete: true })
    expect(await tool(token, 'nb_put_image', { ...meta, index: 1, data: parts[1] })).toMatchObject({ ok: true, complete: true })

    const k1 = keyBetween(null, null), k2 = keyBetween(k1, null)
    const saved = await tool(token, 'nb_save_page', {
      pageId, clientId: client, saveId: 'i1', baseRevision: 0,
      adds: [{ key: k1, stroke: { ...imageRow('p1', 'pic-1'), extra: 'dropped' } }, { key: k2, stroke: strokeData('s1') }],
    })
    expect(saved).toMatchObject({ ok: true, revision: 1, strokeCount: 2 })
    const reopened = await tool(token, 'nb_open_page', { pageId, clientId: client })
    const rows = JSON.parse(reopened.rows)
    expect(rows[0]).toEqual({ key: k1, stroke: imageRow('p1', 'pic-1') })
    expect(rows[1].stroke.id).toBe('s1')

    const back: number[] = []
    for (let i = 0; i < parts.length; i++) {
      const piece = await tool(token, 'nb_get_image', { imageId: 'pic-1', index: i })
      expect(piece).toMatchObject({ ok: true, mime: 'image/jpeg', width: 1600, height: 1200, count: 3, index: i })
      const raw = atob(piece.data)
      for (let k = 0; k < raw.length; k++) back.push(raw.charCodeAt(k))
    }
    expect(back.length).toBe(bytes.length)
    expect(back.every((b, i) => b === bytes[i])).toBe(true)
  })

  it('refuses pictures that are not what they claim, wrong-sized pieces, reused ids and bad rows', async () => {
    const token = (await signIn())!
    const bytes = fakeJpeg(1000)
    const meta = { imageId: 'pic-2', mime: 'image/jpeg', width: 10, height: 10, bytes: 1000, count: 1, index: 0 }
    expect(await tool(token, 'nb_put_image', { ...meta, mime: 'image/png', data: b64(bytes) })).toMatchObject({ ok: false, code: 'INVALID_IMAGE' })
    expect(await tool(token, 'nb_put_image', { ...meta, data: b64(bytes.subarray(0, 999)) })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await tool(token, 'nb_put_image', { ...meta, count: 2, data: b64(bytes) })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await tool(token, 'nb_put_image', { ...meta, data: '***' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await tool(token, 'nb_put_image', { ...meta, data: b64(bytes) })).toMatchObject({ ok: true, complete: true })
    expect(await tool(token, 'nb_put_image', { ...meta, width: 11, data: b64(bytes) })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })

    const created = await tool(token, 'nb_create_notebook', { name: 'Bad rows' })
    const client = crypto.randomUUID()
    await tool(token, 'nb_open_page', { pageId: created.pageId, clientId: client })
    const bad = await tool(token, 'nb_save_page', { pageId: created.pageId, clientId: client, saveId: 'b1', baseRevision: 0, adds: [{ key: keyBetween(null, null), stroke: { ...imageRow('p2', 'pic-2'), w: 1 } }] })
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_STROKE' })
    const other = await tool(token, 'nb_save_page', { pageId: created.pageId, clientId: client, saveId: 'b2', baseRevision: 0, adds: [{ key: keyBetween(null, null), stroke: { id: 'v1', kind: 'video' } }] })
    expect(other).toMatchObject({ ok: false, code: 'INVALID_STROKE' })
    const tilted = await tool(token, 'nb_save_page', { pageId: created.pageId, clientId: client, saveId: 'b3', baseRevision: 0, adds: [{ key: keyBetween(null, null), stroke: { ...imageRow('p3', 'pic-2'), rotation: 45 } }] })
    expect(tilted).toMatchObject({ ok: false, code: 'INVALID_STROKE' })
  })

  it('a rotated picture keeps its rotation through a save and reopen', async () => {
    const token = (await signIn())!
    const bytes = fakeJpeg(1000)
    expect(await tool(token, 'nb_put_image', { imageId: 'pic-3', mime: 'image/jpeg', width: 10, height: 10, bytes: 1000, count: 1, index: 0, data: b64(bytes) })).toMatchObject({ ok: true, complete: true })
    const created = await tool(token, 'nb_create_notebook', { name: 'Rotated' })
    const client = crypto.randomUUID()
    await tool(token, 'nb_open_page', { pageId: created.pageId, clientId: client })
    const key = keyBetween(null, null)
    // A legacy quarter-turn row is stored in the free-angle form (same picture, same place on the page).
    const row = { ...imageRow('r1', 'pic-3'), rotation: 270 }
    const converted = { ...imageRow('r1', 'pic-3'), x: 60, y: -30, w: 200, h: 300, angle: 270 }
    expect(await tool(token, 'nb_save_page', { pageId: created.pageId, clientId: client, saveId: 'r1', baseRevision: 0, adds: [{ key, stroke: row }] })).toMatchObject({ ok: true, revision: 1 })
    const reopened = await tool(token, 'nb_open_page', { pageId: created.pageId, clientId: client })
    expect(JSON.parse(reopened.rows)).toEqual([{ key, stroke: converted }])
  })

  it('a freely turned picture keeps its angle, and a row with both angle and rotation is refused', async () => {
    const token = (await signIn())!
    expect(await tool(token, 'nb_put_image', { imageId: 'pic-4', mime: 'image/jpeg', width: 10, height: 10, bytes: 1000, count: 1, index: 0, data: b64(fakeJpeg(1000)) })).toMatchObject({ ok: true, complete: true })
    const created = await tool(token, 'nb_create_notebook', { name: 'Free turn' })
    const client = crypto.randomUUID()
    await tool(token, 'nb_open_page', { pageId: created.pageId, clientId: client })
    const key = keyBetween(null, null)
    const row = { ...imageRow('f1', 'pic-4'), angle: 37.46 }
    expect(await tool(token, 'nb_save_page', { pageId: created.pageId, clientId: client, saveId: 'f1', baseRevision: 0, adds: [{ key, stroke: row }] })).toMatchObject({ ok: true, revision: 1 })
    const reopened = await tool(token, 'nb_open_page', { pageId: created.pageId, clientId: client })
    expect(JSON.parse(reopened.rows)).toEqual([{ key, stroke: row }])
    const both = await tool(token, 'nb_save_page', { pageId: created.pageId, clientId: client, saveId: 'f2', baseRevision: 1, adds: [{ key: keyBetween(key, null), stroke: { ...imageRow('f2', 'pic-4'), angle: 10, rotation: 90 } }] })
    expect(both).toMatchObject({ ok: false, code: 'INVALID_STROKE' })
  })
})
