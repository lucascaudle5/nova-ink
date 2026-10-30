import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InputController } from '../src/core/input'
import type { InputHandlers, PageSample, PointerInput, PointerKind } from '../src/core/input'
import type { Camera } from '../src/core/types'

function rig(camera: Camera = { x: 0, y: 0, z: 1 }) {
  const log: string[] = []
  const points: PageSample[] = []
  const erased: Array<[number, number, number]> = []
  const state = { camera }
  const handlers: InputHandlers = {
    getCamera: () => state.camera,
    setCamera: c => { state.camera = c; log.push('camera') },
    strokeBegin: s => { points.push(s); log.push('begin') },
    strokeExtend: s => { points.push(...s); log.push(`extend${s.length}`) },
    strokeEnd: cancelled => log.push(cancelled ? 'end-cancelled' : 'end'),
    eraseBegin: () => log.push('eraseBegin'),
    eraseAt: (x, y, r) => erased.push([x, y, r]),
    eraseEnd: () => log.push('eraseEnd'),
    undo: () => log.push('undo'),
    redo: () => log.push('redo'),
  }
  const input = new InputController(handlers)
  const send = (phase: PointerInput['phase'], kind: PointerKind, id: number, ...xy: Array<[number, number]>) =>
    input.handle({ phase, kind, id, button: 0, samples: xy.map(([x, y], i) => ({ x, y, pressure: 0.6, t: 100 + i })) })
  return { input, log, points, erased, state, send }
}

test('pen draws, and every coalesced sample reaches the stroke', () => {
  const { send, log, points } = rig({ x: 100, y: 50, z: 2 })
  send('down', 'pen', 1, [10, 10])
  send('move', 'pen', 1, [12, 10], [14, 11], [16, 12], [18, 13])
  send('up', 'pen', 1, [20, 14])
  assert.deepEqual(log, ['begin', 'extend4', 'extend1', 'end'])
  assert.equal(points.length, 6)
  assert.deepEqual([points[0].x, points[0].y], [105, 55])
})

test('fingers never draw: one finger pans', () => {
  const { send, log, points, state } = rig()
  send('down', 'touch', 7, [100, 100])
  send('move', 'touch', 7, [130, 80])
  send('up', 'touch', 7, [130, 80])
  assert.equal(points.length, 0)
  assert.ok(log.every(e => e === 'camera'))
  assert.deepEqual(state.camera, { x: -30, y: 20, z: 1 })
})

test('read-only: pen and mouse do nothing, fingers still pan', () => {
  const { input, send, log, points, state } = rig()
  input.readOnly = true
  send('down', 'pen', 1, [10, 10]); send('move', 'pen', 1, [20, 20]); send('up', 'pen', 1, [20, 20])
  input.tool = 'eraser'
  send('down', 'mouse', 2, [10, 10]); send('up', 'mouse', 2, [10, 10])
  assert.equal(points.length, 0)
  assert.deepEqual(log, [])
  send('down', 'touch', 7, [100, 100]); send('move', 'touch', 7, [130, 100]); send('up', 'touch', 7, [130, 100])
  assert.deepEqual(state.camera, { x: -30, y: 0, z: 1 })
})

test('two fingers pinch-zoom; lifting one finger continues as a pan without a jump', () => {
  const { send, state } = rig()
  send('down', 'touch', 1, [100, 100])
  send('down', 'touch', 2, [200, 100])
  send('move', 'touch', 2, [300, 100])
  assert.ok(Math.abs(state.camera.z - 2) < 1e-9)
  const before = state.camera
  send('up', 'touch', 2, [300, 100])
  assert.deepEqual(state.camera, before)
  send('move', 'touch', 1, [110, 100])
  assert.equal(state.camera.z, before.z)
  assert.ok(Math.abs(state.camera.x - (before.x - 10 / before.z)) < 1e-9)
})

test('palm rejection: a pen-down cancels a finger gesture and its finger stays ignored', () => {
  const { send, log, state } = rig()
  send('down', 'touch', 9, [400, 400])
  send('move', 'touch', 9, [410, 400])
  const cameraAtPen = state.camera
  log.length = 0
  send('down', 'pen', 1, [50, 50])
  send('move', 'touch', 9, [500, 500])
  send('move', 'pen', 1, [55, 52])
  send('up', 'pen', 1, [60, 54])
  send('move', 'touch', 9, [600, 600])
  assert.deepEqual(state.camera, cameraAtPen)
  assert.deepEqual(log, ['begin', 'extend1', 'extend1', 'end'])
})

