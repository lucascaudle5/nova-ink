// The diagnostics generator must produce canvases the REAL tldraw accepts, otherwise opening a materialized
// diagnostic canvas in the widget would land in "could not be loaded". Run: node --test test/node/diag-data.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { b64Vecs } from 'tldraw'
import { DIAG_SIZES, encodePath, indexKey, lateIndexKey, makeDiagSnapshot, movedSession, strokeRecord } from '../../src/diag-data.ts'
import { loadsInTldraw, shapeCount } from '../helpers/snapshots.mjs'

test('every generated size loads in tldraw with the right number of shapes', () => {
  for (const [name, spec] of Object.entries({ s100: DIAG_SIZES.s100, s500: DIAG_SIZES.s500, s1500: DIAG_SIZES.s1500, small: { strokes: 3 }, img: { strokes: 5, imageBytes: 200_000 } })) {
    const snapshot = makeDiagSnapshot(spec)
    assert.equal(loadsInTldraw(snapshot), shapeCount(snapshot), name)
    assert.equal(shapeCount(snapshot), spec.strokes + (spec.imageBytes ? 1 : 0), name)
  }
})

test('stroke paths decode to the points that were encoded', () => {
  const points = Array.from({ length: 120 }, (_, i) => ({ x: i * 1.7, y: Math.sin(i / 4) * 12, z: 0.3 + (i % 7) / 10 }))
  const decoded = b64Vecs.decodePoints(encodePath(points))
  assert.equal(decoded.length, points.length)
  assert.ok(Math.abs(decoded.at(-1).x - points.at(-1).x) < 0.5)
  assert.ok(Math.abs(decoded.at(-1).y - points.at(-1).y) < 0.5)
})

test('records are about the size of real handwriting (about 1.3 KB each) and unique', () => {
  const snapshot = makeDiagSnapshot({ strokes: 1500 })
  const bytes = JSON.stringify(snapshot).length
  assert.ok(bytes > 1.5 * 1024 * 1024 && bytes < 2.6 * 1024 * 1024, `s1500 is ${bytes} bytes`)
  assert.equal(Object.keys(snapshot.document.store).length, 1502)
  const indexes = Object.values(snapshot.document.store).filter(r => r.typeName === 'shape').map(r => r.index)
  assert.equal(new Set(indexes).size, indexes.length)
  assert.deepEqual([...indexes].sort(), indexes) // generated in increasing order
})

test('index keys are strictly increasing across the whole supported range and the late range sorts after it', () => {
  let previous = ''
  for (let n = 0; n < 62 * 62 + 62; n++) { const key = indexKey(n); assert.ok(key > previous, `${n}: ${key} > ${previous}`); previous = key }
  assert.ok(lateIndexKey(0) > indexKey(62 * 62 + 61))
  assert.ok(lateIndexKey(5) < lateIndexKey(6))
})

test('incremental strokes and a moved camera still load alongside the full canvas', () => {
  const snapshot = makeDiagSnapshot({ strokes: 100 })
  for (let i = 0; i < 3; i++) { const r = strokeRecord(10 + i, 120, 'x', lateIndexKey(10 + i)); snapshot.document.store[r.id] = r }
  snapshot.session = movedSession(snapshot.session, 3)
  assert.equal(loadsInTldraw(snapshot), 103)
})
