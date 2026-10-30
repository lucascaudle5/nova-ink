import { fitBounds, interpolateCamera, nextZoomStep, panBy, toScreen, viewCoverage, viewportBounds, zoomAt } from '../core/camera'
import { InkDocument } from '../core/document'
import type { DocumentChange } from '../core/document'
import { eraseFromStroke, strokesHitBy } from '../core/eraser'
import { History } from '../core/history'
import { createImage, dragRect, fitSize, imageAt, placeImage, rotateImage } from '../core/image'
import type { Rect } from '../core/image'
import { InputController } from '../core/input'
import type { PointerInput, PointerKind, Tool } from '../core/input'
import { Samples } from '../core/metrics'
import type { Paper } from '../core/paper'
import { createStroke } from '../core/stroke'
import type { Camera, ImageItem, Stroke, StrokeStyle } from '../core/types'
import { CanvasRenderer, createPath2D } from '../render/renderer'

export interface SurfaceMetrics {
  /** Pointer event timestamp to the end of the frame that drew it (before compositing; not photon latency). */
  inputToFrameMs: Samples
  /** Main-thread time spent in each animation frame callback. */
  frameMs: Samples
  /** Full base-layer redraws (pan, zoom, erase, undo). */
  sceneMs: Samples
  /** Frame time while a pan/zoom gesture, wheel scroll or zoom animation runs. */
  gestureFrameMs: Samples
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

/** 'partial' cuts away only what the eraser covers; 'stroke' removes every stroke it touches. */
export type EraserMode = 'partial' | 'stroke'

export interface PanBenchmark {
  intervals: Samples
  drawMs: Samples
  /** Strokes in view at the start (the heaviest full redraw the gesture would otherwise repeat). */
  drawn: number
  /** True when frames were drawn from the gesture snapshot rather than by redrawing strokes. */
  cached: boolean
  /** The exact redraw after the gesture ends. */
  finalRedrawMs: number
}

/**
 * Use the gesture snapshot only on heavy views; light pages stay exact. Script time alone misses
 * the cost (browsers rasterize paths later, off the main thread), so stroke count also decides.
 */
const SNAPSHOT_WHEN_SCENE_MS = 4
const SNAPSHOT_WHEN_STROKES = 300
/** Redraw for real (at most every REFRESH_MS) once the snapshot covers too little or is scaled too far. */
const MIN_COVERAGE = 0.7
const MIN_SCALE = 0.5
const MAX_SCALE = 2.5
const REFRESH_MS = 200
const WHEEL_IDLE_MS = 150
/** Resize handle: drawn this size, and grabbed within this distance (CSS px), at every zoom. */
const HANDLE_PX = 14
const HANDLE_HIT_PX = 26

interface Interaction { sources: Set<string>; snapshot: boolean; stale: boolean; refreshedAt: number }

/**
 * Browser binding for the engine: stacks paper, ink and live canvases in `container`, routes pointer
 * events through InputController and draws with CanvasRenderer once per animation frame. Contains no
 * notebook, storage, ChatGPT or hosting logic.
 */
export class InkSurface {
  readonly doc = new InkDocument()
  readonly history = new History(this.doc)
  readonly metrics: SurfaceMetrics = { inputToFrameMs: new Samples(), frameMs: new Samples(), sceneMs: new Samples(), gestureFrameMs: new Samples(), samplesPerEvent: new Samples() }
  camera: Camera = { x: 0, y: 0, z: 1 }
  style: StrokeStyle = { color: '#1b1f24', width: 2.6 }
  eraserMode: EraserMode = 'partial'
  lastDrawnCount = 0

  private readonly canvases: HTMLCanvasElement[] = []
  private readonly renderer: CanvasRenderer
  private readonly input: InputController
  private readonly observer: ResizeObserver
  private readonly cleanup: Array<() => void> = []
  private readonly listeners = new Set<() => void>()
  private live: number[] | null = null
  private liveStart = 0
  private eraser: { x: number; y: number; r: number } | null = null
  private needsPaper = true
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
  private lastSceneMs = 0
  private interaction: Interaction | null = null
  private wheelTimer: ReturnType<typeof setTimeout> | null = null
  private animation: { raf: number; target: Camera } | null = null
  private imageSource: ((image: string) => CanvasImageSource | null) | null = null
  private selected: string | null = null
  private drag: { mode: 'move' | 'resize'; from: { x: number; y: number }; item: ImageItem; rect: Rect } | null = null

