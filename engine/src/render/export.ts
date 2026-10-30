import { viewportBounds } from '../core/camera'
import type { InkDocument } from '../core/document'
import type { Paper } from '../core/paper'
import type { Bounds, Camera, ImageItem, Stroke } from '../core/types'
import { CanvasRenderer } from './renderer'
import type { CanvasLike, RendererOptions } from './renderer'

/** Longest side, in pixels, of an exported view. */
export const EXPORT_MAX_SIDE = 1600
/** Longest side, in pixels, of an exported whole page. */
export const PAGE_EXPORT_MAX_SIDE = 4000
/** Page units of paper left around the content of an exported whole page. */
export const PAGE_EXPORT_MARGIN = 32
/** Never export at more than this many pixels per CSS pixel (a small view is not blown up past retina). */
const EXPORT_MAX_SCALE = 2

export interface ViewExport {
  /** The finished picture: paper, pictures and ink, with no selection frame or eraser ring. */
  canvas: CanvasLike
  /** Strokes and pictures that intersect the view. */
  strokes: number
  images: number
}

/** Pixels per CSS pixel for a view of the given size, so its long side is at most `maxSide`. */
export function exportScale(widthCss: number, heightCss: number, maxSide = EXPORT_MAX_SIDE): number {
  return Math.min(EXPORT_MAX_SCALE, maxSide / Math.max(widthCss, heightCss, 1))
}

/** What a view would contain, without drawing it. */
export function countInView(doc: InkDocument, camera: Camera, widthCss: number, heightCss: number): { strokes: number; images: number } {
  const view = viewportBounds(camera, widthCss, heightCss)
  return { strokes: doc.query(view).length, images: doc.queryImages(view).length }
}

type Canvases = { makeCanvas: () => CanvasLike }

/**
 * Draws the given strokes and pictures (already chosen, in stacking order) seen through `camera` (`widthCss` x
 * `heightCss`) over the paper, on fresh canvases.
 */
function compose(args: { paper: Paper; camera: Camera; widthCss: number; heightCss: number; options: RendererOptions; maxSide?: number; strokes: readonly Stroke[]; images: readonly ImageItem[] } & Canvases): ViewExport {
  const { paper, camera, widthCss, heightCss, strokes, images } = args
  const paperLayer = args.makeCanvas(), base = args.makeCanvas(), live = args.makeCanvas(), snapshot = args.makeCanvas()
  const renderer = new CanvasRenderer({ paper: paperLayer, base, live, snapshot }, args.options)
  renderer.resize(widthCss, heightCss, exportScale(widthCss, heightCss, args.maxSide))
  // An export never uses the live or snapshot layers; do not hold their memory (a large page is several megapixels).
  live.width = live.height = snapshot.width = snapshot.height = 1
  renderer.paper = paper
  renderer.drawPaper(camera)
  renderer.drawScene(strokes, camera, undefined, images)
  // The paper canvas becomes the result: ink and pictures are laid over the paper.
  const out = paperLayer.getContext('2d')!
  out.setTransform(1, 0, 0, 1, 0, 0)
  out.globalAlpha = 1
  out.drawImage(base as never, 0, 0, paperLayer.width, paperLayer.height)
  base.width = base.height = 1
  return { canvas: paperLayer, strokes: strokes.length, images: images.length }
}
/**
 * Draws the current view (what the student sees) onto fresh throwaway canvases. The live layer is
 * never drawn, so nothing but the page itself appears. `makeCanvas` supplies blank canvases; the
 * page document and the surface's own layers are not touched.
 */
export function composeView(args: {
  doc: InkDocument
  paper: Paper
  camera: Camera
  widthCss: number
  heightCss: number
  options: RendererOptions
  makeCanvas: () => CanvasLike
  maxSide?: number
}): ViewExport {
  const view = viewportBounds(args.camera, args.widthCss, args.heightCss)
  return compose({ ...args, strokes: args.doc.query(view), images: args.doc.queryImages(view) })
}
/** The area a whole-page export covers: everything on the page plus a margin, or null when the page is empty. */
export function pageArea(doc: InkDocument, margin = PAGE_EXPORT_MARGIN): Bounds | null {
  const b = doc.contentBounds()
  return b ? { minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin } : null
}

export interface RegionExport extends ViewExport {
  /** The area drawn, in page units. */
  area: Bounds
}
export type PageExport = RegionExport

/**
 * Draws one rectangle of the page (a snip) over the paper onto fresh throwaway canvases, wherever the camera is: everything
 * on the page that touches it, or only `only` (a selection) when given. Long side at most `maxSide` pixels (4000 by default).
 */
export function composeRegion(args: {
  doc: InkDocument
  paper: Paper
  area: Bounds
  /** Draw only these (a selection) instead of everything in the area. */
  only?: { strokes: readonly Stroke[]; images: readonly ImageItem[] }
  options: RendererOptions
  makeCanvas: () => CanvasLike
  maxSide?: number
}): RegionExport {
  const { area } = args
  const widthCss = Math.max(1, area.maxX - area.minX), heightCss = Math.max(1, area.maxY - area.minY)
  const strokes = args.only ? args.only.strokes : args.doc.query(area)
  const images = args.only ? args.only.images : args.doc.queryImages(area)
  const result = compose({ ...args, strokes, images, camera: { x: area.minX, y: area.minY, z: 1 }, widthCss, heightCss, maxSide: args.maxSide ?? PAGE_EXPORT_MAX_SIDE })
  return { ...result, area }
}

/**
 * Draws the whole page (every stroke and picture, fitted with a margin, over the paper) onto fresh throwaway canvases,
 * wherever the student's camera is. Null when the page is empty.
 */
export function composePage(args: {
  doc: InkDocument
  paper: Paper
  options: RendererOptions
  makeCanvas: () => CanvasLike
  maxSide?: number
}): PageExport | null {
  const area = pageArea(args.doc)
  return area ? composeRegion({ ...args, area }) : null
}