import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampWidth, currentStyle, DEFAULT_ERASER, DEFAULT_PRESETS, MAX_WIDTH, MIN_WIDTH, normalizeColor, parseEraser, parsePresets, setColor, setWidth, tapSlot } from '../harness/presets'

test('eraser settings round-trip and fall back to medium partial erasing', () => {
  assert.deepEqual(parseEraser(JSON.stringify({ size: 'large', mode: 'stroke' })), { size: 'large', mode: 'stroke' })
  assert.deepEqual(parseEraser(null), DEFAULT_ERASER)
  assert.deepEqual(parseEraser('{"size":"toString","mode":"x"}'), DEFAULT_ERASER)
  assert.deepEqual(parseEraser('not json'), DEFAULT_ERASER)
})

test('tapping a slot selects it; tapping the selected slot again opens its editor (Goodnotes)', () => {
  const first = tapSlot(DEFAULT_PRESETS, 'width', 3)
  assert.equal(first.edit, false)
  assert.equal(first.presets.widthIndex, 3)
  const again = tapSlot(first.presets, 'width', 3)
  assert.equal(again.edit, true)
  assert.equal(again.presets, first.presets)
  const color = tapSlot(first.presets, 'color', 2)
  assert.deepEqual([color.edit, color.presets.colorIndex, color.presets.widthIndex], [false, 2, 3])
  assert.equal(tapSlot(DEFAULT_PRESETS, 'color', 7).presets, DEFAULT_PRESETS)
})

test('editing changes only that slot, and the current style follows the selected slots', () => {
  const edited = setColor(setWidth(DEFAULT_PRESETS, 1, 7.77), 0, 'FF8800')
  assert.deepEqual(edited.widths, [1.5, 7.8, 5, 10])
  assert.deepEqual(edited.colors, ['#ff8800', '#1f6feb', '#d1242f', '#1a7f37'])
  assert.deepEqual(currentStyle(edited), { width: 7.8, color: '#ff8800' })
  assert.deepEqual(DEFAULT_PRESETS.widths, [1.5, 2.6, 5, 10])
})

test('invalid widths are clamped and invalid colors are ignored', () => {
  assert.equal(clampWidth(0), MIN_WIDTH)
  assert.equal(clampWidth(1000), MAX_WIDTH)
  assert.equal(clampWidth(NaN), 2.6)
  assert.equal(normalizeColor('#12345'), null)
  assert.equal(normalizeColor('red'), null)
  assert.equal(setColor(DEFAULT_PRESETS, 0, '#12'), DEFAULT_PRESETS)
  assert.equal(setWidth(DEFAULT_PRESETS, -1, 3), DEFAULT_PRESETS)
})

test('stored presets round-trip; missing or damaged storage falls back to defaults', () => {
  const edited = { ...setColor(DEFAULT_PRESETS, 3, '#abcdef'), widthIndex: 2, colorIndex: 3 }
  assert.deepEqual(parsePresets(JSON.stringify(edited)), edited)
  assert.deepEqual(parsePresets(null), DEFAULT_PRESETS)
  assert.deepEqual(parsePresets('{oops'), DEFAULT_PRESETS)
  assert.deepEqual(parsePresets('[1]'), DEFAULT_PRESETS)
  assert.deepEqual(
    parsePresets(JSON.stringify({ widths: [3, 'x', 99], colors: ['#000000', 'blue'], widthIndex: 9, colorIndex: 1 })),
    { widths: [3, 2.6, MAX_WIDTH, 10], colors: ['#000000', '#1f6feb', '#d1242f', '#1a7f37'], widthIndex: 1, colorIndex: 1 },
  )
})
