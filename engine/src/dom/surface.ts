import { fitBounds, interpolateCamera, nextZoomStep, panBy, toScreen, viewCoverage, viewportBounds, zoomAt } from '../core/camera'
import { intersects } from '../core/geometry'
import { InkDocument } from '../core/document'
import type { DocumentChange } from '../core/document'
import { eraseFromStroke, strokesHitBy } from '../core/eraser'
import { History } from '../core/history'
import { createImage, dragPlacement, fitSize, imageAt, resizeHandle, rotateHandle } from '../core/image'
import type { DragMode, Placement } from '../core/image'
import { InputController } from '../core/input'
import type { PointerInput, PointerKind, Tool } from '../core/input'
import { Samples } from '../core/metrics'
import type { Paper } from '../core/paper'
import { boxPolygon, frameContains, imagePickedByPolygon, offsetImage, offsetStroke, restyleStroke, selectionFrame, similarityBetween, simplifyLoop, strokeTouchesPolygon, transformImage, transformPlacement, transformStroke, unionBounds } from '../core/selection'
import { createStroke } from '../core/stroke'
import type { Bounds, Camera, ImageItem, Stroke, StrokeStyle } from '../core/types'
import { composePage, composeRegion, composeView, countInView, pageArea } from '../render/export'
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
/** A finger is bigger than a pen tip: grab handles from further away. */
const HANDLE_HIT_TOUCH_PX = 34
/** The rotation handle sits this far (CSS px) out from the middle of the top edge, at every zoom. */
const ROTATE_OFFSET_PX = 36
/** A select drag that travels less than this (CSS px) is a tap, not a lasso. */
const TAP_TRAVEL_PX = 8
/** The lasso keeps points at least this far (CSS px) apart. */
const LASSO_GAP_PX = 2.5
/** A snip rectangle is at least this big (CSS px) on each side. */
const SNIP_MIN_PX = 24
/** A duplicate lands this far (page units) down and to the right of the original. */
const DUPLICATE_OFFSET = 24
/** Margin (page units) around a selection when it is exported on its own. */
const SELECTION_EXPORT_MARGIN = 24

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
  /** Ids of the selected strokes and pictures (ids are unique across both). */
  private sel = new Set<string>()
  /** A selection drag: the frame it started from, and where it has been dragged to. */
  private drag: { mode: DragMode; from: { x: number; y: number }; frame: Placement; place: Placement } | null = null
  /** A lasso being drawn (flat page points); `on` is the picture the pen went down on, for a tap. */
  private lasso: { points: number[]; first: { x: number; y: number }; on: ImageItem | null; travel: number } | null = null
  /** The snipping rectangle (page units) while the snip tool is active, and the drag changing it. */
  private snip: { area: Bounds; whole: boolean } | null = null
  private snipDrag: { mode: 'new' | 'move' | 'corner'; from: { x: number; y: number }; start: Bounds; anchor: { x: number; y: number } } | null = null
  /** What the select tool's drag on empty paper draws: a freehand loop or a box. */
  lassoShape: 'loop' | 'box' = 'loop'
  /** Called while the selection is being turned, with its angle (degrees), and with null when the turn ends. */
  onTurnPreview: ((angle: number | null) => void) | null = null

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
      selectBegin: (p, screen, kind) => this.selectBegin(p, screen, kind),
      touchGrab: (p, screen) => this.tool === 'snip' ? this.snipCornerAt(screen, 'touch') !== null : this.grabAt(p, screen, 'touch') !== null,
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
    // A pointer we lost without a pointerup (capture taken away, the app backgrounded) must not leave input wedged.
    on('lostpointercapture', e => this.onPointer('cancel', e))
    const dropAll = () => { this.input.cancelAll(); this.endInteraction('touch'); this.invalidateScene(); this.needsLive = true; this.schedule() }
    window.addEventListener('blur', dropAll)
    document.addEventListener('visibilitychange', dropAll)
    this.cleanup.push(() => { window.removeEventListener('blur', dropAll); document.removeEventListener('visibilitychange', dropAll) })
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
    if (tool !== 'select' && tool !== 'snip') this.setSelection([])
    this.drag = null
    this.lasso = null
    this.snipDrag = null
    if (tool === 'snip') { if (!this.snip) this.snip = { area: this.defaultSnipArea(), whole: false } } else this.snip = null
    this.invalidateScene()
    this.needsLive = true
    this.schedule()
    this.notify()
  }

  // ---- images ----

  /** The decoded picture for a stored image name, or null while it is not available (a placeholder is drawn). */
  setImageSource(source: (image: string) => CanvasImageSource | null): void { this.imageSource = source; this.invalidateScene() }
  /** Call when pictures finish loading. */
  imagesChanged(): void { this.invalidateScene() }


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

  // ---- selection (lasso) ----

  /** The selected strokes and pictures. */
  get selection(): { strokes: Stroke[]; images: ImageItem[] } {
    const strokes: Stroke[] = [], images: ImageItem[] = []
    for (const id of this.sel) {
      const stroke = this.doc.get(id)
      if (stroke) { strokes.push(stroke); continue }
      const image = this.doc.getImage(id)
      if (image) images.push(image)
    }
    return { strokes, images }
  }

  get selectionCount(): number { return this.sel.size }

  /** The picture, when exactly one picture and no ink is selected. */
  get selectedImage(): ImageItem | null {
    if (this.sel.size !== 1) return null
    const [id] = this.sel
    return this.doc.getImage(id) ?? null
  }

  /** The frame around the selection (see selectionFrame in core/selection), or null when nothing is selected. */
  get selectionBox(): Placement | null {
    const { strokes, images } = this.selection
    return selectionFrame(strokes, images)
  }

  /** Selects exactly these ids (strokes or pictures); ids not on the page are ignored. */
  select(ids: string | null | Iterable<string>): void {
    this.setSelection(ids === null ? [] : typeof ids === 'string' ? [ids] : ids)
  }

  private setSelection(ids: Iterable<string>) {
    const next = new Set<string>()
    for (const id of ids) if (this.doc.has(id) || this.doc.getImage(id)) next.add(id)
    const same = next.size === this.sel.size && [...next].every(id => this.sel.has(id))
    if (same) return
    this.sel = next
    this.needsLive = true
    this.schedule()
    this.notify()
  }

  /** Turns the selection a quarter clockwise about the middle of its frame, as one undoable step; it stays selected. */
  rotateSelection(): boolean {
    const frame = this.selectionBox
    if (!frame || this.readOnly) return false
    return this.applyToSelection(similarityBetween(frame, { ...frame, angle: frame.angle + 90 }))
  }
  /** Same as rotateSelection (the picture bar's button predates ink selection). */
  rotateSelectedImage(): boolean { return this.rotateSelection() }

  /** Removes everything selected, as one undoable step. */
  deleteSelection(): boolean {
    if (!this.sel.size || this.readOnly) return false
    const { strokes, images } = this.selection
    const done = this.history.deleteItems(strokes.map(s => s.id), images.map(i => i.id)) > 0
    this.setSelection([])
    this.invalidateScene()
    this.notify()
    return done
  }
  deleteSelectedImage(): boolean { return this.deleteSelection() }

  /** Adds a copy of everything selected, a little down and to the right, on top, as one undoable step; the copy is selected. */
  duplicateSelection(): boolean {
    if (!this.sel.size || this.readOnly) return false
    const { strokes, images } = this.selection
    const copies = strokes.map(s => offsetStroke(s, DUPLICATE_OFFSET, DUPLICATE_OFFSET))
    const pictures = images.map(i => offsetImage(i, DUPLICATE_OFFSET, DUPLICATE_OFFSET))
    this.history.addItems(copies, pictures)
    this.setSelection([...copies.map(s => s.id), ...pictures.map(i => i.id)])
    this.invalidateScene()
    this.notify()
    return true
  }

  /** Gives the selected ink a new colour and/or width (pictures are left as they are), as one undoable step. */
  restyleSelection(style: Partial<StrokeStyle>): boolean {
    if (this.readOnly) return false
    const { strokes } = this.selection
    if (!strokes.length) return false
    const changed = strokes.filter(s => (style.color !== undefined && style.color !== s.style.color) || (style.width !== undefined && style.width !== s.style.width))
    if (!changed.length) return false
    const next = changed.map(s => [s.id, restyleStroke(s, style)] as const)
    this.history.replaceItems(next, [])
    const replaced = new Map(next.map(([id, n]) => [id, n.id]))
    this.setSelection([...this.sel].map(id => replaced.get(id) ?? id))
    this.invalidateScene()
    this.notify()
    return true
  }

  /** The pen colour and width shared by the selected ink: null for a value that differs between strokes. */
  get selectionStyle(): { color: string | null; width: number | null } | null {
    const { strokes } = this.selection
    if (!strokes.length) return null
    const color = strokes.every(s => s.style.color === strokes[0].style.color) ? strokes[0].style.color : null
    const width = strokes.every(s => s.style.width === strokes[0].style.width) ? strokes[0].style.width : null
    return { color, width }
  }

  private applyToSelection(t: ReturnType<typeof similarityBetween>): boolean {
    const { strokes, images } = this.selection
    const nextStrokes = strokes.map(s => [s.id, transformStroke(s, t)] as const)
    const nextImages = images.map(i => [i.id, transformImage(i, t)] as const)
    if (!this.history.replaceItems(nextStrokes, nextImages)) return false
    this.setSelection([...nextStrokes.map(([, n]) => n.id), ...nextImages.map(([, n]) => n.id)])
    this.invalidateScene()
    this.needsLive = true
    this.notify()
    return true
  }

  /**
   * What a pen or finger at this point would grab: a handle of the selection frame (resize or turn), anywhere inside the
   * frame (move), or, for a finger, any picture (which it selects and moves). Null when it lands on nothing to grab.
   */
  private grabAt(p: { x: number; y: number }, screen: { x: number; y: number }, kind: PointerKind): { mode: DragMode } | { pick: ImageItem } | null {
    const reach = kind === 'touch' ? HANDLE_HIT_TOUCH_PX : HANDLE_HIT_PX
    const frame = this.selectionBox
    if (frame) {
      const near = (page: { x: number; y: number }) => { const sp = toScreen(this.camera, page.x, page.y); return Math.hypot(screen.x - sp.x, screen.y - sp.y) <= reach }
      if (near(resizeHandle(frame))) return { mode: 'resize' }
      if (near(rotateHandle(frame, ROTATE_OFFSET_PX / this.camera.z))) return { mode: 'rotate' }
      if (frameContains(frame, p.x, p.y)) return { mode: 'move' }
    }
    if (kind === 'touch') { const hit = imageAt(this.doc.images, p.x, p.y); if (hit) return { pick: hit } }
    return null
  }

  private beginDrag(mode: DragMode, from: { x: number; y: number }) {
    const frame = this.selectionBox
    if (frame) this.drag = { mode, from, frame, place: frame }
  }

  private selectBegin(p: { x: number; y: number }, screen: { x: number; y: number }, kind: PointerKind) {
    if (this.tool === 'snip') { this.snipBegin(p, screen, kind); return }
    const grab = this.grabAt(p, screen, kind)
    if (grab && 'mode' in grab) { this.beginDrag(grab.mode, p); return }
    if (grab) { this.setSelection([grab.pick.id]); this.beginDrag('move', p); return }
    // Empty paper (or an unselected picture, tapped to select): a lasso. The old selection stays until the lasso is drawn.
    this.lasso = { points: [p.x, p.y], first: p, on: imageAt(this.doc.images, p.x, p.y), travel: 0 }
    this.needsLive = true
    this.schedule()
  }

  private selectMove(p: { x: number; y: number }) {
    if (this.tool === 'snip') { this.snipMove(p); return }
    const drag = this.drag
    if (drag) {
      drag.place = dragPlacement(drag.frame, drag.mode, drag.from, p)
      this.invalidateScene()
      this.needsLive = true
      if (drag.mode === 'rotate') this.onTurnPreview?.(drag.place.angle)
      return
    }
    const lasso = this.lasso
    if (!lasso) return
    const n = lasso.points.length
    const gap = Math.hypot(p.x - lasso.points[n - 2], p.y - lasso.points[n - 1])
    if (gap < LASSO_GAP_PX / this.camera.z) return
    lasso.travel += gap
    lasso.points.push(p.x, p.y)
    this.needsLive = true
    this.schedule()
  }

  private selectEnd(cancelled: boolean) {
    if (this.tool === 'snip') { this.snipEnd(); return }
    if (this.lasso) { this.finishLasso(cancelled); return }
    const drag = this.drag
    this.drag = null
    if (drag?.mode === 'rotate') this.onTurnPreview?.(null)
    if (!drag) return
    const r = drag.place, f = drag.frame
    const turned = Math.abs(((r.angle - f.angle + 540) % 360) - 180) > 0.2
    const moved = Math.abs(r.x - f.x) + Math.abs(r.y - f.y) + Math.abs(r.w - f.w) > 0.5 / this.camera.z || turned
    if (!cancelled && moved && !this.readOnly) this.applyToSelection(similarityBetween(f, r))
    this.invalidateScene()
    this.needsLive = true
    this.notify()
  }

  /** A lasso ended: a tap picks the picture under it (or nothing); a drawn loop or box picks what it touches. */
  private finishLasso(cancelled: boolean) {
    const lasso = this.lasso!
    this.lasso = null
    this.needsLive = true
    this.schedule()
    if (cancelled) { this.notify(); return }
    if (lasso.travel * this.camera.z < TAP_TRAVEL_PX) { this.setSelection(lasso.on ? [lasso.on.id] : []); this.notify(); return }
    const n = lasso.points.length
    const polygon = this.lassoShape === 'box'
      ? boxPolygon(lasso.first.x, lasso.first.y, lasso.points[n - 2], lasso.points[n - 1])
      : simplifyLoop(lasso.points, LASSO_GAP_PX / this.camera.z)
    this.setSelection(this.pickedBy(polygon))
    this.notify()
  }

  /** Ids of the strokes the polygon touches and the pictures it encloses the middle of. */
  private pickedBy(polygon: readonly number[]): string[] {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i + 1 < polygon.length; i += 2) { minX = Math.min(minX, polygon[i]); maxX = Math.max(maxX, polygon[i]); minY = Math.min(minY, polygon[i + 1]); maxY = Math.max(maxY, polygon[i + 1]) }
    const box = { minX, minY, maxX, maxY }
    const ids: string[] = []
    for (const image of this.doc.queryImages(box)) if (imagePickedByPolygon(image, polygon, box)) ids.push(image.id)
    for (const stroke of this.doc.query(box)) if (strokeTouchesPolygon(stroke, polygon, box)) ids.push(stroke.id)
    return ids
  }

  /** The points of the lasso being drawn, as a polygon (a box for the box shape). */
  private lassoPolygon(): number[] {
    const lasso = this.lasso!
    const n = lasso.points.length
    return this.lassoShape === 'box' ? boxPolygon(lasso.first.x, lasso.first.y, lasso.points[n - 2], lasso.points[n - 1]) : lasso.points
  }

  // ---- snipping rectangle ----

  /** The snipping rectangle (page units) while the snip tool is active, else null. */
  get snipArea(): Bounds | null { return this.snip ? { ...this.snip.area } : null }
  /** True while the rectangle is the whole page (as set by snipWholePage) and has not been changed since. */
  get snipIsWholePage(): boolean { return !!this.snip?.whole }

  /** Starts the snip tool: the rectangle begins around the selection if there is one, else in the middle of the view. */
  startSnip(area?: Bounds): void {
    if (this.tool !== 'snip') this.setTool('snip')
    if (area && this.snip) { this.snip = { area: { ...area }, whole: false }; this.needsLive = true; this.schedule(); this.notify() }
  }

  /** Leaves the snip tool for the select tool. */
  endSnip(): void { if (this.tool === 'snip') this.setTool('select') }

  /** Sets the rectangle to everything on the page. Returns false when the page is empty. */
  snipWholePage(): boolean {
    const area = pageArea(this.doc)
    if (!area || !this.snip) return false
    this.snip = { area, whole: true }
    this.needsLive = true
    this.schedule()
    this.notify()
    return true
  }

  private defaultSnipArea(): Bounds {
    const selected = this.selection
    const box = unionBounds([...selected.strokes.map(s => s.bounds), ...selected.images.map(i => i.bounds)])
    const pad = 12 / this.camera.z
    if (box) return { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad }
    const view = viewportBounds(this.camera, this.widthCss, this.heightCss)
    const w = view.maxX - view.minX, h = view.maxY - view.minY
    return { minX: view.minX + w * 0.15, minY: view.minY + h * 0.2, maxX: view.maxX - w * 0.15, maxY: view.maxY - h * 0.2 }
  }

  private snipCornerAt(screen: { x: number; y: number }, kind: PointerKind): { x: number; y: number } | null {
    if (!this.snip) return null
    const a = this.snip.area, reach = kind === 'touch' ? HANDLE_HIT_TOUCH_PX : HANDLE_HIT_PX
    // The anchor is the corner opposite the one grabbed.
    for (const [cx, cy, ox, oy] of [[a.minX, a.minY, a.maxX, a.maxY], [a.maxX, a.minY, a.minX, a.maxY], [a.minX, a.maxY, a.maxX, a.minY], [a.maxX, a.maxY, a.minX, a.minY]]) {
      const sp = toScreen(this.camera, cx, cy)
      if (Math.hypot(screen.x - sp.x, screen.y - sp.y) <= reach) return { x: ox, y: oy }
    }
    return null
  }

  private snipBegin(p: { x: number; y: number }, screen: { x: number; y: number }, kind: PointerKind) {
    if (!this.snip) return
    const start = { ...this.snip.area }
    const anchor = this.snipCornerAt(screen, kind)
    if (anchor) this.snipDrag = { mode: 'corner', from: p, start, anchor }
    else if (p.x >= start.minX && p.x <= start.maxX && p.y >= start.minY && p.y <= start.maxY) this.snipDrag = { mode: 'move', from: p, start, anchor: p }
    else this.snipDrag = { mode: 'new', from: p, start, anchor: p }
  }

  private snipMove(p: { x: number; y: number }) {
    const drag = this.snipDrag
    if (!drag || !this.snip) return
    const a = drag.start
    if (drag.mode === 'move') {
      const dx = p.x - drag.from.x, dy = p.y - drag.from.y
      this.snip.area = { minX: a.minX + dx, minY: a.minY + dy, maxX: a.maxX + dx, maxY: a.maxY + dy }
    } else {
      const k = drag.anchor
      this.snip.area = { minX: Math.min(k.x, p.x), minY: Math.min(k.y, p.y), maxX: Math.max(k.x, p.x), maxY: Math.max(k.y, p.y) }
    }
    this.snip.whole = false
    this.needsLive = true
    this.schedule()
    this.notify()
  }

  private snipEnd() {
    const drag = this.snipDrag
    this.snipDrag = null
    if (!drag || !this.snip) return
    const a = this.snip.area, min = SNIP_MIN_PX / this.camera.z
    // A tap or a sliver is not a rectangle: put back the one there was.
    if (drag.mode !== 'move' && (a.maxX - a.minX < min || a.maxY - a.minY < min)) { this.snip.area = drag.start; this.snip.whole = false }
    this.needsLive = true
    this.schedule()
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
    if (value) { this.drag = null; this.lasso = null; this.setSelection([]) }
    this.input.readOnly = value
    this.notify()
  }

  undo(): boolean { if (this.readOnly) return false; const done = this.history.undo(); this.dropStaleSelection(); this.notify(); return done }
  redo(): boolean { if (this.readOnly) return false; const done = this.history.redo(); this.dropStaleSelection(); this.notify(); return done }
  private dropStaleSelection() { this.setSelection([...this.sel]) }

  /** Replaces the page contents. Not undoable. */
  load(strokes: readonly Stroke[], images: readonly ImageItem[] = []): void {
    this.drag = null
    this.lasso = null
    this.sel = new Set()
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
    if (this.sel.size || this.snip || this.lasso) this.needsLive = true
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

  /** Strokes and pictures in the current view. */
  viewCounts(): { strokes: number; images: number } {
    return countInView(this.doc, this.camera, this.widthCss, this.heightCss)
  }

  /**
   * A PNG of the current view (paper, pictures, ink; long side at most 1600 px), drawn on throwaway
   * canvases so the selection frame, eraser ring and unfinished stroke never appear. Does not move the camera.
   */
  exportView(): Promise<Blob> {
    const { canvas } = composeView({
      doc: this.doc, paper: this.paper, camera: this.camera, widthCss: this.widthCss, heightCss: this.heightCss,
      options: { createPath: createPath2D, imageSource: image => this.imageSource?.(image) ?? null },
      makeCanvas: () => document.createElement('canvas'),
    })
    return new Promise((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(blob => blob ? resolve(blob) : reject(new Error('This browser could not encode the view.')), 'image/png')
    })
  }

  /** Strokes and pictures that touch an area of the page. */
  areaCounts(area: Bounds): { strokes: number; images: number } {
    return { strokes: this.doc.query(area).length, images: this.doc.queryImages(area).length }
  }

  /** The selected strokes and pictures. */
  selectionCounts(): { strokes: number; images: number } {
    const { strokes, images } = this.selection
    return { strokes: strokes.length, images: images.length }
  }

  /** Every stroke and picture on the page. */
  pageCounts(): { strokes: number; images: number } {
    return { strokes: this.doc.size, images: this.doc.images.length }
  }

  /**
   * A PNG of the whole page: everything on it, fitted with a margin over the paper, wherever the camera is
   * (long side at most `maxSide`, 4000 by default). Drawn on throwaway canvases; the camera and selection are untouched.
   * Null when the page is empty.
   */
  exportPage(maxSide?: number): Promise<Blob> | null {
    const page = composePage({
      doc: this.doc, paper: this.paper, maxSide,
      options: { createPath: createPath2D, imageSource: image => this.imageSource?.(image) ?? null },
      makeCanvas: () => document.createElement('canvas'),
    })
    return page ? canvasBlob(page.canvas as HTMLCanvasElement) : null
  }

  /**
   * A PNG of one rectangle of the page (a snip): everything that touches it, over the paper, wherever the camera is
   * (long side at most `maxSide`, 4000 by default). Drawn on throwaway canvases; the camera and selection are untouched.
   */
  exportArea(area: Bounds, maxSide?: number): Promise<Blob> {
    const region = composeRegion({
      doc: this.doc, paper: this.paper, area, maxSide,
      options: { createPath: createPath2D, imageSource: image => this.imageSource?.(image) ?? null },
      makeCanvas: () => document.createElement('canvas'),
    })
    return canvasBlob(region.canvas as HTMLCanvasElement)
  }

  /** A PNG of only the selected strokes and pictures, fitted with a margin over the paper. Null when nothing is selected. */
  exportSelection(maxSide?: number): Promise<Blob> | null {
    const only = this.selection
    const box = unionBounds([...only.strokes.map(s => s.bounds), ...only.images.map(i => i.bounds)])
    if (!box) return null
    const m = SELECTION_EXPORT_MARGIN
    const region = composeRegion({
      doc: this.doc, paper: this.paper, only, maxSide,
      area: { minX: box.minX - m, minY: box.minY - m, maxX: box.maxX + m, maxY: box.maxY + m },
      options: { createPath: createPath2D, imageSource: image => this.imageSource?.(image) ?? null },
      makeCanvas: () => document.createElement('canvas'),
    })
    return canvasBlob(region.canvas as HTMLCanvasElement)
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
      } else if (this.lasso) this.renderer.drawLasso(this.lassoPolygon(), this.camera)
      else if (this.snip && this.tool === 'snip') this.renderer.drawSnip(this.snip.area, this.camera, HANDLE_PX)
      else if (this.tool === 'select' && (this.drag || this.sel.size)) {
        const frame = this.drag?.place ?? this.selectionBox
        if (frame) this.renderer.drawSelection(frame, this.camera, HANDLE_PX, ROTATE_OFFSET_PX)
        else this.renderer.clearLive()
      } else this.renderer.clearLive()
      this.needsLive = false
    }
    const ms = performance.now() - start
    this.metrics.frameMs.push(ms)
    if (this.interaction) this.metrics.gestureFrameMs.push(ms)
    return ms
  }

  private drawFullScene() {
    const view = viewportBounds(this.camera, this.widthCss, this.heightCss)
    const drag = this.drag
    let visible: readonly Stroke[], images: readonly ImageItem[], preview: { strokeIds: ReadonlySet<string>; transform: ReturnType<typeof similarityBetween> } | undefined
    if (drag) {
      // While dragging, the selection is drawn where it is going; the document changes only on release.
      const t = similarityBetween(drag.frame, drag.place), ids = this.sel
      visible = this.doc.strokes.filter(s => ids.has(s.id) || intersects(s.bounds, view))
      images = this.doc.images.filter(i => ids.has(i.id) || intersects(i.bounds, view)).map(i => ids.has(i.id) ? { ...i, ...transformPlacement(i, t) } : i)
      preview = { strokeIds: ids, transform: t }
    } else {
      visible = this.doc.query(view)
      images = this.doc.queryImages(view)
    }
    const { ms } = this.renderer.drawScene(visible, this.camera, undefined, images, preview)
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

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('This browser could not encode the picture.')), 'image/png'))
}
