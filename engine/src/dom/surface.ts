import { fitBounds, viewportBounds, zoomAt, panBy } from '../core/camera'
import { InkDocument } from '../core/document'
import type { DocumentChange } from '../core/document'
import { strokesHitBy } from '../core/eraser'
import { History } from '../core/history'
import { InputController } from '../core/input'
import type { PointerInput, PointerKind, Tool } from '../core/input'
import { Samples } from '../core/metrics'
import { createStroke } from '../core/stroke'
import type { Camera, Stroke, StrokeStyle } from '../core/types'
import { CanvasRenderer, createPath2D } from '../render/renderer'

export interface SurfaceMetrics {
  /** Pointer event timestamp to the end of the frame that drew it (before compositing; not photon latency). */
  inputToFrameMs: Samples
  /** Main-thread time spent in each animation frame callback. */
  frameMs: Samples
  /** Full base-layer redraws (pan, zoom, erase, undo). */
  sceneMs: Samples
  /** Samples delivered per pen/mouse move event (more than 1 means coalesced events are working). */
  samplesPerEvent: Samples
}

export interface Capabilities {
  coalescedEvents: boolean
  predictedEvents: boolean
  altitudeAngle: boolean
  devicePixelRatio: number
  pointerTypesSeen: string[]
  maxPressureSeen: number
  penSamples: number
}

/**
 * Browser binding for the engine: stacks two canvases in `container`, routes pointer events through
 * InputController and draws with CanvasRenderer once per animation frame. Contains no notebook,
 * storage, ChatGPT or hosting logic.
 */
export class InkSurface {
  readonly doc = new InkDocument()
  readonly history = new History(this.doc)
  readonly metrics: SurfaceMetrics = { inputToFrameMs: new Samples(), frameMs: new Samples(), sceneMs: new Samples(), samplesPerEvent: new Samples() }
  camera: Camera = { x: 0, y: 0, z: 1 }
  style: StrokeStyle = { color: '#1b1f24', width: 2.6 }
  lastDrawnCount = 0

  private readonly baseCanvas: HTMLCanvasElement
  private readonly liveCanvas: HTMLCanvasElement
  private readonly renderer: CanvasRenderer
  private readonly input: InputController
  private readonly observer: ResizeObserver
  private readonly cleanup: Array<() => void> = []
  private readonly listeners = new Set<() => void>()
  private live: number[] | null = null
  private liveStart = 0
  private needsScene = true
  private needsLive = false
  private incremental: Stroke[] = []
  private pendingEventTimes: number[] = []
  private raf: number | null = null
  private widthCss = 1
  private heightCss = 1
  private rect: DOMRect | null = null
  private seen = new Set<string>()
  private maxPressure = 0
  private penSamples = 0