  constructor(private readonly container: HTMLElement) {
    container.classList.add('nova-ink-surface')
    Object.assign(container.style, { position: 'relative', overflow: 'hidden', touchAction: 'none', userSelect: 'none', webkitUserSelect: 'none' })
    container.style.setProperty('-webkit-touch-callout', 'none')
    const paper = this.makeCanvas(), base = this.makeCanvas(), live = this.makeCanvas()
    this.renderer = new CanvasRenderer({ paper, base, live, snapshot: document.createElement('canvas') }, { createPath: createPath2D, imageSource: image => this.imageSource?.(image) ?? null })
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
        // The document change notifies before History drops the redo steps; tell listeners again.
        this.notify()
      },
      eraseBegin: () => this.history.beginGroup(),
      eraseAt: (x, y, radius) => this.eraseAt(x, y, radius),
      eraseEnd: () => {
        this.history.endGroup()
        this.eraser = null
        this.needsLive = true
        this.schedule()
        this.notify()
      },
      selectBegin: (p, screen) => this.selectBegin(p, screen),
      selectMove: p => this.selectMove(p),
      selectEnd: cancelled => this.selectEnd(cancelled),
      undo: () => this.undo(),
      redo: () => this.redo(),
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
  setTool(tool: Tool): void {
    this.input.tool = tool
    if (tool !== 'select') this.select(null)
    this.notify()
  }

  // ---- images ----

  /** The decoded picture for a stored image name, or null while it is not available (a placeholder is drawn). */
  setImageSource(source: (image: string) => CanvasImageSource | null): void { this.imageSource = source; this.invalidateScene() }
  /** Call when pictures finish loading. */
  imagesChanged(): void { this.invalidateScene() }

  get selectedImage(): ImageItem | null { return (this.selected && this.doc.getImage(this.selected)) || null }

  /** Places a stored picture of `w` x `h` pixels in the middle of the view (at most 60% of it) and selects it. */
  insertImage(image: string, w: number, h: number): ImageItem | null {
    if (this.readOnly) return null
    const z = this.camera.z
    const size = fitSize(w, h, (this.widthCss * 0.6) / z, (this.heightCss * 0.6) / z)
    const cx = this.camera.x + this.widthCss / 2 / z, cy = this.camera.y + this.heightCss / 2 / z
    const item = createImage({ image, x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h })
    this.history.insertImage(item)
    this.input.tool = 'select'
    this.select(item.id)
    return item
  }

  /**
   * Places stored pictures (sizes in page units) in a column, `gap` apart, centred on the view horizontally and
   * starting near its top, as one undoable step; then moves the view to the first one. For imported PDF pages.
   */
  insertImageColumn(pages: readonly { image: string; w: number; h: number }[], gap = 32): ImageItem[] {
    if (this.readOnly || !pages.length) return []
    const z = this.camera.z
    const cx = this.camera.x + this.widthCss / 2 / z
    let y = this.camera.y + 24 / z
    const items = pages.map(p => {
      const item = createImage({ image: p.image, x: cx - p.w / 2, y, w: p.w, h: p.h })
      y += p.h + gap
      return item
    })
    this.history.insertImages(items)
    this.select(null)
    const first = items[0]
    this.animateCamera(fitBounds({ minX: first.x, minY: first.y, maxX: first.x + first.w, maxY: first.y + first.h }, this.widthCss, this.heightCss))
    this.notify()
    return items
  }

  /** Turns the selected picture a quarter clockwise about its centre, as one undoable step; it stays selected. */
  rotateSelectedImage(): boolean {
    const current = this.selectedImage
    if (!current || this.readOnly) return false
    const next = rotateImage(current)
    if (!this.history.replaceImage(current.id, next)) return false
    this.selected = next.id
    this.invalidateScene()
    this.needsLive = true
    this.notify()
    return true
  }

  deleteSelectedImage(): boolean {
    const id = this.selected
    if (!id || this.readOnly) return false
    const done = this.history.deleteImage(id)
    this.select(null)
    return done
  }

  private select(id: string | null) {
    if (this.selected === id) return
    this.selected = id
    this.needsLive = true
    this.schedule()
    this.notify()
  }

  private selectBegin(p: { x: number; y: number }, screen: { x: number; y: number }) {
    const current = this.selectedImage
    if (current) {
      const corner = toScreen(this.camera, current.x + current.w, current.y + current.h)
      if (Math.hypot(screen.x - corner.x, screen.y - corner.y) <= HANDLE_HIT_PX) { this.drag = { mode: 'resize', from: p, item: current, rect: current }; return }
    }
    const hit = imageAt(this.doc.images, p.x, p.y)
    this.select(hit?.id ?? null)
    this.drag = hit ? { mode: 'move', from: p, item: hit, rect: hit } : null
  }

