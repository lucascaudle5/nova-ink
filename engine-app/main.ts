import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps'
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { PAPER_COLORS, PAPER_PATTERNS } from '../engine/src/core/paper'
import type { Paper, PaperColor, PaperPattern } from '../engine/src/core/paper'
import { InkSurface } from '../engine/src/dom/surface'
import { $, el, mountTools, readStored, writeStored } from '../engine/harness/tools'
import { MAX_WIDTH, MIN_WIDTH, PALETTE } from '../engine/harness/presets'
import { MockServer } from './mock-server'
import { ASK_DISCLOSURE, askMessage, askRefusal, blobToBase64, HELP_LEVELS, HELP_ORDER, MAX_IMAGE_BASE64, MAX_QUESTION } from './ask'
import type { AskInput, AskScope, HelpLevel } from './ask'
import type { Bounds } from '../engine/src/core/types'
import { JobRunner } from './jobs'
import { isPdf, openPdf, PAGE_UNITS_PER_POINT, PDF_MAX_PAGES, PDF_MAX_SIDE } from './pdf'
import type { PdfDocument, RenderedPdfPage } from './pdf'
import { NotebookSession } from './session'
import type { Api, Data, FolderInfo, NotebookInfo, PageEditor, PageInfo, SessionState, Status } from './session'
import '../engine/harness/harness.css'
import './app.css'

const VERSION = '0.3.0-engine'
const CLIENT_KEY = 'nova-ink-engine:client-id'
const preview = window.parent === window || new URLSearchParams(location.search).has('mock')

/** Reused across reopenings when storage is allowed, so a quick reopen keeps editing control. */
function persistentClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_KEY)
    if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing
    const fresh = crypto.randomUUID()
    localStorage.setItem(CLIENT_KEY, fresh)
    return fresh
  } catch { return crypto.randomUUID() }
}

function hostApi(app: App): Api {
  return async (name, args) => {
    const result = await app.callServerTool({ name, arguments: args })
    const data = result.structuredContent as Data | undefined
    if (result.isError || !data || typeof data.ok !== 'boolean') {
      const text = result.content?.find(item => item.type === 'text')
      throw new Error(text && 'text' in text ? String(text.text) : `${name}: no valid server response`)
    }
    return data
  }
}

// ---- Drawing surface and tools ----

const surface = new InkSurface($('surface'))
const pagesPanel = $<HTMLElement>('pages')
const menu = $<HTMLDivElement>('menu')
const pagesButton = $<HTMLButtonElement>('pages-button')
const menuButton = $<HTMLButtonElement>('menu-button')

function closePanels(except?: HTMLElement) {
  for (const [panel, button] of [[pagesPanel, pagesButton], [menu, menuButton]] as const) {
    if (panel === except) continue
    panel.hidden = true
    button.classList.remove('active')
    button.setAttribute('aria-expanded', 'false')
  }
}
const rail = $<HTMLElement>('rail')
const railHandle = $<HTMLElement>('rail-handle')
const penFlyout = $<HTMLElement>('pen-flyout')
const penDot = $<HTMLElement>('pen-dot')
const RAIL_KEY = 'nova-ink-engine-app:rail-collapsed'

const tools = mountTools(surface, {
  storagePrefix: 'nova-ink-engine-app',
  onOpenPopover: () => closePanels(),
  // Tapping the pen again opens its width and color presets beside the tool rail.
  onReselect: (tool, button) => {
    if (tool === 'pen') { showPenFlyout(penFlyout.hidden, button); return true }
    if (tool === 'select') { showSelectFlyout(selectFlyout.hidden, button); return true }
    return false
  },
  onPenStyle: color => { penDot.style.background = color },
})

// ---- Tool rail (left edge): pen, eraser, select, undo, redo; can be hidden down to one small button ----

function showPenFlyout(open: boolean, anchor?: HTMLElement) {
  if (open) {
    showSelectFlyout(false)
    closePanels()
    tools.closePopover()
    const rect = (anchor ?? document.querySelector<HTMLElement>('button[data-tool="pen"]')!).getBoundingClientRect()
    penFlyout.style.left = `${rect.right + 10}px`
    penFlyout.style.top = `${rect.top}px`
  }
  penFlyout.hidden = !open
  document.querySelector('button[data-tool="pen"]')?.classList.toggle('flyout-open', open)
}

// The select tool's own flyout: how a drag on empty paper selects, a freehand loop or a box.
const selectFlyout = $<HTMLElement>('select-flyout')
const LASSO_KEY = 'nova-ink-engine-app:lasso-shape'

function showSelectFlyout(open: boolean, anchor?: HTMLElement) {
  if (open) {
    showPenFlyout(false)
    closePanels()
    tools.closePopover()
    const rect = (anchor ?? document.querySelector<HTMLElement>('button[data-tool="select"]')!).getBoundingClientRect()
    selectFlyout.style.left = `${rect.right + 10}px`
    selectFlyout.style.top = `${rect.top}px`
  }
  selectFlyout.hidden = !open
  document.querySelector('button[data-tool="select"]')?.classList.toggle('flyout-open', open)
}

function setLassoShape(shape: 'loop' | 'box', remember = true) {
  surface.lassoShape = shape
  for (const b of selectFlyout.querySelectorAll<HTMLButtonElement>('button[data-shape]')) {
    const on = b.dataset.shape === shape
    b.classList.toggle('selected', on)
    b.setAttribute('aria-checked', String(on))
  }
  if (remember) writeStored(LASSO_KEY, shape)
}
for (const b of selectFlyout.querySelectorAll<HTMLButtonElement>('button[data-shape]')) b.addEventListener('click', () => { setLassoShape(b.dataset.shape as 'loop' | 'box'); showSelectFlyout(false) })
setLassoShape(readStored(LASSO_KEY) === 'box' ? 'box' : 'loop', false)
document.addEventListener('pointerdown', e => {
  const target = e.target as Element
  if (selectFlyout.hidden || selectFlyout.contains(target) || target.closest('button[data-tool="select"]')) return
  showSelectFlyout(false)
})
surface.onChange(() => { if (!selectFlyout.hidden && surface.tool !== 'select') showSelectFlyout(false) })

function setRailCollapsed(collapsed: boolean) {
  rail.hidden = collapsed
  railHandle.hidden = !collapsed
  if (collapsed) { showPenFlyout(false); showSelectFlyout(false); tools.closePopover() }
  writeStored(RAIL_KEY, collapsed ? '1' : '0')
}
$('rail-collapse').addEventListener('click', () => setRailCollapsed(true))
$('rail-expand').addEventListener('click', () => setRailCollapsed(false))
if (readStored(RAIL_KEY) === '1') setRailCollapsed(true)

// The flyout closes when you tap anywhere else (the width/color editor popover counts as inside), switch tool, or press Escape.
document.addEventListener('pointerdown', e => {
  const target = e.target as Element
  if (penFlyout.hidden || penFlyout.contains(target) || target.closest('#preset-editor') || target.closest('button[data-tool="pen"]')) return
  showPenFlyout(false)
})
surface.onChange(() => { if (!penFlyout.hidden && surface.tool !== 'pen') showPenFlyout(false) })
window.addEventListener('keydown', e => { if (e.key === 'Escape') { showPenFlyout(false); showSelectFlyout(false) } })

