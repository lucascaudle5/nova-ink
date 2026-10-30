/**
 * Pen presets, Goodnotes-style: four width slots and four color slots. Tap a slot to use it; tap the
 * slot that is already selected to edit it. Pure functions; the page stores the JSON.
 */

export const MIN_WIDTH = 0.5
export const MAX_WIDTH = 24
export const SLOTS = 4
export const PALETTE = [
  '#1b1f24', '#5f6b7a', '#0b3d91', '#1f6feb', '#0f8b8d', '#1a7f37',
  '#b08800', '#e36209', '#d1242f', '#bf3989', '#8250df', '#8b5a2b',
] as const

export type PresetKind = 'width' | 'color'

export interface PenPresets {
  widths: number[]
  colors: string[]
  widthIndex: number
  colorIndex: number
}

export const DEFAULT_PRESETS: PenPresets = {
  widths: [1.5, 2.6, 5, 10],
  colors: ['#1b1f24', '#1f6feb', '#d1242f', '#1a7f37'],
  widthIndex: 1,
  colorIndex: 0,
}

/** Clamps to the allowed range and rounds to 0.1 so values compare cleanly. */
export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PRESETS.widths[DEFAULT_PRESETS.widthIndex]
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)) * 10) / 10
}

/** Returns a lowercase #rrggbb color, or null if `value` is not one (with or without #). */
export function normalizeColor(value: string): string | null {
  const text = value.trim().replace(/^#?/, '#').toLowerCase()
  return /^#[0-9a-f]{6}$/.test(text) ? text : null
}

/** Reads stored presets; anything missing or damaged falls back to defaults rather than failing. */
export function parsePresets(text: string | null): PenPresets {
  let data: unknown
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  const stored = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Partial<Record<keyof PenPresets, unknown>>
  const at = (list: unknown, i: number) => Array.isArray(list) ? list[i] : undefined
  const widths = Array.from({ length: SLOTS }, (_, i) => {
    const v = at(stored.widths, i)
    return typeof v === 'number' && Number.isFinite(v) ? clampWidth(v) : DEFAULT_PRESETS.widths[i]
  })
  const colors = Array.from({ length: SLOTS }, (_, i) => {
    const v = at(stored.colors, i)
    return (typeof v === 'string' && normalizeColor(v)) || DEFAULT_PRESETS.colors[i]
  })
  const index = (v: unknown, fallback: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < SLOTS ? v as number : fallback
  return { widths, colors, widthIndex: index(stored.widthIndex, DEFAULT_PRESETS.widthIndex), colorIndex: index(stored.colorIndex, DEFAULT_PRESETS.colorIndex) }
}

/** A tap on a slot: selects it, or asks to open its editor when it was already selected. */
export function tapSlot(presets: PenPresets, kind: PresetKind, index: number): { presets: PenPresets; edit: boolean } {
  if (!Number.isInteger(index) || index < 0 || index >= SLOTS) return { presets, edit: false }
  const selected = kind === 'width' ? presets.widthIndex : presets.colorIndex
  if (selected === index) return { presets, edit: true }
  return { presets: kind === 'width' ? { ...presets, widthIndex: index } : { ...presets, colorIndex: index }, edit: false }
}

export function setWidth(presets: PenPresets, index: number, width: number): PenPresets {
  if (!Number.isInteger(index) || index < 0 || index >= SLOTS) return presets
  const widths = [...presets.widths]
  widths[index] = clampWidth(width)
  return { ...presets, widths }
}

/** Ignores invalid colors, so a half-typed hex code never reaches a stroke. */
export function setColor(presets: PenPresets, index: number, color: string): PenPresets {
  const value = normalizeColor(color)
  if (!value || !Number.isInteger(index) || index < 0 || index >= SLOTS) return presets
  const colors = [...presets.colors]
  colors[index] = value
  return { ...presets, colors }
}

export const currentStyle = (p: PenPresets) => ({ width: p.widths[p.widthIndex], color: p.colors[p.colorIndex] })

/** Eraser: radius in screen pixels per size, and whether it cuts strokes or removes them whole. */
export const ERASER_SIZES = { small: 6, medium: 12, large: 24 } as const
export type EraserSize = keyof typeof ERASER_SIZES
export interface EraserSettings { size: EraserSize; mode: 'partial' | 'stroke' }
export const DEFAULT_ERASER: EraserSettings = { size: 'medium', mode: 'partial' }

export function parseEraser(text: string | null): EraserSettings {
  let data: unknown
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  const stored = (data && typeof data === 'object' ? data : {}) as Partial<Record<keyof EraserSettings, unknown>>
  const size = typeof stored.size === 'string' && Object.hasOwn(ERASER_SIZES, stored.size) ? stored.size as EraserSize : DEFAULT_ERASER.size
  const mode = stored.mode === 'stroke' || stored.mode === 'partial' ? stored.mode : DEFAULT_ERASER.mode
  return { size, mode }
}
