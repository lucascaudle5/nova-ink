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
  /** Line width (diameter) in page units; constant along the stroke. */
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
  /** Optional group this mark belongs to (a diagram NOVA drew, a problem and its working). Survives moves, resizes and restyles. */
  readonly group?: string
  /** Point bounds padded by half the stroke width. */
  readonly bounds: Bounds
  /** Epoch milliseconds. */
  readonly createdAt: number
}

/**
 * A picture placed on the page, always drawn under the ink. Like strokes, placements are immutable:
 * moving or resizing one replaces it with a new id. `image` names the stored picture, which several
 * placements (and pages) can share; the engine never stores the picture itself.
 */
export interface ImageItem {
  readonly kind: 'image'
  readonly id: string
  readonly author: Author
  readonly image: string
  /** Top-left corner and size in page units of the picture before it is turned. */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Degrees clockwise about the centre of that rectangle, 0 up to (not including) 360. */
  readonly angle: number
  /** Optional group this picture belongs to; see Stroke.group. */
  readonly group?: string
  /** The smallest axis-aligned box around the turned picture (used for culling and hit pre-checks). */
  readonly bounds: Bounds
  readonly createdAt: number
}

/** Anything a page holds, as stored per row. Strokes have no `kind`. */
export type PageItem = Stroke | ImageItem
export const isImage = (item: PageItem): item is ImageItem => (item as ImageItem).kind === 'image'

/** Screen = (page - (x, y)) * z. (x, y) is the page point at the top-left of the view. */
export interface Camera { x: number; y: number; z: number }
