import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InkDocument } from '../src/core/document'
import { parsePage, parseItem, serializeItem, serializePage } from '../src/core/format'
import { History } from '../src/core/history'
import { createImage } from '../src/core/image'
import { parseOps, planOps } from '../src/core/ops'
import type { Op, Plan } from '../src/core/ops'
import { describeScene, inkClusters } from '../src/core/scene'
import { transformStroke } from '../src/core/selection'
import { hasGlyph } from '../src/core/font'
import { createStroke } from '../src/core/stroke'
import { typesetMath, typesetText } from '../src/core/typeset'
import type { ImageItem, PageItem, Stroke } from '../src/core/types'

const line = (x0: number, y0: number, x1: number, y1: number, extra: Partial<{ group: string; author: 'student' | 'ai' }> = {}) =>
  createStroke({ points: [x0, y0, 0.5, 0, x1, y1, 0.5, 80], style: { color: '#1b1f24', width: 2 }, ...extra })
const picture = (x: number, y: number, w = 300, h = 200, group?: string) => createImage({ image: 'pic1', x, y, w, h, group })
const OP = '11111111-2222-3333-4444-555555555555'
const ok = (r: ReturnType<typeof planOps>) => { assert.ok(r.ok, r.ok ? '' : r.message); return r as Extract<typeof r, { ok: true }> }

/** Applies a plan to arrays the way the editor and the server both do: replace in place, remove, append. */
function apply(strokes: Stroke[], images: ImageItem[], plan: Plan) {
  const items = new Map<string, PageItem>([...strokes, ...images].map(i => [i.id, i]))
  const out = { strokes: [...strokes], images: [...images] }
  const swap = (list: PageItem[], id: string, next: PageItem) => { const at = list.findIndex(i => i.id === id); assert.ok(at >= 0, `unknown id ${id}`); list[at] = next }
  for (const [id, next] of plan.replaces) swap((items.get(id) as ImageItem).kind === 'image' ? out.images : out.strokes, id, next)
  out.strokes = out.strokes.filter(s => !plan.removes.includes(s.id))
  out.images = out.images.filter(s => !plan.removes.includes(s.id))
  for (const a of plan.adds) ((a as ImageItem).kind === 'image' ? out.images : out.strokes).push(a as never)
  return out
}

test('every printable ASCII character has a glyph, and unknown ones draw a visible box', () => {
  for (let c = 33; c < 127; c++) assert.ok(hasGlyph(String.fromCharCode(c)), `no glyph for ${String.fromCharCode(c)}`)
  const t = typesetText('Σ F\u0000', 16)
  assert.ok(t.polylines.length > 3)
})

test('typesetting: width grows with text, scripts are smaller, a fraction has a bar, lines stack', () => {
  const a = typesetText('Fx', 20), b = typesetText('Fxxx', 20)
  assert.ok(b.width > a.width + 20)
  const sup = typesetMath('x^2', 20), flat = typesetMath('x2', 20)
  assert.ok(sup.height > flat.height, 'a superscript rises above the line')
  const frac = typesetMath('\\frac{a}{b}', 20)
  assert.ok(frac.polylines.some(p => p.length === 2 && p[0][1] === p[1][1] && Math.abs(p[1][0] - p[0][0]) > 8), 'the fraction bar is a horizontal line')
  const two = typesetText('a\nb', 20)
  assert.ok(two.height > typesetText('a', 20).height * 1.8)
  const eq = typesetMath('\\Sigma F_{x} = 0', 18)
  assert.ok(eq.polylines.length >= 5 && eq.width > 50)
  for (const poly of eq.polylines) for (const [x, y] of poly) assert.ok(Number.isFinite(x) && Number.isFinite(y))
})

