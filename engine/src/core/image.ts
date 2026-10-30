import { newId } from './stroke'
import { ROTATIONS } from './types'
import type { Author, ImageItem, Rotation } from './types'

/** Smallest and largest side of a placement in page units (5% to 3200% zoom keeps both usable). */
export const MIN_IMAGE_SIDE = 8
export const MAX_IMAGE_SIDE = 100_000
export const IMAGE_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface ImageInput {
  image: string
  x: number
  y: number
  w: number
  h: number
  rotation?: Rotation
  id?: string
  author?: Author
  createdAt?: number
}

export function createImage(input: ImageInput): ImageItem {
  const { x, y, w, h } = input
  const rotation = input.rotation ?? 0
  if (![x, y, w, h].every(Number.isFinite)) throw new Error('Image position and size must be finite')
  if (w < MIN_IMAGE_SIDE || h < MIN_IMAGE_SIDE || w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) throw new Error('Image size out of range')
  if (!ROTATIONS.includes(rotation)) throw new Error('Image rotation must be 0, 90, 180 or 270')
  if (!IMAGE_ID.test(input.image)) throw new Error('Invalid image reference')
  return Object.freeze({
    kind: 'image' as const,
    id: input.id ?? newId(),
    author: input.author ?? 'student',
    image: input.image,
    x, y, w, h, rotation,
    bounds: Object.freeze({ minX: x, minY: y, maxX: x + w, maxY: y + h }),
    createdAt: input.createdAt ?? Date.now(),
  })
}

/** The same picture at a new position and size, same rotation: a new placement with a new id. */
export function placeImage(item: ImageItem, rect: Rect): ImageItem {
  return createImage({ image: item.image, author: item.author, rotation: item.rotation, ...rect })
}

/** The picture turned a quarter clockwise about its centre (its area swaps width and height): a new placement. */
export function rotateImage(item: ImageItem): ImageItem {
  const cx = item.x + item.w / 2, cy = item.y + item.h / 2
  const rotation = ((item.rotation + 90) % 360) as Rotation
  return createImage({ image: item.image, author: item.author, rotation, x: cx - item.h / 2, y: cy - item.w / 2, w: item.h, h: item.w })
}

/** Topmost placement containing the page point (later placements are on top). */
export function imageAt(images: readonly ImageItem[], x: number, y: number): ImageItem | null {
  for (let i = images.length - 1; i >= 0; i--) {
    const b = images[i].bounds
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return images[i]
  }
  return null
}

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Where a drag from page point `from` to `to` puts `item`. 'move' offsets it; 'resize' drags the
 * bottom-right corner with the top-left fixed, keeping the aspect ratio.
 */
export function dragRect(item: Rect, mode: 'move' | 'resize', from: { x: number; y: number }, to: { x: number; y: number }): Rect {
  const dx = to.x - from.x, dy = to.y - from.y
  if (mode === 'move') return { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h }
  const aspect = item.h / item.w
  // Follow whichever axis moved further, relative to the size, so the corner tracks the pointer.
  const scale = Math.max((item.w + dx) / item.w, (item.h + dy) / item.h)
  const w = Math.min(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE / aspect, Math.max(MIN_IMAGE_SIDE, MIN_IMAGE_SIDE / aspect, item.w * scale))
  return { x: item.x, y: item.y, w, h: w * aspect }
}

/** A size that fits `w` x `h` inside `maxW` x `maxH`, keeping its aspect ratio and never enlarging. */
export function fitSize(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(1, maxW / w, maxH / h)
  return { w: Math.max(MIN_IMAGE_SIDE, w * k), h: Math.max(MIN_IMAGE_SIDE, h * k) }
}
