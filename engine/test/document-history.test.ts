import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InkDocument } from '../src/core/document'
import { History } from '../src/core/history'
import { strokeHit, strokesHitBy } from '../src/core/eraser'
import { createStroke } from '../src/core/stroke'

const style = { color: '#112233', width: 2 }
const line = (id: string, x: number, y: number) => createStroke({ id, style, points: [x, y, 0.5, 0, x + 20, y, 0.5, 8] })
const ids = (doc: InkDocument) => doc.strokes.map(s => s.id)

test('strokes are immutable copies of their input', () => {
  const input = [1, 2, 0.5, 0]
  const s = createStroke({ points: input, style })
  input[0] = 999
  assert.equal(s.points[0], 1)
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.style))
  assert.throws(() => createStroke({ points: [], style }))
})

test('duplicate ids are refused rather than silently replacing work', () => {
  const doc = new InkDocument()
  doc.add(line('a', 0, 0))
  assert.throws(() => doc.add(line('a', 5, 5)), /Duplicate/)
  assert.throws(() => doc.load([line('b', 0, 0), line('b', 1, 1)]), /Duplicate/)
  assert.deepEqual(ids(doc), ['a'])
})

test('undo of an erase restores strokes at their original z-order positions', () => {
  const doc = new InkDocument()
  const history = new History(doc)
  for (const id of ['a', 'b', 'c', 'd', 'e']) history.addStroke(line(id, 0, id.charCodeAt(0) * 10))
  history.beginGroup()
  history.erase(['b'])
  history.erase(['d', 'a'])
  history.endGroup()
  assert.deepEqual(ids(doc), ['c', 'e'])
  assert.ok(history.undo())
  assert.deepEqual(ids(doc), ['a', 'b', 'c', 'd', 'e'])
  assert.ok(history.redo())
  assert.deepEqual(ids(doc), ['c', 'e'])
  history.undo()
  history.undo()
  assert.deepEqual(ids(doc), ['a', 'b', 'c', 'd'])
})

test('a new edit clears redo; an empty erase records nothing', () => {
  const doc = new InkDocument()
  const history = new History(doc)
  history.addStroke(line('a', 0, 0))
  history.undo()
  assert.ok(history.canRedo)
  history.addStroke(line('b', 0, 0))
  assert.ok(!history.canRedo)
  history.erase(['nope'])
  history.undo()
  assert.deepEqual(ids(doc), [])
  assert.ok(!history.undo())
})

test('history is bounded', () => {
  const doc = new InkDocument()
  const history = new History(doc, 3)
  for (let i = 0; i < 5; i++) history.addStroke(line(`s${i}`, 0, i * 10))
  let undone = 0
  while (history.undo()) undone++
  assert.equal(undone, 3)
  assert.deepEqual(ids(doc), ['s0', 's1'])
})

test('revision increments on every change and listeners see indices', () => {
  const doc = new InkDocument()
  const seen: string[] = []
  doc.onChange(c => seen.push(`${c.reset ? 'reset' : ''}+${c.added.map(p => p.index)}-${c.removed.map(p => p.index)}`))
  doc.add(line('a', 0, 0)); doc.add(line('b', 0, 10)); doc.remove(['a']); doc.load([])
  assert.equal(doc.revision, 4)
  assert.deepEqual(seen, ['+0-', '+1-', '+-0', 'reset+-'])
})

test('query culls by bounds and preserves z-order', () => {
  const doc = new InkDocument()
  doc.add(line('far', 5000, 5000)); doc.add(line('near1', 10, 10)); doc.add(line('near2', 30, 30))
  assert.deepEqual(doc.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 }).map(s => s.id), ['near1', 'near2'])
})

test('eraser hits within radius plus half the stroke width, and misses beyond', () => {
  const s = line('a', 0, 0)
  assert.ok(strokeHit(s, 10, 4.9, 4))
  assert.ok(!strokeHit(s, 10, 5.2, 4))
  assert.ok(strokeHit(createStroke({ style, points: [50, 50, 0.5, 0] }), 52, 50, 1.5))
  const doc = new InkDocument()
  doc.add(s); doc.add(line('b', 0, 100))
  assert.deepEqual(strokesHitBy(doc, 5, 2, 3).map(x => x.id), ['a'])
})
