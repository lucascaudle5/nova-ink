import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InkDocument } from '../src/core/document'
import { History } from '../src/core/history'
import { createImage } from '../src/core/image'
import {
  applySimilarity, boxPolygon, frameContains, imagePickedByPolygon, isIdentity, offsetImage, offsetStroke, pointInPolygon, restyleStroke,
  selectionFrame, similarityBetween, similarityMatrix, simplifyLoop, strokeTouchesPolygon, transformImage, transformPlacement, transformStroke,
} from '../src/core/selection'
import { createStroke } from '../src/core/stroke'

const line = (x0: number, y0: number, x1: number, y1: number, width = 2) =>
  createStroke({ points: [x0, y0, 0.5, 0, x1, y1, 0.8, 120], style: { color: '#1b1f24', width } })
const near = (a: number, b: number, tolerance = 1e-3) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`)

test('a transform between two frames scales, turns and moves about the frame centres', () => {
  const from = { x: 0, y: 0, w: 100, h: 50, angle: 0 }
  const moved = similarityBetween(from, { ...from, x: 30, y: 10 })
  assert.deepEqual(applySimilarity(moved, 50, 25), { x: 80, y: 35 })
  const doubled = similarityBetween(from, { x: -50, y: -25, w: 200, h: 100, angle: 0 })
  const p = applySimilarity(doubled, 100, 50)
  near(p.x, 150); near(p.y, 75)
  const quarter = similarityBetween(from, { ...from, angle: 90 })
  const q = applySimilarity(quarter, 100, 25)
  near(q.x, 50); near(q.y, 75) // the right-hand end swings down to the bottom
  assert.ok(isIdentity(similarityBetween(from, from)))
  assert.ok(!isIdentity(moved))
  const [a, b, c, d] = similarityMatrix(quarter)
  near(a, 0); near(b, 1); near(c, -1); near(d, 0)
})

test('transformStroke makes a new stroke: points moved, pressure and timing kept, width scaled', () => {
  const stroke = line(0, 0, 10, 0, 2)
  const t = similarityBetween({ x: 0, y: 0, w: 10, h: 10, angle: 0 }, { x: 100, y: 50, w: 20, h: 20, angle: 0 })
  const next = transformStroke(stroke, t)
  assert.notEqual(next.id, stroke.id)
  assert.equal(next.style.width, 4)
  assert.equal(next.style.color, stroke.style.color)
  assert.deepEqual([...next.points], [100, 50, 0.5, 0, 120, 50, Math.fround(0.8), 120])
  assert.equal(next.createdAt, stroke.createdAt)
  // the original is untouched
  assert.equal(stroke.points[0], 0)
})

test('transformImage agrees with transformPlacement and gives a new id; offsets and restyles make new items', () => {
  const image = createImage({ image: 'pic', x: 0, y: 0, w: 100, h: 50, angle: 10 })
  const t = similarityBetween({ x: 0, y: 0, w: 100, h: 50, angle: 10 }, { x: 200, y: 100, w: 50, h: 25, angle: 55 })
  const next = transformImage(image, t)
  assert.notEqual(next.id, image.id)
  assert.deepEqual({ x: next.x, y: next.y, w: next.w, h: next.h, angle: next.angle }, { x: 200, y: 100, w: 50, h: 25, angle: 55 })
  assert.deepEqual(transformPlacement(image, t), { x: 200, y: 100, w: 50, h: 25, angle: 55 })
  const shifted = offsetImage(image, 24, 24)
  assert.deepEqual([shifted.x, shifted.y, shifted.w, shifted.angle], [24, 24, 100, 10])
  const stroke = line(0, 0, 10, 0)
  assert.deepEqual([...offsetStroke(stroke, 5, 7).points.slice(0, 2)], [5, 7])
  const red = restyleStroke(stroke, { color: '#d1242f' })
  assert.equal(red.style.color, '#d1242f')
  assert.equal(red.style.width, stroke.style.width)
  assert.notEqual(red.id, stroke.id)
  assert.deepEqual([...red.points], [...stroke.points])
})

test('pointInPolygon uses the even-odd rule', () => {
  const square = boxPolygon(0, 0, 10, 10)
  assert.ok(pointInPolygon(5, 5, square))
  assert.ok(!pointInPolygon(15, 5, square))
  // a loop that crosses itself (a figure eight): both lobes count
  const eight = [0, 0, 10, 10, 10, 0, 0, 10]
  assert.ok(pointInPolygon(1, 5, eight) && pointInPolygon(9, 5, eight), 'both lobes')
  assert.ok(!pointInPolygon(5, 1, eight), 'between them, above the crossing')
  assert.ok(!pointInPolygon(-1, -1, eight))
})

test('a lasso touches a stroke that is inside it or that it crosses, and not one that is clear', () => {
  const loop = boxPolygon(0, 0, 100, 100)
  assert.ok(strokeTouchesPolygon(line(10, 10, 50, 50), loop), 'inside')
  assert.ok(strokeTouchesPolygon(line(-50, 50, 150, 50), loop), 'a line that crosses the loop without a point inside the loop... it has none, but it cuts the edge')
  assert.ok(strokeTouchesPolygon(line(90, 50, 300, 50), loop), 'poking in from outside')
  assert.ok(!strokeTouchesPolygon(line(200, 10, 300, 90), loop), 'far away')
  assert.ok(!strokeTouchesPolygon(line(-50, 150, 150, 150), loop), 'parallel, outside, bounds overlap in x only')
  const dot = createStroke({ points: [50, 50, 0.5, 0], style: { color: '#000000', width: 4 } })
  assert.ok(strokeTouchesPolygon(dot, loop), 'a dot')
})

test('a lasso picks a picture only when it encloses its middle', () => {
  const page = createImage({ image: 'pdf', x: 0, y: 0, w: 1000, h: 1400 })
  const small = createImage({ image: 'fig', x: 40, y: 40, w: 20, h: 20 })
  const loop = boxPolygon(30, 30, 100, 100)
  assert.ok(!imagePickedByPolygon(page, loop), 'a loop over some writing on a pasted page does not grab the page')
  assert.ok(imagePickedByPolygon(small, loop))
  assert.ok(!imagePickedByPolygon(small, boxPolygon(60, 60, 100, 100)), 'touching the corner only is not enough')
})

test('selectionFrame: a lone picture keeps its own turned frame; anything else gets the upright box', () => {
  const image = createImage({ image: 'a', x: 10, y: 20, w: 100, h: 50, angle: 30 })
  assert.deepEqual(selectionFrame([], [image]), { x: 10, y: 20, w: 100, h: 50, angle: 30 })
  const a = line(0, 0, 50, 0), b = line(0, 100, 50, 100)
  const box = selectionFrame([a, b], [])!
  assert.equal(box.angle, 0)
  near(box.x, a.bounds.minX); near(box.y, a.bounds.minY)
  near(box.x + box.w, a.bounds.maxX); near(box.y + box.h, b.bounds.maxY)
  assert.equal(selectionFrame([], []), null)
  assert.ok(selectionFrame([a], [image])!.angle === 0, 'ink and a picture together: upright box')
})

test('frameContains follows a turned frame', () => {
  const frame = { x: 0, y: 0, w: 100, h: 20, angle: 90 } // turned: tall and thin around (50, 10)
  assert.ok(frameContains(frame, 50, 50))
  assert.ok(!frameContains(frame, 95, 10))
  assert.ok(frameContains(frame, 95, 10, 40), 'with padding')
})

test('simplifyLoop drops crowded points and caps the count', () => {
  const crowded = Array.from({ length: 200 }, (_, i) => [i * 0.1, 0]).flat()
  assert.ok(simplifyLoop(crowded, 1).length < crowded.length / 5)
  const long = Array.from({ length: 2000 }, (_, i) => [i * 10, 0]).flat()
  assert.ok(simplifyLoop(long, 1, 400).length / 2 <= 400)
})

test('History.replaceItems, deleteItems and addItems are single undo steps and keep the stacking order', () => {
  const doc = new InkDocument(), history = new History(doc)
  const a = line(0, 0, 10, 0), b = line(0, 10, 10, 10), c = line(0, 20, 10, 20)
  const image = createImage({ image: 'pic', x: 0, y: 0, w: 50, h: 50 })
  history.addStrokes([a, b, c])
  history.insertImage(image)
  const t = similarityBetween({ x: 0, y: 0, w: 10, h: 10, angle: 0 }, { x: 100, y: 0, w: 10, h: 10, angle: 0 })
  const a2 = transformStroke(a, t), c2 = transformStroke(c, t), image2 = transformImage(image, t)
  assert.equal(history.replaceItems([[a.id, a2], [c.id, c2]], [[image.id, image2]]), 3)
  assert.deepEqual(doc.strokes.map(s => s.id), [a2.id, b.id, c2.id], 'same places in the stack')
  assert.equal(doc.images[0].id, image2.id)
  assert.ok(history.undo())
  assert.deepEqual(doc.strokes.map(s => s.id), [a.id, b.id, c.id], 'one undo restores all of them')
  assert.equal(doc.images[0].id, image.id)
  assert.ok(history.redo())
  assert.deepEqual(doc.strokes.map(s => s.id), [a2.id, b.id, c2.id])

  assert.equal(history.deleteItems([a2.id, c2.id], [image2.id]), 3)
  assert.equal(doc.size, 1)
  assert.equal(doc.images.length, 0)
  assert.ok(history.undo())
  assert.deepEqual(doc.strokes.map(s => s.id), [a2.id, b.id, c2.id], 'deleted strokes come back where they were')
  assert.equal(doc.images.length, 1)

  const copy = offsetStroke(b, 24, 24), pic = offsetImage(doc.images[0], 24, 24)
  history.addItems([copy], [pic])
  assert.equal(doc.size, 4)
  assert.equal(doc.images.length, 2)
  assert.ok(history.undo())
  assert.equal(doc.size, 3)
  assert.equal(doc.images.length, 1)
  assert.equal(history.replaceItems([['missing', a]], []), 0, 'unknown ids are skipped')
})
