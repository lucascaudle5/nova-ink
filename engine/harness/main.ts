import { generateStrokes } from '../src/dev/generate'
import { InkSurface } from '../src/dom/surface'
import type { PanBenchmark } from '../src/dom/surface'
import { parsePage, serializePage } from '../src/core/format'
import type { Tool } from '../src/core/input'
import type { Samples } from '../src/core/metrics'
import { displayColor, PAPER_COLORS, PAPER_PATTERNS } from '../src/core/paper'
import type { PaperColor, PaperPattern } from '../src/core/paper'
import { currentStyle, ERASER_SIZES, MAX_WIDTH, MIN_WIDTH, normalizeColor, PALETTE, parseEraser, parsePresets, setColor, setWidth, tapSlot } from './presets'
import type { EraserSettings, EraserSize, PenPresets, PresetKind } from './presets'

// Harness-only scratch draft. Never a NOVA notebook; real notebooks live on the NOVA server.
const DRAFT_KEY = 'nova-ink-engine-harness:draft:v1'
const PRESETS_KEY = 'nova-ink-engine-harness:presets:v1'
const ERASER_KEY = 'nova-ink-engine-harness:eraser:v1'
const STATS_KEY = 'nova-ink-engine-harness:stats:v1'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const readStored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const writeStored = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* preference only */ } }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, style: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  Object.assign(node.style, style)
  return node
}

const surface = new InkSurface($('surface'))
const draftLabel = $<HTMLSpanElement>('draft')
const stats = $<HTMLElement>('stats')
let benchText = ''
let lastBench: unknown = null
let draftTimer: ReturnType<typeof setTimeout> | null = null
let draftSaved = ''
// Metrics cover only this page load; a reload restores strokes but starts metrics from zero.
const sessionStartedAt = new Date().toISOString()
let restoredStrokes = 0

// ---- Local scratch draft ----

/** What the draft would contain; cheap because each stroke's encoding is cached. */
const draftKey = () => `${surface.doc.revision}|${surface.paper.color}|${surface.paper.pattern}`

function setDraft(text: string, bad = false) {
  draftLabel.textContent = text
  draftLabel.classList.toggle('bad', bad)
}

function restoreDraft() {
  let text: string | null = null
  try { text = localStorage.getItem(DRAFT_KEY) } catch { setDraft('Local draft unavailable', true); return }
  if (!text) { setDraft('No local draft'); draftSaved = draftKey(); return }
  let data: unknown
  try { data = JSON.parse(text) } catch { setDraft('Local draft is damaged; not loaded', true); return }
  const result = parsePage(data)
  if (!result.ok) { setDraft(`Local draft not loaded: ${result.message}`, true); return }
  surface.setPaper(result.paper)
  surface.load(result.strokes)
  surface.fitToContent()
  draftSaved = draftKey()
  restoredStrokes = result.strokes.length
  setDraft(`Restored local draft (${result.strokes.length} strokes)`)
}

function saveDraft() {
  draftTimer = null
  const key = draftKey()
  if (key === draftSaved) return
  const start = performance.now()
  const text = JSON.stringify(serializePage(surface.doc.strokes, surface.paper))
  const ms = performance.now() - start
  try {
    localStorage.setItem(DRAFT_KEY, text)
    draftSaved = key
    setDraft(`Draft saved locally · ${(text.length / 1024).toFixed(0)} KB · ${ms.toFixed(1)} ms`)
  } catch {
    setDraft(`Draft NOT saved locally (${(text.length / 1048576).toFixed(1)} MB; browser storage full)`, true)
  }
}

// ---- Toolbar state ----

