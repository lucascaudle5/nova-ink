/**
 * Generated test canvases for the diagnostics tool. No real notes, no tldraw dependency: this builds records in
 * tldraw's snapshot format (schema copied from a snapshot produced by tldraw 5.6) so the output also loads in the
 * widget. test/node/diag-data.test.mjs checks, with the real tldraw, that every generated snapshot loads.
 *
 * Plain syntax only (no enums, no imports) so Node can import this file directly in tests.
 */

export type DiagSnapshot = { document: { store: Record<string, any>; schema: unknown }; session: any }

export const DIAG_SIZES: Record<string, { strokes: number; imageBytes?: number }> = {
  s100: { strokes: 100 },
  s500: { strokes: 500 },
  s1500: { strokes: 1500 },
  s3000: { strokes: 3000 },
  img3mb: { strokes: 5, imageBytes: 3_000_000 },
  img8mb: { strokes: 5, imageBytes: 8_000_000 },
}

const SCHEMA = {
  schemaVersion: 2,
  sequences: {
    'com.tldraw.store': 5, 'com.tldraw.asset': 1, 'com.tldraw.camera': 1, 'com.tldraw.document': 2, 'com.tldraw.instance': 26,
    'com.tldraw.instance_page_state': 5, 'com.tldraw.page': 1, 'com.tldraw.instance_presence': 6, 'com.tldraw.pointer': 1,
    'com.tldraw.shape': 4, 'com.tldraw.user': 1, 'com.tldraw.asset.image': 6, 'com.tldraw.asset.video': 5,
    'com.tldraw.asset.bookmark': 2, 'com.tldraw.shape.group': 0, 'com.tldraw.shape.text': 4, 'com.tldraw.shape.bookmark': 2,
    'com.tldraw.shape.draw': 5, 'com.tldraw.shape.geo': 12, 'com.tldraw.shape.note': 13, 'com.tldraw.shape.line': 5,
    'com.tldraw.shape.frame': 1, 'com.tldraw.shape.arrow': 8, 'com.tldraw.shape.highlight': 4, 'com.tldraw.shape.embed': 4,
    'com.tldraw.shape.image': 5, 'com.tldraw.shape.video': 4, 'com.tldraw.binding.arrow': 1,
  },
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Fractional-index keys in increasing order: a0..az, then b00..bzz (valid integer keys; 3,906 of them). */
export function indexKey(n: number): string {
  if (n < 62) return `a${B62[n]}`
  const m = n - 62
  if (m >= 62 * 62) throw new Error('indexKey: too many shapes for the generator')
  return `b${B62[Math.floor(m / 62)]}${B62[m % 62]}`
}

/** Keys that sort after every indexKey(): 'd' + 4 base-62 digits (a valid 5-character integer key). */
export function lateIndexKey(n: number): string {
  let out = ''
  for (let i = 0, rest = n; i < 4; i++, rest = Math.floor(rest / 62)) out = B62[rest % 62] + out
  return `d${out}`
}

function toFloat16(value: number): number {
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  f32[0] = value
  const x = u32[0]
  const sign = (x >>> 16) & 0x8000
  const exp = ((x >>> 23) & 0xff) - 127 + 15
  let man = x & 0x7fffff
  if (exp <= 0) {
    if (exp < -10) return sign
    man = (man | 0x800000) >> (1 - exp)
    return sign | ((man + 0x1000) >> 13)
  }
  if (exp >= 31) return sign | 0x7c00
  return sign | (exp << 10) | ((man + 0x1000) >> 13)
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** tldraw's compressed draw path: first point as 3 float32, every later point as 3 float16 deltas. */
export function encodePath(points: Array<{ x: number; y: number; z: number }>): string {
  const bytes = new Uint8Array(12 + (points.length - 1) * 6)
  const view = new DataView(bytes.buffer)
  view.setFloat32(0, points[0].x, true); view.setFloat32(4, points[0].y, true); view.setFloat32(8, points[0].z, true)
  for (let i = 1; i < points.length; i++) {
    const o = 12 + (i - 1) * 6
    view.setUint16(o, toFloat16(points[i].x - points[i - 1].x), true)
    view.setUint16(o + 2, toFloat16(points[i].y - points[i - 1].y), true)
    view.setUint16(o + 4, toFloat16(points[i].z - points[i - 1].z), true)
  }
  return base64(bytes)
}

export function strokeRecord(n: number, pointsPerStroke = 120, idPrefix = 'd', index: string = indexKey(n)): any {
  const points = Array.from({ length: pointsPerStroke }, (_, i) => ({ x: i * 1.7, y: Math.sin((i + n) / 4) * 12, z: 0.3 + (i % 7) / 10 }))
  return {
    id: `shape:${idPrefix}${n.toString(36)}`, typeName: 'shape', type: 'draw', x: (n % 20) * 40, y: Math.floor(n / 20) * 40, rotation: 0,
    index, parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
    props: { segments: [{ type: 'free', path: encodePath(points) }], color: 'black', fill: 'none', dash: 'draw', size: 'm', isComplete: true, isClosed: false, isPen: true, scale: 1, scaleX: 1, scaleY: 1 },
  }
}

/** Incompressible-looking base64 payload (random bytes), like a pasted photo. Not a decodable image. */
export function randomBase64(bytes: number): string {
  const parts: string[] = []
  const chunk = new Uint8Array(48_000) // multiple of 3, so every chunk encodes without padding
  for (let done = 0; done < bytes; done += chunk.length) {
    const take = Math.min(chunk.length, bytes - done)
    crypto.getRandomValues(chunk.subarray(0, Math.min(take, 65536)))
    parts.push(base64(chunk.subarray(0, take)))
  }
  return parts.join('')
}

export function makeDiagSnapshot(spec: { strokes: number; imageBytes?: number }): DiagSnapshot {
  const store: Record<string, any> = {
    'page:page': { meta: {}, id: 'page:page', name: 'Page 1', index: 'a1', typeName: 'page' },
    'document:document': { gridSize: 10, name: '', meta: {}, id: 'document:document', typeName: 'document' },
  }
  for (let n = 0; n < spec.strokes; n++) { const r = strokeRecord(n); store[r.id] = r }
  if (spec.imageBytes && spec.imageBytes > 0) {
    const assetId = 'asset:diagimage'
    store[assetId] = {
      id: assetId, typeName: 'asset', type: 'image', meta: {},
      props: { name: 'generated.png', src: `data:image/png;base64,${randomBase64(spec.imageBytes)}`, w: 1200, h: 800, mimeType: 'image/png', isAnimated: false, fileSize: spec.imageBytes },
    }
    store['shape:diagimage'] = {
      id: 'shape:diagimage', typeName: 'shape', type: 'image', x: 0, y: 400, rotation: 0, index: indexKey(spec.strokes), parentId: 'page:page',
      isLocked: false, opacity: 1, meta: {},
      props: { w: 600, h: 400, assetId, playing: true, url: '', crop: null, flipX: false, flipY: false, altText: '' },
    }
  }
  return {
    document: { store, schema: SCHEMA },
    session: {
      version: 0, currentPageId: 'page:page', exportBackground: true, isFocusMode: false, isDebugMode: false, isToolLocked: false, isGridMode: false,
      pageStates: [{ pageId: 'page:page', camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], focusedGroupId: null }],
    },
  }
}

/** A session with a different camera: the cheapest possible "change". */
export function movedSession(session: any, step: number): any {
  return { ...session, pageStates: session.pageStates.map((s: any) => ({ ...s, camera: { x: -120 - step, y: 45, z: 1.5 } })) }
}
