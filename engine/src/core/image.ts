import { newId } from './stroke'
import type { Author, Bounds, ImageItem } from './types'

/** Smallest and largest side of a placement in page units (5% to 3200% zoom keeps both usable). */
export const MIN_IMAGE_SIDE = 8
export const MAX_IMAGE_SIDE = 100_000
export const IMAGE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Where a picture sits: an unrotated rectangle turned `angle` degrees clockwise about its centre. */
export interface Placement { x: number; y: number; w: number; h: number; angle: number }

export interface ImageInput {
  image: string
  x: number
  y: number
  w: number
  h: number
  /** Degrees clockwise about the centre of the x, y, w, h rectangle; any value, stored as 0 to under 360. */
  angle?: number
  id?: string
  author?: Author
  createdAt?: number
  group?: string
}

/** An angle in degrees as 0 (inclusive) to 360 (exclusive), kept to 0.01°. */
export function normalizeAngle(angle: number): number {
  const turned = Math.round((((angle % 360) + 360) % 360) * 100) / 100
  return turned >= 360 ? 0 : turned
}

/** The smallest axis-aligned box around a rectangle turned `angle` degrees about its centre. */
export function turnedBounds(x: number, y: number, w: number, h: number, angle: number): Bounds {
  const a = (angle * Math.PI) / 180
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a))
  const bw = w * c + h * s, bh = w * s + h * c
  const cx = x + w / 2, cy = y + h / 2
  return { minX: cx - bw / 2, minY: cy - bh / 2, maxX: cx + bw / 2, maxY: cy + bh / 2 }
}

export function createImage(input: ImageInput): ImageItem {
  const { x, y, w, h } = input
  const angleIn = input.angle ?? 0
  if (![x, y, w, h, angleIn].every(Number.isFinite)) throw new Error('Image position, size and angle must be finite')
  if (w < MIN_IMAGE_SIDE || h < MIN_IMAGE_SIDE || w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) throw new Error('Image size out of range')
  if (!IMAGE_ID.test(input.image)) throw new Error('Invalid image reference')
  const angle = normalizeAngle(angleIn)
  return Object.freeze({
    kind: 'image' as const,
    id: input.id ?? newId(),
    author: input.author ?? 'student',
    image: input.image,
    x, y, w, h, angle,
    bounds: Object.freeze(turnedBounds(x, y, w, h, angle)),
    createdAt: input.createdAt ?? Date.now(),
    ...(input.group ? { group: input.group } : {}),
  })
}

/** The same picture at a new place (any of x, y, w, h, angle may change): a new placement with a new id. */
export function placeImage(item: ImageItem, place: Partial<Placement>): ImageItem {
  // Only the placement is taken from place: it may be a whole picture (a drag keeps one), and its id must not carry over.
  const { x, y, w, h, angle } = { x: item.x, y: item.y, w: item.w, h: item.h, angle: item.angle, ...place }
  return createImage({ image: item.image, author: item.author, x, y, w, h, angle, group: item.group })
}

/** The picture turned `degrees` (default a quarter, clockwise) about its centre: a new placement. */
export function rotateImage(item: ImageItem, degrees = 90): ImageItem {
  return placeImage(item, { angle: item.angle + degrees })
}

/** A point given relative to the picture's centre in its own (turned) frame, as a page point. */
export function localToPage(item: Placement, lx: number, ly: number): { x: number; y: number } {
  const a = (item.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  return { x: item.x + item.w / 2 + lx * cos - ly * sin, y: item.y + item.h / 2 + lx * sin + ly * cos }
}

/** A page point in the picture's own (turned) frame, relative to its centre. */
export function pageToLocal(item: Placement, x: number, y: number): { x: number; y: number } {
  const a = (item.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const dx = x - (item.x + item.w / 2), dy = y - (item.y + item.h / 2)
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos }
}

/** Page point of the bottom-right resize handle. */
export function resizeHandle(item: Placement): { x: number; y: number } { return localToPage(item, item.w / 2, item.h / 2) }

/** Page point of the rotation handle: straight out from the middle of the top edge by `offset` page units. */
export function rotateHandle(item: Placement, offset: number): { x: number; y: number } { return localToPage(item, 0, -item.h / 2 - offset) }

/** Topmost placement containing the page point (later placements are on top); turned pictures are tested in their own frame. */
export function imageAt(images: readonly ImageItem[], x: number, y: number): ImageItem | null {
  for (let i = images.length - 1; i >= 0; i--) {
    const item = images[i]
    const b = item.bounds
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue
    const p = pageToLocal(item, x, y)
    if (Math.abs(p.x) <= item.w / 2 && Math.abs(p.y) <= item.h / 2) return item
  }
  return null
}

/** Within this many degrees of a multiple of 45° a turning picture snaps to it. */
export const SNAP_DEGREES = 3

/** `angle` snapped to the nearest multiple of 45° when within SNAP_DEGREES of it, else just normalized. */
export function snapAngle(angle: number, tolerance = SNAP_DEGREES): number {
  const n = normalizeAngle(angle)
  const nearest = Math.round(n / 45) * 45
  return Math.abs(n - nearest) <= tolerance ? normalizeAngle(nearest) : n
}

export type DragMode = 'move' | 'resize' | 'rotate'

/**
 * Where a drag from page point `from` to `to` puts `item`.
 * - move: offsets it.
 * - resize: drags the bottom-right corner (in the picture's own frame) with the top-left corner fixed, keeping the aspect ratio.
 * - rotate: turns it about its centre by the angle the pointer sweeps around the centre, snapping near multiples of 45°.
 */
export function dragPlacement(item: Placement, mode: DragMode, from: { x: number; y: number }, to: { x: number; y: number }): Placement {
  const dx = to.x - from.x, dy = to.y - from.y
  if (mode === 'move') return { ...item, x: item.x + dx, y: item.y + dy }
  if (mode === 'rotate') {
    const cx = item.x + item.w / 2, cy = item.y + item.h / 2
    const swept = Math.atan2(to.y - cy, to.x - cx) - Math.atan2(from.y - cy, from.x - cx)
    return { ...item, angle: snapAngle(item.angle + (swept * 180) / Math.PI) }
  }
  const a = (item.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const ldx = dx * cos + dy * sin, ldy = -dx * sin + dy * cos
  const aspect = item.h / item.w
  // Follow whichever axis moved further, relative to the size, so the corner tracks the pointer.
  const scale = Math.max((item.w + ldx) / item.w, (item.h + ldy) / item.h)
  const w = Math.min(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE / aspect, Math.max(MIN_IMAGE_SIDE, MIN_IMAGE_SIDE / aspect, item.w * scale))
  const h = w * aspect
  // The top-left corner (in the picture's own frame) stays where it was on the page.
  const corner = localToPage(item, -item.w / 2, -item.h / 2)
  const cx = corner.x + (w / 2) * cos - (h / 2) * sin, cy = corner.y + (w / 2) * sin + (h / 2) * cos
  return { x: cx - w / 2, y: cy - h / 2, w, h, angle: item.angle }
}

/** A size that fits `w` x `h` inside `maxW` x `maxH`, keeping its aspect ratio and never enlarging. */
export function fitSize(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(1, maxW / w, maxH / h)
  return { w: Math.max(MIN_IMAGE_SIDE, w * k), h: Math.max(MIN_IMAGE_SIDE, h * k) }
}
