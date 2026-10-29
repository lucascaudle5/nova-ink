// Builds genuine tldraw snapshots headlessly so tests exercise the real format.
import { AssetRecordType, b64Vecs, createShapeId, createTLStore, defaultBindingUtils, defaultShapeUtils, getIndices, getSnapshot, loadSnapshot } from 'tldraw'

export function newStore() {
  const store = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils })
  store.ensureStoreIsUsable()
  return store
}

/** strokes: handwriting-like pen strokes; imageBytes: size of an inline base64 image asset (tldraw's default for pasted images). */
export function makeSnapshot({ strokes = 3, pointsPerStroke = 80, imageBytes = 0, camera } = {}) {
  const store = newStore()
  const page = store.allRecords().find(r => r.typeName === 'page')
  const records = []
  const indices = getIndices(strokes + 1)
  for (let s = 0; s < strokes; s++) {
    const points = Array.from({ length: pointsPerStroke }, (_, i) => ({ x: i * 1.7, y: Math.sin((i + s) / 4) * 12, z: 0.3 + (i % 7) / 10 }))
    records.push({
      id: createShapeId(), typeName: 'shape', type: 'draw', x: (s % 20) * 40, y: Math.floor(s / 20) * 40, rotation: 0,
      index: indices[s], parentId: page.id, isLocked: false, opacity: 1, meta: {},
      props: { segments: [{ type: 'free', path: b64Vecs.encodePoints(points) }], color: 'black', fill: 'none', dash: 'draw', size: 'm', isComplete: true, isClosed: false, isPen: true, scale: 1, scaleX: 1, scaleY: 1 },
    })
  }
  if (imageBytes > 0) {
    const assetId = AssetRecordType.createId()
    records.push({
      id: assetId, typeName: 'asset', type: 'image', meta: {},
      props: { name: 'paste.png', src: `data:image/png;base64,${'A'.repeat(imageBytes)}`, w: 1200, h: 800, mimeType: 'image/png', isAnimated: false, fileSize: imageBytes },
    })
    records.push({
      id: createShapeId(), typeName: 'shape', type: 'image', x: 0, y: 400, rotation: 0, index: indices[strokes], parentId: page.id,
      isLocked: false, opacity: 1, meta: {},
      props: { w: 600, h: 400, assetId, playing: true, url: '', crop: null, flipX: false, flipY: false, altText: '' },
    })
  }
  store.put(records)
  const snapshot = getSnapshot(store)
  if (camera) {
    for (const state of Object.values(snapshot.session.pageStates ?? {})) if (state && typeof state === 'object') state.camera = camera
  }
  return JSON.parse(JSON.stringify(snapshot))
}

export function shapeCount(snapshot) {
  return Object.values(snapshot.document.store).filter(r => r.typeName === 'shape').length
}

/** Loads a snapshot into a fresh tldraw store, as the widget does before mounting. Throws if tldraw rejects it. */
export function loadsInTldraw(snapshot) {
  const store = newStore()
  loadSnapshot(store, snapshot)
  return store.allRecords().filter(r => r.typeName === 'shape').length
}

export const bytesOf = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
