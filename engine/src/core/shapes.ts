import type { Poly, Pt } from './font'
import { typesetMath, typesetText } from './typeset'

/**
 * Drawing instructions as plain data (what a tool or a test can describe) and the polylines they become.
 * Coordinates are in the drawing's own frame, y down; the caller decides where on the page the drawing lands.
 */
export type Shape =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; color?: string; width?: number }
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number; both?: boolean; color?: string; width?: number }
  | { type: 'polyline'; points: Array<[number, number]>; closed?: boolean; color?: string; width?: number }
  | { type: 'rect'; x: number; y: number; w: number; h: number; color?: string; width?: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry?: number; color?: string; width?: number }
  | { type: 'arc'; cx: number; cy: number; rx: number; ry?: number; from: number; to: number; arrow?: boolean; color?: string; width?: number }
  | { type: 'text'; x: number; y: number; text: string; size?: number; math?: boolean; color?: string; width?: number }
  | { type: 'equation'; x: number; y: number; text: string; size?: number; color?: string; width?: number }

export interface InkLine { points: Poly; color?: string; width?: number; text?: boolean }

export const DEFAULT_TEXT_SIZE = 18
export const MAX_SHAPES = 200
export const MAX_COORD = 100_000

const rad = (deg: number) => (deg * Math.PI) / 180

/** Adds points so no segment is longer than `step` (the ink outline looks even, not faceted). */
export function densify(poly: Poly, step: number): Poly {
  if (poly.length < 2) return poly
  const out: Poly = [poly[0]]
  for (let i = 1; i < poly.length; i++) {
    const [x0, y0] = poly[i - 1], [x1, y1] = poly[i]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step))
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
  }
  return out
}

function arrowHead(from: Pt, tip: Pt): Poly {
  const dx = tip[0] - from[0], dy = tip[1] - from[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return []
  const size = Math.max(8, Math.min(16, len * 0.28))
  const a = Math.atan2(dy, dx)
  return [[tip[0] - size * Math.cos(a - rad(25)), tip[1] - size * Math.sin(a - rad(25))], tip, [tip[0] - size * Math.cos(a + rad(25)), tip[1] - size * Math.sin(a + rad(25))]]
}

function ellipse(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Poly {
  const steps = Math.max(8, Math.ceil(Math.abs(to - from) / 6))
  const out: Poly = []
  for (let i = 0; i <= steps; i++) {
    const a = rad(from + ((to - from) * i) / steps)
    out.push([cx + rx * Math.cos(a), cy - ry * Math.sin(a)]) // counter-clockwise on screen: y is down
  }
  return out
}

/** The ink lines a shape is drawn with. Text and equations come out as stroke-font polylines. */
export function shapeToInk(shape: Shape): InkLine[] {
  const style = { color: (shape as { color?: string }).color, width: (shape as { width?: number }).width }
  const line = (points: Poly, extra: Partial<InkLine> = {}): InkLine => ({ points, ...style, ...extra })
  switch (shape.type) {
    case 'line': return [line([[shape.x1, shape.y1], [shape.x2, shape.y2]])]
    case 'arrow': {
      const a: Pt = [shape.x1, shape.y1], b: Pt = [shape.x2, shape.y2]
      const out = [line([a, b]), line(arrowHead(a, b))]
      if (shape.both) out.push(line(arrowHead(b, a)))
      return out.filter(l => l.points.length)
    }
    case 'polyline': return [line(shape.closed && shape.points.length > 2 ? [...shape.points, shape.points[0]] : shape.points)]
    case 'rect': return [line([[shape.x, shape.y], [shape.x + shape.w, shape.y], [shape.x + shape.w, shape.y + shape.h], [shape.x, shape.y + shape.h], [shape.x, shape.y]])]
    case 'ellipse': return [line(ellipse(shape.cx, shape.cy, shape.rx, shape.ry ?? shape.rx, 0, 360))]
    case 'arc': {
      const pts = ellipse(shape.cx, shape.cy, shape.rx, shape.ry ?? shape.rx, shape.from, shape.to)
      const out = [line(pts)]
      if (shape.arrow && pts.length > 2) out.push(line(arrowHead(pts[pts.length - 3], pts[pts.length - 1])))
      return out
    }
    case 'text':
    case 'equation': {
      const math = shape.type === 'equation' || !!(shape as { math?: boolean }).math
      const size = Math.max(6, Math.min(200, shape.size ?? DEFAULT_TEXT_SIZE))
      const set = (math ? typesetMath : typesetText)(shape.text, size, shape.x, shape.y)
      return set.polylines.map(points => ({ points, ...style, text: true }))
    }
  }
}

export function inkBounds(lines: readonly InkLine[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const { points } of lines) for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD
const isColor = (v: unknown) => v === undefined || (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v))

/** Checks one shape from untrusted input; returns a message when it is not acceptable. */
export function shapeProblem(shape: unknown): string | null {
  const s = shape as Record<string, unknown> | null
  if (!s || typeof s !== 'object') return 'a shape must be an object'
  if (!isColor(s.color)) return 'color must look like #1a2b3c'
  if (s.width !== undefined && !(isNum(s.width) && s.width >= 0.3 && s.width <= 40)) return 'width must be between 0.3 and 40'
  const nums = (...keys: string[]) => keys.every(k => isNum(s[k]))
  switch (s.type) {
    case 'line': return nums('x1', 'y1', 'x2', 'y2') ? null : 'a line needs numeric x1, y1, x2, y2'
    case 'arrow': return nums('x1', 'y1', 'x2', 'y2') ? null : 'an arrow needs numeric x1, y1, x2, y2'
    case 'polyline': return Array.isArray(s.points) && s.points.length >= 2 && s.points.length <= 500 && s.points.every(p => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1])) ? null : 'a polyline needs 2 to 500 [x, y] points'
    case 'rect': return nums('x', 'y', 'w', 'h') ? null : 'a rect needs numeric x, y, w, h'
    case 'ellipse': return nums('cx', 'cy', 'rx') && (s.ry === undefined || isNum(s.ry)) ? null : 'an ellipse needs numeric cx, cy, rx (and optional ry)'
    case 'arc': return nums('cx', 'cy', 'rx', 'from', 'to') && (s.ry === undefined || isNum(s.ry)) ? null : 'an arc needs numeric cx, cy, rx, from, to (degrees)'
    case 'text':
    case 'equation':
      if (!nums('x', 'y')) return 'text needs numeric x and y'
      if (typeof s.text !== 'string' || !s.text.length || s.text.length > 600) return 'text must be 1 to 600 characters'
      if (s.size !== undefined && !(isNum(s.size) && s.size >= 6 && s.size <= 200)) return 'size must be between 6 and 200'
      return null
    default: return `unknown shape type ${JSON.stringify(s.type)}`
  }
}
