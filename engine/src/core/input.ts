import { gestureCamera, toPage } from './camera'
import type { GestureFrame } from './camera'
import type { Camera } from './types'

export type PointerKind = 'pen' | 'touch' | 'mouse'
export type Tool = 'pen' | 'eraser'

/** One input sample in screen (CSS pixel) coordinates. `t` is the event timestamp in ms. */
export interface PointerSample { x: number; y: number; pressure: number; t: number }

/** A normalized pointer event. `samples` holds every coalesced sample, oldest first. */
export interface PointerInput {
  phase: 'down' | 'move' | 'up' | 'cancel'
  id: number
  kind: PointerKind
  /** Mouse button for 'down' (0 = primary). */
  button?: number
  samples: PointerSample[]
}

/** A sample converted to page coordinates. */
export interface PageSample { x: number; y: number; pressure: number; t: number }

export interface InputHandlers {
  getCamera(): Camera
  setCamera(camera: Camera): void
  strokeBegin(sample: PageSample): void
  strokeExtend(samples: PageSample[]): void
  /** `cancelled` is true when the system interrupted the pointer; the stroke is still kept. */
  strokeEnd(cancelled: boolean): void
  eraseBegin(): void
  /** Page position and radius in page units. Called at least every radius/2 along fast movements. */
  eraseAt(x: number, y: number, radius: number): void
  eraseEnd(): void
}

export interface InputOptions {
  /** Eraser radius in screen pixels, so it feels the same at every zoom. */
  eraserRadiusPx?: number
}

/**
 * Turns pointer events into ink, erasing and navigation.
 *
 * Rules (tested in test/input.test.ts):
 * - Apple Pencil (pen) and the primary mouse button draw or erase with the current tool.
 * - Fingers never draw. One finger pans; two fingers pan and zoom.
 * - Palm rejection: while the pen is down, new touches are ignored until they lift, and a pen-down
 *   cancels any finger gesture already in progress (usually the palm landing first).
 */
export class InputController {
  tool: Tool = 'pen'
  private inkPointer: number | null = null
  private inkMode: Tool | null = null
  private lastErase: { x: number; y: number } | null = null
  private touches = new Map<number, { x: number; y: number }>()
  private ignored = new Set<number>()
  private gesture: { start: Camera; from: GestureFrame } | null = null
  private readonly eraserRadiusPx: number

  constructor(private readonly handlers: InputHandlers, options: InputOptions = {}) {
    this.eraserRadiusPx = options.eraserRadiusPx ?? 10
  }

  get inking(): boolean { return this.inkPointer !== null }
  get navigating(): boolean { return this.gesture !== null }

  handle(event: PointerInput): void {
    if (event.kind === 'touch') this.handleTouch(event)
    else this.handleInk(event)
  }

  private handleInk(event: PointerInput) {
    const { phase, id, samples } = event
    if (phase === 'down') {
      if (this.inkPointer !== null || (event.kind === 'mouse' && (event.button ?? 0) !== 0) || !samples.length) return
      for (const touchId of this.touches.keys()) this.ignored.add(touchId)
      this.touches.clear()
      this.gesture = null
      this.inkPointer = id
      this.inkMode = this.tool
      if (this.inkMode === 'pen') {
        const [first, ...rest] = samples.map(s => this.toPageSample(s))
        this.handlers.strokeBegin(first)
        if (rest.length) this.handlers.strokeExtend(rest)
      } else {
        this.handlers.eraseBegin()
        this.lastErase = null
        for (const s of samples) this.eraseSample(s)
      }
      return
    }
    if (id !== this.inkPointer) return
    if (samples.length) {
      if (this.inkMode === 'pen') this.handlers.strokeExtend(samples.map(s => this.toPageSample(s)))
      else for (const s of samples) this.eraseSample(s)
    }
    if (phase === 'up' || phase === 'cancel') {
      if (this.inkMode === 'pen') this.handlers.strokeEnd(phase === 'cancel')
      else this.handlers.eraseEnd()
      this.inkPointer = null
      this.inkMode = null
      this.lastErase = null
    }
  }

  private handleTouch(event: PointerInput) {
    const { phase, id, samples } = event
    const last = samples[samples.length - 1]
    if (phase === 'down') {
      if (this.inkPointer !== null) { this.ignored.add(id); return }
      if (!last) return
      this.touches.set(id, { x: last.x, y: last.y })
      this.restartGesture()
      return
    }
    if (this.ignored.has(id)) {
      if (phase === 'up' || phase === 'cancel') this.ignored.delete(id)
      return
    }
    if (!this.touches.has(id)) return
    if (last) this.touches.set(id, { x: last.x, y: last.y })
    if (phase === 'move') {
      if (this.gesture) this.handlers.setCamera(gestureCamera(this.gesture.start, this.gesture.from, this.frame()))
      return
    }
    this.touches.delete(id)
    this.restartGesture()
  }

  /** A finger added or lifted: continue from the current camera with a new baseline, so nothing jumps. */
  private restartGesture() {
    this.gesture = this.touches.size ? { start: this.handlers.getCamera(), from: this.frame() } : null
  }

  private frame(): GestureFrame {
    const points = [...this.touches.values()].slice(0, 2)
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length
    const spread = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0
    return { cx, cy, spread }
  }

  private toPageSample(s: PointerSample): PageSample {
    const p = toPage(this.handlers.getCamera(), s.x, s.y)
    return { x: p.x, y: p.y, pressure: s.pressure, t: s.t }
  }

  private eraseSample(s: PointerSample) {
    const camera = this.handlers.getCamera()
    const p = toPage(camera, s.x, s.y)
    const radius = this.eraserRadiusPx / camera.z
    const from = this.lastErase
    if (from) {
      const steps = Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / (radius / 2))
      for (let k = 1; k < steps; k++) this.handlers.eraseAt(from.x + ((p.x - from.x) * k) / steps, from.y + ((p.y - from.y) * k) / steps, radius)
    }
    this.handlers.eraseAt(p.x, p.y, radius)
    this.lastErase = p
  }
}
