import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InkDocument } from '../src/core/document'
import { parseStroke, serializeStroke } from '../src/core/format'
import { isOrderKey, keyBetween } from '../src/core/order'
import { createStroke } from '../src/core/stroke'
import { isEmptyDelta, PageSync } from '../src/core/sync'
import type { PageDelta } from '../src/core/sync'
import { mulberry32 } from '../src/dev/generate'

const stroke = (id: string, x = 0) => createStroke({ id, style: { color: '#112233', width: 2 }, createdAt: 1, points: [x, 0, 0.5, 0, x + 5, 3, 0.5, 8] })

/** A stand-in for the server: rows keyed by stroke id, read back sorted by order key. */
class FakeServer {
  rows = new Map<string, string>()
  apply(delta: PageDelta) {
    for (const id of delta.removes) this.rows.delete(id)
    for (const { key, stroke: s } of delta.adds) this.rows.set(s.id, key)
    const keys = [...this.rows.values()]
    assert.equal(new Set(keys).size, keys.length, 'order keys are unique')
  }
  order() { return [...this.rows].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([id]) => id) }
}

test('order keys: appends stay short, inserts always fit, every key is valid', () => {
  const keys: string[] = []
  let last: string | null = null
  for (let i = 0; i < 5000; i++) { last = keyBetween(last, null); keys.push(last) }
  assert.ok(keys.every(k => k.length === 9 && isOrderKey(k)))
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i])

  // Repeatedly squeeze into the same gap, at the start, and next to the previous insert.
  const random = mulberry32(3)
  const list = keys.slice(0, 20)
  for (let i = 0; i < 3000; i++) {
    const at = Math.floor(random() * (list.length + 1))
    const key = keyBetween(at === 0 ? null : list[at - 1], at === list.length ? null : list[at])
    assert.ok(isOrderKey(key), key)
    list.splice(at, 0, key)
  }
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1] < list[i], `${list[i - 1]} < ${list[i]}`)
  let squeezed = keyBetween(list[0], list[1])
  for (let i = 0; i < 40; i++) squeezed = keyBetween(list[0], squeezed)
  assert.ok(squeezed.length < 30, `deep nesting grows slowly (${squeezed.length})`)
  assert.throws(() => keyBetween(list[1], list[0]))
  assert.throws(() => keyBetween('nope', null))
})

test('PageSync sends only changes and keeps the z-order on the server', () => {
  const doc = new InkDocument()
  const server = new FakeServer()
  const sync = new PageSync()
  const save = () => { const d = sync.delta(doc.strokes); server.apply(d); sync.acknowledge(d); return d }

  doc.addMany([stroke('a'), stroke('b'), stroke('c')])
  assert.equal(save().adds.length, 3)
  assert.ok(isEmptyDelta(sync.delta(doc.strokes)), 'nothing changed, nothing to send')

  doc.add(stroke('d'))
  assert.deepEqual(save().adds.map(a => a.stroke.id), ['d'])

  // Partial erase: b becomes two pieces at b's position.
  doc.replace('b', [stroke('b1'), stroke('b2')])
  const erase = save()
  assert.deepEqual(erase.removes, ['b'])
  assert.deepEqual(erase.adds.map(a => a.stroke.id), ['b1', 'b2'])
  assert.deepEqual(server.order(), doc.strokes.map(s => s.id))

  // Undo of the erase puts b back in place.
  const placed = doc.remove(['b1', 'b2'])
  doc.restore([{ stroke: stroke('b'), index: placed[0].index }])
  save()
  assert.deepEqual(server.order(), ['a', 'b', 'c', 'd'])
})

test('a save that is not acknowledged is resent with the same keys; later edits merge in', () => {
  const doc = new InkDocument()
  const server = new FakeServer()
  const sync = new PageSync()
  doc.addMany([stroke('a'), stroke('b')])
  const lost = sync.delta(doc.strokes)
  server.apply(lost) // the server stored it, but the reply never arrived
  doc.add(stroke('c'))
  const retry = sync.delta(doc.strokes)
  assert.deepEqual(retry.adds.slice(0, 2), lost.adds, 'same strokes, same keys')
  server.apply(retry)
  sync.acknowledge(retry)
  assert.deepEqual(server.order(), ['a', 'b', 'c'])
  assert.ok(isEmptyDelta(sync.delta(doc.strokes)))
})

test('PageSync starts from what the server returned when a page was opened', () => {
  const doc = new InkDocument()
  const server = new FakeServer()
  const first = new PageSync()
  doc.addMany([stroke('a'), stroke('b')])
  const d = first.delta(doc.strokes)
  server.apply(d)

  const reopened = new PageSync(d.adds.map(a => ({ id: a.stroke.id, key: a.key })))
  assert.equal(reopened.size, 2)
  assert.ok(isEmptyDelta(reopened.delta(doc.strokes)))
  doc.remove(['a'])
  assert.deepEqual(reopened.delta(doc.strokes), { adds: [], removes: ['a'] })
})

test('random edits: after every acknowledged save the server matches the page exactly', () => {
  const random = mulberry32(11)
  const doc = new InkDocument()
  const server = new FakeServer()
  const sync = new PageSync()
  let next = 0
  for (let step = 0; step < 400; step++) {
    const r = random()
    const ids = doc.strokes.map(s => s.id)
    if (r < 0.5 || !ids.length) doc.add(stroke(`s${next++}`, random() * 100))
    else if (r < 0.7) doc.replace(ids[Math.floor(random() * ids.length)], [stroke(`s${next++}`), stroke(`s${next++}`)])
    else if (r < 0.85) {
      const removed = doc.remove([ids[Math.floor(random() * ids.length)]])
      if (random() < 0.5) doc.restore(removed) // undo straight away
    } else doc.remove(ids.filter(() => random() < 0.2))
    if (random() < 0.4) {
      const d = sync.delta(doc.strokes)
      server.apply(d)
      if (random() < 0.8) sync.acknowledge(d) // sometimes the reply is lost
    }
  }
  const d = sync.delta(doc.strokes)
  server.apply(d)
  sync.acknowledge(d)
  assert.deepEqual(server.order(), doc.strokes.map(s => s.id))
})

test('parseStroke round-trips one stored stroke and refuses bad ones', () => {
  const original = stroke('abc', 10)
  const parsed = parseStroke(JSON.parse(JSON.stringify(serializeStroke(original))))
  assert.ok(parsed.ok)
  if (parsed.ok) { assert.equal(parsed.stroke.id, 'abc'); assert.equal(parsed.stroke.points.length, 8) }
  for (const bad of [null, {}, { ...serializeStroke(original), id: 'bad id!' }, { ...serializeStroke(original), n: 3 }, { ...serializeStroke(original), author: 'robot' }]) {
    assert.equal(parseStroke(bad).ok, false)
  }
})