const editor: PageEditor = {
  items: () => [...surface.doc.images, ...surface.doc.strokes],
  paper: () => surface.paper,
  camera: () => surface.camera,
  load(strokes, images, paper, camera) {
    surface.setPaper(paper)
    surface.load(strokes, images)
    if (camera) surface.setCamera(camera)
    else surface.fitToContent()
    loadPictures(images.map(i => i.image))
  },
  applyPlan: plan => surface.applyPlan(plan),
  busy: () => surface.busy,
  setReadOnly(readOnly) {
    surface.readOnly = readOnly
    document.body.classList.toggle('read-only', readOnly)
    for (const b of document.querySelectorAll<HTMLButtonElement>('.rail button:not(#rail-collapse):not(#rail-expand), #page, #insert-image')) b.disabled = readOnly
    if (readOnly) tools.closePopover()
  },
}

// ---- Host connection ----

let app: App | null = null
let host: McpUiHostContext | undefined
let api: Api
if (preview) {
  const mock = new MockServer({ clock: () => Date.now() })
  mock.latencyMs = 120
  if (new URLSearchParams(location.search).has('demo')) {
    const physics = mock.id(), math = mock.id()
    mock.folders.push({ id: physics, name: 'Physics', deletedAt: null }, { id: math, name: 'Math 241', deletedAt: null })
    for (const [name, folderId, color] of [['Dynamics HW', physics, '#b8432f'], ['Lab notebook', physics, '#1f7a5c'], ['Calc III lectures', math, '#6b4fa3'], ['Ideas', null, '#d08a1e']] as const) {
      mock.addPage(mock.addNotebook(name, folderId, color), 'Page 1')
    }
  }
  api = mock.api
  ;(window as unknown as { novaMock: MockServer }).novaMock = mock
} else {
  app = new App({ name: 'NOVA Ink', version: VERSION }, { availableDisplayModes: ['inline', 'fullscreen'] })
  api = hostApi(app)
}

/** The angle shown while a picture is being turned by its handle, or null. */
let turning: number | null = null

const session = new NotebookSession({ api, clientId: persistentClientId(), editor })
surface.onChange(() => { session.changed(); renderSelectionBar(); renderSnipBar() })

// ---- Pictures ----

/** Decoded pictures by stored id; a page shows a placeholder box until its picture is here. */
const pictures = new Map<string, ImageBitmap | 'loading' | 'failed'>()
surface.setImageSource(id => { const p = pictures.get(id); return p && typeof p !== 'string' ? p : null })

function loadPictures(ids: string[]) {
  const wanted = [...new Set(ids)].filter(id => !pictures.has(id) || pictures.get(id) === 'failed')
  for (const id of wanted) pictures.set(id, 'loading')
  // Two at a time, so a page full of pictures does not flood the connection.
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const id = wanted[next++]
      const stored = await session.fetchImage(id)
      try {
        if (!stored) throw new Error('unavailable')
        pictures.set(id, await createImageBitmap(new Blob([stored.bytes as BlobPart], { type: stored.mime })))
      } catch { pictures.set(id, 'failed') }
      surface.imagesChanged()
    }
  }
  void Promise.all([worker(), worker()])
}

/** Longest side of a stored picture; enough for a full-screen iPad view, small enough to upload quickly. */
const PICTURE_MAX_SIDE = 2048

/** Decodes the chosen file and re-encodes it at most PICTURE_MAX_SIDE pixels on its longest side. */
async function preparePicture(file: File): Promise<{ bitmap: ImageBitmap; bytes: Uint8Array; mime: string }> {
  const source = await createImageBitmap(file)
  const k = Math.min(1, PICTURE_MAX_SIDE / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * k)), h = Math.max(1, Math.round(source.height * k))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  canvas.getContext('2d')!.drawImage(source, 0, 0, w, h)
  source.close()
  const encode = (type: string, quality?: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality))
  // PNG keeps screenshots and diagrams sharp (and transparent); photos, or PNGs that come out large, become JPEG.
  let blob = file.type === 'image/png' ? await encode('image/png') : null
  if (!blob || blob.size > 3 * 1024 * 1024) blob = await encode('image/jpeg', 0.86)
  if (!blob) throw new Error('This browser could not encode the picture.')
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/jpeg' }
}

/** JPEG bytes of a rendered PDF page, plus a bitmap for drawing it right away. */
async function encodePage(canvas: HTMLCanvasElement): Promise<{ bitmap: ImageBitmap; bytes: Uint8Array; mime: string }> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new Error('This browser could not encode the page.')
  return { bitmap: await createImageBitmap(canvas), bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' }
}

/** Each PDF page becomes a picture; they are placed in a column, as one undoable step, once all are stored. */
async function importPdf(file: File) {
  const state = session.getState()
  const stillHere = () => { const now = session.getState(); return now.pageId === state.pageId && now.editable && !now.conflict }
  session.say('Opening the PDF…')
  let pdf: PdfDocument
  try { pdf = await openPdf(new Uint8Array(await file.arrayBuffer())) } catch (error) {
    session.say(`That PDF could not be opened (${error instanceof Error ? error.message : String(error)}). Nothing was added.`)
    return
  }
  const placed: { image: string; w: number; h: number }[] = []
  const count = Math.min(pdf.pageCount, PDF_MAX_PAGES)
  // Keep the original file too, so NOVA can later place its pages and problems from it. A failure only means NOVA cannot.
  session.say('Keeping the original PDF…')
  const original = await session.uploadSource(new Uint8Array(await file.arrayBuffer()), file.name, pdf.pageCount)
  const provenance: Array<{ imageId: string; page: number }> = []
  try {
    for (let n = 1; n <= count; n++) {
      if (!stillHere()) { session.say('The page changed while the PDF was importing, so nothing was placed.'); return }
      const label = `PDF page ${n} of ${count}`
      session.say(`Preparing ${label}…`)
      let prepared: Awaited<ReturnType<typeof encodePage>>, page: RenderedPdfPage
      try {
        page = await pdf.render(n)
        prepared = await encodePage(page.canvas)
        page.canvas.width = page.canvas.height = 0
      } catch (error) {
        session.say(`${label} could not be read (${error instanceof Error ? error.message : String(error)}). Nothing was added.`)
        return
      }
      const { bitmap, bytes, mime } = prepared
      const imageId = await session.uploadImage({ bytes, mime, width: bitmap.width, height: bitmap.height }, (done, total) => session.say(`Uploading ${label}… ${Math.round((done / total) * 100)}%`))
      if (!imageId) { bitmap.close(); return }
      pictures.set(imageId, bitmap)
      provenance.push({ imageId, page: n })
      placed.push({ image: imageId, w: page.widthPt * PAGE_UNITS_PER_POINT, h: page.heightPt * PAGE_UNITS_PER_POINT })
    }
    if (!stillHere()) { session.say('The PDF pages were stored, but this page can no longer be edited here, so they were not placed.'); return }
    surface.insertImageColumn(placed)
    if (original) for (const p of provenance) void session.setImageMeta(p.imageId, { sourceId: original, sourceName: file.name, page: p.page })
    if (pdf.pageCount > count) session.say(`Added the first ${count} of ${pdf.pageCount} PDF pages; import the rest from a shorter PDF.`)
  } finally {
    void pdf.close()
  }
}

