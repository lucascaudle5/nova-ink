import { createImage } from './image'
import type { Placement } from './image'
import { createStroke } from './stroke'
import { POINT_STRIDE } from './types'
import type { Bounds, ImageItem, Stroke, StrokeStyle } from './types'

/**
 * Selecting ink and pictures: lasso hit tests, the frame around a selection, and the single move/resize/turn
 * transform that is applied to every selected item. Pure functions on immutable items; no DOM.
 */

/** Pen widths the transform may produce (page units). */
const MIN_STROKE_WIDTH = 0.3
const MAX_STROKE_WIDTH = 400

// ---- the transform ----

/** p' = to + s * R(angle) * (p - pivot). Angles are degrees clockwise (y points down). */
export interface Similarity { s: number; angle: number; pivot: { x: number; y: number }; to: { x: number; y: number } }

/** The transform that carries the frame `from` onto the frame `to` (same aspect ratio): scale, turn and move together. */
export function similarityBetween(from: Placement, to: Placement): Similarity {
  return {
    s: to.w / from.w,
    angle: to.angle - from.angle,
    pivot: { x: from.x + from.w / 2, y: from.y + from.h / 2 },
    to: { x: to.x + to.w / 2, y: to.y + to.h / 2 },
  }
}

export const isIdentity = (t: Similarity): boolean =>
  Math.abs(t.s - 1) < 1e-9 && Math.abs(((t.angle + 540) % 360) - 180) < 1e-9 && t.pivot.x === t.to.x && t.pivot.y === t.to.y

/** The 2x3 matrix (a, b, c, d, e, f) of the transform, as canvas setTransform takes it: x' = a x + c y + e, y' = b x + d y + f. */
export function similarityMatrix(t: Similarity): [number, number, number, number, number, number] {
  const r = (t.angle * Math.PI) / 180
  const a = t.s * Math.cos(r), b = t.s * Math.sin(r)
  return [a, b, -b, a, t.to.x - (a * t.pivot.x - b * t.pivot.y), t.to.y - (b * t.pivot.x + a * t.pivot.y)]
}

export function applySimilarity(t: Similarity, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = similarityMatrix(t)
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

/** The stroke moved, scaled and turned: a new stroke (new id) with the same ink, author and time; its width scales with it. */
export function transformStroke(stroke: Stroke, t: Similarity): Stroke {
  const [a, b, c, d, e, f] = similarityMatrix(t)
  const points = new Float32Array(stroke.points)
  for (let i = 0; i + 1 < points.length; i += POINT_STRIDE) {
    const x = stroke.points[i], y = stroke.points[i + 1]
    points[i] = a * x + c * y + e
    points[i + 1] = b * x + d * y + f
  }
  const width = Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, Math.round(stroke.style.width * t.s * 100) / 100))
  return createStroke({ points, style: { color: stroke.style.color, width }, author: stroke.author, createdAt: stroke.createdAt })
}

/** Where a picture's placement lands under the transform (no new picture is made). */
export function transformPlacement(image: Placement, t: Similarity): Placement {
  const centre = applySimilarity(t, image.x + image.w / 2, image.y + image.h / 2)
  const w = image.w * t.s, h = image.h * t.s
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, angle: image.angle + t.angle }
}

/** The picture moved, scaled and turned: a new placement (new id) of the same stored picture. */
export function transformImage(image: ImageItem, t: Similarity): ImageItem {
  const p = transformPlacement(image, t)
  return createImage({ image: image.image, author: image.author, ...p, createdAt: image.createdAt })
}

/** The stroke with a new colour and/or width: a new stroke (new id) with the same points. */
export function restyleStroke(stroke: Stroke, style: Partial<StrokeStyle>): Stroke {
  return createStroke({ points: stroke.points, style: { color: style.color ?? stroke.style.color, width: style.width ?? stroke.style.width }, author: stroke.author, createdAt: stroke.createdAt })
}

/** The stroke shifted by (dx, dy): a new stroke (new id). For duplicates. */
export function offsetStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  return transformStroke(stroke, { s: 1, angle: 0, pivot: { x: 0, y: 0 }, to: { x: dx, y: dy } })
}

/** The picture shifted by (dx, dy): a new placement (new id). For duplicates. */
export function offsetImage(image: ImageItem, dx: number, dy: number): ImageItem {
  return transformImage(image, { s: 1, angle: 0, pivot: { x: 0, y: 0 }, to: { x: dx, y: dy } })
}

// ---- the frame around a selection ----

/**
 * The frame drawn around what is selected, and the one dragged by its handles: a lone picture keeps its own turned frame;
 * anything else gets the upright box around everything. Null when nothing is selected.
 */