const zoomLabel = $<HTMLButtonElement>('zoom-reset')
let shownPaper = ''
surface.onChange(() => {
  $<HTMLButtonElement>('undo').disabled = !surface.history.canUndo
  $<HTMLButtonElement>('redo').disabled = !surface.history.canRedo
  for (const b of document.querySelectorAll<HTMLButtonElement>('button.tool')) b.classList.toggle('active', b.dataset.tool === surface.tool)
  zoomLabel.textContent = `${Math.round(surface.camera.z * 100)}%`
  const paperKey = `${surface.paper.color}|${surface.paper.pattern}`
  if (paperKey !== shownPaper) {
    shownPaper = paperKey
    document.body.classList.toggle('dark-paper', PAPER_COLORS[surface.paper.color].dark)
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', PAPER_COLORS[surface.paper.color].fill)
    renderSlots()
  }
  if (draftKey() !== draftSaved) {
    setDraft('Unsaved local changes')
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(saveDraft, 600)
  }
})

// ---- Pen presets (Goodnotes-style: tap to use, tap the selected one again to edit) ----

let presets: PenPresets = parsePresets(readStored(PRESETS_KEY))
const lineHeight = (width: number) => `${Math.max(1.5, Math.min(14, width))}px`
/** Swatches show ink as it appears on this page's paper. */
const shown = (color: string) => displayColor(color, surface.paper)

function applyPresets(next: PenPresets) {
  presets = next
  surface.style = currentStyle(presets)
  writeStored(PRESETS_KEY, JSON.stringify(presets))
  renderSlots()
}

function renderSlots() {
  const color = shown(currentStyle(presets).color)
  $('width-slots').replaceChildren(...presets.widths.map((width, index) => {
    const button = el('button', { className: index === presets.widthIndex ? 'current' : '', title: `Width ${width.toFixed(1)}` })
    button.append(el('span', { className: 'line' }, { height: lineHeight(width), background: color }))
    button.addEventListener('click', () => onSlotTap('width', index, button))
    return button
  }))
  $('color-slots').replaceChildren(...presets.colors.map((c, index) => {
    const button = el('button', { className: index === presets.colorIndex ? 'current' : '', title: c })
    button.append(el('span', { className: 'swatch' }, { background: shown(c), color: shown(c) }))
    button.addEventListener('click', () => onSlotTap('color', index, button))
    return button
  }))
}

function onSlotTap(kind: PresetKind, index: number, anchor: HTMLElement) {
  const { presets: next, edit } = tapSlot(presets, kind, index)
  surface.setTool('pen')
  if (!edit) { closePopover(); applyPresets(next); return }
  togglePopover(`${kind}:${index}`, anchor, root => (kind === 'width' ? buildWidthEditor : buildColorEditor)(root, index))
}

function buildWidthEditor(root: HTMLElement, index: number) {
  const value = el('span')
  const line = el('span', {}, { display: 'inline-block', width: '160px', borderRadius: '99px' })
  const slider = el('input', { type: 'range', min: String(MIN_WIDTH), max: String(MAX_WIDTH), step: '0.1', value: String(presets.widths[index]) })
  const show = () => {
    const width = presets.widths[index]
    value.textContent = width.toFixed(1)
    Object.assign(line.style, { height: lineHeight(width), background: shown(currentStyle(presets).color) })
  }
  slider.addEventListener('input', () => { applyPresets(setWidth(presets, index, Number(slider.value))); show() })
  const title = el('h4', { textContent: 'Width' })
  title.append(value)
  const preview = el('div', { className: 'preview' })
  preview.append(line)
  root.append(title, preview, slider)
  show()
}