let inserting = false
async function insertPicture(file: File) {
  const state = session.getState()
  if (inserting || !state.pageId || !state.editable || state.conflict) return
  if (isPdf(file)) {
    inserting = true
    renderSelectionBar()
    try { await importPdf(file) } finally { inserting = false; renderSelectionBar() }
    return
  }
  inserting = true
  renderSelectionBar()
  try {
    session.say('Preparing the picture…')
    let prepared: Awaited<ReturnType<typeof preparePicture>>
    try { prepared = await preparePicture(file) } catch (error) {
      session.say(`That file could not be opened as a picture (${error instanceof Error ? error.message : String(error)}). Nothing was added.`)
      return
    }
    const { bitmap, bytes, mime } = prepared
    const imageId = await session.uploadImage({ bytes, mime, width: bitmap.width, height: bitmap.height }, (done, count) => session.say(`Uploading the picture… ${Math.round((done / count) * 100)}%`))
    if (!imageId) { bitmap.close(); return }
    pictures.set(imageId, bitmap)
    const now = session.getState()
    if (now.pageId !== state.pageId || !now.editable || now.conflict) { session.say('The picture was stored, but this page can no longer be edited here, so it was not placed.'); return }
    surface.insertImage(imageId, bitmap.width, bitmap.height)
  } finally {
    inserting = false
    renderSelectionBar()
  }
}

const imageFile = $<HTMLInputElement>('image-file')
$('insert-image').addEventListener('click', () => { tools.closePopover(); imageFile.value = ''; imageFile.click() })
imageFile.addEventListener('change', () => { const file = imageFile.files?.[0]; if (file) void insertPicture(file) })
$('sel-turn').addEventListener('click', () => surface.rotateSelection())
$('sel-duplicate').addEventListener('click', () => surface.duplicateSelection())
$('sel-delete').addEventListener('click', () => surface.deleteSelection())
$('sel-done').addEventListener('click', () => surface.setTool('pen'))
$('sel-ask').addEventListener('click', () => askSheet())
$('sel-style').addEventListener('click', () => tools.togglePopover('selection-style', $('sel-style'), buildSelectionStyle))
// While the selection is being turned by its handle, show the angle in the bar.
surface.onTurnPreview = angle => { turning = angle; renderSelectionBar() }

/** The color and width of the selected ink: tap a color, or let go of the slider, to restyle it as one undoable step. */
function buildSelectionStyle(root: HTMLElement) {
  const palette = el('div', { className: 'palette' })
  const value = el('span')
  const slider = el('input', { type: 'range', min: String(MIN_WIDTH), max: String(MAX_WIDTH), step: '0.1' })
  const show = () => {
    const style = surface.selectionStyle
    for (const b of palette.children) b.classList.toggle('current', !!style && (b as HTMLElement).dataset.color === style.color)
    if (style?.width != null) { slider.value = String(style.width); value.textContent = style.width.toFixed(1) } else value.textContent = 'mixed'
  }
  for (const c of PALETTE) {
    const b = el('button', { title: c }, { background: c })
    b.dataset.color = c
    b.addEventListener('click', () => { surface.restyleSelection({ color: c }); show() })
    palette.append(b)
  }
  slider.addEventListener('input', () => { value.textContent = Number(slider.value).toFixed(1) })
  slider.addEventListener('change', () => { surface.restyleSelection({ width: Math.round(Number(slider.value) * 10) / 10 }); show() })
  const title = el('h4', { textContent: 'Width' })
  title.append(value)
  root.append(el('h4', { textContent: 'Color of the selected ink' }), palette, title, slider)
  show()
}

window.addEventListener('keydown', e => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && surface.tool === 'select' && surface.selectionCount) { e.preventDefault(); surface.deleteSelection() }
  if (e.key === 'Escape' && !typing && sheet.hidden) { if (surface.tool === 'snip') surface.endSnip(); else if (surface.selectionCount) surface.select(null) }
})
if (preview) Object.assign(window, { novaInsertPicture: insertPicture, novaSurface: surface, novaSession: session })

function plural(n: number, one: string, many = one + 's') { return `${n} ${n === 1 ? one : many}` }

function renderSelectionBar() {
  const { strokes, images } = surface.selectionCounts()
  const bar = $('selection-bar')
  bar.hidden = !(strokes + images) || surface.tool !== 'select'
  const parts = [strokes ? plural(strokes, 'stroke') : '', images ? plural(images, 'picture') : ''].filter(Boolean)
  const alone = surface.selectedImage
  const angle = turning ?? alone?.angle ?? 0
  const picked = surface.selection
  const byNova = picked.strokes.length > 0 && picked.strokes.every(s => s.author === 'ai')
  const withNova = !byNova && picked.strokes.some(s => s.author === 'ai')
  $('selection-label').textContent = `${byNova ? 'NOVA drawing: ' : withNova ? 'Includes NOVA drawing: ' : ''}${parts.join(' and ')} selected${angle ? ` · ${Math.round(angle)}°` : ''}`
  $('sel-style').hidden = strokes === 0
  $<HTMLButtonElement>('insert-image').disabled = inserting || surface.readOnly
}

/** Claude overlays its navigation bar and chat input on a full-screen app; only the safe area it reports can be tapped. */
const COMPOSER_FALLBACK = 68

function applyHost(context: McpUiHostContext | undefined) {
  host = context
  const fullscreen = !!app && context?.displayMode === 'fullscreen'
  const inset = context?.safeAreaInsets
  // A full-screen host that reports no bottom inset still draws its chat input over the bottom edge.
  const bottom = inset?.bottom || (fullscreen ? COMPOSER_FALLBACK : 0)
  const root = document.documentElement.style
  root.setProperty('--top', `max(12px, env(safe-area-inset-top), ${(inset?.top ?? 0) + 12}px)`)
  root.setProperty('--bottom', `max(12px, env(safe-area-inset-bottom), ${bottom + 12}px)`)
  root.setProperty('--left', `max(12px, env(safe-area-inset-left), ${(inset?.left ?? 0) + 12}px)`)
  root.setProperty('--right', `max(12px, env(safe-area-inset-right), ${(inset?.right ?? 0) + 12}px)`)
  $('fullscreen-button').hidden = !app || fullscreen || !context?.availableDisplayModes?.includes('fullscreen')
  renderMenu()
}

async function goFullscreen() {
  if (!app || !host?.availableDisplayModes?.includes('fullscreen') || host.displayMode === 'fullscreen') return
  try {
    const { mode } = await app.requestDisplayMode({ mode: 'fullscreen' })
    applyHost({ ...host, displayMode: mode })
  } catch { /* the full-screen button stays available */ }
}
$('fullscreen-button').addEventListener('click', () => void goFullscreen())

// ---- Status pill ----

const LABELS: Record<Status, string> = {
  loading: 'Loading…', saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', notSynced: 'Not synced',
  conflict: 'Not saved', readOnly: 'View only', recovery: 'Recovery needed', trash: 'In the trash',
}
const TONES: Partial<Record<Status, string>> = { saved: 'ok', saving: 'busy', unsaved: 'busy', loading: 'busy', notSynced: 'bad', conflict: 'bad', recovery: 'bad' }

/** A button that needs a second tap within 3 s, for anything that discards work. */
function confirmButton(label: string, confirmLabel: string, action: () => void, className = '') {
  const button = el('button', { textContent: label, className })
  let timer: ReturnType<typeof setTimeout> | null = null
  button.addEventListener('click', () => {
    if (button.dataset.armed === '1') {
      if (timer) clearTimeout(timer)
      button.dataset.armed = '0'
      button.textContent = label
      action()
      return
    }
    button.dataset.armed = '1'
    button.textContent = confirmLabel
    timer = setTimeout(() => { button.dataset.armed = '0'; button.textContent = label }, 3000)
  })
  return button
}
const action = (label: string, run: () => void, className = '') => {
  const button = el('button', { textContent: label, className })
  button.addEventListener('click', run)
  return button
}

