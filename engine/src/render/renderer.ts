import { strokeOutline } from '../core/geometry'
import type { OutlineOptions } from '../core/geometry'
import { DEFAULT_PAPER, displayColor, PAPER_COLORS, patternLayers } from '../core/paper'
import type { Paper } from '../core/paper'
import type { Camera, ImageItem, Stroke, StrokeStyle } from '../core/types'

/** The subset of CanvasRenderingContext2D the renderer uses, so tests can supply a recording fake. */
export interface Context2D {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fill(path: never): void
  drawImage(image: never, dx: number, dy: number, dw: number, dh: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, start: number, end: number): void
  stroke(): void
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  globalAlpha: number
}

export interface CanvasLike {
  width: number
  height: number
  getContext(kind: '2d'): Context2D | null
}

/** paper (pattern, bottom), base (committed ink), live (stroke being written, top); snapshot is offscreen. */
export interface RendererLayers { paper: CanvasLike; base: CanvasLike; live: CanvasLike; snapshot: CanvasLike }

export interface RendererOptions {
  /** Builds a fillable path from a flat outline polygon. In browsers: Path2D. */
  createPath: (outline: number[]) => unknown
  outline?: OutlineOptions
  /** The decoded picture for an image placement (ImageBitmap, canvas, ...), or null while it is not available. */
  imageSource?: (image: string) => unknown
}

export interface SceneStats { drawn: number; ms: number }

/**
 * Layered Canvas 2D renderer.
 * - paper: background color and pattern; cheap, redrawn exactly on every camera change.
 * - base: committed strokes, each drawn from a cached path; redrawn on camera or removal changes.
 * - live: just the stroke being written (or the eraser ring), redrawn every frame.
 * - snapshot: a copy of the base layer taken when a pan/zoom gesture starts. While the gesture
 *   runs, the base layer can show the snapshot moved and scaled instead of redrawing every stroke.
 */
export class CanvasRenderer {
  private readonly ctx: Record<keyof RendererLayers, Context2D>
  private readonly paths = new WeakMap<Stroke, unknown>()
  private readonly colors = new Map<string, string>()
  private dpr = 1
  private widthCss = 0
  private heightCss = 0
  private paperStyle: Paper = DEFAULT_PAPER
  private snapshotCamera: Camera | null = null
  pathsBuilt = 0

