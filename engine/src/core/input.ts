import { gestureCamera, toPage } from './camera'
import type { GestureFrame } from './camera'
import type { Camera } from './types'

export type PointerKind = 'pen' | 'touch' | 'mouse'
/** 'select' picks, moves, resizes and turns images with the pen or mouse, and with a finger that lands on a picture. */
export type Tool = 'pen' | 'eraser' | 'select'

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
  /** Select tool. Positions are page coordinates; `screen` is the same point in CSS pixels (for handle hits). */
  selectBegin?(sample: PageSample, screen: PointerSample, kind: PointerKind): void
  selectMove?(sample: PageSample): void
  selectEnd?(cancelled: boolean): void
  /**
   * Select tool, finger down with no other finger down: true when the finger landed on a picture or one of its handles,
   * so it drags the picture (selectBegin/selectMove/selectEnd) instead of panning the page.
   */
  touchGrab?(sample: PageSample, screen: PointerSample): boolean
  /** Quick two-finger tap. */
  undo?(): void
  /** Quick three-finger tap. */
  redo?(): void
}

export interface InputOptions {
  /** Eraser radius in screen pixels, so it feels the same at every zoom. */
  eraserRadiusPx?: number
}

/** A finger tap must lift within this time and move less than TAP_SLOP_PX to count. */
export const TAP_MS = 300
export const TAP_SLOP_PX = 12
/** Touches starting this soon after the pen lifts are treated as the palm, never as a tap. */
export const PEN_QUIET_MS = 400

/**
 * Turns pointer events into ink, erasing and navigation.
 *
 * Rules (tested in test/input.test.ts):
 * - Apple Pencil (pen) and the primary mouse button draw or erase with the current tool.
 * - Fingers never draw. One finger pans; two fingers pan and zoom.
 * - Palm rejection: while the pen is down, new touches are ignored until they lift, and a pen-down
 *   cancels any finger gesture already in progress (usually the palm landing first).
 * - A quick two-finger tap undoes and a three-finger tap redoes (Goodnotes-style), unless the pen
 *   was used during it or just before it; the tap's tiny camera movement is put back.
 */
export class InputController {
  tool: Tool = 'pen'
  /** Pen and mouse do nothing (fingers still navigate), e.g. while another device edits the page. */
  readOnly = false
  /** Eraser radius in screen pixels, so it feels the same at every zoom. */
  eraserRadiusPx: number
  private inkPointer: number | null = null
  private inkMode: Tool | null = null
  private inkKind: PointerKind | null = null
  /** A finger dragging a picture (select tool), or null. */
  private grab: number | null = null
  private grabT = 0
  private lastErase: { x: number; y: number } | null = null
  private touches = new Map<number, { x: number; y: number }>()
  private ignored = new Set<number>()
  private gesture: { start: Camera; from: GestureFrame } | null = null
  private tap: { t: number; camera: Camera; fingers: number; moved: boolean; starts: Map<number, { x: number; y: number }> } | null = null
  private penUpAt = -Infinity
  private lastInkT = -Infinity

  constructor(private readonly handlers: InputHandlers, options: InputOptions = {}) {
    this.eraserRadiusPx = options.eraserRadiusPx ?? 10
  }

  get inking(): boolean { return this.inkPointer !== null }
  get navigating(): boolean { return this.gesture !== null }

  /**
   * Drops everything in progress (a stroke, an erase, a picture drag, fingers) as cancelled. For when the page loses
   * its pointers without telling us (a lost capture, the app going to the background), so input can never stay wedged.
   */
  cancelAll(): void {
    const mode = this.inkMode, grabbed = this.grab !== null
    const active = this.inkPointer !== null
    this.inkPointer = null
    this.inkMode = null
    this.inkKind = null
    this.grab = null
    this.lastErase = null
    this.touches.clear()
    this.ignored.clear()
    this.gesture = null
    this.tap = null
    if (active) this.endInk(mode, true)
    else if (grabbed) this.handlers.selectEnd?.(true)
  }

  private endInk(mode: Tool | null, cancelled: boolean) {
    if (mode === 'pen') this.handlers.strokeEnd(cancelled)
    else if (mode === 'select') this.handlers.selectEnd?.(cancelled)
    else if (mode) this.handlers.eraseEnd()
  }

  handle(event: PointerInput): void {
    if (event.kind === 'touch') this.handleTouch(event)
    else this.handleInk(event)
  }

