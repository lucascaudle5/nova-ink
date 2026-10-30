import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InkDocument } from '../src/core/document'
import { parseItem, serializeItem } from '../src/core/format'
import { History } from '../src/core/history'
import { createImage, dragPlacement, fitSize, imageAt, localToPage, normalizeAngle, placeImage, resizeHandle, rotateHandle, rotateImage, snapAngle } from '../src/core/image'
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

test('the pages of an imported PDF go in and come out as one undo step', () => {
  const doc = new InkDocument(), history = new History(doc)
  history.insertImage(photo('before'))
  history.insertImages([photo('p1', 0, 0), photo('p2', 0, 332), photo('p3', 0, 664)])
  assert.deepEqual(doc.images.map(i => i.id), ['before', 'p1', 'p2', 'p3'])
  history.undo()
  assert.deepEqual(doc.images.map(i => i.id), ['before'])
  history.redo()
  assert.deepEqual(doc.images.map(i => i.id), ['before', 'p1', 'p2', 'p3'])
  history.insertImages([])
  history.undo(); history.undo()
  assert.equal(doc.images.length, 0)
})

test('turning keeps the rectangle, sets the angle, round-trips at any angle, and undoes as one step', () => {
  const doc = new InkDocument(), history = new History(doc)
  history.insertImage(photo('a', 0, 0, 400, 300))
  const once = rotateImage(doc.getImage('a')!)
  assert.deepEqual([once.x, once.y, once.w, once.h, once.angle], [0, 0, 400, 300, 90])
  assert.deepEqual(once.bounds, { minX: 50, minY: -50, maxX: 350, maxY: 350 }, 'the box around the turned picture swaps its sides')
  history.replaceImage('a', once)
  let item = once
  for (const expected of [180, 270, 0]) { item = rotateImage(item); assert.equal(item.angle, expected) }
  assert.equal(rotateImage(once, -90).angle, 0)
  assert.equal(placeImage(once, { x: 1, y: 2, w: 30, h: 40 }).angle, 90, 'moving or resizing keeps the angle')
  assert.equal(normalizeAngle(-30), 330)
  assert.equal(normalizeAngle(720.004), 0)

  const tilted = placeImage(once, { angle: 37.456 })
  const row = JSON.parse(JSON.stringify(serializeItem(tilted)))
  assert.equal(row.angle, 37.46)
  assert.equal('rotation' in row, false)
  const back = parseItem(row)
  assert.ok(back.ok && isImage(back.item) && back.item.angle === 37.46 && back.item.w === 400)
  assert.equal('angle' in JSON.parse(JSON.stringify(serializeItem(photo('b')))), false, 'unturned rows are unchanged')
  assert.equal(parseItem({ ...row, angle: 360 }).ok, false)
  assert.equal(parseItem({ ...row, angle: '90' }).ok, false)
  assert.equal(parseItem({ ...row, angle: Infinity }).ok, false)

  history.undo()
  assert.deepEqual(doc.images.map(i => [i.id, i.angle]), [['a', 0]])
})

test('rows stored with the earlier quarter-turn field read as the same picture in the same place', () => {
  const area = { id: 'old', kind: 'image', author: 'student', createdAt: 1, image: 'pic1', x: 50, y: -50, w: 300, h: 400, rotation: 90 }
  const turned = parseItem(area)
  assert.ok(turned.ok && isImage(turned.item))
  assert.deepEqual([turned.item.x, turned.item.y, turned.item.w, turned.item.h, turned.item.angle], [0, 0, 400, 300, 90])
  assert.deepEqual(turned.item.bounds, { minX: 50, minY: -50, maxX: 350, maxY: 350 }, 'it covers the same area as before')
  const half = parseItem({ ...area, x: 0, y: 0, w: 400, h: 300, rotation: 180 })
  assert.ok(half.ok && isImage(half.item) && half.item.angle === 180 && half.item.w === 400)
  assert.equal(parseItem({ ...area, rotation: 45 }).ok, false)
  assert.equal(parseItem({ ...area, angle: 10 }).ok, false, 'both fields at once is refused')
  assert.ok(parseItem({ ...area, rotation: 0 }).ok)
})

