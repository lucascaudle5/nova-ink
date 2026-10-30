import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InkDocument } from '../src/core/document'
import { History } from '../src/core/history'
import { eraseFromStroke } from '../src/core/eraser'
import { createStroke } from '../src/core/stroke'
import { POINT_STRIDE } from '../src/core/types'
import type { Stroke } from '../src/core/types'

const style = { color: '#112233', width: 2 }
/** Horizontal line from x = 0 to x = 100 at y = 0 with only its two end points (a long segment). */
const longLine = (id = 'line', author: 'student' | 'ai' = 'student') =>
  createStroke({ id, style, author, createdAt: 42, points: [0, 0, 0.5, 0, 100, 0, 0.5, 100] })
const xs = (s: Stroke) => Array.from({ length: s.points.length / POINT_STRIDE }, (_, i) => s.points[i * POINT_STRIDE])

test('erasing the middle of a stroke leaves two pieces ending at the eraser edge', () => {
  const pieces = eraseFromStroke(longLine(), 50, 0, 5)
  assert.ok(pieces)
  assert.equal(pieces.length, 2)
  // Reach = eraser radius 5 + half the width 1, so the cut is at 50 ± 6, even between sample points.
  assert.deepEqual(xs(pieces[0]), [0, 44])
  assert.deepEqual(xs(pieces[1]), [56, 100])
  // Time and pressure are interpolated, so replay timing survives.
  assert.equal(pieces[1].points[3], 56)
})

test('pieces keep style, author and time but get new ids', () => {
  const pieces = eraseFromStroke(longLine('x', 'ai'), 50, 0, 5)!
  for (const p of pieces) {
    assert.equal(p.author, 'ai')
    assert.equal(p.createdAt, 42)
    assert.deepEqual(p.style, style)
    assert.notEqual(p.id, 'x')
  }
})

test('erasing an end trims it; covering everything leaves nothing; missing leaves it alone', () => {
  const trimmed = eraseFromStroke(longLine(), 0, 0, 10)!
  assert.equal(trimmed.length, 1)
  assert.deepEqual(xs(trimmed[0]), [11, 100])
  assert.deepEqual(eraseFromStroke(longLine(), 50, 0, 80), [])
  assert.equal(eraseFromStroke(longLine(), 50, 30, 5), null)
  const dot = createStroke({ style, points: [5, 5, 0.5, 0] })
  assert.deepEqual(eraseFromStroke(dot, 6, 5, 2), [])
  assert.equal(eraseFromStroke(dot, 50, 50, 2), null)
})

test('a partial erase keeps z-order and undoes and redoes as one step', () => {
  const doc = new InkDocument()
  const history = new History(doc)
  const below = createStroke({ id: 'below', style, points: [0, 10, 0.5, 0] })
  const above = createStroke({ id: 'above', style, points: [0, 20, 0.5, 0] })
  history.addStroke(below)
  history.addStroke(longLine())
  history.addStroke(above)
  history.beginGroup()
  for (const x of [30, 70]) {
    for (const s of doc.query({ minX: x - 5, minY: -5, maxX: x + 5, maxY: 5 })) {
      const pieces = eraseFromStroke(s, x, 0, 5)
      if (pieces) history.cut(s.id, pieces)
    }
  }
  history.endGroup()
  assert.equal(doc.size, 5)
  assert.equal(doc.strokes[0].id, 'below')
  assert.equal(doc.strokes[4].id, 'above')
  assert.deepEqual(doc.strokes.slice(1, 4).map(s => xs(s)[0]), [0, 36, 76])
  history.undo()
  assert.deepEqual(doc.strokes.map(s => s.id), ['below', 'line', 'above'])
  history.redo()
  assert.equal(doc.size, 5)
  history.undo()
  assert.deepEqual(doc.strokes.map(s => s.id), ['below', 'line', 'above'])
})

test('clearing and bulk adds are each one undoable step', () => {
  const doc = new InkDocument()
  const history = new History(doc)
  history.addStrokes([longLine('a'), longLine('b'), longLine('c')])
  assert.equal(doc.size, 3)
  history.erase(doc.strokes.map(s => s.id))
  assert.equal(doc.size, 0)
  history.undo()
  assert.deepEqual(doc.strokes.map(s => s.id), ['a', 'b', 'c'])
  history.undo()
  assert.equal(doc.size, 0)
  assert.equal(history.canUndo, false)
})