  constructor(private readonly layers: RendererLayers, private readonly options: RendererOptions) {
    const get = (canvas: CanvasLike) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D is not available')
      return ctx
    }
    this.ctx = { paper: get(layers.paper), base: get(layers.base), live: get(layers.live), snapshot: get(layers.snapshot) }
  }

  get paper(): Paper { return this.paperStyle }
  /** Changes the paper; callers redraw the paper and base layers afterwards (ink colors may adapt). */
  set paper(paper: Paper) { this.paperStyle = paper; this.colors.clear() }

  /** Camera the snapshot was taken at, or null when there is no usable snapshot. */
  get snapshotAt(): Camera | null { return this.snapshotCamera }

  resize(widthCss: number, heightCss: number, dpr: number): void {
    this.widthCss = widthCss
    this.heightCss = heightCss
    this.dpr = dpr
    for (const canvas of Object.values(this.layers)) {
      canvas.width = Math.max(1, Math.round(widthCss * dpr))
      canvas.height = Math.max(1, Math.round(heightCss * dpr))
    }
    this.snapshotCamera = null
  }

  drawPaper(camera: Camera): void {
    const ctx = this.ctx.paper
    const spec = PAPER_COLORS[this.paperStyle.color]
    const w = this.deviceWidth, h = this.deviceHeight
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.fillStyle = spec.fill
    ctx.fillRect(0, 0, w, h)
    const dots = this.paperStyle.pattern === 'dots'
    for (const layer of patternLayers(this.paperStyle.pattern, camera, this.widthCss, this.heightCss)) {
      ctx.globalAlpha = layer.alpha
      ctx.fillStyle = layer.major || dots ? spec.major : spec.line
      const size = dots ? Math.max(2, Math.round(this.dpr * 2.4)) : Math.max(1, Math.round(this.dpr * (layer.major ? 1 : 0.6)))
      if (dots) {
        for (const y of layer.ys) for (const x of layer.xs) ctx.fillRect(Math.round(x * this.dpr - size / 2), Math.round(y * this.dpr - size / 2), size, size)
        continue
      }
      for (const x of layer.xs) ctx.fillRect(Math.round(x * this.dpr), 0, size, h)
      for (const y of layer.ys) ctx.fillRect(0, Math.round(y * this.dpr), w, size)
    }
    ctx.globalAlpha = 1
  }

  /** Redraws the base layer: the given (already culled) images, then strokes on top, in order. */
  drawScene(strokes: readonly Stroke[], camera: Camera, now: () => number = () => performance.now(), images: readonly ImageItem[] = []): SceneStats {
    const start = now()
    this.clear(this.ctx.base)
    this.applyCamera(this.ctx.base, camera)
    for (const image of images) this.drawImageItem(this.ctx.base, image, camera)
    for (const stroke of strokes) this.fillStroke(this.ctx.base, stroke)
    return { drawn: strokes.length + images.length, ms: now() - start }
  }

  /** Selection frame and resize handle for one placement, on the live layer. */
  drawSelection(image: { x: number; y: number; w: number; h: number }, camera: Camera, handlePx: number): void {
    const live = this.ctx.live
    this.clear(live)
    live.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const x = (image.x - camera.x) * camera.z, y = (image.y - camera.y) * camera.z
    const w = image.w * camera.z, h = image.h * camera.z
    live.globalAlpha = 1
    live.fillStyle = '#1f6feb'
    const t = 1.5
    live.fillRect(x - t, y - t, w + 2 * t, t * 2); live.fillRect(x - t, y + h - t, w + 2 * t, t * 2)
    live.fillRect(x - t, y - t, t * 2, h + 2 * t); live.fillRect(x + w - t, y - t, t * 2, h + 2 * t)
    const s = handlePx
    live.fillStyle = '#ffffff'
    live.fillRect(x + w - s / 2 - 1.5, y + h - s / 2 - 1.5, s + 3, s + 3)
    live.fillStyle = '#1f6feb'
    live.fillRect(x + w - s / 2, y + h - s / 2, s, s)
  }

  private drawImageItem(ctx: Context2D, image: ImageItem, camera: Camera) {
    const source = this.options.imageSource?.(image.image)
    if (source) { ctx.drawImage(source as never, image.x, image.y, image.w, image.h); return }
    // Not loaded (yet): a quiet placeholder of the right size, so the layout never jumps.
    const dark = PAPER_COLORS[this.paperStyle.color].dark
    ctx.fillStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(27,31,36,.06)'
    ctx.fillRect(image.x, image.y, image.w, image.h)
    ctx.fillStyle = dark ? 'rgba(255,255,255,.22)' : 'rgba(27,31,36,.18)'
    const t = 1 / camera.z
    ctx.fillRect(image.x, image.y, image.w, t); ctx.fillRect(image.x, image.y + image.h - t, image.w, t)
    ctx.fillRect(image.x, image.y, t, image.h); ctx.fillRect(image.x + image.w - t, image.y, t, image.h)
  }

  /** Incremental: adds one committed stroke on top of the base layer. */
  drawStroke(stroke: Stroke, camera: Camera): void {
    this.applyCamera(this.ctx.base, camera)
    this.fillStroke(this.ctx.base, stroke)
  }

  /** Copies the base layer, which must currently show the scene at `camera`. */
  takeSnapshot(camera: Camera): void {
    const ctx = this.ctx.snapshot
    this.clear(ctx)
    ctx.drawImage(this.layers.base as never, 0, 0, this.deviceWidth, this.deviceHeight)
    this.snapshotCamera = camera
  }

  dropSnapshot(): void { this.snapshotCamera = null }

  /** Shows the snapshot as it would appear at `camera`. Returns false when there is no snapshot. */
  drawFromSnapshot(camera: Camera): boolean {
    const from = this.snapshotCamera
    if (!from) return false
    const k = camera.z / from.z
    const dx = (from.x - camera.x) * camera.z * this.dpr, dy = (from.y - camera.y) * camera.z * this.dpr
    this.clear(this.ctx.base)
    this.ctx.base.drawImage(this.layers.snapshot as never, dx, dy, this.deviceWidth * k, this.deviceHeight * k)
    return true
  }

  drawLive(points: ArrayLike<number>, style: StrokeStyle, camera: Camera): void {
    const live = this.ctx.live
    this.clear(live)
    if (points.length === 0) return
    this.applyCamera(live, camera)
    live.fillStyle = this.inkColor(style.color)
    live.fill(this.options.createPath(strokeOutline(points, style.width, this.options.outline)) as never)
  }

  /** Eraser outline at a screen position (CSS pixels), on the live layer. */
  drawEraser(x: number, y: number, radiusCss: number): void {
    const live = this.ctx.live
    this.clear(live)
    const dark = PAPER_COLORS[this.paperStyle.color].dark
    live.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    live.beginPath()
    live.arc(x, y, radiusCss, 0, Math.PI * 2)
    live.lineWidth = 1.5
    live.strokeStyle = dark ? 'rgba(255,255,255,.7)' : 'rgba(27,31,36,.55)'
    live.stroke()
  }

  clearLive(): void { this.clear(this.ctx.live) }

  private get deviceWidth() { return Math.round(this.widthCss * this.dpr) }
  private get deviceHeight() { return Math.round(this.heightCss * this.dpr) }

  private inkColor(color: string): string {
    let out = this.colors.get(color)
    if (out === undefined) { out = displayColor(color, this.paperStyle); this.colors.set(color, out) }
    return out
  }

  private fillStroke(ctx: Context2D, stroke: Stroke) {
    let path = this.paths.get(stroke)
    if (!path) {
      path = this.options.createPath(strokeOutline(stroke.points, stroke.style.width, this.options.outline))
      this.paths.set(stroke, path)
      this.pathsBuilt++
    }
    ctx.fillStyle = this.inkColor(stroke.style.color)
    ctx.fill(path as never)
  }

  private clear(ctx: Context2D) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.deviceWidth, this.deviceHeight)
  }

  private applyCamera(ctx: Context2D, camera: Camera) {
    const s = camera.z * this.dpr
    ctx.setTransform(s, 0, 0, s, -camera.x * s, -camera.y * s)
  }
}

export function createPath2D(outline: number[]): Path2D {
  const path = new Path2D()
  if (outline.length < 2) return path
  path.moveTo(outline[0], outline[1])
  for (let i = 2; i < outline.length; i += 2) path.lineTo(outline[i], outline[i + 1])
  path.closePath()
  return path
}