function renderStatus(state: SessionState) {
  const footer = document.querySelector<HTMLElement>('footer.status')!
  footer.dataset.tone = TONES[state.status] ?? ''
  const label = LABELS[state.status]
  const detail = state.message && state.message !== label ? state.message : ''
  const text = !detail || detail.startsWith(label) || state.status === 'saved' ? detail || label : `${label}. ${detail}`
  $('status-text').textContent = preview ? `${text} · Preview: test data in memory only` : text
  footer.title = state.lastSavedAt ? `Last saved ${new Date(state.lastSavedAt).toLocaleString()}` : ''
  const actions: HTMLButtonElement[] = []
  const busy = state.busy
  if (state.status === 'readOnly') actions.push(action('Edit here', () => void session.takeOver(), 'primary'))
  if (state.status === 'notSynced' && state.pageId && state.editable) actions.push(action('Retry now', () => void session.save()))
  if (state.status === 'notSynced' && !state.pageId) actions.push(action('Retry', () => void session.start()))
  if (state.status === 'trash' && state.pageId) actions.push(action('Restore page', () => void session.restorePage(state.pageId!), 'primary'))
  if (state.status === 'recovery') actions.push(action('Checkpoints…', () => openMenu(true)))
  if (state.conflict && state.conflict !== 'damaged' || (state.conflict === 'damaged' && state.status === 'conflict')) {
    if (state.conflict === 'lease') actions.push(action('Take over editing', () => void session.takeOver()))
    actions.push(action('Copy to a new page', () => void session.copyToNewPage(), 'primary'))
    actions.push(confirmButton('Discard my changes', 'Tap again to discard', () => void session.reload()))
  }
  for (const b of actions) b.disabled = busy
  $('status-actions').replaceChildren(...actions)
}

// ---- Notebook and page navigation ----

let renaming: string | null = null
let showTrash = false

const icon = (path: string) => {
  const span = el('span')
  span.innerHTML = `<svg viewBox="0 0 24 24">${path}</svg>`
  return span.firstElementChild as SVGElement
}
const ICON_RENAME = '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'
const ICON_TRASH = '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'
const ICON_RESTORE = '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'
const ICON_PLUS = '<path d="M12 5v14M5 12h14"/>'

function livePages(state: SessionState): PageInfo[] {
  return state.notebooks.find(n => n.id === state.notebookId)?.pages.filter(p => !p.deletedAt) ?? []
}

function renameInput(value: string, save: (text: string) => void) {
  const input = el('input', { className: 'rename', value, maxLength: 80 })
  const done = (commit: boolean) => {
    if (renaming === null) return
    renaming = null
    const text = input.value.trim()
    if (commit && text && text !== value) save(text)
    render()
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false) })
  input.addEventListener('blur', () => done(true))
  setTimeout(() => { input.focus(); input.select() })
  return input
}

function iconButton(title: string, path: string, run: () => void, confirm = false) {
  const button = el('button', { className: 'icon', title, ariaLabel: title })
  button.append(icon(path))
  if (!confirm) { button.addEventListener('click', run); return button }
  let timer: ReturnType<typeof setTimeout> | null = null
  button.addEventListener('click', () => {
    if (button.dataset.armed === '1') { if (timer) clearTimeout(timer); run(); return }
    button.dataset.armed = '1'
    button.title = `Tap again: ${title.toLowerCase()}`
    timer = setTimeout(() => { button.dataset.armed = '0'; button.title = title }, 3000)
  })
  return button
}

function renderPages(state: SessionState) {
  const current = state.notebooks.find(n => n.id === state.notebookId)
  const page = session.currentPage
  $('page-title').textContent = page ? `${current?.name ?? 'Notebook'} · ${page.title}` : current?.name ?? 'NOVA Ink'
  const live = livePages(state)
  const index = live.findIndex(p => p.id === state.pageId)
  $<HTMLButtonElement>('prev-page').disabled = state.busy || index <= 0
  $<HTMLButtonElement>('next-page').disabled = state.busy || index < 0 || index >= live.length - 1
  if (pagesPanel.hidden) return

  const header = el('header')
  header.append(el('span', { className: 'title', textContent: current?.name ?? 'Notebook' }))

  const list = el('div', { className: 'list' })
  if (!live.length) list.append(el('div', { className: 'empty', textContent: 'No pages in this notebook.' }))
  for (const p of live) {
    const row = el('div', { className: `row${p.id === state.pageId ? ' current' : ''}` })
    if (renaming === `page:${p.id}`) row.append(renameInput(p.title, title => void session.renamePage(p.id, title)))
    else {
      const open = el('button', { className: 'open', textContent: p.title, title: p.title })
      open.addEventListener('click', () => { if (p.id !== state.pageId) void session.openPage(p.id); else closePanels() })
      row.append(open,
        iconButton('Rename page', ICON_RENAME, () => { renaming = `page:${p.id}`; render() }),
        iconButton('Move page to trash', ICON_TRASH, () => void session.removePage(p.id), true))
    }
    list.append(row)
  }

  if (showTrash && current) {
    list.append(el('div', { className: 'section', textContent: 'Trash' }))
    const trashedPages = current.pages.filter(p => p.deletedAt)
    if (!trashedPages.length) list.append(el('div', { className: 'empty', textContent: 'No pages of this notebook are in the trash.' }))
    for (const p of trashedPages) {
      const row = el('div', { className: 'row trash' })
      row.append(el('button', { className: 'open', textContent: p.title, disabled: true }), iconButton('Restore page', ICON_RESTORE, () => void session.restorePage(p.id)))
      list.append(row)
    }
  }

  const footer = el('footer')
  const add = el('button', { className: 'text primary new-page', disabled: !current || state.busy })
  add.append(icon(ICON_PLUS), el('span', { textContent: 'New page' }))
  add.addEventListener('click', pageSheet)
  footer.append(add)
  footer.append(action(showTrash ? 'Hide trash' : 'Trashed pages', () => { showTrash = !showTrash; render() }))
  for (const b of footer.querySelectorAll('button')) b.classList.add('text')
  pagesPanel.replaceChildren(header, list, footer)
}

pagesButton.addEventListener('click', () => {
  tools.closePopover()
  const open = pagesPanel.hidden
  closePanels(pagesPanel)
  pagesPanel.hidden = !open
  pagesButton.classList.toggle('active', open)
  pagesButton.setAttribute('aria-expanded', String(open))
  if (open) void session.refreshList()
  render()
})
function step(direction: 1 | -1) {
  const state = session.getState()
  const live = livePages(state)
  const target = live[live.findIndex(p => p.id === state.pageId) + direction]
  if (target) void session.openPage(target.id)
}
$('prev-page').addEventListener('click', () => step(-1))
$('next-page').addEventListener('click', () => step(1))

// ---- Library: notebook covers and folders ----