function buildColorEditor(root: HTMLElement, index: number) {
  const palette = el('div', { className: 'palette' })
  const picker = el('input', { type: 'color' })
  const hex = el('input', { type: 'text', maxLength: 7, spellcheck: false, autocapitalize: 'off' })
  const show = () => {
    const c = presets.colors[index]
    picker.value = c
    if (document.activeElement !== hex) hex.value = c
    hex.classList.remove('bad')
    for (const b of palette.children) b.classList.toggle('current', (b as HTMLElement).dataset.color === c)
  }
  const choose = (c: string) => { applyPresets(setColor(presets, index, c)); show() }
  for (const c of PALETTE) {
    const b = el('button', { title: c }, { background: c })
    b.dataset.color = c
    b.addEventListener('click', () => choose(c))
    palette.append(b)
  }
  picker.addEventListener('input', () => choose(picker.value))
  hex.addEventListener('input', () => {
    const c = normalizeColor(hex.value)
    if (c) choose(c); else hex.classList.add('bad')
  })
  const custom = el('div', { className: 'custom' })
  custom.append(picker, hex)
  root.append(el('h4', { textContent: 'Color' }), palette, custom)
  if (PAPER_COLORS[surface.paper.color].dark) root.append(el('p', { className: 'hint', textContent: 'Black ink shows light on dark paper.' }))
  show()
}

// ---- Eraser ----

let eraser: EraserSettings = parseEraser(readStored(ERASER_KEY))
function applyEraser(next: EraserSettings) {
  eraser = next
  surface.eraserMode = eraser.mode
  surface.eraserRadiusPx = ERASER_SIZES[eraser.size]
  writeStored(ERASER_KEY, JSON.stringify(eraser))
}

function buildEraserEditor(root: HTMLElement) {
  const sizes = el('div', { className: 'choices sizes' })
  const modes = el('div', { className: 'segmented' })
  const show = () => {
    for (const b of sizes.children) b.classList.toggle('current', (b as HTMLElement).dataset.size === eraser.size)
    for (const b of modes.children) b.classList.toggle('current', (b as HTMLElement).dataset.mode === eraser.mode)
  }
  for (const size of Object.keys(ERASER_SIZES) as EraserSize[]) {
    const b = el('button', { title: size })
    b.dataset.size = size
    const d = `${ERASER_SIZES[size] * 1.2}px`
    b.append(el('span', { className: 'ring' }, { width: d, height: d }))
    b.addEventListener('click', () => { applyEraser({ ...eraser, size }); show() })
    sizes.append(b)
  }
  for (const [mode, label] of [['partial', 'Partial'], ['stroke', 'Whole stroke']] as const) {
    const b = el('button', { textContent: label })
    b.dataset.mode = mode
    b.addEventListener('click', () => { applyEraser({ ...eraser, mode }); show() })
    modes.append(b)
  }
  root.append(el('h4', { textContent: 'Eraser' }), sizes, modes)
  show()
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button.tool')) {
  button.addEventListener('click', () => {
    const tool = button.dataset.tool as Tool
    if (tool === 'eraser' && surface.tool === 'eraser') togglePopover('eraser', button, buildEraserEditor)
    else { closePopover(); surface.setTool(tool) }
  })
}

// ---- Page paper ----

function buildPageEditor(root: HTMLElement) {
  const colors = el('div', { className: 'choices papers' })
  const patterns = el('div', { className: 'choices patterns' })
  const show = () => {
    for (const b of colors.children) b.classList.toggle('current', (b as HTMLElement).dataset.paper === surface.paper.color)
    for (const b of patterns.children) {
      const pattern = (b as HTMLElement).dataset.pattern as PaperPattern
      b.classList.toggle('current', pattern === surface.paper.pattern)
      const tile = b.firstElementChild as HTMLElement
      tile.className = `tile pattern-${pattern}${PAPER_COLORS[surface.paper.color].dark ? ' dark' : ''}`
      tile.style.background = PAPER_COLORS[surface.paper.color].fill
    }
  }
  for (const color of Object.keys(PAPER_COLORS) as PaperColor[]) {
    const spec = PAPER_COLORS[color]
    const b = el('button', { title: spec.label })
    b.dataset.paper = color
    b.append(el('span', { className: 'tile' }, { background: spec.fill }), el('span', { textContent: spec.label }))
    b.addEventListener('click', () => { surface.setPaper({ ...surface.paper, color }); show() })
    colors.append(b)
  }
  for (const pattern of Object.keys(PAPER_PATTERNS) as PaperPattern[]) {
    const b = el('button', { title: PAPER_PATTERNS[pattern].label })
    b.dataset.pattern = pattern
    b.append(el('span', { className: 'tile' }), el('span', { textContent: PAPER_PATTERNS[pattern].label }))
    b.addEventListener('click', () => { surface.setPaper({ ...surface.paper, pattern }); show() })
    patterns.append(b)
  }
  root.append(el('h4', { textContent: 'Paper' }), colors, el('h4', { textContent: 'Pattern' }), patterns)
  show()
}
$('page').addEventListener('click', () => togglePopover('page', $('page'), buildPageEditor))

