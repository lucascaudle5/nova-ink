import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpolateCamera, MAX_ZOOM, MIN_ZOOM, nextZoomStep, viewCoverage } from '../src/core/camera'
import { displayColor, isPaper, patternLayers } from '../src/core/paper'

test('zoom steps move to the next stop and stop at the ends of the range', () => {
  assert.equal(nextZoomStep(1, 1), 1.5)
  assert.equal(nextZoomStep(1, -1), 0.75)
  assert.equal(nextZoomStep(1.2, -1), 1)
  assert.equal(nextZoomStep(MAX_ZOOM, 1), MAX_ZOOM)
  assert.equal(nextZoomStep(MIN_ZOOM, -1), MIN_ZOOM)
})

test('camera animation zooms geometrically and moves the view centre in a straight line', () => {
  const a = { x: 0, y: 0, z: 1 }, b = { x: 300, y: 100, z: 4 }
  const mid = interpolateCamera(a, b, 0.5, 800, 600)
  assert.ok(Math.abs(mid.z - 2) < 1e-9)
  const centre = (c: typeof a) => [c.x + 400 / c.z, c.y + 300 / c.z]
  const [ax, ay] = centre(a), [bx, by] = centre(b), [mx, my] = centre(mid)
  assert.ok(Math.abs(mx - (ax + bx) / 2) < 1e-9 && Math.abs(my - (ay + by) / 2) < 1e-9)
  assert.deepEqual(interpolateCamera(a, b, 1, 800, 600), b)
})

test('view coverage says how much of the current view a snapshot still shows', () => {
  const at = { x: 0, y: 0, z: 1 }
  assert.equal(viewCoverage(at, at, 800, 600), 1)
  assert.equal(viewCoverage(at, { x: 400, y: 0, z: 1 }, 800, 600), 0.5)
  assert.equal(viewCoverage(at, { x: 900, y: 0, z: 1 }, 800, 600), 0)
  // Zoomed out 2x around the same corner: the old view is a quarter of the new one.
  assert.equal(viewCoverage(at, { x: 0, y: 0, z: 0.5 }, 800, 600), 0.25)
})

test('graph paper: lines sit on page multiples and move with the camera', () => {
  const [minor, major] = patternLayers('graph', { x: 5, y: 0, z: 1 }, 100, 50)
  assert.deepEqual(minor.xs, [15, 35, 55, 75, 95])
  assert.deepEqual(major.xs, [95])
  assert.equal(major.major, true)
  assert.deepEqual(patternLayers('lined', { x: 0, y: 0, z: 1 }, 100, 100)[0].xs, [])
  assert.deepEqual(patternLayers('blank', { x: 0, y: 0, z: 1 }, 100, 100), [])
})

test('zoomed far out, patterns step to coarser spacing instead of filling the page', () => {
  for (const pattern of ['graph', 'dots', 'lined'] as const) {
    for (const z of [MIN_ZOOM, 0.1, 0.3, 1, 4, MAX_ZOOM]) {
      for (const layer of patternLayers(pattern, { x: 0, y: 0, z }, 1024, 1366)) {
        assert.ok(layer.xs.length <= 1024 / 6 + 1 && layer.ys.length <= 1366 / 6 + 1, `${pattern} @ ${z}`)
        assert.ok(layer.alpha > 0 && layer.alpha <= 1)
      }
    }
  }
})

test('paper validation and dark-paper ink display', () => {
  assert.ok(isPaper({ color: 'dark', pattern: 'graph' }))
  assert.ok(!isPaper({ color: 'dark', pattern: 'hex' }))
  assert.ok(!isPaper({ color: 'toString', pattern: 'graph' }))
  const dark = { color: 'dark', pattern: 'blank' } as const
  assert.equal(displayColor('#1b1f24', dark), '#e6e8eb')
  assert.equal(displayColor('#0b3d91', dark), '#0b3d91', 'dark blue is a color, not black')
  assert.equal(displayColor('#1b1f24', { color: 'cream', pattern: 'lined' }), '#1b1f24')
})