const library = $<HTMLElement>('library')
const sheet = $<HTMLDivElement>('sheet')
const COVERS = ['#2f5d8a', '#1f7a5c', '#b8432f', '#d08a1e', '#6b4fa3', '#2b8a9e', '#c2477a', '#5f6b7a']
const DEFAULT_COVER = COVERS[0]
const LAST_PAGES_KEY = 'nova-ink-engine:last-pages'
const ICON_FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
const ICON_MORE = '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'
const ICON_BACK = '<path d="m15 18-6-6 6-6"/>'

/** null = top level. */
let folderView: string | null = null
let libraryTrash = false

/** The page last open in each notebook on this device, so a notebook reopens where you left it. */
const lastPages: Record<string, string> = (() => { try { return JSON.parse(readStored(LAST_PAGES_KEY) ?? '{}') ?? {} } catch { return {} } })()
function rememberPage(state: SessionState) {
  if (!state.notebookId || !state.pageId || lastPages[state.notebookId] === state.pageId) return
  lastPages[state.notebookId] = state.pageId
  writeStored(LAST_PAGES_KEY, JSON.stringify(lastPages))
}

function editedLabel(iso: string | undefined) {
  if (!iso) return ''
  const d = new Date(iso), now = new Date()
  if (d.toDateString() === now.toDateString()) return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

function showLibrary(open: boolean) {
  library.hidden = !open
  document.body.classList.toggle('in-library', open)
  if (open) { closePanels(); openMenu(false); tools.closePopover(); folderView = null; libraryTrash = false; void session.refreshList() }
  else closeSheet()
  render()
}
$('library-button').addEventListener('click', () => showLibrary(true))

async function openFromLibrary(notebookId: string) {
  const state = session.getState()
  if (notebookId === state.notebookId && (state.pageId || !livePages(state).length)) { showLibrary(false); return }
  if (await session.openNotebook(notebookId, lastPages[notebookId])) showLibrary(false)
}

function cover(n: NotebookInfo) {
  const tile = el('div', { className: `tile notebook${n.id === session.getState().notebookId ? ' current' : ''}` })
  const open = el('button', { className: 'cover', title: `Open ${n.name}`, ariaLabel: `Open ${n.name}` }, { background: n.color ?? DEFAULT_COVER })
  open.append(el('span', { className: 'cover-name', textContent: n.name }))
  open.addEventListener('click', () => void openFromLibrary(n.id))
  const pages = n.pages.filter(p => !p.deletedAt).length
  tile.append(open, caption(n.name, `${editedLabel(n.editedAt)}${n.editedAt ? ' · ' : ''}${pages} ${pages === 1 ? 'page' : 'pages'}`, () => notebookSheet(n)))
  return tile
}

function folderTile(f: FolderInfo, count: number) {
  const tile = el('div', { className: 'tile folder' })
  const open = el('button', { className: 'cover folder-cover', title: `Open folder ${f.name}`, ariaLabel: `Open folder ${f.name}` })
  open.append(icon(ICON_FOLDER))
  open.addEventListener('click', () => { folderView = f.id; render() })
  tile.append(open, caption(f.name, `${count} ${count === 1 ? 'notebook' : 'notebooks'}`, () => folderSheet(f)))
  return tile
}

function caption(name: string, detail: string, more: () => void) {
  const box = el('div', { className: 'caption' })
  const text = el('div', { className: 'caption-text' })
  text.append(el('div', { className: 'caption-name', textContent: name, title: name }), el('div', { className: 'caption-detail', textContent: detail }))
  box.append(text, iconButton(`Options for ${name}`, ICON_MORE, more))
  return box
}

const libraryButton = (label: string, run: () => void, className = '') => action(label, run, `text ${className}`)

function renderLibrary(state: SessionState) {
  if (library.hidden) return
  const folders = state.folders.filter(f => !f.deletedAt)
  if (folderView && !folders.some(f => f.id === folderView)) folderView = null
  const folder = folders.find(f => f.id === folderView)
  const books = state.notebooks.filter(n => !n.deletedAt)

  const title = $('library-title')
  if (libraryTrash || folder) {
    const back = el('button', { className: 'back', title: 'All notebooks', ariaLabel: 'All notebooks' })
    back.append(icon(ICON_BACK))
    back.addEventListener('click', () => { libraryTrash = false; folderView = null; render() })
    title.replaceChildren(back, el('span', { textContent: libraryTrash ? 'Trash' : folder!.name }))
  } else title.replaceChildren(el('span', { textContent: 'Notebooks' }))

  const actions: HTMLButtonElement[] = []
  if (!libraryTrash) {
    if (!folder) actions.push(libraryButton('New folder', () => folderSheet(null)))
    actions.push(libraryButton('New notebook', () => notebookSheet(null), 'primary'))
    actions.push(libraryButton('Trash', () => { libraryTrash = true; render() }))
  }
  if (state.notebookId && books.some(n => n.id === state.notebookId)) actions.push(libraryButton('Done', () => showLibrary(false)))
  $('library-actions').replaceChildren(...actions)

  const grid = $('library-grid')
  const tiles: HTMLElement[] = []
  if (libraryTrash) {
    const trashedBooks = state.notebooks.filter(n => n.deletedAt)
    const trashedFolders = state.folders.filter(f => f.deletedAt)
    for (const f of trashedFolders) tiles.push(trashRow(`Folder: ${f.name}`, () => void session.restoreFolder(f.id)))
    for (const n of trashedBooks) tiles.push(trashRow(n.name, () => void session.restoreNotebook(n.id), n.color))
    if (!tiles.length) tiles.push(el('div', { className: 'library-empty', textContent: 'The trash is empty.' }))
    tiles.push(el('div', { className: 'library-note', textContent: 'Trashed pages are listed in each notebook\'s Pages panel. Restoring a folder does not move notebooks back into it.' }))
  } else {
    if (!folder) for (const f of folders) tiles.push(folderTile(f, books.filter(n => n.folderId === f.id).length))
    const here = books.filter(n => (n.folderId ?? null) === (folder?.id ?? null) || (!folder && n.folderId && !folders.some(f => f.id === n.folderId)))
    for (const n of here) tiles.push(cover(n))
    if (!tiles.length) tiles.push(el('div', { className: 'library-empty', textContent: folder ? 'This folder is empty. Create a notebook here, or move one in from its options.' : 'No notebooks yet.' }))
  }
  grid.className = libraryTrash ? 'library-grid list' : 'library-grid'
  grid.replaceChildren(...tiles)
}

function trashRow(name: string, restore: () => void, color?: string | null) {
  const row = el('div', { className: 'trash-row' })
  row.append(el('span', { className: 'swatch' }, { background: color ?? (name.startsWith('Folder:') ? 'transparent' : DEFAULT_COVER) }), el('span', { className: 'name', textContent: name }), action('Restore', restore, 'text'))
  return row
}

// The sheet is built once per opening (not on every state change), so typing in it is never interrupted.
function closeSheet() { sheet.hidden = true; sheet.replaceChildren() }
function openSheet(heading: string, body: HTMLElement[], buttons: HTMLButtonElement[]) {
  const card = el('div', { className: 'sheet-card' })
  const foot = el('div', { className: 'sheet-buttons' })
  foot.append(...buttons)
  card.append(el('h2', { textContent: heading }), ...body, foot)
  sheet.replaceChildren(card)
  sheet.hidden = false
  const input = card.querySelector('input')
  if (input) setTimeout(() => { input.focus(); input.select() })
}
sheet.addEventListener('pointerdown', e => { if (e.target === sheet) closeSheet() })

function nameField(value: string, placeholder: string, submit: () => void) {
  const input = el('input', { className: 'sheet-name', value, placeholder, maxLength: 80 })
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') closeSheet() })
  return input
}

function swatches(selected: string, pick: (color: string) => void) {
  const row = el('div', { className: 'swatches', role: 'radiogroup', ariaLabel: 'Cover color' })
  for (const c of COVERS) {
    const b = el('button', { className: `swatch${c === selected ? ' selected' : ''}`, title: c, ariaLabel: `Cover color ${c}`, role: 'radio', ariaChecked: String(c === selected) }, { background: c })
    b.addEventListener('click', () => {
      for (const other of row.children) { other.classList.toggle('selected', other === b); other.setAttribute('aria-checked', String(other === b)) }
      pick(c)
    })
    row.append(b)
  }
  return row
}

/** null = a new notebook (created in the folder being viewed). */
function notebookSheet(n: NotebookInfo | null) {
  const state = session.getState()
  let color = n?.color ?? (n ? DEFAULT_COVER : COVERS[state.notebooks.length % COVERS.length])
  const folders = state.folders.filter(f => !f.deletedAt)
  const move = el('select', { className: 'sheet-select', ariaLabel: 'Folder' })
  move.append(el('option', { value: '', textContent: 'No folder' }))
  const inFolder = n ? n.folderId ?? null : folderView
  for (const f of folders) move.append(el('option', { value: f.id, textContent: f.name, selected: f.id === inFolder }))
  const label = (text: string) => el('div', { className: 'sheet-label', textContent: text })

  const submit = async () => {
    const name = input.value.trim()
    if (!name) { input.focus(); return }
    const folderId = move.value || null
    closeSheet()
    if (!n) { if (await session.createNotebook(name, { folderId, color })) showLibrary(false); return }
    const changes: Array<Promise<unknown>> = []
    if (name !== n.name) changes.push(session.renameNotebook(n.id, name))
    if (folderId !== (n.folderId ?? null)) changes.push(session.updateNotebook(n.id, { folderId }))
    await Promise.all(changes)
  }
  const input = nameField(n?.name ?? `Notebook ${state.notebooks.filter(b => !b.deletedAt).length + 1}`, 'Notebook name', () => void submit())
  // An existing notebook's cover changes on the tap, without waiting for Save or the server.
  const pick = (c: string) => { color = c; if (n) void session.updateNotebook(n.id, { color: c }) }
  const body = [label('Name'), input, label('Cover'), swatches(color, pick), label('Folder'), move]
  const buttons = [action(n ? 'Close' : 'Cancel', closeSheet, 'text'), action(n ? 'Save' : 'Create', () => void submit(), 'text primary')]
  if (n) buttons.unshift(confirmButton('Move to trash', 'Tap again to trash it', () => { closeSheet(); void trashNotebook(n.id) }, 'text danger'))
  openSheet(n ? 'Notebook' : 'New notebook', body, buttons)
}

/** New page: name, paper (starts as the open page's) and where it goes. */
function pageSheet() {
  const state = session.getState()
  const live = livePages(state)
  const index = live.findIndex(p => p.id === state.pageId)
  let paper: Paper = { ...surface.paper }
  const label = (text: string) => el('div', { className: 'sheet-label', textContent: text })

  const papers = el('div', { className: 'papers', role: 'radiogroup', ariaLabel: 'Paper' })
  const colors = el('div', { className: 'paper-colors', role: 'radiogroup', ariaLabel: 'Paper color' })
  const paint = () => {
    papers.replaceChildren(...(Object.keys(PAPER_PATTERNS) as PaperPattern[]).map(pattern => {
      const selected = pattern === paper.pattern
      const b = el('button', { className: `paper paper-${pattern}${selected ? ' selected' : ''}${PAPER_COLORS[paper.color].dark ? ' dark' : ''}`, role: 'radio', ariaChecked: String(selected), ariaLabel: PAPER_PATTERNS[pattern].label }, { backgroundColor: PAPER_COLORS[paper.color].fill })
      b.style.setProperty('--rule', PAPER_COLORS[paper.color].major)
      b.append(el('span', { textContent: PAPER_PATTERNS[pattern].label }))
      b.addEventListener('click', () => { paper = { ...paper, pattern }; paint() })
      return b
    }))
    colors.replaceChildren(...(Object.keys(PAPER_COLORS) as PaperColor[]).map(color => {
      const selected = color === paper.color
      const b = el('button', { className: `paper-color${selected ? ' selected' : ''}`, role: 'radio', ariaChecked: String(selected), title: PAPER_COLORS[color].label, ariaLabel: `${PAPER_COLORS[color].label} paper` }, { background: PAPER_COLORS[color].fill })
      b.addEventListener('click', () => { paper = { ...paper, color }; paint() })
      return b
    }))
  }
  paint()

  const where = el('select', { className: 'sheet-select', ariaLabel: 'Position' })
  if (index >= 0 && index < live.length - 1) where.append(el('option', { value: 'after', textContent: `After “${live[index].title}”` }))
  where.append(el('option', { value: 'end', textContent: 'At the end of the notebook' }))

  const submit = async () => {
    const title = input.value.trim()
    if (!title) { input.focus(); return }
    create.disabled = true
    const afterPageId = where.value === 'after' ? live[index].id : live.at(-1)?.id ?? null
    if (await session.addPage({ title, paper, afterPageId })) { closeSheet(); closePanels() }
    else create.disabled = false
  }
  const input = nameField(`Page ${live.length + 1}`, 'Page name', () => void submit())
  const create = action('Add page', () => void submit(), 'text primary')
  const body = [label('Name'), input, label('Paper'), papers, colors, ...(where.options.length > 1 ? [label('Position'), where] : [])]
  openSheet('New page', body, [action('Cancel', closeSheet, 'text'), create])
}

async function trashNotebook(notebookId: string) {
  const state = session.getState()
  const current = state.notebookId === notebookId
  if (current) await session.save()
  const res = await session.removeNotebook(notebookId)
  if (!res.ok || !current) return
  const next = session.getState().notebooks.find(b => !b.deletedAt)
  if (next) void session.openNotebook(next.id, lastPages[next.id])
}

function folderSheet(f: FolderInfo | null) {
  const submit = async () => {
    const name = input.value.trim()
    if (!name) { input.focus(); return }
    closeSheet()
    if (!f) await session.createFolder(name)
    else if (name !== f.name) await session.renameFolder(f.id, name)
  }
  const input = nameField(f?.name ?? 'New folder', 'Folder name', () => void submit())
  const buttons = [action('Cancel', closeSheet, 'text'), action(f ? 'Save' : 'Create', () => void submit(), 'text primary')]
  if (f) buttons.unshift(confirmButton('Delete folder', 'Tap again: its notebooks stay', () => { closeSheet(); void session.removeFolder(f.id) }, 'text danger'))
  const note = el('div', { className: 'sheet-note', textContent: f ? 'Deleting a folder moves it to the trash; its notebooks move to the top level and are not deleted.' : 'Folders hold notebooks. Move a notebook in from its options.' })
  openSheet(f ? 'Folder' : 'New folder', [input, note], buttons)
}

// ---- Ask NOVA ----

let askLevel: HelpLevel = 'nudge'
let askSending = false

/** In the desktop preview nothing is sent; the message is kept here so it can be inspected. */
const askLog: Array<{ role: string; content: Array<{ type: string; text?: string; mimeType?: string; bytes?: number }> }> = []
if (preview) Object.assign(window, { novaAskLog: askLog })

function askInput(question: string, scope: AskScope, area: Bounds | null): AskInput {
  const state = session.getState()
  const notebook = state.notebooks.find(n => n.id === state.notebookId)
  const live = livePages(state)
  const counts = scope === 'selection' ? surface.selectionCounts() : (scope === 'area' || scope === 'page') && area ? surface.areaCounts(area) : surface.viewCounts()
  return {
    scope,
    notebook: notebook?.name ?? 'Notebook', pageTitle: session.currentPage?.title ?? 'Page',
    pageNumber: Math.max(1, live.findIndex(p => p.id === state.pageId) + 1), pageCount: live.length,
    paper: surface.paper, zoom: surface.camera.z, visibleStrokes: counts.strokes, visiblePictures: counts.images,
    helpLevel: askLevel, question,
  }
}

/** Pictures other than the screen are tried at these long-side sizes, largest first, until one fits in the message. */
const ASK_SIZES = [4000, 3000, 2000, 1600]

/** The picture to send, as base64 PNG: the screen, or the selection or a rectangle shrunk until it fits in a message. */
async function renderForAsk(scope: AskScope, area: Bounds | null): Promise<string> {
  if (scope === 'screen') return blobToBase64(await surface.exportView())
  let png = ''
  for (const side of ASK_SIZES) {
    const blob = scope === 'selection' ? surface.exportSelection(side) : area ? surface.exportArea(area, side) : null
    if (!blob) throw new Error('There is nothing to show.')
    png = await blobToBase64(await blob)
    if (png.length <= MAX_IMAGE_BASE64) break
  }
  return png
}

const SCOPE_NOUN: Record<AskScope, string> = { screen: 'the screen', selection: 'the selection', area: 'that area', page: 'the page' }

/** Student-initiated only: this runs when Send is tapped, never on its own. Reports "Sent" or the reason it was not. */
async function sendAsk(question: string, scope: AskScope, say: (text: string, tone?: 'ok' | 'bad') => void, area: Bounds | null = null): Promise<boolean> {
  const input = askInput(question, scope, area)
  const early = askRefusal(input, null)
  if (early) { say(early, 'bad'); return false }
  say('Rendering your work…')
  let png: string
  try { png = await renderForAsk(scope, area) } catch (error) {
    say(`Could not render ${SCOPE_NOUN[scope]}, so nothing was sent (${error instanceof Error ? error.message : String(error)}).`, 'bad')
    return false
  }
  // The student may have moved or edited while the picture was prepared; send what the picture shows.
  const refusal = askRefusal(input, png.length)
  if (refusal) { say(refusal, 'bad'); return false }
  const message = askMessage(input, png)
  if (!app) {
    askLog.push({ role: message.role, content: message.content.map(c => c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image', mimeType: c.mimeType, bytes: c.data.length }) })
    say('Preview: logged in window.novaAskLog; nothing was sent to Claude.', 'ok')
    return true
  }
  const accepts = app.getHostCapabilities()?.message
  if (!accepts || (Object.keys(accepts).length > 0 && !accepts.image)) {
    say('Not sent: this Claude app does not accept pictures from the notebook.', 'bad')
    return false
  }
  say('Sending to Claude…')
  try {
    const answer = await app.sendMessage(message)
    if (answer.isError) throw new Error('Claude did not accept the message')
  } catch (error) {
    say(`Not sent: ${error instanceof Error ? error.message : String(error)}`, 'bad')
    return false
  }
  say('Sent. The answer will appear in the chat.', 'ok')
  return true
}

function askSheet() {
  tools.closePopover()
  closePanels()
  showPenFlyout(false)
  showSelectFlyout(false)
  askSending = false
  const label = (text: string) => el('div', { className: 'sheet-label', textContent: text })
  const hint = el('div', { className: 'ask-hint' })
  const segments = el('div', { className: 'segmented', role: 'radiogroup', ariaLabel: 'Help level' })
  const paintLevels = () => {
    segments.replaceChildren(...HELP_ORDER.map(level => {
      const b = el('button', { className: level === askLevel ? 'selected' : '', textContent: HELP_LEVELS[level].label, role: 'radio', ariaChecked: String(level === askLevel) })
      b.addEventListener('click', () => { askLevel = level; paintLevels() })
      return b
    }))
    hint.textContent = HELP_LEVELS[askLevel].instruction
  }
  paintLevels()
  // With something selected, the picture is the selection unless the student picks the screen.
  let showing: 'screen' | 'selection' = surface.selectionCount ? 'selection' : 'screen'
  const scopeRow = el('div', { className: 'segmented two', role: 'radiogroup', ariaLabel: 'What to show' })
  const paintScope = () => {
    const choices: Array<['screen' | 'selection', string]> = [['screen', 'What is on screen'], ['selection', `Your selection (${surface.selectionCount})`]]
    scopeRow.replaceChildren(...choices.map(([scope, text]) => {
      const b = el('button', { className: scope === showing ? 'selected' : '', textContent: text, role: 'radio', ariaChecked: String(scope === showing) })
      b.addEventListener('click', () => { showing = scope; paintScope() })
      return b
    }))
  }
  paintScope()
  const question = el('textarea', { className: 'ask-question', placeholder: 'Add a note for Claude if you like (optional)', maxLength: MAX_QUESTION, ariaLabel: 'Note (optional)' })
  const result = el('div', { className: 'ask-result', ariaLive: 'polite' })
  const say = (text: string, tone?: 'ok' | 'bad') => { result.textContent = text; if (tone) result.dataset.tone = tone; else delete result.dataset.tone }
  const send = action('Send', async () => {
    if (askSending) return
    askSending = true
    send.disabled = true
    const sent = await sendAsk(question.value, showing, say)
    askSending = false
    send.disabled = false
    if (sent) question.value = ''
  }, 'text primary')
  const choose = action('Choose an area', () => { askNote = question.value.trim(); snipFromSheet = true; closeSheet(); surface.startSnip() }, 'text')
  openSheet('Ask NOVA', [label('Help level'), segments, hint, ...(surface.selectionCount ? [label('Show'), scopeRow] : []), label('Note (optional)'), question, el('div', { className: 'ask-disclosure', textContent: ASK_DISCLOSURE }), result], [action('Close', closeSheet, 'text'), choose, send])
}

// ---- Snip bar: drag a rectangle over the page, pick a level, send just that ----

/** The note typed in the Ask NOVA sheet, carried to the snip bar when the student chooses an area from there. */
let askNote = ''
let snipFromSheet = false
let snipShown = false
let snipSending = false
/** What the last message in the snip bar was about: it is cleared when the page or the rectangle changes. */
let snipMessageKey = ''

function paintSnipLevels() {
  $('snip-levels').replaceChildren(...HELP_ORDER.map(level => {
    const b = el('button', { className: level === askLevel ? 'selected' : '', textContent: HELP_LEVELS[level].label, role: 'radio', ariaChecked: String(level === askLevel) })
    b.addEventListener('click', () => { askLevel = level; paintSnipLevels() })
    return b
  }))
}

function snipSay(text: string, tone?: 'ok' | 'bad') {
  const result = $('snip-result')
  result.textContent = text
  if (tone) result.dataset.tone = tone; else delete result.dataset.tone
}

function renderSnipBar() {
  const on = surface.tool === 'snip'
  $('snip-bar').hidden = !on
  if (on && !snipShown) {
    // Just opened: from the Ask NOVA sheet it keeps that sheet's note; from the rail it starts without one.
    if (!snipFromSheet) askNote = ''
    snipFromSheet = false
    snipSay('')
    paintSnipLevels()
  }
  snipShown = on
  if (!on) return
  const key = session.getState().pageId + JSON.stringify(surface.snipArea)
  if (key !== snipMessageKey) { if (!snipSending) snipSay(''); snipMessageKey = key }
  const note = $('snip-note')
  note.textContent = askNote ? `Note: ${askNote}` : ''
  $<HTMLButtonElement>('snip-send').disabled = snipSending
}

$('snip-cancel').addEventListener('click', () => surface.endSnip())
$('snip-whole').addEventListener('click', () => { if (!surface.snipWholePage()) snipSay('This page is empty, so there is nothing to show Claude.', 'bad') })
$('snip-send').addEventListener('click', async () => {
  const area = surface.snipArea
  if (!area || snipSending) return
  snipSending = true
  renderSnipBar()
  try { await sendAsk(askNote, surface.snipIsWholePage ? 'page' : 'area', snipSay, area) } finally { snipSending = false; renderSnipBar() }
})
$('ask-button').addEventListener('click', askSheet)

// ---- More menu ----

let checkpoints: Array<{ revision: number; savedAt: string; strokeCount: number }> | null = null
let checkpointError = ''

function openMenu(open: boolean) {
  tools.closePopover()
  closePanels(menu)
  menu.hidden = !open
  menuButton.classList.toggle('active', open)
  menuButton.setAttribute('aria-expanded', String(open))
  if (open) {
    checkpoints = null
    checkpointError = ''
    renderMenu()
    void session.listCheckpoints().then(list => { checkpoints = list; renderMenu() }, error => { checkpointError = String(error); renderMenu() })
  }
}
menuButton.addEventListener('click', () => openMenu(menu.hidden))

function renderMenu() {
  if (menu.hidden) return
  const state = session.getState()
  const items: HTMLElement[] = [el('div', { className: 'menu-label', textContent: 'Page' })]
  const modes = host?.availableDisplayModes ?? []
  if (app && modes.includes('fullscreen') && host?.displayMode !== 'fullscreen') items.push(action('Full screen', () => { void app!.requestDisplayMode({ mode: 'fullscreen' }).catch(() => {}); openMenu(false) }))
  if (app && modes.includes('inline') && host?.displayMode === 'fullscreen') items.push(action('Show in chat', () => { void app!.requestDisplayMode({ mode: 'inline' }).catch(() => {}); openMenu(false) }))
  items.push(action('Copy page to a new page', () => { openMenu(false); void session.copyToNewPage() }))
  items.push(action('Fit all ink', () => { openMenu(false); surface.fitToContent(true) }))

  items.push(el('div', { className: 'menu-rule' }), el('div', { className: 'menu-label', textContent: 'Checkpoints' }))
  const note = el('div', { className: 'menu-note' })
  const box = el('div', { className: 'checkpoints' })
  if (checkpointError) note.textContent = `Could not list checkpoints: ${checkpointError}`
  else if (!checkpoints) note.textContent = 'Reading checkpoints…'
  else if (!checkpoints.length) note.textContent = 'No checkpoints yet. NOVA Ink keeps one every 10 minutes while you write.'
  else {
    note.textContent = 'Restoring replaces this page with the checkpoint as a new version; changes on this device that are not saved are discarded.'
    const canRestore = state.editable || state.status === 'recovery'
    for (const c of checkpoints) {
      const when = new Date(c.savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      const button = confirmButton(`${when} · ${c.strokeCount} strokes`, 'Tap again to restore', () => { openMenu(false); void session.restoreCheckpoint(c.revision) })
      button.disabled = !canRestore || state.busy
      box.append(button)
    }
  }
  items.push(note, box)
  items.push(el('div', { className: 'menu-rule' }), el('div', { className: 'menu-note', textContent: `NOVA Ink ${VERSION} · version ${state.revision} of this page${preview ? ' · preview' : ''}` }))
  menu.replaceChildren(...items)
}

document.addEventListener('pointerdown', e => {
  const target = e.target as Element
  if (!menu.hidden && !menu.contains(target) && !menuButton.contains(target)) openMenu(false)
  if (!pagesPanel.hidden && !pagesPanel.contains(target) && !pagesButton.contains(target)) { closePanels(); render() }
})
window.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!sheet.hidden) closeSheet(); else { openMenu(false); closePanels() } } })

// ---- Lifecycle ----

let rendered: SessionState | null = null
function render() {
  const state = session.getState()
  renderStatus(state)
  renderPages(state)
  renderLibrary(state)
  rememberPage(state)
  if (rendered?.revision !== state.revision || rendered?.editable !== state.editable) renderMenu()
  rendered = state
}
session.subscribe(render)

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void session.save() })
window.addEventListener('pagehide', () => void session.save())
window.addEventListener('beforeunload', e => { if (session.hasUnsavedChanges && session.getState().status !== 'saved') e.preventDefault() })

