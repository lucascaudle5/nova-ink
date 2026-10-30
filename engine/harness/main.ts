import { generateStrokes } from '../src/dev/generate'
import { InkSurface } from '../src/dom/surface'
import { parsePage, serializePage } from '../src/core/format'
import type { Tool } from '../src/core/input'
import type { Samples } from '../src/core/metrics'

// Harness-only scratch draft. Never a NOVA notebook; real notebooks live on the NOVA server.
const DRAFT_KEY = 'nova-ink-engine-harness:draft:v1'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const surface = new InkSurface($('surface'))
const draftLabel = $<HTMLSpanElement>('draft')
const stats = $<HTMLElement>('stats')
let benchText = ''
let draftTimer: ReturnType<typeof setTimeout> | null = null
let draftRevision = -1

function setDraft(text: string, bad = false) {
  draftLabel.textContent = text
  draftLabel.classList.toggle('bad', bad)
}

function restoreDraft() {
  let text: string | null = null
  try { text = localStorage.getItem(DRAFT_KEY) } catch { setDraft('Local draft unavailable', true); return }
  if (!text) { setDraft('No local draft'); return }
  let data: unknown
  try { data = JSON.parse(text) } catch { setDraft('Local draft is damaged; not loaded', true); return }
  const result = parsePage(data)
  if (!result.ok) { setDraft(`Local draft not loaded: ${result.message}`, true); return }
  surface.load(result.strokes)
  surface.fitToContent()
  draftRevision = surface.doc.revision
  setDraft(`Restored local draft (${result.strokes.length} strokes)`)
}

function saveDraft() {
  draftTimer = null
  if (surface.doc.revision === draftRevision) return
  const revision = surface.doc.revision
  const start = performance.now()
  const text = JSON.stringify(serializePage(surface.doc.strokes))
  const ms = performance.now() - start
  try {
    localStorage.setItem(DRAFT_KEY, text)
    draftRevision = revision
    setDraft(`Draft saved locally · ${(text.length / 1024).toFixed(0)} KB · ${ms.toFixed(1)} ms`)
  } catch {
    setDraft(`Draft NOT saved locally (${(text.length / 1048576).toFixed(1)} MB; browser storage full)`, true)
  }
}

surface.onChange(() => {
  ($('undo') as HTMLButtonElement).disabled = !surface.history.canUndo
  ;($('redo') as HTMLButtonElement).disabled = !surface.history.canRedo
  for (const b of document.querySelectorAll<HTMLButtonElement>('button.tool')) b.classList.toggle('active', b.dataset.tool === surface.tool)
  if (surface.doc.revision !== draftRevision) {
    setDraft('Unsaved local changes')
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(saveDraft, 600)
  }
})

for (const button of document.querySelectorAll<HTMLButtonElement>('button.tool')) {
  button.addEventListener('click', () => surface.setTool(button.dataset.tool as Tool))
}
$('undo').addEventListener('click', () => surface.undo())
$('redo').addEventListener('click', () => surface.redo())
$('fit').addEventListener('click', () => surface.fitToContent())
$('gen').addEventListener('click', () => {
  const extra = generateStrokes(3000, {
    seed: Date.now() % 100000,
    offsetY: (surface.doc.contentBounds()?.maxY ?? 0) + 40,
    idPrefix: `gen${Date.now().toString(36)}`,
  })
  surface.load([...surface.doc.strokes, ...extra])
  surface.fitToContent()
})
$('bench').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('bench')
  button.disabled = true
  benchText = 'pan benchmark running…'
  const { intervals, drawMs, drawn } = await surface.benchmarkPan()
  lastBench = {
    zoom: surface.camera.z, strokesVisible: drawn,
    frameIntervalMs: { p50: intervals.percentile(50), p95: intervals.percentile(95), max: intervals.max() },
    drawSubmitMs: { p50: drawMs.percentile(50), p95: drawMs.percentile(95), max: drawMs.max() },
  }
  benchText = `pan benchmark, up to ${drawn} strokes visible @ z=${surface.camera.z.toFixed(2)}\n  frame interval ${pct(intervals)}\n  draw submit    ${pct(drawMs)}`
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
$('export').addEventListener('click', () => download('nova-ink-engine-page', serializePage(surface.doc.strokes)))
let lastBench: unknown = null
$('results').addEventListener('click', () => {
  const summary = (s: Samples) => ({ count: s.total, p50: s.percentile(50), p95: s.percentile(95), max: s.max() })
  const m = surface.metrics
  download('nova-ink-engine-results', {
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height },
    capabilities: surface.capabilities(),
    strokes: surface.doc.size,
    inputToFrameMs: summary(m.inputToFrameMs), frameMs: summary(m.frameMs), sceneMs: summary(m.sceneMs), samplesPerEvent: summary(m.samplesPerEvent),
    panBenchmark: lastBench,
  })
})
$<HTMLInputElement>('import').addEventListener('change', async e => {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  let data: unknown
  try { data = JSON.parse(await file.text()) } catch { setDraft('Import failed: not JSON', true); return }
  const result = parsePage(data)
  if (!result.ok) { setDraft(`Import refused: ${result.message}`, true); return }
  surface.load(result.strokes)
  surface.fitToContent()
})
$('clear').addEventListener('click', () => {
  const button = $<HTMLButtonElement>('clear')
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1'; button.textContent = 'Tap again to clear'
    setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Clear' }, 4000)
    return
  }
  button.dataset.armed = ''; button.textContent = 'Clear'
  surface.load([])
})
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
  e.preventDefault()
  if (e.shiftKey) surface.redo(); else surface.undo()
})
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft() })
window.addEventListener('pagehide', () => saveDraft())

const fmt = (v: number) => Number.isFinite(v) ? v.toFixed(1) : '–'
const pct = (s: Samples) => `p50 ${fmt(s.percentile(50))} p95 ${fmt(s.percentile(95))} max ${fmt(s.max())}`

setInterval(() => {
  const m = surface.metrics
  const c = surface.capabilities()
  stats.textContent = [
    `strokes ${surface.doc.size} · drawn ${surface.lastDrawnCount} · zoom ${surface.camera.z.toFixed(2)}`,
    `input→frame ms ${pct(m.inputToFrameMs)}`,
    `frame ms       ${pct(m.frameMs)}`,
    `full redraw ms ${pct(m.sceneMs)}`,
    `samples/event  ${pct(m.samplesPerEvent)}`,
    `pointers ${c.pointerTypesSeen.join(',') || '–'} · pen samples ${c.penSamples} · max pressure ${c.maxPressureSeen.toFixed(2)}`,
    `coalesced ${c.coalescedEvents} · predicted ${c.predictedEvents} · altitude ${c.altitudeAngle} · dpr ${c.devicePixelRatio}`,
    benchText,
  ].filter(Boolean).join('\n')
}, 500)

restoreDraft()
