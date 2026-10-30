import { clamp } from './geometry'
import type { Bounds, Camera } from './types'

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

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

/** Camera that fits `content` inside the view with a margin in screen pixels. */
export function fitBounds(content: Bounds, widthCss: number, heightCss: number, margin = 24): Camera {
  const w = Math.max(1, content.maxX - content.minX), h = Math.max(1, content.maxY - content.minY)
  const z = clamp(Math.min((widthCss - margin * 2) / w, (heightCss - margin * 2) / h), MIN_ZOOM, MAX_ZOOM)
  return { x: content.minX - (widthCss / z - w) / 2, y: content.minY - (heightCss / z - h) / 2, z }
}
