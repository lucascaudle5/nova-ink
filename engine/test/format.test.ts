import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromBase64, toBase64, unzigzag, VarintReader, writeVarint, zigzag } from '../src/core/codec'
import { decodePoints, encodePoints, FORMAT_VERSION, parsePage, serializePage } from '../src/core/format'
import { createStroke } from '../src/core/stroke'
import { generateStrokes, mulberry32 } from '../src/dev/generate'
import type { Stroke } from '../src/core/types'

function assertSameStrokes(a: readonly Stroke[], b: readonly Stroke[]) {
  assert.equal(a.length, b.length)
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].id, a[i].id); assert.equal(b[i].author, a[i].author)
    assert.deepEqual(b[i].style, a[i].style); assert.equal(b[i].createdAt, a[i].createdAt)
    assert.equal(b[i].points.length, a[i].points.length)
    for (let k = 0; k < a[i].points.length; k += 4) {
      // 0.01-unit quantization, plus Float32 spacing for coordinates far from the origin.
      const tolerance = (v: number) => 0.0051 + Math.abs(v) * 1.2e-7
      assert.ok(Math.abs(b[i].points[k] - a[i].points[k]) <= tolerance(a[i].points[k]), 'x')
      assert.ok(Math.abs(b[i].points[k + 1] - a[i].points[k + 1]) <= tolerance(a[i].points[k + 1]), 'y')
      assert.ok(Math.abs(b[i].points[k + 2] - a[i].points[k + 2]) <= 0.00051, 'pressure')
      assert.ok(Math.abs(b[i].points[k + 3] - a[i].points[k + 3]) <= 0.5, 'time')
    }
  }
}

test('base64 matches Node for random byte strings of every padding length', () => {
  const random = mulberry32(7)
  for (let length = 0; length < 70; length++) {
    const bytes = Uint8Array.from({ length }, () => Math.floor(random() * 256))
    const text = toBase64(bytes)
    assert.equal(text, Buffer.from(bytes).toString('base64'))
    assert.deepEqual(fromBase64(text), bytes)
  }
  assert.throws(() => fromBase64('abc'), /length/)
  assert.throws(() => fromBase64('ab!d'), /character/)
  assert.throws(() => fromBase64('a=bc'), /character/)
})

test('zigzag varints round-trip large and negative values', () => {
  const values = [0, 1, -1, 63, -64, 127, 128, -129, 2 ** 31, -(2 ** 31) - 7, 1e12]
  const bytes: number[] = []
  for (const v of values) writeVarint(bytes, zigzag(v))
  const reader = new VarintReader(Uint8Array.from(bytes))
  assert.deepEqual(values.map(() => unzigzag(reader.read())), values)
  assert.ok(reader.done)
  assert.throws(() => new VarintReader(Uint8Array.from([0x80])).read(), /Truncated/)
})

test('a page round-trips within the documented quantization', () => {
  const strokes = [
    ...generateStrokes(25),
    createStroke({ id: 'dot', author: 'ai', style: { color: '#AA0011', width: 5.5 }, points: [-12345.678, 98765.432, 0, 0], createdAt: 5 }),
  ]
  const text = JSON.stringify(serializePage(strokes))
  const result = parsePage(JSON.parse(text))
  assert.ok(result.ok)
  if (result.ok) assertSameStrokes(strokes, result.strokes)
})

test('a 3,000-stroke page stays far below the 12 MiB save limit', () => {
  const strokes = generateStrokes(3000)
  const bytes = Buffer.byteLength(JSON.stringify(serializePage(strokes)))
  // Same order as tldraw's 3.9 MiB for its 3,000-stroke fixture (cloudflare/docs), with raw 240 Hz input kept.
  assert.ok(bytes < 4 * 1024 * 1024, `${(bytes / 1048576).toFixed(2)} MiB`)
})

test('parsing refuses rather than guesses', () => {
  const good = serializePage(generateStrokes(2))
  const variants: Array<[unknown, string]> = [
    [null, 'NOT_NOVA_INK'],
    [{ document: { store: {} } }, 'NOT_NOVA_INK'],
    [{ ...good, version: FORMAT_VERSION + 1 }, 'FORMAT_NEWER'],
    [{ ...good, version: '1' }, 'INVALID'],
    [{ ...good, strokes: {} }, 'INVALID'],
    [{ ...good, strokes: [good.strokes[0], good.strokes[0]] }, 'INVALID'],
    [{ ...good, strokes: [{ ...good.strokes[0], author: 'teacher' }] }, 'INVALID'],
    [{ ...good, strokes: [{ ...good.strokes[0], color: 'red' }] }, 'INVALID'],
    [{ ...good, strokes: [{ ...good.strokes[0], n: good.strokes[0].n + 1 }] }, 'INVALID'],
    [{ ...good, strokes: [{ ...good.strokes[0], n: good.strokes[0].n - 1 }] }, 'INVALID'],
    [{ ...good, strokes: [{ ...good.strokes[0], points: good.strokes[0].points.slice(0, -4) }] }, 'INVALID'],
    [{ ...good, strokes: [{ ...good.strokes[0], id: '../x' }] }, 'INVALID'],
  ]
  for (const [data, code] of variants) {
    const result = parsePage(data)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, code, JSON.stringify(data)?.slice(0, 80))
  }
})

test('decoding rejects out-of-range pressure and negative time', () => {
  assert.throws(() => decodePoints(encodePoints([0, 0, 1.5, 0]), 1), /Pressure/)
  assert.throws(() => decodePoints(encodePoints([0, 0, 0.5, -3]), 1), /Negative/)
})

test('serializing does not mutate strokes, and cached encodings are reused and frozen', () => {
  const strokes = generateStrokes(3)
  const before = strokes.map(s => Array.from(s.points))
  const first = serializePage(strokes)
  assert.deepEqual(strokes.map(s => Array.from(s.points)), before)
  const second = serializePage(strokes)
  assert.equal(second.strokes[1], first.strokes[1])
  assert.ok(Object.isFrozen(first.strokes[0]))
})
