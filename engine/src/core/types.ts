/**
 * Core types. Everything under src/core is DOM-free so it runs in Node tests, workers and the browser.
 * Page coordinates are CSS pixels at zoom 1.
 */

/** Stored values per input point: x, y, pressure (0..1), milliseconds since the stroke began. */
export const POINT_STRIDE = 4

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export interface StrokeStyle {
  /** #rrggbb */
  color: string
  /** Nominal diameter in page units at full pressure. */
  width: number
}

/** Who made a mark. AI marks must stay distinguishable from student work (product decision 10). */
export type Author = 'student' | 'ai'

/**
 * A stroke keeps the raw input points, not a smoothed or simplified version, so rendering can
 * improve later without rewriting saved work. Strokes are immutable once committed.
 */
export interface Stroke {
  readonly id: string
  readonly author: Author
  readonly style: StrokeStyle
  /** Flat [x, y, pressure, dt, x, y, ...]. Float32 keeps 3,000 strokes near 7 MB; see docs for precision. */
  readonly points: Float32Array
  /** Point bounds padded by half the stroke width. */
  readonly bounds: Bounds
  /** Epoch milliseconds. */
  readonly createdAt: number
}

/** Screen = (page - (x, y)) * z. (x, y) is the page point at the top-left of the view. */
export interface Camera { x: number; y: number; z: number }
