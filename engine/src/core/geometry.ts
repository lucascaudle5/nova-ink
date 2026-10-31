import { POINT_STRIDE } from './types'
import type { Bounds } from './types'

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function pointCount(points: ArrayLike<number>): number {
  return Math.floor(points.length / POINT_STRIDE)
}

export function pointBounds(points: ArrayLike<number>, pad = 0): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < points.length; i += POINT_STRIDE) {
    const x = points[i], y = points[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

export function distanceToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0
  t = clamp(t, 0, 1)
  const cx = ax + t * dx - px, cy = ay + t * dy - py
  return cx * cx + cy * cy
}

export interface OutlineOptions {
  /** 0 = follow raw input exactly, towards 1 = heavier low-pass filtering. */
  smoothing?: number
  /** Centerline points closer than this (page units) are merged. */
  minSpacing?: number
  /** Segments per round cap. */
  capSegments?: number
}

/**
 * The smoothed centre line of a stroke (flat [x0, y0, x1, y1, ...]): low-pass filtered, close points merged, ending
 * at the real lift-off point. Ink is drawn along it at the stroke's width with round joins and caps, which never
 * leaves gaps where the pen turns more tightly than the width. Live and committed strokes use this same line, so a
 * stroke does not change shape on pen-up.
 */
export function strokeCenterline(points: ArrayLike<number>, options: OutlineOptions = {}): number[] {
  const { cx, cy } = centerline(points, options)
  const out: number[] = []
  for (let i = 0; i < cx.length; i++) out.push(cx[i], cy[i])
  return out
}

function centerline(points: ArrayLike<number>, options: OutlineOptions): { cx: number[]; cy: number[] } {
  const smoothing = clamp(options.smoothing ?? 0.45, 0, 0.95)
  const minSpacing = options.minSpacing ?? 0.35
  const n = pointCount(points)
  const cx: number[] = [], cy: number[] = []
  if (n === 0) return { cx, cy }
  let sx = points[0], sy = points[1]
  cx.push(sx); cy.push(sy)
  const follow = 1 - smoothing
  for (let i = 1; i < n; i++) {
    const o = i * POINT_STRIDE
    sx += (points[o] - sx) * follow
    sy += (points[o + 1] - sy) * follow
    const last = cx.length - 1
    if (Math.hypot(sx - cx[last], sy - cy[last]) < minSpacing) continue
    cx.push(sx); cy.push(sy)
  }
  // The filter lags the pen; finish at the real lift-off point so strokes are not visibly short.
  const lx = points[(n - 1) * POINT_STRIDE], ly = points[(n - 1) * POINT_STRIDE + 1]
  const lastIndex = cx.length - 1
  if (n > 1 && Math.hypot(lx - cx[lastIndex], ly - cy[lastIndex]) >= minSpacing) { cx.push(lx); cy.push(ly) }
  return { cx, cy }
}

/**
 * Filled outline polygon (flat [x0, y0, x1, y1, ...]) for a constant-width stroke, around the same centre line.
 * Pressure is recorded with each point but deliberately ignored here: the user chose fixed widths over pressure.
 * At turns tighter than the width the inner edge folds over itself, so this is for dots and geometry, not for filling ink.
 */
export function strokeOutline(points: ArrayLike<number>, width: number, options: OutlineOptions = {}): number[] {
  const capSegments = Math.max(2, options.capSegments ?? 8)
  const { cx, cy } = centerline(points, options)
  const r = width / 2
  const m = cx.length
  if (m === 0) return []
  if (m === 1) return circle(cx[0], cy[0], r, capSegments * 2)

  const nx = new Array<number>(m), ny = new Array<number>(m)
  let px = 0, py = -1
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1)
    let tx = cx[b] - cx[a], ty = cy[b] - cy[a]
    const length = Math.hypot(tx, ty)
    if (length > 1e-9) { tx /= length; ty /= length; px = -ty; py = tx }
    nx[i] = px; ny[i] = py
  }

  const out: number[] = []
  for (let i = 0; i < m; i++) out.push(cx[i] + nx[i] * r, cy[i] + ny[i] * r)
  cap(out, cx[m - 1], cy[m - 1], r, nx[m - 1], ny[m - 1], ny[m - 1], -nx[m - 1], capSegments)
  for (let i = m - 1; i >= 0; i--) out.push(cx[i] - nx[i] * r, cy[i] - ny[i] * r)
  cap(out, cx[0], cy[0], r, -nx[0], -ny[0], -ny[0], nx[0], capSegments)
  return out
}

/** Half circle from +n to -n bulging along t (t is the outward tangent). */
function cap(out: number[], x: number, y: number, r: number, nx: number, ny: number, tx: number, ty: number, segments: number) {
  for (let k = 1; k < segments; k++) {
    const a = (Math.PI * k) / segments
    const c = Math.cos(a), s = Math.sin(a)
    out.push(x + r * (nx * c + tx * s), y + r * (ny * c + ty * s))
  }
}

function circle(x: number, y: number, r: number, segments: number): number[] {
  const out: number[] = []
  for (let k = 0; k < segments; k++) {
    const a = (2 * Math.PI * k) / segments
    out.push(x + r * Math.cos(a), y + r * Math.sin(a))
  }
  return out
}