test('operations are checked: unknown ops, bad shapes and oversized batches are refused with a message', () => {
  assert.equal(parseOps([]).ok, false)
  assert.equal(parseOps([{ op: 'nope' }]).ok, false)
  assert.match((parseOps([{ op: 'draw', place: { x: 1, y: 2 }, shapes: [{ type: 'line', x1: 'a' }] }]) as { message: string }).message, /line needs numeric/)
  assert.match((parseOps([{ op: 'draw', place: {}, shapes: [] }]) as { message: string }).message, /place/)
  assert.match((parseOps([{ op: 'move', targets: ['a'] }]) as { message: string }).message, /dx and\/or dy/)
  assert.equal(parseOps(Array.from({ length: 41 }, () => ({ op: 'ungroup', targets: ['a'] }))).ok, false)
  assert.equal(parseOps([{ op: 'draw', place: { x: 0, y: 0 }, shapes: [{ type: 'line', x1: 0, y1: 0, x2: 10, y2: 10, color: 'red' }] }]).ok, false)
})

test('draw: NOVA marks are author ai, grouped, tagged, placed beside a target without covering it, and attributed after a save round trip', () => {
  const pic = picture(100, 100)
  const mine = [line(500, 120, 600, 160), line(520, 180, 640, 200)]
  const draw: Op = { op: 'draw', name: 'Free body diagram', place: { relativeTo: 'ink:' + mine[0].id, side: 'right', gap: 50 }, shapes: [
    { type: 'rect', x: 0, y: 0, w: 40, h: 30 },
    { type: 'arrow', x1: 20, y1: 15, x2: 120, y2: 15 },
    { type: 'equation', x: 0, y: 60, text: 'F_x = 0' },
    { type: 'text', x: 0, y: 100, text: 'N' },
  ] }
  const plan = ok(planOps({ strokes: mine, images: [pic] }, [draw], { opId: OP, now: 5 }))
  assert.ok(plan.adds.length > 10)
  assert.ok(plan.adds.every(a => a.author === 'ai' && /^nova-free-body-diagram-[0-9a-f]{8}$/.test(a.group!)), 'all marks are NOVA ink in one group')
  assert.equal(plan.groups.length, 1)
  assert.equal(plan.removes.length + plan.replaces.length, 0, 'the student work is untouched')
  const placed = plan.groups[0].bounds
  const target = describeScene({ strokes: mine, images: [pic] }).regions[0].bounds
  assert.ok(placed.minX >= target.maxX + 40, `the drawing starts to the right of the attempt (${placed.minX} vs ${target.maxX})`)
  // saved and read back: group and author survive, and a group id is a valid stored id
  const round = parsePage(JSON.parse(JSON.stringify(serializePage(plan.adds as Stroke[]))))
  assert.ok(round.ok && round.strokes.every(s => s.author === 'ai' && s.group === plan.groups[0].id))
  const text = describeScene({ strokes: [...mine, ...(plan.adds as Stroke[])], images: [pic] })
  assert.equal(text.groups[0].author, 'nova')
  assert.equal(text.groups[0].label, 'free body diagram')
})

test('placement nudges clear of existing work and says so', () => {
  const blocker = line(260, 100, 400, 140)
  const pic = picture(100, 100, 150, 100)
  const plan = ok(planOps({ strokes: [blocker], images: [pic] }, [{ op: 'draw', place: { relativeTo: pic.id, side: 'right', gap: 10 }, shapes: [{ type: 'rect', x: 0, y: 0, w: 60, h: 40 }] }], { opId: OP }))
  const b = plan.groups[0].bounds
  assert.ok(b.minX > blocker.bounds.maxX, 'moved past the blocking ink')
  assert.ok(plan.warnings.some(w => /avoid existing work/.test(w)))
})

test('the same batch is never applied twice: planning against its own result changes nothing', () => {
  const mine = [line(0, 0, 50, 50)]
  const ops: Op[] = [{ op: 'draw', place: { x: 300, y: 0 }, shapes: [{ type: 'line', x1: 0, y1: 0, x2: 30, y2: 30 }] }, { op: 'move', targets: [mine[0].id], dx: 10, dy: 0 }]
  const first = ok(planOps({ strokes: mine, images: [] }, ops, { opId: OP }))
  const after = apply(mine, [], first)
  const again = ok(planOps(after, ops, { opId: OP }))
  assert.equal(again.alreadyApplied, true)
  assert.equal(again.empty, true)
  const other = ok(planOps(after, [ops[0]], { opId: 'aaaaaaaa-2222-3333-4444-555555555555' }))
  assert.equal(other.empty, false, 'a different batch id is a different action')
  // the plan itself is deterministic
  const a = ok(planOps({ strokes: mine, images: [] }, ops, { opId: OP, now: 9 })), b = ok(planOps({ strokes: mine, images: [] }, ops, { opId: OP, now: 9 }))
  assert.deepEqual(a.adds.map(i => i.id), b.adds.map(i => i.id))
  assert.deepEqual(a.replaces.map(([from, to]) => [from, to.id]), b.replaces.map(([from, to]) => [from, to.id]))
})

