import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CanvasRenderer } from '../src/render/renderer'
import type { CanvasLike, Context2D } from '../src/render/renderer'
import { generateStrokes } from '../src/dev/generate'
import { createImage, rotateImage } from '../src/core/image'

class FakeContext implements Context2D {
  calls: string[] = []
  images: Array<{ dx: number; dy: number; dw: number; dh: number }> = []
  rects = 0
  fillStyle: unknown = '#000'
  strokeStyle: unknown = '#000'
  lineWidth = 1
  globalAlpha = 1
  transform: number[] = []
  setTransform(...m: number[]) { this.transform = m; this.calls.push('transform') }
  clearRect() { this.calls.push('clear') }
  fillRect() { this.rects++ }
  fill() { this.calls.push(`fill:${String(this.fillStyle)}`) }
  drawImage(_image: never, dx: number, dy: number, dw: number, dh: number) { this.images.push({ dx, dy, dw, dh }); this.calls.push('image') }
  beginPath() { this.calls.push('beginPath') }
  arc() { this.calls.push('arc') }
  stroke() { this.calls.push('stroke') }
}

function fakeCanvas(): CanvasLike & { ctx: FakeContext } {
  const ctx = new FakeContext()
  return { width: 0, height: 0, ctx, getContext: () => ctx }
}

function setup() {
  const paper = fakeCanvas(), base = fakeCanvas(), live = fakeCanvas(), snapshot = fakeCanvas()
  let built = 0
  const renderer = new CanvasRenderer({ paper, base, live, snapshot }, { createPath: () => ({ path: ++built }) })
  renderer.resize(800, 600, 2)
  return { paper, base, live, snapshot, renderer, built: () => built }
}

test('resize sets device-pixel sizes on every layer', () => {
  const { paper, base, live, snapshot } = setup()
  for (const c of [paper, base, live, snapshot]) assert.deepEqual([c.width, c.height], [1600, 1200])
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

test('gesture snapshot: the base shows the copy moved and scaled, with no stroke fills', () => {
  const { base, snapshot, renderer } = setup()
  renderer.drawScene(generateStrokes(20), { x: 0, y: 0, z: 1 })
  assert.equal(renderer.drawFromSnapshot({ x: 0, y: 0, z: 1 }), false, 'no snapshot yet')
  renderer.takeSnapshot({ x: 100, y: 50, z: 1 })
  assert.deepEqual(snapshot.ctx.images, [{ dx: 0, dy: 0, dw: 1600, dh: 1200 }])
  base.ctx.calls = []
  assert.ok(renderer.drawFromSnapshot({ x: 90, y: 50, z: 2 }))
  assert.deepEqual(base.ctx.calls, ['transform', 'clear', 'image'])
  // Page point (100, 50) was at screen 0,0; at the new camera it is at (100 - 90) * 2 = 20 CSS = 40 device px.
  assert.deepEqual(base.ctx.images.at(-1), { dx: 40, dy: 0, dw: 3200, dh: 2400 })
})

test('resizing or dropping the snapshot makes it unusable', () => {
  const { renderer } = setup()
  renderer.takeSnapshot({ x: 0, y: 0, z: 1 })
  renderer.resize(400, 300, 2)
  assert.equal(renderer.snapshotAt, null)
  renderer.takeSnapshot({ x: 0, y: 0, z: 1 })
  renderer.dropSnapshot()
  assert.equal(renderer.drawFromSnapshot({ x: 0, y: 0, z: 1 }), false)
})

test('paper: fills the page color and draws pattern lines; blank draws only the fill', () => {
  const { paper, renderer } = setup()
  renderer.paper = { color: 'dark', pattern: 'blank' }
  renderer.drawPaper({ x: 0, y: 0, z: 1 })
  assert.equal(paper.ctx.rects, 1)
  assert.equal(paper.ctx.fillStyle, '#16181c')
  paper.ctx.rects = 0
  renderer.paper = { color: 'white', pattern: 'graph' }
  renderer.drawPaper({ x: 0, y: 0, z: 1 })
  assert.ok(paper.ctx.rects > 50)
})

test('a rotated picture is drawn turned about the centre of its area, then the camera is restored', () => {
  const base = fakeCanvas()
  const c = fakeCanvas()
  const renderer = new CanvasRenderer({ paper: c, base, live: c, snapshot: c }, { createPath: () => ({}), imageSource: () => ({}) as never })
  renderer.resize(800, 600, 1)
  const turned = rotateImage(createImage({ image: 'pic1', x: 0, y: 0, w: 400, h: 300 }))
  renderer.drawScene([], { x: 0, y: 0, z: 2 }, undefined, [turned])
  // Area is 300 x 400 centred on (200, 150); the picture itself stays 400 x 300, turned a quarter.
  assert.deepEqual(base.ctx.images, [{ dx: -200, dy: -150, dw: 400, dh: 300 }])
  assert.deepEqual(base.ctx.transform, [2, 0, 0, 2, -0, -0])
})

test('on dark paper near-black ink is shown light; colored ink is unchanged', () => {
  const { base, renderer } = setup()
  const [a] = generateStrokes(1)
  renderer.paper = { color: 'slate', pattern: 'blank' }
  renderer.drawScene([a], { x: 0, y: 0, z: 1 })
  assert.ok(base.ctx.calls.includes('fill:#e6e8eb'))
  assert.equal(a.style.color, '#1b1f24', 'stored color is untouched')
})
