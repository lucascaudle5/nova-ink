import { distanceToSegmentSq } from './geometry'
import type { InkDocument } from './document'
import { createStroke } from './stroke'
import { POINT_STRIDE } from './types'
import type { Stroke } from './types'

/** True when a circle of `radius` at (x, y) touches the stroke's centerline widened by half its width. */
export function strokeHit(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const b = stroke.bounds
  if (x + radius < b.minX || x - radius > b.maxX || y + radius < b.minY || y - radius > b.maxY) return false
  const reach = radius + stroke.style.width / 2
  const reachSq = reach * reach
  const p = stroke.points
  if (p.length === POINT_STRIDE) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= reachSq
  for (let i = POINT_STRIDE; i < p.length; i += POINT_STRIDE) {
    if (distanceToSegmentSq(x, y, p[i - POINT_STRIDE], p[i - POINT_STRIDE + 1], p[i], p[i + 1]) <= reachSq) return true
  }
  return false
}

/** Strokes touched by the eraser circle, in z-order. */
export function strokesHitBy(doc: InkDocument, x: number, y: number, radius: number): Stroke[] {
  return doc.query({ minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius })
    .filter(stroke => strokeHit(stroke, x, y, radius))
}

/**
 * Partial ("pixel") eraser: removes the part of `stroke` covered by a circle of `radius` at (x, y).
 * The centerline is cut where it enters and leaves the circle widened by half the stroke width, so
 * each remaining piece's round cap ends at the eraser's edge. Returns null when nothing was touched,
 * otherwise the remaining pieces (possibly none). Pieces are ordinary strokes with new ids that keep
 * the original style, author and time, so AI marks stay attributed.
 */
export function eraseFromStroke(stroke: Stroke, x: number, y: number, radius: number): Stroke[] | null {
  if (!strokeHit(stroke, x, y, radius)) return null
  const p = stroke.points
  const n = p.length / POINT_STRIDE
  const reach = radius + stroke.style.width / 2
  const reachSq = reach * reach
  if (n === 1) return []
  const inside = (i: number) => (p[i * POINT_STRIDE] - x) ** 2 + (p[i * POINT_STRIDE + 1] - y) ** 2 < reachSq
  const pieces: number[][] = []
  let current: number[] | null = inside(0) ? null : pushPoint([], p, 0, 0)
  let cut = false
  for (let i = 0; i < n - 1; i++) {
    const span = insideSpan(p, i, x, y, reachSq)
    if (!span) {
      // A point exactly on the edge ends one span and can start the next piece.
      current ??= pushPoint([], p, i, 0)
      pushPoint(current, p, i + 1, 0)
      continue
    }
    cut = true
    const [t0, t1] = span
    if (current) {
      if (t0 > 0) pushPoint(current, p, i, t0)
      pieces.push(current)
      current = null
    }
    if (t1 < 1) {
      current = pushPoint([], p, i, t1)
      pushPoint(current, p, i + 1, 0)
    }
  }
  if (current) pieces.push(current)
  if (!cut) return null
  return pieces
    .filter(points => points.length >= 2 * POINT_STRIDE)
    .map(points => createStroke({ points, style: stroke.style, author: stroke.author, createdAt: stroke.createdAt }))
}

/** Part of segment i..i+1 (as t in [0, 1]) strictly inside the circle, or null. */
function insideSpan(p: Float32Array, i: number, cx: number, cy: number, rSq: number): [number, number] | null {
  const o = i * POINT_STRIDE
  const ax = p[o] - cx, ay = p[o + 1] - cy
  const dx = p[o + POINT_STRIDE] - p[o], dy = p[o + POINT_STRIDE + 1] - p[o + 1]
  const a = dx * dx + dy * dy
  const c = ax * ax + ay * ay - rSq
  if (a < 1e-12) return c < 0 ? [0, 1] : null
  const b = 2 * (ax * dx + ay * dy)
  const disc = b * b - 4 * a * c
  if (disc <= 0) return null
  const root = Math.sqrt(disc)
  const t0 = Math.max(0, (-b - root) / (2 * a)), t1 = Math.min(1, (-b + root) / (2 * a))
  return t0 < t1 ? [t0, t1] : null
}

/** Appends the point at fraction t between point i and i+1 (t = 0 is point i itself). */
function pushPoint(out: number[], p: Float32Array, i: number, t: number): number[] {
  const o = i * POINT_STRIDE
  for (let k = 0; k < POINT_STRIDE; k++) out.push(t === 0 ? p[o + k] : p[o + k] + (p[o + POINT_STRIDE + k] - p[o + k]) * t)
  return out
}