  private selectMove(p: { x: number; y: number }) {
    const drag = this.drag
    if (!drag) return
    drag.rect = dragRect(drag.item, drag.mode, drag.from, p)
    this.invalidateScene()
    this.needsLive = true
  }

  private selectEnd(cancelled: boolean) {
    const drag = this.drag
    this.drag = null
    if (!drag) return
    const r = drag.rect, i = drag.item
    const moved = Math.abs(r.x - i.x) + Math.abs(r.y - i.y) + Math.abs(r.w - i.w) > 0.5 / this.camera.z
    if (!cancelled && moved && this.doc.getImage(i.id)) {
      const next = placeImage(i, r)
      this.history.replaceImage(i.id, next)
      this.selected = next.id
    }
    this.invalidateScene()
    this.needsLive = true
    this.notify()
  }

  get eraserRadiusPx(): number { return this.input.eraserRadiusPx }
  set eraserRadiusPx(px: number) { this.input.eraserRadiusPx = px }

  get paper(): Paper { return this.renderer.paper }
  setPaper(paper: Paper): void {
    this.renderer.paper = { color: paper.color, pattern: paper.pattern }
    this.needsPaper = true
    this.invalidateScene()
    this.notify()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** No drawing, erasing, undo or redo; fingers still pan and zoom. */
  get readOnly(): boolean { return this.input.readOnly }
  set readOnly(value: boolean) {
    if (value && this.live) { this.live = null; this.needsLive = true; this.schedule() }
    if (value) { this.drag = null; this.select(null) }
    this.input.readOnly = value
    this.notify()
  }

  undo(): boolean { if (this.readOnly) return false; const done = this.history.undo(); this.dropStaleSelection(); this.notify(); return done }
  redo(): boolean { if (this.readOnly) return false; const done = this.history.redo(); this.dropStaleSelection(); this.notify(); return done }
  private dropStaleSelection() { if (this.selected && !this.doc.getImage(this.selected)) this.select(null) }

  /** Replaces the page contents. Not undoable. */
  load(strokes: readonly Stroke[], images: readonly ImageItem[] = []): void {
    this.drag = null
    this.selected = null
    this.doc.load(strokes, images)
    this.history.clear()
    this.notify()
  }

  /** Adds strokes as one undoable step. */
  addStrokes(strokes: readonly Stroke[]): void { this.history.addStrokes(strokes); this.notify() }

  /** Erases everything as one undoable step. */
  clearPage(): void { this.history.erase(this.doc.strokes.map(s => s.id)); this.notify() }

  setCamera(camera: Camera): void {
    this.camera = camera
    this.needsPaper = true
    this.needsScene = true
    if (this.selected) this.needsLive = true
    this.schedule()
    this.notify()
  }

  /** Smoothly moves to `target`; a new animation or a finger gesture takes over from this one. */
  animateCamera(target: Camera, ms = 220): void {
    this.stopAnimation()
    const from = this.camera
    const start = performance.now()
    this.beginInteraction('animation')
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const eased = 1 - Math.pow(1 - t, 3)
      this.setCamera(t >= 1 ? target : interpolateCamera(from, target, eased, this.widthCss, this.heightCss))
      if (t < 1 && this.animation) this.animation.raf = requestAnimationFrame(step)
      else this.stopAnimation()
    }
    this.animation = { raf: requestAnimationFrame(step), target }
  }

  /** Zooms about the centre of the view. */
  zoomTo(z: number, animate = true): void {
    const target = zoomAt(this.animation?.target ?? this.camera, this.widthCss / 2, this.heightCss / 2, z)
    if (animate) this.animateCamera(target)
    else this.setCamera(target)
  }

  zoomStep(direction: 1 | -1): void { this.zoomTo(nextZoomStep((this.animation?.target ?? this.camera).z, direction)) }