export function selectionFrame(strokes: readonly Stroke[], images: readonly ImageItem[]): Placement | null {
  if (strokes.length === 0 && images.length === 1) { const { x, y, w, h, angle } = images[0]; return { x, y, w, h, angle } }
  const b = unionBounds([...strokes.map(s => s.bounds), ...images.map(i => i.bounds)])
  return b ? { x: b.minX, y: b.minY, w: Math.max(b.maxX - b.minX, 1), h: Math.max(b.maxY - b.minY, 1), angle: 0 } : null
}

export function unionBounds(list: readonly Bounds[]): Bounds | null {
  if (!list.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of list) { minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY) }
  return { minX, minY, maxX, maxY }
}

/** Whether the page point is inside the (turned) frame, `pad` page units beyond its edges. */
export function frameContains(frame: Placement, x: number, y: number, pad = 0): boolean {
  const a = (frame.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const dx = x - (frame.x + frame.w / 2), dy = y - (frame.y + frame.h / 2)
  return Math.abs(dx * cos + dy * sin) <= frame.w / 2 + pad && Math.abs(-dx * sin + dy * cos) <= frame.h / 2 + pad
}

// ---- the lasso ----

/** A flat [x0, y0, x1, y1, ...] polygon. */
export type Polygon = readonly number[]

/** The four corners of an axis-aligned box, as a polygon (the box selection). */
export function boxPolygon(ax: number, ay: number, bx: number, by: number): number[] {
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by)
  return [minX, minY, maxX, minY, maxX, maxY, minX, maxY]
}

export function polygonBounds(polygon: Polygon): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < polygon.length; i += 2) { minX = Math.min(minX, polygon[i]); maxX = Math.max(maxX, polygon[i]); minY = Math.min(minY, polygon[i + 1]); maxY = Math.max(maxY, polygon[i + 1]) }
  return { minX, minY, maxX, maxY }
}

/** Even-odd rule, so a loop that crosses itself still selects what it encloses. */
export function pointInPolygon(x: number, y: number, polygon: Polygon): boolean {
  let inside = false
  const n = polygon.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[2 * i], yi = polygon[2 * i + 1], xj = polygon[2 * j], yj = polygon[2 * j + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy
  const cross = d1x * d2y - d1y * d2x
  if (cross === 0) return false
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / cross
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / cross
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

const overlaps = (a: Bounds, b: Bounds) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

/** True when the stroke touches or lies inside the polygon: any of its points is inside, or its line crosses the polygon's edge. */
export function strokeTouchesPolygon(stroke: Stroke, polygon: Polygon, polygonBox: Bounds = polygonBounds(polygon)): boolean {
  if (!overlaps(stroke.bounds, polygonBox)) return false
  const p = stroke.points, n = polygon.length / 2
  for (let i = 0; i + 1 < p.length; i += POINT_STRIDE) if (pointInPolygon(p[i], p[i + 1], polygon)) return true
  for (let i = 0; i + POINT_STRIDE + 1 < p.length; i += POINT_STRIDE) {
    const ax = p[i], ay = p[i + 1], bx = p[i + POINT_STRIDE], by = p[i + POINT_STRIDE + 1]
    for (let k = 0, m = n - 1; k < n; m = k++) {
      if (segmentsIntersect(ax, ay, bx, by, polygon[2 * m], polygon[2 * m + 1], polygon[2 * k], polygon[2 * k + 1])) return true
    }
  }
  return false
}

/**
 * Whether a lasso picks a picture: the loop must enclose the picture's middle. (Touching is not enough for pictures: a
 * pasted PDF page sits under everything, and a loop around some writing on it must not grab the whole page.)
 */
export function imagePickedByPolygon(image: ImageItem, polygon: Polygon, polygonBox: Bounds = polygonBounds(polygon)): boolean {
  if (!overlaps(image.bounds, polygonBox)) return false
  return pointInPolygon(image.x + image.w / 2, image.y + image.h / 2, polygon)
}

/** Drops points closer than `minGap` to the one before, and thins to at most `maxPoints`, keeping the last. For a drawn lasso. */
export function simplifyLoop(polygon: Polygon, minGap: number, maxPoints = 400): number[] {
  const out: number[] = []
  for (let i = 0; i + 1 < polygon.length; i += 2) {
    const last = out.length - 2
    if (last >= 0 && Math.hypot(polygon[i] - out[last], polygon[i + 1] - out[last + 1]) < minGap) continue
    out.push(polygon[i], polygon[i + 1])
  }
  if (out.length / 2 > maxPoints) {
    const stride = Math.ceil(out.length / 2 / maxPoints), thin: number[] = []
    for (let i = 0; i < out.length / 2; i += stride) thin.push(out[2 * i], out[2 * i + 1])
    return thin
  }
  return out
}