  private handleInk(event: PointerInput) {
    const { phase, id, samples } = event
    if (samples.length && (phase === 'down' ? this.inkPointer === null : id === this.inkPointer)) this.lastInkT = samples[samples.length - 1].t
    if (phase === 'down') {
      // A second pen or mouse pointer cannot start while the first is down, so the first one must have been lost.
      if (this.inkPointer !== null && this.inkKind === event.kind && id !== this.inkPointer) this.cancelAll()
      if (this.readOnly || this.inkPointer !== null || (event.kind === 'mouse' && (event.button ?? 0) !== 0) || !samples.length) return
      if (this.grab !== null) { const lost = this.grab; this.grab = null; this.ignored.add(lost); this.handlers.selectEnd?.(true) }
      for (const touchId of this.touches.keys()) this.ignored.add(touchId)
      this.touches.clear()
      this.gesture = null
      this.tap = null
      this.inkPointer = id
      this.inkKind = event.kind
      this.inkMode = this.tool
      if (this.inkMode === 'pen') {
        const [first, ...rest] = samples.map(s => this.toPageSample(s))
        this.handlers.strokeBegin(first)
        if (rest.length) this.handlers.strokeExtend(rest)
      } else if (this.inkMode === 'select') {
        this.handlers.selectBegin?.(this.toPageSample(samples[0]), samples[0], event.kind)
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
      else if (this.inkMode === 'select') this.handlers.selectMove?.(this.toPageSample(samples[samples.length - 1]))
      else for (const s of samples) this.eraseSample(s)
    }
    if (phase === 'up' || phase === 'cancel') {
      // Clear our state first: if an end handler throws, input must still recover.
      const mode = this.inkMode
      this.penUpAt = this.lastInkT
      this.inkPointer = null
      this.inkMode = null
      this.inkKind = null
      this.lastErase = null
      this.endInk(mode, phase === 'cancel')
    }
  }

  private handleTouch(event: PointerInput) {
    const { phase, id, samples } = event
    const last = samples[samples.length - 1]
    if (this.grab !== null && id === this.grab) {
      if (last) this.grabT = last.t
      if (last && phase === 'move') this.handlers.selectMove?.(this.toPageSample(last))
      if (phase === 'up' || phase === 'cancel') {
        this.grab = null
        try { if (last && phase === 'up') this.handlers.selectMove?.(this.toPageSample(last)) } finally { this.handlers.selectEnd?.(phase === 'cancel') }
      }
      return
    }
    if (phase === 'down') {
      // A drag whose finger has been silent for seconds was lost (no up/cancel ever arrived); do not let it block everything.
      if (this.grab !== null && last && last.t - this.grabT > 1500) this.cancelAll()
      if (this.inkPointer !== null || this.grab !== null) { this.ignored.add(id); return }
      if (!last) return
      if (!this.touches.size && !this.readOnly && this.tool === 'select') {
        const page = this.toPageSample(last)
        if (this.handlers.touchGrab?.(page, last)) {
          this.grab = id
          this.grabT = last.t
          this.handlers.selectBegin?.(page, last, 'touch')
          return
        }
      }
      if (!this.touches.size) {
        this.tap = last.t - this.penUpAt >= PEN_QUIET_MS
          ? { t: last.t, camera: this.handlers.getCamera(), fingers: 0, moved: false, starts: new Map() }
          : null
      }
      this.touches.set(id, { x: last.x, y: last.y })
      if (this.tap) {
        this.tap.starts.set(id, { x: last.x, y: last.y })
        this.tap.fingers = Math.max(this.tap.fingers, this.touches.size)
      }
      this.restartGesture()
      return
    }
    if (this.ignored.has(id)) {
      if (phase === 'up' || phase === 'cancel') this.ignored.delete(id)
      return
    }
    if (!this.touches.has(id)) return
    if (last) {
      this.touches.set(id, { x: last.x, y: last.y })
      const start = this.tap?.starts.get(id)
      if (start && Math.hypot(last.x - start.x, last.y - start.y) > TAP_SLOP_PX) this.tap!.moved = true
    }
    if (phase === 'move') {
      if (this.gesture) this.handlers.setCamera(gestureCamera(this.gesture.start, this.gesture.from, this.frame()))
      return
    }
    this.touches.delete(id)
    this.restartGesture()
    if (!this.touches.size) this.finishTap(phase === 'up' && last ? last.t : Infinity)
  }

  private finishTap(t: number) {
    const tap = this.tap
    this.tap = null
    if (!tap || tap.moved || t - tap.t > TAP_MS) return
    const action = tap.fingers === 2 ? this.handlers.undo : tap.fingers === 3 ? this.handlers.redo : undefined
    if (!action) return
    this.handlers.setCamera(tap.camera)
    action.call(this.handlers)
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
