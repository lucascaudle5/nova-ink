import type { Camera } from './types'

/**
 * Page paper: a background color and a pattern drawn in page coordinates, so the pattern pans and
 * zooms with the ink. Paper is part of the page, not of any stroke.
 */
export type PaperColor = 'white' | 'cream' | 'slate' | 'dark'
export type PaperPattern = 'blank' | 'dots' | 'lined' | 'graph'
export interface Paper { color: PaperColor; pattern: PaperPattern }

export const DEFAULT_PAPER: Paper = Object.freeze({ color: 'white', pattern: 'blank' })

export interface PaperColorSpec { label: string; fill: string; dark: boolean; line: string; major: string }

export const PAPER_COLORS: Readonly<Record<PaperColor, PaperColorSpec>> = {
  white: { label: 'White', fill: '#ffffff', dark: false, line: '#c9d3e0', major: '#a9b8cc' },
  cream: { label: 'Cream', fill: '#fbf6ea', dark: false, line: '#dccfb4', major: '#c5b493' },
  slate: { label: 'Slate', fill: '#2b3038', dark: true, line: '#454c57', major: '#5c6573' },
  dark: { label: 'Dark', fill: '#16181c', dark: true, line: '#2c3037', major: '#3e444e' },
}

/**
 * Base spacing in page units, how much it grows per zoom-out level, and the smallest on-screen
 * spacing (CSS px) drawn before stepping up. Dots step up sooner: each dot is its own rectangle.
 */
export const PAPER_PATTERNS: Readonly<Record<PaperPattern, { label: string; spacing: number; factor: number; minPx: number }>> = {
  blank: { label: 'Blank', spacing: 0, factor: 1, minPx: 0 },
  dots: { label: 'Dots', spacing: 24, factor: 4, minPx: 14 },
  lined: { label: 'Lined', spacing: 32, factor: 4, minPx: 6 },
  graph: { label: 'Graph', spacing: 20, factor: 5, minPx: 6 },
}

export function isPaper(value: unknown): value is Paper {
  if (!value || typeof value !== 'object') return false
  const { color, pattern } = value as Record<string, unknown>
  return typeof color === 'string' && Object.hasOwn(PAPER_COLORS, color) && typeof pattern === 'string' && Object.hasOwn(PAPER_PATTERNS, pattern)
}

/**
 * Near-black, colorless ink is shown light on dark paper so existing notes stay readable when the
 * paper changes. Only the display changes; the stroke keeps its stored color.
 */
export function displayColor(color: string, paper: Paper): string {
  if (!PAPER_COLORS[paper.color].dark) return color
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (!m) return color
  const [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h, 16))
  const neutral = Math.max(r, g, b) - Math.min(r, g, b) < 24
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return neutral && luminance < 0.2 ? '#e6e8eb' : color
}

/** One set of pattern lines or dots, in screen CSS pixels. */
export interface PatternLayer { xs: number[]; ys: number[]; alpha: number; major: boolean }

/**
 * Lines (graph, lined) or dots (dots) to draw for `camera`. Zoomed far out, spacing steps up by the
 * pattern's factor so the page never fills with a solid wash; the finest visible level fades in.
 */
export function patternLayers(pattern: PaperPattern, camera: Camera, widthCss: number, heightCss: number): PatternLayer[] {
  const spec = PAPER_PATTERNS[pattern]
  if (!spec.spacing) return []
  let spacing = spec.spacing
  while (spacing * camera.z < spec.minPx) spacing *= spec.factor
  // The finest level fades in from 15% as it grows from minPx to 2.5 × minPx on screen.
  const alpha = Math.min(1, (spacing * camera.z - spec.minPx) / (1.5 * spec.minPx) + 0.15)
  const at = (s: number, from: number, size: number) => {
    const out: number[] = []
    for (let p = Math.ceil(from / s) * s; (p - from) * camera.z <= size; p += s) out.push((p - from) * camera.z)
    return out
  }
  const xs = pattern === 'lined' ? [] : at(spacing, camera.x, widthCss)
  const ys = at(spacing, camera.y, heightCss)
  if (pattern !== 'graph') return [{ xs, ys, alpha, major: false }]
  const major = spacing * spec.factor
  return [
    { xs, ys, alpha, major: false },
    { xs: at(major, camera.x, widthCss), ys: at(major, camera.y, heightCss), alpha: 1, major: true },
  ]
}
