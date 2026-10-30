import { distanceToSegmentSq } from './geometry'
import type { InkDocument } from './document'
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

/** Whole-stroke eraser hit test (Apple Notes "object eraser" semantics). */
export function strokesHitBy(doc: InkDocument, x: number, y: number, radius: number): Stroke[] {
  return doc.query({ minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius })
    .filter(stroke => strokeHit(stroke, x, y, radius))
}
