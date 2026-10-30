import { clamp } from './geometry'
import type { Bounds, Camera } from './types'

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 32
/** Stops for the zoom buttons, as zoom factors (1 = 100%). */
export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const

export interface Point { x: number; y: number }
/** A one- or two-finger gesture reduced to its centroid and finger spread (0 for one finger). */
export interface GestureFrame { cx: number; cy: number; spread: number }

export function toPage(camera: Camera, sx: number, sy: number): Point {
  return { x: sx / camera.z + camera.x, y: sy / camera.z + camera.y }
}

export function toScreen(camera: Camera, px: number, py: number): Point {
  return { x: (px - camera.x) * camera.z, y: (py - camera.y) * camera.z }
}

export function panBy(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return { x: camera.x - dxScreen / camera.z, y: camera.y - dyScreen / camera.z, z: camera.z }
}

/** Zoom keeping the page point under (sx, sy) fixed on screen. */
export function zoomAt(camera: Camera, sx: number, sy: number, zoom: number): Camera {
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
  const anchor = toPage(camera, sx, sy)
  return { x: anchor.x - sx / z, y: anchor.y - sy / z, z }
}

/**
 * Camera for a gesture, always computed from the gesture's start (not frame-to-frame), so it cannot drift.
 * The page point that was under the starting centroid stays under the current centroid.
 */
export function gestureCamera(start: Camera, from: GestureFrame, to: GestureFrame): Camera {
  const scale = from.spread > 1 && to.spread > 1 ? to.spread / from.spread : 1
  const z = clamp(start.z * scale, MIN_ZOOM, MAX_ZOOM)
  const anchor = toPage(start, from.cx, from.cy)
  return { x: anchor.x - to.cx / z, y: anchor.y - to.cy / z, z }
}

export function viewportBounds(camera: Camera, widthCss: number, heightCss: number): Bounds {
  return { minX: camera.x, minY: camera.y, maxX: camera.x + widthCss / camera.z, maxY: camera.y + heightCss / camera.z }
}

/** The next zoom stop above (direction 1) or below (-1) `z`; stays put at the ends of the range. */
export function nextZoomStep(z: number, direction: 1 | -1): number {
  const eps = 1e-6
  if (direction > 0) return ZOOM_STEPS.find(s => s > z * (1 + eps)) ?? MAX_ZOOM
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z * (1 - eps)) return ZOOM_STEPS[i]
  return MIN_ZOOM
}

/**
 * Camera between `a` (t = 0) and `b` (t = 1) for animations: zoom changes geometrically and the
 * view centre moves linearly, so zooming feels even and the view never swings off course.
 */
export function interpolateCamera(a: Camera, b: Camera, t: number, widthCss: number, heightCss: number): Camera {
  const z = a.z * Math.pow(b.z / a.z, t)
  const ax = a.x + widthCss / (2 * a.z), ay = a.y + heightCss / (2 * a.z)
  const bx = b.x + widthCss / (2 * b.z), by = b.y + heightCss / (2 * b.z)
  const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t
  return { x: cx - widthCss / (2 * z), y: cy - heightCss / (2 * z), z }
}

/**
 * Fraction (0..1) of the view at `current` that was visible at `snapshot`: how much of a bitmap
 * taken at `snapshot` can be reused when only the camera moved.
 */
export function viewCoverage(snapshot: Camera, current: Camera, widthCss: number, heightCss: number): number {
  const a = viewportBounds(snapshot, widthCss, heightCss), b = viewportBounds(current, widthCss, heightCss)
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY)
  if (w <= 0 || h <= 0) return 0
  return (w * h) / ((b.maxX - b.minX) * (b.maxY - b.minY))
}

/** Camera that fits `content` inside the view with a margin in screen pixels. */
export function fitBounds(content: Bounds, widthCss: number, heightCss: number, margin = 24): Camera {
  const w = Math.max(1, content.maxX - content.minX), h = Math.max(1, content.maxY - content.minY)
  const z = clamp(Math.min((widthCss - margin * 2) / w, (heightCss - margin * 2) / h), MIN_ZOOM, MAX_ZOOM)
  return { x: content.minX - (widthCss / z - w) / 2, y: content.minY - (heightCss / z - h) / 2, z }
}
