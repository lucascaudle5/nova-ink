import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CanvasRenderer } from '../src/render/renderer'
import type { CanvasLike, Context2D } from '../src/render/renderer'
import { generateStrokes } from '../src/dev/generate'

class FakeContext implements Context2D {
  calls: string[] = []
  fillStyle: unknown = '#000'
  transform: number[] = []
  setTransform(...m: number[]) { this.transform = m; this.calls.push('transform') }
  clearRect() { this.calls.push('clear') }
  fill() { this.calls.push(`fill:${String(this.fillStyle)}`) }
}

function fakeCanvas(): CanvasLike & { ctx: FakeContext } {
  const ctx = new FakeContext()
  return { width: 0, height: 0, ctx, getContext: () => ctx }
}

function setup() {
  const base = fakeCanvas(), live = fakeCanvas()
  let built = 0
  const renderer = new CanvasRenderer(base, live, { createPath: () => ({ path: ++built }) })
  renderer.resize(800, 600, 2)
  return { base, live, renderer, built: () => built }
}

test('resize sets device-pixel canvas sizes', () => {
  const { base, live } = setup()
  assert.deepEqual([base.width, base.height, live.width, live.height], [1600, 1200, 1600, 1200])
})

test('scene draws exactly the given strokes and caches each path across redraws', () => {
  const { base, renderer, built } = setup()
  const strokes = generateStrokes(50)
  renderer.drawScene(strokes, { x: 0, y: 0, z: 1 })
  renderer.drawScene(strokes, { x: 30, y: 10, z: 1.5 })
  assert.equal(base.ctx.calls.filter(c => c.startsWith('fill')).length, 100)
  assert.equal(built(), 50)
  assert.deepEqual(base.ctx.transform, [3, 0, 0, 3, -90, -30])
})

test('committing a stroke draws only that stroke and does not clear the base layer', () => {
  const { base, renderer } = setup()
  const [a, b] = generateStrokes(2)
  renderer.drawScene([a], { x: 0, y: 0, z: 1 })
  base.ctx.calls = []
  renderer.drawStroke(b, { x: 0, y: 0, z: 1 })
  assert.deepEqual(base.ctx.calls, ['transform', 'fill:#1b1f24'])
})

test('live layer redraw touches only the live canvas', () => {
  const { base, live, renderer } = setup()
  base.ctx.calls = []
  renderer.drawLive([0, 0, 0.5, 0, 10, 0, 0.5, 4], { color: '#ff0000', width: 3 }, { x: 0, y: 0, z: 1 })
  assert.deepEqual(base.ctx.calls, [])
  assert.deepEqual(live.ctx.calls, ['transform', 'clear', 'transform', 'fill:#ff0000'])
  renderer.clearLive()
  assert.equal(live.ctx.calls.at(-1), 'clear')
})