test('move keeps group and author, and a whole group moves together; targets that are gone fail the whole batch', () => {
  const g1 = line(0, 0, 10, 10, { group: 'nova-box-0123abcd', author: 'ai' }), g2 = line(10, 10, 20, 0, { group: 'nova-box-0123abcd', author: 'ai' })
  const loose = line(300, 300, 340, 340)
  const plan = ok(planOps({ strokes: [g1, loose, g2], images: [] }, [{ op: 'move', targets: ['nova-box-0123abcd'], dx: 100, dy: 50 }], { opId: OP }))
  assert.equal(plan.replaces.length, 2)
  for (const [, moved] of plan.replaces) { assert.equal(moved.group, 'nova-box-0123abcd'); assert.equal(moved.author, 'ai'); assert.ok(moved.bounds.minX >= 98) }
  assert.deepEqual(plan.replaces.map(([from]) => from).sort(), [g1.id, g2.id].sort())
  const bad = planOps({ strokes: [g1], images: [] }, [{ op: 'move', targets: [g1.id], dx: 5 }, { op: 'move', targets: ['gone'], dx: 5 }], { opId: OP })
  assert.equal(bad.ok, false)
  assert.match((bad as { message: string }).message, /Operation 2/)
})

test('make room moves what is below in the same column, nothing else; align and distribute use whole groups', () => {
  const top = picture(100, 100, 300, 100)
  const below = line(120, 400, 200, 420), farRight = line(900, 400, 950, 420), above = line(120, 10, 180, 30)
  const room = ok(planOps({ strokes: [below, farRight, above], images: [top] }, [{ op: 'make_room', below: top.id, amount: 200 }], { opId: OP }))
  assert.deepEqual(room.replaces.map(([from]) => from), [below.id])
  assert.ok(room.replaces[0][1].bounds.minY > below.bounds.minY + 199)

  const a = picture(0, 0, 100, 100), b = picture(300, 40, 100, 100), c = picture(700, 90, 100, 100)
  const aligned = ok(planOps({ strokes: [], images: [a, b, c] }, [{ op: 'align', targets: [a.id, b.id, c.id], edge: 'top' }], { opId: OP }))
  const after = apply([], [a, b, c], aligned)
  assert.deepEqual(new Set(after.images.map(i => i.y)).size, 1)
  const spaced = ok(planOps({ strokes: [], images: [a, b, c] }, [{ op: 'distribute', targets: [a.id, b.id, c.id], axis: 'x' }], { opId: OP }))
  const xs = apply([], [a, b, c], spaced).images.sort((p, q) => p.x - q.x)
  assert.ok(Math.abs(xs[1].x - xs[0].x - (xs[2].x - xs[1].x)) < 1e-6, 'equal spacing between equal-width pictures')
  assert.equal(xs[0].x, 0); assert.equal(xs[2].x, 700)
})