  fitToContent(animate = false): void {
    const bounds = this.doc.contentBounds()
    const target = bounds ? fitBounds(bounds, this.widthCss, this.heightCss) : { x: 0, y: 0, z: 1 }
    if (animate) this.animateCamera(target)
    else this.setCamera(target)
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
   * Pans by `stepPx` per frame for `frames` animation frames through the same path a finger pan uses
   * (including the gesture snapshot), and records the interval between frames. Intervals above the
   * display's refresh period (8.3 ms at 120 Hz, 16.7 ms at 60 Hz) are dropped frames. No pixel
   * readback is used: in Chrome, readbacks can move a canvas to software rendering.
   */
  benchmarkPan(frames = 90, stepPx = 6): Promise<PanBenchmark> {
    const intervals = new Samples(frames), drawMs = new Samples(frames)
    this.stopAnimation()
    const start = this.camera
    const drawn = this.doc.query(viewportBounds(start, this.widthCss, this.heightCss)).length
    if (this.needsScene) this.render()
    this.beginInteraction('benchmark')
    const cached = this.interaction?.snapshot ?? false
    let previous: number | null = null, i = 0
    return new Promise(resolve => {
      const step = (time: number) => {
        if (previous !== null) intervals.push(time - previous)
        previous = time
        if (i++ >= frames) {
          this.camera = start
          this.needsPaper = true
          this.endInteraction('benchmark')
          const finalRedrawMs = this.render()
          resolve({ intervals, drawMs, drawn, cached, finalRedrawMs })
          return
        }
        const direction = i <= frames / 2 ? 1 : -1
        this.camera = panBy(this.camera, -stepPx * direction, 0)
        this.needsPaper = true
        this.needsScene = true
        drawMs.push(this.render())
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.stopAnimation()
    if (this.wheelTimer) clearTimeout(this.wheelTimer)
    this.observer.disconnect()
    for (const fn of this.cleanup) fn()
    for (const canvas of this.canvases) canvas.remove()
    this.listeners.clear()
  }

  private eraseAt(x: number, y: number, radius: number) {
    this.eraser = { x, y, r: radius }
    this.needsLive = true
    this.schedule()
    const hits = strokesHitBy(this.doc, x, y, radius)
    if (!hits.length) return
    if (this.eraserMode === 'stroke') { this.history.erase(hits.map(s => s.id)); return }
    for (const stroke of hits) {
      const pieces = eraseFromStroke(stroke, x, y, radius)
      if (pieces) this.history.cut(stroke.id, pieces)
    }
  }

  private beginInteraction(source: string) {
    if (this.interaction) { this.interaction.sources.add(source); return }
    const snapshot = this.lastSceneMs > SNAPSHOT_WHEN_SCENE_MS || this.lastDrawnCount >= SNAPSHOT_WHEN_STROKES
    // Stale: the first gesture frame redraws for real and takes the snapshot from that.
    this.interaction = { sources: new Set([source]), snapshot, stale: true, refreshedAt: -Infinity }
    if (snapshot && !this.needsScene && !this.incremental.length) {
      this.renderer.takeSnapshot(this.camera)
      this.interaction.stale = false
      this.interaction.refreshedAt = performance.now()
    }
  }

  private endInteraction(source: string) {
    const interaction = this.interaction
    if (!interaction) return
    interaction.sources.delete(source)
    if (interaction.sources.size) return
    this.interaction = null
    this.renderer.dropSnapshot()
    if (interaction.snapshot) { this.needsScene = true; this.schedule() }
  }

  private stopAnimation() {
    if (!this.animation) return
    cancelAnimationFrame(this.animation.raf)
    this.animation = null
    this.endInteraction('animation')
  }

  private invalidateScene() {
    if (this.interaction) this.interaction.stale = true
    this.needsScene = true
    this.incremental = []
    this.schedule()
  }

  private makeCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', pointerEvents: 'none' })
    this.container.appendChild(canvas)
    this.canvases.push(canvas)
    return canvas
  }

  private resize() {
    const rect = this.container.getBoundingClientRect()
    this.rect = rect
    this.widthCss = Math.max(1, rect.width)
    this.heightCss = Math.max(1, rect.height)
    this.renderer.resize(this.widthCss, this.heightCss, window.devicePixelRatio || 1)
    this.needsPaper = true
    this.needsLive = true
    this.invalidateScene()
  }

  private onPointer(phase: PointerInput['phase'], e: PointerEvent) {
    e.preventDefault()
    const kind: PointerKind = e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse'
    this.seen.add(e.pointerType || 'unknown')
    if (phase === 'down') {
      this.rect = this.container.getBoundingClientRect()
      try { this.container.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
      if (kind === 'touch') this.stopAnimation()
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
    const wasInking = this.input.inking, wasNavigating = this.input.navigating
    this.input.handle({ phase, id: e.pointerId, kind, button: e.button, samples })
    if (!wasNavigating && this.input.navigating) this.beginInteraction('touch')
    if (wasNavigating && !this.input.navigating) this.endInteraction('touch')
    if (kind !== 'touch' && (wasInking || this.input.inking)) {
      if (phase === 'move') this.metrics.samplesPerEvent.push(samples.length)
      this.pendingEventTimes.push(e.timeStamp)
      this.schedule()
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault()
    this.stopAnimation()
    this.beginInteraction('wheel')
    if (this.wheelTimer) clearTimeout(this.wheelTimer)
    this.wheelTimer = setTimeout(() => { this.wheelTimer = null; this.endInteraction('wheel') }, WHEEL_IDLE_MS)
    const rect = this.container.getBoundingClientRect()
    const scale = e.deltaMode === 1 ? 16 : 1
    if (e.ctrlKey || e.metaKey) this.setCamera(zoomAt(this.camera, e.clientX - rect.left, e.clientY - rect.top, this.camera.z * Math.exp(-e.deltaY * scale * 0.01)))
    else this.setCamera(panBy(this.camera, -e.deltaX * scale, -e.deltaY * scale))
  }

  private onDocumentChange(change: DocumentChange) {
    const appended = !change.reset && !change.images && !change.removed.length && change.added.every(p => p.index >= this.doc.size - change.added.length)
    if (change.images) this.needsLive = true
    if (appended && !this.needsScene && !this.interaction) this.incremental.push(...change.added.map(p => p.stroke))
    else this.invalidateScene()
    this.schedule()
    this.notify()
  }

  private schedule() {
    if (this.raf === null) this.raf = requestAnimationFrame(() => this.frame())
  }

  private frame() {
    this.raf = null
    this.render()
    const end = performance.now()
    for (const t of this.pendingEventTimes) this.metrics.inputToFrameMs.push(end - t)
    this.pendingEventTimes = []
  }

  /** Draws whatever is out of date and returns the time it took. */
  private render(): number {
    const start = performance.now()
    if (this.needsPaper) { this.renderer.drawPaper(this.camera); this.needsPaper = false }
    if (this.needsScene) {
      if (!this.drawFromSnapshot(start)) this.drawFullScene()
      this.needsScene = false
      this.incremental = []
    } else if (this.incremental.length) {
      for (const stroke of this.incremental) this.renderer.drawStroke(stroke, this.camera)
      this.lastDrawnCount += this.incremental.length
      this.incremental = []
    }
    if (this.needsLive) {
      if (this.live) this.renderer.drawLive(this.live, this.style, this.camera)
      else if (this.eraser) {
        const p = toScreen(this.camera, this.eraser.x, this.eraser.y)
        this.renderer.drawEraser(p.x, p.y, this.eraser.r * this.camera.z)
      } else if (this.drag || this.selectedImage) this.renderer.drawSelection(this.drag?.rect ?? this.selectedImage!, this.camera, HANDLE_PX)
      else this.renderer.clearLive()
      this.needsLive = false
    }
    const ms = performance.now() - start
    this.metrics.frameMs.push(ms)
    if (this.interaction) this.metrics.gestureFrameMs.push(ms)
    return ms
  }

  private drawFullScene() {
    const view = viewportBounds(this.camera, this.widthCss, this.heightCss)
    const visible = this.doc.query(view)
    const drag = this.drag
    // While dragging, the placement is drawn where it is going; the document changes only on release.
    const images = drag
      ? this.doc.images.map(i => i.id === drag.item.id ? { ...i, ...drag.rect } : i)
      : this.doc.queryImages(view)
    const { ms } = this.renderer.drawScene(visible, this.camera, undefined, images)
    this.metrics.sceneMs.push(ms)
    this.lastSceneMs = ms
    this.lastDrawnCount = visible.length
  }

  /** During a heavy gesture: reuse the snapshot, refreshing it when stale or stretched too far. */
  private drawFromSnapshot(now: number): boolean {
    const interaction = this.interaction
    if (!interaction?.snapshot) return false
    const snap = this.renderer.snapshotAt
    const scale = snap ? this.camera.z / snap.z : 1
    const worn = !snap || viewCoverage(snap, this.camera, this.widthCss, this.heightCss) < MIN_COVERAGE || scale < MIN_SCALE || scale > MAX_SCALE
    if (interaction.stale || (worn && now - interaction.refreshedAt >= REFRESH_MS)) {
      this.drawFullScene()
      this.renderer.takeSnapshot(this.camera)
      interaction.stale = false
      interaction.refreshedAt = now
      return true
    }
    return this.renderer.drawFromSnapshot(this.camera)
  }

  private notify() { for (const listener of this.listeners) listener() }
}
