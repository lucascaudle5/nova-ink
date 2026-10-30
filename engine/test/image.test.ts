import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InkDocument } from '../src/core/document'
import { parseItem, serializeItem } from '../src/core/format'
import { History } from '../src/core/history'
import { createImage, dragRect, fitSize, imageAt, placeImage } from '../src/core/image'
import { InputController } from '../src/core/input'
import type { InputHandlers } from '../src/core/input'
import { createStroke } from '../src/core/stroke'
import { PageSync } from '../src/core/sync'
import { isImage } from '../src/core/types'
import type { PageItem } from '../src/core/types'

const photo = (id: string, x = 0, y = 0, w = 400, h = 300) => createImage({ id, image: 'pic1', x, y, w, h, createdAt: 1 })
const line = (id: string) => createStroke({ id, points: [0, 0, 0.5, 0, 10, 10, 0.5, 16], style: { color: '#1b1f24', width: 2 }, createdAt: 1 })

test('image rows round-trip through the stored format; unknown kinds and bad sizes are refused', () => {
  const item = createImage({ id: 'img-1', image: 'pic_A', x: 10.123, y: -5, w: 320.456, h: 240, createdAt: 7 })
  const row = JSON.parse(JSON.stringify(serializeItem(item)))
  assert.deepEqual(row, { id: 'img-1', kind: 'image', author: 'student', createdAt: 7, image: 'pic_A', x: 10.12, y: -5, w: 320.46, h: 240 })
  const back = parseItem(row)
  assert.ok(back.ok && isImage(back.item) && back.item.w === 320.46 && back.item.bounds.maxX === 10.12 + 320.46)
  const stroke = parseItem(JSON.parse(JSON.stringify(serializeItem(line('s1')))))
  assert.ok(stroke.ok && !isImage(stroke.item))
  assert.equal(parseItem({ ...row, kind: 'video' }).ok, false)
  assert.equal(parseItem({ ...row, w: 2 }).ok, false)
  assert.equal(parseItem({ ...row, image: '../etc' }).ok, false)
  assert.equal(parseItem({ ...row, x: 'NaN' }).ok, false)
})

test('images live under the ink with ids unique across both, and are found topmost-first', () => {
  const doc = new InkDocument()
  doc.add(line('s1'))
  doc.addImage(photo('a', 0, 0))
  doc.addImage(photo('b', 100, 100))
  assert.throws(() => doc.addImage(photo('s1')), /Duplicate/)
  assert.throws(() => doc.add(line('a')), /Duplicate/)
  assert.equal(imageAt(doc.images, 150, 150)?.id, 'b')
  assert.equal(imageAt(doc.images, 50, 50)?.id, 'a')
  assert.equal(imageAt(doc.images, 900, 900), null)
  assert.deepEqual(doc.contentBounds(), { minX: -2, minY: -2, maxX: 500, maxY: 400 }, 'the stroke bounds are padded by its width')
  assert.deepEqual(doc.queryImages({ minX: 450, minY: 350, maxX: 460, maxY: 360 }).map(i => i.id), ['b'])
})

test('insert, move and delete are undoable steps; a move keeps the stacking position', () => {
  const doc = new InkDocument(), history = new History(doc)
  history.insertImage(photo('a'))
  history.insertImage(photo('b'))
  const moved = placeImage(doc.getImage('a')!, { x: 50, y: 60, w: 200, h: 150 })
  history.replaceImage('a', moved)
  assert.deepEqual(doc.images.map(i => i.id), [moved.id, 'b'])
  history.deleteImage('b')
  assert.deepEqual(doc.images.map(i => i.id), [moved.id])
  history.undo()
  assert.deepEqual(doc.images.map(i => i.id), [moved.id, 'b'])
  history.undo()
  assert.deepEqual(doc.images.map(i => [i.id, i.x]), [['a', 0], ['b', 0]])
  history.redo()
  assert.deepEqual(doc.images.map(i => [i.id, i.x]), [[moved.id, 50], ['b', 0]])
  history.undo(); history.undo(); history.undo()
  assert.equal(doc.images.length, 0)
})

test('dragging: move offsets; resize keeps the aspect ratio and a minimum size', () => {
  const r = { x: 10, y: 20, w: 400, h: 200 }
  assert.deepEqual(dragRect(r, 'move', { x: 0, y: 0 }, { x: 5, y: -7 }), { x: 15, y: 13, w: 400, h: 200 })
  assert.deepEqual(dragRect(r, 'resize', { x: 410, y: 220 }, { x: 610, y: 220 }), { x: 10, y: 20, w: 600, h: 300 })
  const tiny = dragRect(r, 'resize', { x: 410, y: 220 }, { x: -1000, y: -1000 })
  assert.ok(tiny.h >= 8 && Math.abs(tiny.w / tiny.h - 2) < 1e-9)
  assert.deepEqual(fitSize(4000, 3000, 800, 800), { w: 800, h: 600 })
  assert.deepEqual(fitSize(100, 50, 800, 800), { w: 100, h: 50 })
})

test('sync: images are sent first (under the ink), and a move is a remove plus an add', () => {
  const sync = new PageSync()
  const a = photo('a'), s = line('s1')
  const items: PageItem[] = [a, s]
  const first = sync.delta(items)
  assert.deepEqual(first.adds.map(x => x.stroke.id), ['a', 's1'])
  assert.ok(first.adds[0].key < first.adds[1].key)
  sync.acknowledge(first)
  const moved = placeImage(a, { x: 5, y: 5, w: 400, h: 300 })
  const second = sync.delta([moved, s])
  assert.deepEqual([second.adds.map(x => x.stroke.id), second.removes], [[moved.id], ['a']])
  assert.ok(second.adds[0].key < first.adds[1].key, 'the moved image still sorts below the ink')
  assert.equal(sync.hasChanges([moved, s]), true)
  sync.acknowledge(second)
  assert.equal(sync.hasChanges([moved, s]), false)
})

test('select tool: the pen picks and drags; fingers still pan; read-only does nothing', () => {
  const log: string[] = []
  const camera = { x: 0, y: 0, z: 2 }
  const handlers: InputHandlers = {
    getCamera: () => camera, setCamera: () => log.push('camera'),
    strokeBegin: () => log.push('stroke'), strokeExtend: () => {}, strokeEnd: () => {},
    eraseBegin: () => {}, eraseAt: () => {}, eraseEnd: () => {},
    selectBegin: (p, screen) => log.push(`begin ${p.x},${p.y} @${screen.x}`),
    selectMove: p => log.push(`move ${p.x},${p.y}`),
    selectEnd: cancelled => log.push(cancelled ? 'cancel' : 'end'),
  }
  const input = new InputController(handlers)
  input.tool = 'select'
  const send = (phase: 'down' | 'move' | 'up', kind: 'pen' | 'touch', x: number, y: number) =>
    input.handle({ phase, kind, id: kind === 'pen' ? 1 : 9, button: 0, samples: [{ x, y, pressure: 0.5, t: 1000 }] })
  send('down', 'pen', 20, 40); send('move', 'pen', 30, 40); send('up', 'pen', 30, 40)
  send('down', 'touch', 0, 0); send('move', 'touch', 50, 0); send('up', 'touch', 50, 0)
  input.readOnly = true
  send('down', 'pen', 20, 40)
  assert.deepEqual(log, ['begin 10,20 @20', 'move 15,20', 'move 15,20', 'end', 'camera'], 'pen-up carries its last position')
})