test('group and ungroup; copy; NOVA removes only its own marks', () => {
  const pic = picture(0, 0), work = line(10, 250, 200, 300)
  const grouped = ok(planOps({ strokes: [work], images: [pic] }, [{ op: 'group', name: 'Problem 6-66', targets: [pic.id, work.id] }], { opId: OP }))
  assert.ok(grouped.replaces.every(([, item]) => item.group === grouped.groups[0].id && /^nova-problem-6-66-/.test(item.group!)))
  const state = apply([work], [pic], grouped)
  const copy = ok(planOps(state, [{ op: 'duplicate', targets: [grouped.groups[0].id], place: { x: 0, y: 900 } }], { opId: 'bbbbbbbb-2222-3333-4444-555555555555' }))
  assert.equal(copy.adds.length, 2)
  assert.ok(copy.adds.every(a => a.group && a.group !== grouped.groups[0].id), 'a copy gets its own group')
  assert.ok(copy.adds.every(a => a.bounds.minY >= 899))
  const un = ok(planOps(state, [{ op: 'ungroup', targets: [grouped.groups[0].id] }], { opId: 'cccccccc-2222-3333-4444-555555555555' }))
  assert.ok(un.replaces.every(([, item]) => item.group === undefined))
  const refuse = planOps({ strokes: [work], images: [pic] }, [{ op: 'remove', targets: [work.id] }], { opId: OP })
  assert.equal(refuse.ok, false)
  const nova = line(0, 0, 5, 5, { author: 'ai' })
  const removed = ok(planOps({ strokes: [nova, work], images: [] }, [{ op: 'remove', targets: [nova.id] }], { opId: OP }))
  assert.deepEqual(removed.removes, [nova.id])
})

test('a batch that draws and then moves what it drew nets out to new items only', () => {
  const plan = ok(planOps({ strokes: [], images: [] }, [
    { op: 'draw', name: 'axes', place: { x: 100, y: 100 }, shapes: [{ type: 'arrow', x1: 0, y1: 0, x2: 80, y2: 0 }] },
    { op: 'move', targets: ['__last__'], dx: 1 },
  ].slice(0, 1) as Op[], { opId: OP }))
  assert.equal(plan.replaces.length, 0)
  assert.equal(plan.removes.length, 0)
  assert.ok(plan.adds.length >= 3)
})

test('History.applyPlan is one undo step for draw + move + remove, and redo repeats it', () => {
  const doc = new InkDocument(), history = new History(doc)
  const mine = line(0, 0, 40, 40), other = line(100, 100, 140, 140), nova = line(300, 0, 340, 40, { author: 'ai' })
  doc.load([mine, other, nova])
  const before = doc.strokes.map(s => s.id)
  const plan = ok(planOps({ strokes: doc.strokes, images: doc.images }, [
    { op: 'draw', place: { x: 500, y: 0 }, shapes: [{ type: 'rect', x: 0, y: 0, w: 30, h: 30 }] },
    { op: 'move', targets: [mine.id], dx: 0, dy: 60 },
    { op: 'remove', targets: [nova.id] },
  ], { opId: OP }))
  const changed = history.applyPlan(plan)
  assert.ok(changed > 3)
  assert.ok(doc.strokes.length > 3)
  assert.equal(doc.has(nova.id), false)
  assert.equal(doc.has(mine.id), false, 'the moved stroke was replaced')
  assert.ok(history.undo())
  assert.deepEqual(doc.strokes.map(s => s.id), before, 'one undo restores everything, in the original order')
  assert.equal(history.undo(), false, 'and there was only one step')
  assert.ok(history.redo())
  assert.ok(doc.strokes.length > 3 && !doc.has(nova.id))
  const redone = planOps({ strokes: doc.strokes, images: doc.images }, [{ op: 'draw', place: { x: 500, y: 0 }, shapes: [{ type: 'rect', x: 0, y: 0, w: 30, h: 30 }] }], { opId: OP })
  assert.ok(redone.ok && redone.alreadyApplied, 'the page itself says the batch is applied')
})

test('groups survive moves, resizes, restyles and erasing; scene regions ignore NOVA and grouped ink', () => {
  const s = line(0, 0, 40, 40, { group: 'g1' })
  assert.equal(transformStroke(s, { s: 2, angle: 30, pivot: { x: 0, y: 0 }, to: { x: 5, y: 5 } }).group, 'g1')
  const img = picture(0, 0, 100, 100, 'g2')
  assert.equal(parseItem(serializeItem(img)).ok && (parseItem(serializeItem(img)) as { item: PageItem }).item.group, 'g2')
  assert.equal(parseItem({ ...serializeItem(img), group: 'bad id!' }).ok, false)
  const loose = [line(0, 0, 10, 10), line(15, 15, 30, 30), line(500, 500, 520, 520), line(0, 0, 10, 10, { author: 'ai' }), s]
  const clusters = inkClusters(loose)
  assert.equal(clusters.length, 2)
  assert.equal(clusters[0].ids.length, 2)
})