  constructor(private readonly container: HTMLElement) {
    container.classList.add('nova-ink-surface')
    Object.assign(container.style, { position: 'relative', overflow: 'hidden', touchAction: 'none', userSelect: 'none', webkitUserSelect: 'none' })
    container.style.setProperty('-webkit-touch-callout', 'none')
    this.baseCanvas = this.makeCanvas()
    this.liveCanvas = this.makeCanvas()
    this.renderer = new CanvasRenderer(this.baseCanvas, this.liveCanvas, { createPath: createPath2D })
    this.input = new InputController({
      getCamera: () => this.camera,
      setCamera: camera => this.setCamera(camera),
      strokeBegin: s => { this.liveStart = s.t; this.live = [s.x, s.y, s.pressure, 0]; this.needsLive = true },
      strokeExtend: samples => {
        if (!this.live) return
        let lastT = this.live[this.live.length - 1]
        for (const s of samples) { lastT = Math.max(lastT, s.t - this.liveStart); this.live.push(s.x, s.y, s.pressure, lastT) }
        this.needsLive = true
      },
      strokeEnd: () => {
        const points = this.live
        this.live = null
        this.needsLive = true
        if (points?.length) this.history.addStroke(createStroke({ points, style: this.style }))
        this.schedule()
      },
      eraseBegin: () => this.history.beginGroup(),
      eraseAt: (x, y, radius) => {
        const hits = strokesHitBy(this.doc, x, y, radius)
        if (hits.length) this.history.erase(hits.map(s => s.id))
      },
      eraseEnd: () => this.history.endGroup(),
    })
    this.doc.onChange(change => this.onDocumentChange(change))

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      container.addEventListener(type, fn as EventListener, opts)
      this.cleanup.push(() => container.removeEventListener(type, fn as EventListener, opts))
    }
    on('pointerdown', e => this.onPointer('down', e), { passive: false })
    on('pointermove', e => this.onPointer('move', e), { passive: false })
    on('pointerup', e => this.onPointer('up', e), { passive: false })
    on('pointercancel', e => this.onPointer('cancel', e), { passive: false })
    on('wheel', e => this.onWheel(e), { passive: false })
    on('contextmenu', e => e.preventDefault())
    // Safari's own pinch-to-zoom of the page.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) on(type as keyof HTMLElementEventMap, e => e.preventDefault(), { passive: false })
    // Stops iOS text selection / magnifier on long press with a finger.
    on('touchstart', e => { if (e.touches.length > 0) e.preventDefault() }, { passive: false })

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
  }

  get tool(): Tool { return this.input.tool }
  setTool(tool: Tool): void { this.input.tool = tool; this.notify() }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  undo(): boolean { const done = this.history.undo(); this.notify(); return done }
  redo(): boolean { const done = this.history.redo(); this.notify(); return done }

  /** Replaces the page contents. Not undoable. */
  load(strokes: readonly Stroke[]): void {
    this.doc.load(strokes)
    this.history.clear()
    this.notify()
  }

  setCamera(camera: Camera): void {
    this.camera = camera
    this.needsScene = true
    this.schedule()
    this.notify()
  }

  fitToContent(): void {
    const bounds = this.doc.contentBounds()
    this.setCamera(bounds ? fitBounds(bounds, this.widthCss, this.heightCss) : { x: 0, y: 0, z: 1 })
  }

  capabilities(): Capabilities {
    const proto = typeof PointerEvent !== 'undefined' ? PointerEvent.prototype : {}
    return {
      coalescedEvents: 'getCoalescedEvents' in proto,
      predictedEvents: 'getPredictedEvents' in proto,
      altitudeAngle: 'altitudeAngle' in proto,
      devicePixelRatio: window.devicePixelRatio || 1,
      pointerTypesSeen: [...this.seen],
      maxPressureSeen: this.maxPressure,
      penSamples: this.penSamples,
    }
  }

  /**
   * Pans by `stepPx` per frame for `frames` animation frames and records the interval between frames.
   * Intervals above the display's refresh period (8.3 ms at 120 Hz, 16.7 ms at 60 Hz) are dropped frames.
   * No pixel readback is used: in Chrome, readbacks can move a canvas to software rendering.
   */
  benchmarkPan(frames = 90, stepPx = 6): Promise<{ intervals: Samples; drawMs: Samples; drawn: number }> {
    const intervals = new Samples(frames), drawMs = new Samples(frames)
    const start = this.camera
    let previous: number | null = null, i = 0, drawn = 0
    return new Promise(resolve => {
      const step = (time: number) => {
        if (previous !== null) intervals.push(time - previous)
        previous = time
        if (i++ >= frames) {
          this.setCamera(start)
          resolve({ intervals, drawMs, drawn })
          return
        }
        const direction = i <= frames / 2 ? 1 : -1
        this.camera = panBy(this.camera, -stepPx * direction, 0)
        const visible = this.doc.query(viewportBounds(this.camera, this.widthCss, this.heightCss))
        drawn = Math.max(drawn, visible.length)
        drawMs.push(this.renderer.drawScene(visible, this.camera).ms)
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    for (const fn of this.cleanup) fn()
    this.baseCanvas.remove()
    this.liveCanvas.remove()
    this.listeners.clear()
  }

  private makeCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', pointerEvents: 'none' })
    this.container.appendChild(canvas)
    return canvas
  }

  private resize() {
    const rect = this.container.getBoundingClientRect()
    this.rect = rect
    this.widthCss = Math.max(1, rect.width)
    this.heightCss = Math.max(1, rect.height)
    this.renderer.resize(this.widthCss, this.heightCss, window.devicePixelRatio || 1)
    this.needsScene = true
    this.needsLive = true
    this.schedule()
  }

  private onPointer(phase: PointerInput['phase'], e: PointerEvent) {
    e.preventDefault()
    const kind: PointerKind = e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse'
    this.seen.add(e.pointerType || 'unknown')
    if (phase === 'down') {
      this.rect = this.container.getBoundingClientRect()
      try { this.container.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    }
    const rect = this.rect ?? this.container.getBoundingClientRect()
    const events = phase === 'move' && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const source = events.length ? events : [e]
    const samples = source.map(ev => ({
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
      pressure: kind === 'mouse' ? (ev.pressure || 0.5) : ev.pressure,
      t: ev.timeStamp,
    }))
    if (kind === 'pen') {
      this.penSamples += samples.length
      for (const s of samples) if (s.pressure > this.maxPressure) this.maxPressure = s.pressure
    }
    const wasInking = this.input.inking
    this.input.handle({ phase, id: e.pointerId, kind, button: e.button, samples })
    if (kind !== 'touch' && (wasInking || this.input.inking)) {
      if (phase === 'move') this.metrics.samplesPerEvent.push(samples.length)
      this.pendingEventTimes.push(e.timeStamp)
      this.schedule()
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault()
    const rect = this.container.getBoundingClientRect()
    const scale = e.deltaMode === 1 ? 16 : 1
    if (e.ctrlKey || e.metaKey) this.setCamera(zoomAt(this.camera, e.clientX - rect.left, e.clientY - rect.top, this.camera.z * Math.exp(-e.deltaY * scale * 0.01)))
    else this.setCamera(panBy(this.camera, -e.deltaX * scale, -e.deltaY * scale))
  }

  private onDocumentChange(change: DocumentChange) {
    const appended = !change.reset && !change.removed.length && change.added.every(p => p.index >= this.doc.size - change.added.length)
    if (appended && !this.needsScene) this.incremental.push(...change.added.map(p => p.stroke))
    else { this.needsScene = true; this.incremental = [] }
    this.schedule()
    this.notify()
  }

  private schedule() {
    if (this.raf === null) this.raf = requestAnimationFrame(() => this.frame())
  }

  private frame() {
    this.raf = null
    const start = performance.now()
    if (this.needsScene) {
      const visible = this.doc.query(viewportBounds(this.camera, this.widthCss, this.heightCss))
      this.metrics.sceneMs.push(this.renderer.drawScene(visible, this.camera).ms)
      this.lastDrawnCount = visible.length
      this.needsScene = false
      this.incremental = []
    } else if (this.incremental.length) {
      for (const stroke of this.incremental) this.renderer.drawStroke(stroke, this.camera)
      this.lastDrawnCount += this.incremental.length
      this.incremental = []
    }
    if (this.needsLive) {
      if (this.live) this.renderer.drawLive(this.live, this.style, this.camera)
      else this.renderer.clearLive()
      this.needsLive = false
    }
    const end = performance.now()
    this.metrics.frameMs.push(end - start)
    for (const t of this.pendingEventTimes) this.metrics.inputToFrameMs.push(end - t)
    this.pendingEventTimes = []
  }

  private notify() { for (const listener of this.listeners) listener() }
}