test('palm rejection: touches that land during a stroke are ignored until lifted', () => {
  const { send, log, state } = rig()
  send('down', 'pen', 1, [0, 0])
  send('down', 'touch', 4, [300, 300])
  send('move', 'touch', 4, [350, 350])
  send('up', 'pen', 1, [5, 5])
  send('move', 'touch', 4, [400, 400])
  assert.ok(!log.includes('camera'))
  assert.deepEqual(state.camera, { x: 0, y: 0, z: 1 })
  send('up', 'touch', 4, [400, 400])
  send('down', 'touch', 5, [0, 0])
  send('move', 'touch', 5, [10, 0])
  assert.ok(log.includes('camera'))
})

test('a system-cancelled stroke is kept, not dropped', () => {
  const { send, log } = rig()
  send('down', 'pen', 1, [0, 0])
  send('move', 'pen', 1, [3, 3])
  send('cancel', 'pen', 1)
  assert.deepEqual(log, ['begin', 'extend1', 'end-cancelled'])
})

test('mouse primary button draws; other buttons and second pointers do not', () => {
  const { input, send, log } = rig()
  input.handle({ phase: 'down', kind: 'mouse', id: 1, button: 2, samples: [{ x: 0, y: 0, pressure: 0.5, t: 0 }] })
  assert.deepEqual(log, [])
  send('down', 'mouse', 1, [0, 0])
  send('down', 'pen', 2, [9, 9])
  send('move', 'pen', 2, [10, 10])
  send('up', 'mouse', 1, [1, 1])
  assert.deepEqual(log, ['begin', 'extend1', 'end'])
})

function touchAt(input: InputController, phase: PointerInput['phase'], id: number, x: number, y: number, t: number) {
  input.handle({ phase, kind: 'touch', id, samples: [{ x, y, pressure: 0, t }] })
}
function pen(input: InputController, phase: PointerInput['phase'], t: number) {
  input.handle({ phase, kind: 'pen', id: 99, samples: [{ x: 500, y: 500, pressure: 0.5, t }] })
}

test('a quick two-finger tap undoes and a three-finger tap redoes, without moving the view', () => {
  const { input, log, state } = rig()
  touchAt(input, 'down', 1, 100, 100, 1000)
  touchAt(input, 'down', 2, 200, 100, 1010)
  touchAt(input, 'move', 2, 204, 101, 1050)
  touchAt(input, 'up', 1, 100, 100, 1100)
  touchAt(input, 'up', 2, 204, 101, 1120)
  assert.equal(log.filter(e => e === 'undo').length, 1)
  assert.deepEqual(state.camera, { x: 0, y: 0, z: 1 })
  for (const id of [1, 2, 3]) touchAt(input, 'down', id, id * 50, 100, 2000)
  for (const id of [1, 2, 3]) touchAt(input, 'up', id, id * 50, 100, 2100)
  assert.equal(log.filter(e => e === 'redo').length, 1)
})

test('pinching, slow taps, one finger and the palm near the pen never undo', () => {
  const { input, log } = rig()
  touchAt(input, 'down', 1, 100, 100, 0)
  touchAt(input, 'down', 2, 200, 100, 0)
  touchAt(input, 'move', 2, 260, 100, 50)
  touchAt(input, 'up', 1, 100, 100, 100)
  touchAt(input, 'up', 2, 260, 100, 100)
  touchAt(input, 'down', 1, 100, 100, 1000)
  touchAt(input, 'down', 2, 200, 100, 1000)
  touchAt(input, 'up', 1, 100, 100, 1600)
  touchAt(input, 'up', 2, 200, 100, 1600)
  touchAt(input, 'down', 1, 100, 100, 2000)
  touchAt(input, 'up', 1, 100, 100, 2050)
  pen(input, 'down', 3000); pen(input, 'up', 3100)
  touchAt(input, 'down', 1, 100, 100, 3200)
  touchAt(input, 'down', 2, 200, 100, 3200)
  touchAt(input, 'up', 1, 100, 100, 3250)
  touchAt(input, 'up', 2, 200, 100, 3250)
  touchAt(input, 'down', 1, 100, 100, 5000)
  touchAt(input, 'down', 2, 200, 100, 5000)
  pen(input, 'down', 5050); pen(input, 'up', 5080)
  touchAt(input, 'up', 1, 100, 100, 5100)
  touchAt(input, 'up', 2, 200, 100, 5100)
  assert.ok(!log.includes('undo') && !log.includes('redo'), log.join(','))
})

test('eraser covers fast movements with overlapping hits and a zoom-independent screen radius', () => {
  const { input, send, log, erased } = rig({ x: 0, y: 0, z: 2 })
  input.tool = 'eraser'
  send('down', 'pen', 1, [0, 0])
  send('move', 'pen', 1, [200, 0])
  send('up', 'pen', 1)
  assert.deepEqual(log, ['eraseBegin', 'eraseEnd'])
  const radius = erased[0][2]
  assert.equal(radius, 5)
  for (let i = 1; i < erased.length; i++) assert.ok(erased[i][0] - erased[i - 1][0] <= radius / 2 + 1e-9)
  assert.equal(erased[erased.length - 1][0], 100)
})