test('turned pictures are found in their own frame, not by their bounding box', () => {
  const diamond = createImage({ id: 'd', image: 'pic1', x: 0, y: 0, w: 400, h: 100, angle: 45 })
  // The centre is (200, 50). A point near the box corner is outside the picture; a point along the turned length is inside.
  assert.equal(imageAt([diamond], 200, 50)?.id, 'd')
  assert.equal(imageAt([diamond], 200 + 120, 50 + 120)?.id, 'd')
  assert.equal(imageAt([diamond], 200 + 120, 50 - 120), null)
  assert.equal(imageAt([diamond], 5, 5), null)
})

test('handles follow the picture: resize is the bottom-right corner and rotate sits above the top edge', () => {
  const item = createImage({ id: 'h', image: 'pic1', x: 100, y: 100, w: 200, h: 100, angle: 90 })
  const near = (p: { x: number; y: number }, x: number, y: number) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9
  // Centre (200, 150); turned a quarter clockwise, the bottom-right corner (+100, +50) lands at (-50, +100) from it.
  assert.ok(near(resizeHandle(item), 150, 250))
  // Straight out from the top edge: local (0, -50 - 20) turns to (+70, 0).
  assert.ok(near(rotateHandle(item, 20), 270, 150))
  assert.ok(near(localToPage({ ...item, angle: 0 }, 100, 50), 300, 200))
})

test('dragging: move offsets; resize keeps the aspect ratio, a minimum size and the top-left corner', () => {
  const r = { x: 10, y: 20, w: 400, h: 200, angle: 0 }
  assert.deepEqual(dragPlacement(r, 'move', { x: 0, y: 0 }, { x: 5, y: -7 }), { x: 15, y: 13, w: 400, h: 200, angle: 0 })
  assert.deepEqual(dragPlacement(r, 'resize', { x: 410, y: 220 }, { x: 610, y: 220 }), { x: 10, y: 20, w: 600, h: 300, angle: 0 })
  const tiny = dragPlacement(r, 'resize', { x: 410, y: 220 }, { x: -1000, y: -1000 })
  assert.ok(tiny.h >= 8 && Math.abs(tiny.w / tiny.h - 2) < 1e-9)

  // Turned a quarter, dragging along the picture's own width (down the page) grows it with its top-left corner fixed.
  const item = createImage({ id: 'q', image: 'pic1', x: 100, y: 100, w: 200, h: 100, angle: 90 })
  const cornerBefore = localToPage(item, -item.w / 2, -item.h / 2)
  const grown = dragPlacement(item, 'resize', { x: 150, y: 250 }, { x: 150, y: 450 })
  assert.ok(Math.abs(grown.w - 400) < 1e-9 && Math.abs(grown.h - 200) < 1e-9 && grown.angle === 90)
  const cornerAfter = localToPage(grown, -grown.w / 2, -grown.h / 2)
  assert.ok(Math.abs(cornerAfter.x - cornerBefore.x) < 1e-9 && Math.abs(cornerAfter.y - cornerBefore.y) < 1e-9)

  assert.deepEqual(fitSize(4000, 3000, 800, 800), { w: 800, h: 600 })
  assert.deepEqual(fitSize(100, 50, 800, 800), { w: 100, h: 50 })
})

