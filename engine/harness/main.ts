import { generateStrokes } from '../src/dev/generate'
import { InkSurface } from '../src/dom/surface'
import type { PanBenchmark } from '../src/dom/surface'
import { parsePage, serializePage } from '../src/core/format'
import type { Samples } from '../src/core/metrics'
import { $, mountTools, readStored, writeStored } from './tools'

// Harness-only scratch draft. Never a NOVA notebook; real notebooks live on the NOVA server.
const DRAFT_KEY = 'nova-ink-engine-harness:draft:v1'
const STATS_KEY = 'nova-ink-engine-harness:stats:v1'

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

const menu = $<HTMLDivElement>('menu')
const menuButton = $<HTMLButtonElement>('menu-button')
function setMenu(open: boolean) {
  menu.hidden = !open
  menuButton.classList.toggle('active', open)
  menuButton.setAttribute('aria-expanded', String(open))
}
const tools = mountTools(surface, { storagePrefix: 'nova-ink-engine-harness', onOpenPopover: () => setMenu(false) })

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

surface.onChange(() => {
  if (draftKey() !== draftSaved) {
    setDraft('Unsaved local changes')
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(saveDraft, 600)
  }
})

// ---- Engine lab menu ----

menuButton.addEventListener('click', () => { tools.closePopover(); setMenu(menu.hidden) })

function setStats(show: boolean) {
  stats.hidden = !show
  $('stats-toggle').textContent = show ? 'Hide stats' : 'Show stats'
  writeStored(STATS_KEY, show ? '1' : '0')
}
$('stats-toggle').addEventListener('click', () => setStats(stats.hidden))

document.addEventListener('pointerdown', e => {
  const target = e.target as Element
  if (!menu.hidden && !menu.contains(target) && !menuButton.contains(target)) setMenu(false)
})
window.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false) })

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

setStats(readStored(STATS_KEY) === '1')
restoreDraft()
