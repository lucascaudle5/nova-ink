import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strokeCenterline, strokeOutline, pointBounds } from '../src/core/geometry'
import { fitBounds, gestureCamera, MAX_ZOOM, MIN_ZOOM, toPage, toScreen, viewportBounds, zoomAt } from '../src/core/camera'
import { createStroke } from '../src/core/stroke'

const pts = (...xy: Array<[number, number, number?]>) => xy.flatMap(([x, y, p = 0.5], i) => [x, y, p, i * 4])

function polygonWidthAt(outline: number[], x: number): number {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < outline.length; i += 2) if (Math.abs(outline[i] - x) < 0.6) { lo = Math.min(lo, outline[i + 1]); hi = Math.max(hi, outline[i + 1]) }
  return hi - lo
}

test('a single point becomes a closed dot of half the stroke width', () => {
  const outline = strokeOutline(pts([10, 20, 1]), 4)
  assert.ok(outline.length >= 16 * 2)
  for (let i = 0; i < outline.length; i += 2) assert.ok(Math.abs(Math.hypot(outline[i] - 10, outline[i + 1] - 20) - 2) < 1e-9)
})

test('outline stays within the stroke bounds padded by the radius', () => {
  const raw = pts(...Array.from({ length: 50 }, (_, i): [number, number] => [i * 2, Math.sin(i / 5) * 10]))
  const outline = strokeOutline(raw, 6)
  const b = pointBounds(raw, 3 + 1e-9)
  for (let i = 0; i < outline.length; i += 2) {
    assert.ok(outline[i] >= b.minX && outline[i] <= b.maxX && outline[i + 1] >= b.minY && outline[i + 1] <= b.maxY)
  }
})

test('width is the chosen width everywhere; pressure never changes it', () => {
  const varying = strokeOutline(pts(...Array.from({ length: 40 }, (_, i): [number, number, number] => [i, 0, i % 2 ? 0.05 : 1])), 8)
  const light = strokeOutline(pts(...Array.from({ length: 40 }, (_, i): [number, number, number] => [i, 0, 0.1])), 8)
  for (const x of [5, 20, 33]) {
    assert.ok(Math.abs(polygonWidthAt(varying, x) - 8) < 1e-9)
    assert.ok(Math.abs(polygonWidthAt(light, x) - 8) < 1e-9)
  }
})

test('the outline reaches the real lift-off point despite smoothing lag', () => {
  const raw = pts(...Array.from({ length: 30 }, (_, i): [number, number] => [i * 3, 0]))
  const outline = strokeOutline(raw, 2, { smoothing: 0.8 })
  const maxX = Math.max(...outline.filter((_, i) => i % 2 === 0))
  assert.ok(maxX >= 87 - 1e-6, `maxX ${maxX}`)
})

test('the centre line is smoothed, ends at the lift-off point, and a lone point stays one point', () => {
  assert.deepEqual(strokeCenterline(pts([10, 20])), [10, 20])
  const raw = pts(...Array.from({ length: 30 }, (_, i): [number, number] => [i * 3, i % 2]))
  const line = strokeCenterline(raw)
  assert.deepEqual(line.slice(-2), [87, 1])
  for (let i = 3; i < line.length - 2; i += 2) assert.ok(line[i] > 0.05 && line[i] < 0.95, 'jitter is smoothed out')
})

test('screen/page transforms round-trip, including far from the origin', () => {
  for (const camera of [{ x: 0, y: 0, z: 1 }, { x: -1234.5, y: 987.25, z: 3.7 }, { x: 1e6, y: -1e6, z: 0.13 }]) {
    const page = toPage(camera, 311.4, 77.9)
    const back = toScreen(camera, page.x, page.y)
    assert.ok(Math.abs(back.x - 311.4) < 1e-6 && Math.abs(back.y - 77.9) < 1e-6)
  }
})

test('zoomAt keeps the point under the cursor fixed and clamps zoom', () => {
  const camera = { x: 100, y: 50, z: 1.5 }
  const before = toPage(camera, 200, 120)
  const zoomed = zoomAt(camera, 200, 120, 4)
  const after = toPage(zoomed, 200, 120)
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9)
  assert.equal(zoomAt(camera, 0, 0, 1000).z, MAX_ZOOM)
  assert.equal(zoomAt(camera, 0, 0, 0).z, MIN_ZOOM)
})

test('gesture camera: one finger pans; two fingers zoom about the moving centroid', () => {
  const start = { x: 10, y: 20, z: 2 }
  const pan = gestureCamera(start, { cx: 100, cy: 100, spread: 0 }, { cx: 140, cy: 90, spread: 0 })
  assert.equal(pan.z, 2)
  assert.ok(Math.abs(pan.x - (10 - 20)) < 1e-9 && Math.abs(pan.y - (20 + 5)) < 1e-9)

  const anchor = toPage(start, 300, 200)
  const pinch = gestureCamera(start, { cx: 300, cy: 200, spread: 100 }, { cx: 320, cy: 210, spread: 250 })
  assert.ok(Math.abs(pinch.z - 5) < 1e-9)
  const under = toPage(pinch, 320, 210)
  assert.ok(Math.abs(under.x - anchor.x) < 1e-9 && Math.abs(under.y - anchor.y) < 1e-9)
})

test('fitBounds shows all content', () => {
  const content = { minX: -50, minY: 100, maxX: 950, maxY: 3100 }
  const camera = fitBounds(content, 1024, 768)
  const view = viewportBounds(camera, 1024, 768)
  assert.ok(view.minX <= content.minX && view.maxX >= content.maxX && view.minY <= content.minY && view.maxY >= content.maxY)
})

test('Float32 point storage keeps 0.01-unit precision up to 100,000 page units', () => {
  const s = createStroke({ points: [99_999.37, -54_321.11, 0.5, 0], style: { color: '#000000', width: 2 } })
  assert.ok(Math.abs(s.points[0] - 99_999.37) < 0.005)
  assert.ok(Math.abs(s.points[1] - -54_321.11) < 0.005)
})
