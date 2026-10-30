import { strokeOutline } from '../core/geometry'
import type { OutlineOptions } from '../core/geometry'
import type { Camera, Stroke, StrokeStyle } from '../core/types'

/** The subset of CanvasRenderingContext2D the renderer uses, so tests can supply a recording fake. */
export interface Context2D {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fill(path: never): void
  fillStyle: unknown
}

export interface CanvasLike {
  width: number
  height: number
  getContext(kind: '2d'): Context2D | null
}

export interface RendererOptions {
  /** Builds a fillable path from a flat outline polygon. In browsers: Path2D. */
  createPath: (outline: number[]) => unknown
  outline?: OutlineOptions
}

export interface SceneStats { drawn: number; ms: number }

/**
 * Two-layer Canvas 2D renderer.
 * - base layer: committed strokes, each drawn from a cached path; redrawn only on camera or removal changes.
 * - live layer: just the stroke being written, cleared and redrawn every frame (cost grows with that stroke only).
 * Committing a stroke draws it onto the base layer without redrawing anything else.
 */
export class CanvasRenderer {
  private readonly base: Context2D
  private readonly live: Context2D
  private readonly paths = new WeakMap<Stroke, unknown>()
  private dpr = 1
  private widthCss = 0
  private heightCss = 0
  pathsBuilt = 0

  constructor(private readonly baseCanvas: CanvasLike, private readonly liveCanvas: CanvasLike, private readonly options: RendererOptions) {
    const base = baseCanvas.getContext('2d'), live = liveCanvas.getContext('2d')
    if (!base || !live) throw new Error('Canvas 2D is not available')
    this.base = base
    this.live = live
  }

  resize(widthCss: number, heightCss: number, dpr: number): void {
    this.widthCss = widthCss
    this.heightCss = heightCss
    this.dpr = dpr
    for (const canvas of [this.baseCanvas, this.liveCanvas]) {
      canvas.width = Math.max(1, Math.round(widthCss * dpr))
      canvas.height = Math.max(1, Math.round(heightCss * dpr))
    }
  }

  /** Redraws the base layer with the given (already culled) strokes, in order. */
  drawScene(strokes: readonly Stroke[], camera: Camera, now: () => number = () => performance.now()): SceneStats {
    const start = now()
    this.clear(this.base)
    this.applyCamera(this.base, camera)
    for (const stroke of strokes) this.fillStroke(this.base, stroke)
    return { drawn: strokes.length, ms: now() - start }
  }

  /** Incremental: adds one committed stroke on top of the base layer. */
  drawStroke(stroke: Stroke, camera: Camera): void {
    this.applyCamera(this.base, camera)
    this.fillStroke(this.base, stroke)
  }

  drawLive(points: ArrayLike<number>, style: StrokeStyle, camera: Camera): void {
    this.clear(this.live)
    if (points.length === 0) return
    this.applyCamera(this.live, camera)
    this.live.fillStyle = style.color
    this.live.fill(this.options.createPath(strokeOutline(points, style.width, this.options.outline)) as never)
  }

  clearLive(): void { this.clear(this.live) }

  private fillStroke(ctx: Context2D, stroke: Stroke) {
    let path = this.paths.get(stroke)
    if (!path) {
      path = this.options.createPath(strokeOutline(stroke.points, stroke.style.width, this.options.outline))
      this.paths.set(stroke, path)
      this.pathsBuilt++
    }
    ctx.fillStyle = stroke.style.color
    ctx.fill(path as never)
  }

  private clear(ctx: Context2D) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, Math.round(this.widthCss * this.dpr), Math.round(this.heightCss * this.dpr))
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