// ---- Popover (one at a time; tap outside to close; changes apply immediately) ----

const popover = $<HTMLDivElement>('preset-editor')
let popoverKey: string | null = null

function togglePopover(key: string, anchor: HTMLElement, build: (root: HTMLElement) => void) {
  setMenu(false)
  if (popoverKey === key) { closePopover(); return }
  popoverKey = key
  popover.replaceChildren()
  build(popover)
  const rect = anchor.getBoundingClientRect()
  popover.hidden = false
  const left = rect.left + rect.width / 2 - popover.offsetWidth / 2
  popover.style.left = `${Math.max(8, Math.min(left, window.innerWidth - popover.offsetWidth - 8))}px`
  popover.style.top = `${rect.bottom + 12}px`
}

function closePopover() { popover.hidden = true; popoverKey = null }

// ---- Zoom ----

$('zoom-in').addEventListener('click', () => surface.zoomStep(1))
$('zoom-out').addEventListener('click', () => surface.zoomStep(-1))
zoomLabel.addEventListener('click', () => surface.zoomTo(1))
$('fit').addEventListener('click', () => surface.fitToContent(true))

// ---- Engine lab menu ----

const menu = $<HTMLDivElement>('menu')
const menuButton = $<HTMLButtonElement>('menu-button')
function setMenu(open: boolean) {
  menu.hidden = !open
  menuButton.classList.toggle('active', open)
  menuButton.setAttribute('aria-expanded', String(open))
}
menuButton.addEventListener('click', () => { closePopover(); setMenu(menu.hidden) })

function setStats(show: boolean) {
  stats.hidden = !show
  $('stats-toggle').textContent = show ? 'Hide stats' : 'Show stats'
  writeStored(STATS_KEY, show ? '1' : '0')
}
$('stats-toggle').addEventListener('click', () => setStats(stats.hidden))

document.addEventListener('pointerdown', e => {
  const target = e.target as Element
  if (popoverKey && !popover.contains(target) && !target.closest('[data-popover-anchor]')) closePopover()
  if (!menu.hidden && !menu.contains(target) && !menuButton.contains(target)) setMenu(false)
})