async function boot() {
  editor.setReadOnly(true)
  render()
  if (app) {
    app.onhostcontextchanged = update => applyHost({ ...host, ...update })
    // The host may notify the app before removing it; best effort only.
    app.onteardown = async () => { await session.teardown(); return {} }
    try { await app.connect(new PostMessageTransport(window.parent, window.parent)) } catch (error) {
      $('status-text').textContent = `Could not connect to Claude: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    applyHost(app.getHostContext())
    void goFullscreen()
  }
  await session.start()
  if (preview && new URLSearchParams(location.search).has('library')) showLibrary(true)
  startJobs()
}

// ---- NOVA's rendering jobs ----

/** Renders pages and crops of a stored PDF for NOVA; only the open notebook can, the server has no PDF renderer. */
const jobs = new JobRunner({
  rpc: (name, args) => session.rpc(name, args),
  uploadImage: picture => session.uploadImage(picture),
  say: text => session.say(text),
  changed: () => session.refreshList(),
  async open(bytes) {
    const pdf = await openPdf(bytes)
    return {
      pageCount: pdf.pageCount,
      async render(number, crop) {
        const page = await pdf.render(number, crop ? 2400 : PDF_MAX_SIDE)
        let canvas = page.canvas
        if (crop) {
          const sx = Math.min(canvas.width - 1, Math.round(crop.x * canvas.width)), sy = Math.min(canvas.height - 1, Math.round(crop.y * canvas.height))
          const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(crop.w * canvas.width))), sh = Math.max(1, Math.min(canvas.height - sy, Math.round(crop.h * canvas.height)))
          const cut = document.createElement('canvas')
          cut.width = sw; cut.height = sh
          cut.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
          canvas.width = canvas.height = 0
          canvas = cut
        }
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9))
        if (!blob) throw new Error('This browser could not encode the page.')
        const picture = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', width: canvas.width, height: canvas.height }
        canvas.width = canvas.height = 0
        return picture
      },
      close: () => pdf.close(),
    }
  },
})
function startJobs() {
  if (!preview && !app) return
  const poll = () => { if (document.visibilityState !== 'hidden' && session.getState().status !== 'loading') void jobs.poll() }
  setInterval(poll, 8000)
  setTimeout(poll, 1500)
  if (preview) Object.assign(window, { novaPollJobs: () => jobs.poll() })
}
void boot()
