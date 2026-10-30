import { pointBounds, pointCount } from './geometry'
import { POINT_STRIDE } from './types'
import type { Author, Stroke, StrokeStyle } from './types'

export const MAX_POINTS_PER_STROKE = 100_000

/** Random id that also works outside secure contexts (crypto.randomUUID needs HTTPS; iPad-on-LAN testing is HTTP). */
export function newId(): string {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export interface StrokeInput {
  points: ArrayLike<number>
  style: StrokeStyle
  id?: string
  author?: Author
  createdAt?: number
}

/** Freezes input into an immutable stroke with a private copy of its points. */
export function createStroke(input: StrokeInput): Stroke {
  const n = pointCount(input.points)
  if (n < 1) throw new Error('A stroke needs at least one point')
  if (n > MAX_POINTS_PER_STROKE) throw new Error(`A stroke may have at most ${MAX_POINTS_PER_STROKE} points`)
  const points = new Float32Array(n * POINT_STRIDE)
  for (let i = 0; i < points.length; i++) points[i] = input.points[i]
  const style = Object.freeze({ color: input.style.color, width: input.style.width })
  return Object.freeze({
    id: input.id ?? newId(),
    author: input.author ?? 'student',
    style,
    points,
    bounds: Object.freeze(pointBounds(points, style.width / 2 + 1)),
    createdAt: input.createdAt ?? Date.now(),
  })
}