$('undo').addEventListener('click', () => surface.undo())
$('redo').addEventListener('click', () => surface.redo())
$('gen').addEventListener('click', () => {
  setMenu(false)
  const extra = generateStrokes(3000, {
    seed: Date.now() % 100000,
    offsetY: (surface.doc.contentBounds()?.maxY ?? 0) + 40,
    idPrefix: `gen${Date.now().toString(36)}`,
  })
  surface.addStrokes(extra)
  surface.fitToContent(true)
})
$('bench').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('bench')
  setMenu(false)
  setStats(true)
  button.disabled = true
  benchText = 'pan benchmark running…'
  const result: PanBenchmark = await surface.benchmarkPan()
  lastBench = {
    zoom: surface.camera.z, strokesVisible: result.drawn, usedGestureSnapshot: result.cached,
    frameIntervalMs: summary(result.intervals), drawSubmitMs: summary(result.drawMs), finalRedrawMs: result.finalRedrawMs,
  }
  benchText = `pan benchmark, ${result.drawn} strokes in view @ z=${surface.camera.z.toFixed(2)}${result.cached ? ' (snapshot)' : ''}\n  frame interval ${pct(result.intervals)}\n  draw submit    ${pct(result.drawMs)}\n  final redraw   ${fmt(result.finalRedrawMs)} ms`
  button.disabled = false
})
function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
$('export').addEventListener('click', () => download('nova-ink-engine-page', serializePage(surface.doc.strokes, surface.paper)))
const summary = (s: Samples) => ({ count: s.total, p50: s.percentile(50), p95: s.percentile(95), max: s.max() })
$('results').addEventListener('click', () => {
  const m = surface.metrics
  download('nova-ink-engine-results', {
    recordedAt: new Date().toISOString(),
    session: { startedAt: sessionStartedAt, restoredFromDraft: restoredStrokes },
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height },
    capabilities: surface.capabilities(),
    strokes: surface.doc.size,
    paper: surface.paper,
    inputToFrameMs: summary(m.inputToFrameMs), frameMs: summary(m.frameMs), sceneMs: summary(m.sceneMs),
    gestureFrameMs: summary(m.gestureFrameMs), samplesPerEvent: summary(m.samplesPerEvent),
    panBenchmark: lastBench,
  })
})
$<HTMLInputElement>('import').addEventListener('change', async e => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  setMenu(false)
  input.value = ''
  if (!file) return
  let data: unknown
  try { data = JSON.parse(await file.text()) } catch { setDraft('Import failed: not JSON', true); return }
  const result = parsePage(data)
  if (!result.ok) { setDraft(`Import refused: ${result.message}`, true); return }
  surface.setPaper(result.paper)
  surface.load(result.strokes)
  surface.fitToContent()
})
$('clear').addEventListener('click', () => {
  setMenu(false)
  if (!surface.doc.size) return
  surface.clearPage()
  setDraft('Page cleared · Undo brings it back')
})

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePopover(); setMenu(false); return }
  if (!(e.ctrlKey || e.metaKey)) return
  const key = e.key.toLowerCase()
  if (key === 'z') { e.preventDefault(); if (e.shiftKey) surface.redo(); else surface.undo() }
  else if (key === 'y') { e.preventDefault(); surface.redo() }
  else if (key === '=' || key === '+') { e.preventDefault(); surface.zoomStep(1) }
  else if (key === '-') { e.preventDefault(); surface.zoomStep(-1) }
  else if (key === '0') { e.preventDefault(); surface.zoomTo(1) }
})
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft() })
window.addEventListener('pagehide', () => saveDraft())

const fmt = (v: number) => Number.isFinite(v) ? v.toFixed(1) : '–'
const pct = (s: Samples) => `p50 ${fmt(s.percentile(50))} p95 ${fmt(s.percentile(95))} max ${fmt(s.max())}`

setInterval(() => {
  if (stats.hidden) return
  const m = surface.metrics
  const c = surface.capabilities()
  stats.textContent = [
    `strokes ${surface.doc.size} · drawn ${surface.lastDrawnCount} · zoom ${surface.camera.z.toFixed(2)}`,
    `input→frame ms ${pct(m.inputToFrameMs)}`,
    `frame ms       ${pct(m.frameMs)}`,
    `gesture ms     ${pct(m.gestureFrameMs)}`,
    `full redraw ms ${pct(m.sceneMs)}`,
    `samples/event  ${pct(m.samplesPerEvent)}`,
    `pointers ${c.pointerTypesSeen.join(',') || '–'} · pen samples ${c.penSamples} · max pressure ${c.maxPressureSeen.toFixed(2)}`,
    `coalesced ${c.coalescedEvents} · predicted ${c.predictedEvents} · altitude ${c.altitudeAngle} · dpr ${c.devicePixelRatio}`,
    benchText,
  ].filter(Boolean).join('\n')
}, 500)

applyEraser(eraser)
applyPresets(presets)
setStats(readStored(STATS_KEY) === '1')
restoreDraft()