test('rotating by dragging follows the pointer around the centre and snaps near multiples of 45 degrees', () => {
  const item = createImage({ id: 'r', image: 'pic1', x: 0, y: 0, w: 200, h: 200, angle: 0 })
  // Centre (100, 100). Grab straight above, drag to straight right: a quarter turn.
  assert.equal(dragPlacement(item, 'rotate', { x: 100, y: -50 }, { x: 250, y: 100 }).angle, 90)
  // Slightly short of 90 snaps to it; further away does not.
  const toAngle = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return { x: 100 + 200 * Math.sin(rad), y: 100 - 200 * Math.cos(rad) }
  }
  assert.equal(dragPlacement(item, 'rotate', toAngle(0), toAngle(87.5)).angle, 90)
  assert.equal(dragPlacement(item, 'rotate', toAngle(0), toAngle(40)).angle, 40)
  assert.equal(dragPlacement(item, 'rotate', toAngle(0), toAngle(43)).angle, 45)
  assert.equal(dragPlacement(item, 'rotate', toAngle(0), toAngle(-20)).angle, 340)
  assert.equal(snapAngle(358.5), 0)
  assert.equal(snapAngle(182.9), 180)
  assert.equal(snapAngle(100), 100)
  // The rectangle and centre are untouched.
  const turned = dragPlacement(item, 'rotate', toAngle(0), toAngle(30))
  assert.deepEqual([turned.x, turned.y, turned.w, turned.h], [0, 0, 200, 200])
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

test('select tool: a finger that lands on a picture drags it; elsewhere it still pans; a second finger and the pen are handled', () => {
  const log: string[] = []
  const camera = { x: 0, y: 0, z: 1 }
  let overPicture = true
  const handlers: InputHandlers = {
    getCamera: () => camera, setCamera: () => log.push('camera'),
    strokeBegin: () => {}, strokeExtend: () => {}, strokeEnd: () => {},
    eraseBegin: () => {}, eraseAt: () => {}, eraseEnd: () => {},
    touchGrab: () => overPicture,
    selectBegin: (p, _screen, kind) => log.push(`begin ${p.x},${p.y} ${kind}`),
    selectMove: p => log.push(`move ${p.x},${p.y}`),
    selectEnd: cancelled => log.push(cancelled ? 'cancel' : 'end'),
  }
  const input = new InputController(handlers)
  input.tool = 'select'
  const send = (phase: 'down' | 'move' | 'up', kind: 'pen' | 'touch', id: number, x: number, y: number, t = 1000) =>
    input.handle({ phase, kind, id, button: 0, samples: [{ x, y, pressure: 0.5, t }] })

  send('down', 'touch', 9, 10, 10); send('move', 'touch', 9, 30, 10); send('down', 'touch', 8, 200, 200); send('move', 'touch', 8, 220, 200); send('up', 'touch', 8, 220, 200); send('up', 'touch', 9, 40, 10)
  assert.deepEqual(log, ['begin 10,10 touch', 'move 30,10', 'move 40,10', 'end'], 'a second finger during the drag does nothing')

  log.length = 0
  overPicture = false
  send('down', 'touch', 9, 10, 10, 5000); send('move', 'touch', 9, 60, 10, 5100); send('up', 'touch', 9, 60, 10, 5200)
  assert.ok(!log.some(l => l.startsWith('begin')) && log.includes('camera'), 'off the picture a finger pans')

  log.length = 0
  overPicture = true
  send('down', 'touch', 9, 10, 10, 9000); send('move', 'touch', 9, 20, 10, 9100)
  send('down', 'pen', 1, 50, 50, 9200)
  send('move', 'touch', 9, 90, 10, 9300)
  assert.deepEqual(log.filter(l => l === 'cancel' || l.startsWith('begin')), ['begin 10,10 touch', 'cancel', 'begin 50,50 pen'], 'the pen takes over and the finger is dropped')
  assert.ok(!log.includes('move 90,10'))

  log.length = 0
  input.readOnly = true
  input.handle({ phase: 'up', kind: 'pen', id: 1, button: 0, samples: [{ x: 50, y: 50, pressure: 0, t: 9400 }] })
  log.length = 0
  send('down', 'touch', 7, 10, 10, 20000)
  assert.ok(!log.some(l => l.startsWith('begin')), 'read-only never grabs')
})
