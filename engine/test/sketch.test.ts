import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createImage } from '../src/core/image'
import { planOps } from '../src/core/ops'
import type { Op } from '../src/core/ops'
import { sketch, sketchArea, sketchOfPlan } from '../src/core/sketch'
import { createStroke } from '../src/core/stroke'

const line = (x0: number, y0: number, x1: number, y1: number, author: 'student' | 'ai' = 'student') =>
  createStroke({ points: [x0, y0, 0.5, 0, x1, y1, 0.5, 80], style: { color: '#1b1f24', width: 2 }, author })
const OP = '11111111-2222-3333-4444-555555555555'
const grid = (text: string) => text.split('\n').filter(l => l.startsWith('|')).map(l => l.slice(1, -1))
/** Row and column of the first cell holding `s`. */
const find = (rows: string[], s: string) => { const r = rows.findIndex(l => l.includes(s)); return r < 0 ? null : { r, c: rows[r].indexOf(s) } }

test('the planner records where each text and equation label landed and which strokes write it', () => {
  const draw: Op = { op: 'draw', name: 'fbd', place: { x: 200, y: 100 }, shapes: [
    { type: 'rect', x: 0, y: 0, w: 60, h: 40 },
    { type: 'text', x: 80, y: 10, text: 'N' },
    { type: 'equation', x: 0, y: 70, text: 'F_x = 0' },
  ] }
  const plan = planOps({ strokes: [], images: [] }, [draw], { opId: OP, now: 1 })
  assert.ok(plan.ok)
  assert.deepEqual(plan.labels?.map(l => l.text), ['N', 'F_x = 0'])
  const [n, eq] = plan.labels!
  assert.ok(n.bounds.minX >= 270 && n.bounds.minX <= 300 && n.bounds.minY < 140, `N sits right of the box (${JSON.stringify(n.bounds)})`)
  assert.ok(eq.bounds.minY > n.bounds.maxY, 'the equation is below')
  const ids = new Set(plan.adds.map(a => a.id))
  assert.ok([...n.strokeIds, ...eq.strokeIds].every(id => ids.has(id)))
  assert.equal(n.group, plan.groups[0].id)
})

test('the sketch marks student ink, pictures, earlier and new NOVA marks, and writes labels at their position', () => {
  const student = line(100, 100, 300, 100)
  const old = line(100, 250, 300, 250, 'ai')
  const pic = createImage({ image: 'p', x: 400, y: 80, w: 120, h: 80 })
  const draw: Op = { op: 'draw', place: { x: 100, y: 180 }, shapes: [
    { type: 'line', x1: 0, y1: 0, x2: 200, y2: 0 },
    { type: 'text', x: 220, y: -8, text: 'mg' },
  ] }
  const scene = { strokes: [student, old], images: [pic] }
  const plan = planOps(scene, [draw], { opId: OP, now: 1 })
  assert.ok(plan.ok)
  const text = sketchOfPlan(scene, plan)!
  assert.match(text, /^Area x -?\d+ to \d+, y -?\d+ to \d+ \(y grows down\); one character is \d+ units wide and \d+ tall\./)
  assert.match(text, /Legend: # student/)
  const rows = grid(text)
  assert.ok(rows.length <= 36 && rows.every(r => r.length === rows[0].length && r.length <= 72))
  // the drawn line, not NOVA's small badge beside it
  const hash = find(rows, '#'), star = find(rows, '*'.repeat(20)), plus = find(rows, '+'), colon = find(rows, ':'), mg = find(rows, 'mg')
  assert.ok(hash && star && plus && colon && mg, text)
  assert.ok(hash.r < star.r && star.r < plus.r, 'student line above the new line above the old NOVA line')
  assert.ok(colon.c > hash.c, 'the picture is to the right')
  assert.ok(Math.abs(mg.r - star.r) <= 1 && mg.c > star.c, 'the label is written beside the end of the new line')
})

test('the sketch area pads small changes to a readable size, and no change gives no sketch', () => {
  const a = sketchArea({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
  assert.ok(a.maxX - a.minX >= 320 && a.maxY - a.minY >= 200)
  const b = sketchArea({ minX: 0, minY: 0, maxX: 2000, maxY: 3000 })
  assert.ok(b.minX < 0 && b.maxY > 3000)
  assert.equal(sketchOfPlan({ strokes: [], images: [] }, { adds: [], removes: [], replaces: [], summary: [], warnings: [], groups: [], empty: true }), null)
  // a tall area is limited to 36 rows
  const rows = grid(sketch({ strokes: [line(0, 0, 0, 3000)], images: [] }, b))
  assert.ok(rows.length <= 36 && rows.some(r => r.includes('#')))
})
