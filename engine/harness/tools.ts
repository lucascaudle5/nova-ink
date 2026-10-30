import type { InkSurface } from '../src/dom/surface'
import type { Tool } from '../src/core/input'
import { displayColor, PAPER_COLORS, PAPER_PATTERNS } from '../src/core/paper'
import type { PaperColor, PaperPattern } from '../src/core/paper'
import { currentStyle, ERASER_SIZES, MAX_WIDTH, MIN_WIDTH, normalizeColor, PALETTE, parseEraser, parsePresets, setColor, setWidth, tapSlot } from './presets'
import type { EraserSettings, EraserSize, PenPresets, PresetKind } from './presets'

/**
 * The drawing toolbar shared by the harness and the NOVA Ink notebook app: pen presets, eraser, page paper,
 * zoom bar, undo/redo and keyboard shortcuts. Expects the toolbar markup of harness/index.html (ids
 * width-slots, color-slots, undo, redo, page, zoom-in, zoom-out, zoom-reset, fit, preset-editor, and
 * button.tool[data-tool]). Preferences are kept in localStorage under `storagePrefix`.
 */
export interface Tools {
  closePopover(): void
  togglePopover(key: string, anchor: HTMLElement, build: (root: HTMLElement) => void): void
}

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
export const readStored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
export const writeStored = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* preference only */ } }
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, style: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  Object.assign(node.style, style)
  return node
}

export interface ToolsOptions {
  storagePrefix: string
  onOpenPopover?: () => void
  /** Tapping the tool that is already selected. Return true when handled (the app opens its own panel). */
  onReselect?: (tool: Tool, button: HTMLElement) => boolean
  /** The pen's current ink color (as shown on this paper) and width, whenever either changes. */
  onPenStyle?: (color: string, width: number) => void
}

export function mountTools(surface: InkSurface, options: ToolsOptions): Tools {
  const PRESETS_KEY = `${options.storagePrefix}:presets:v1`
  const ERASER_KEY = `${options.storagePrefix}:eraser:v1`

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
    options.onPenStyle?.(color, currentStyle(presets).width)
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
      else if (surface.tool === tool && options.onReselect?.(tool, button)) { /* handled by the app */ }
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
    options.onOpenPopover?.()
    if (popoverKey === key) { closePopover(); return }
    popoverKey = key
    popover.replaceChildren()
    build(popover)
    const rect = anchor.getBoundingClientRect()
    popover.hidden = false
    const left = rect.left + rect.width / 2 - popover.offsetWidth / 2
    popover.style.left = `${Math.max(8, Math.min(left, window.innerWidth - popover.offsetWidth - 8))}px`
    // Below the button, or above it when there is no room (a button near the bottom of the screen).
    const below = rect.bottom + 12
    popover.style.top = `${below + popover.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - popover.offsetHeight - 12) : below}px`
  }

  function closePopover() { popover.hidden = true; popoverKey = null }

  document.addEventListener('pointerdown', e => {
    const target = e.target as Element
    if (popoverKey && !popover.contains(target) && !target.closest('[data-popover-anchor]')) closePopover()
  })

  // ---- Zoom, undo/redo, shortcuts ----

  $('zoom-in').addEventListener('click', () => surface.zoomStep(1))
  $('zoom-out').addEventListener('click', () => surface.zoomStep(-1))
  zoomLabel.addEventListener('click', () => surface.zoomTo(1))
  $('fit').addEventListener('click', () => surface.fitToContent(true))
  $('undo').addEventListener('click', () => surface.undo())
  $('redo').addEventListener('click', () => surface.redo())

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closePopover(); return }
    if (!(e.ctrlKey || e.metaKey)) return
    const key = e.key.toLowerCase()
    if (key === 'z') { e.preventDefault(); if (e.shiftKey) surface.redo(); else surface.undo() }
    else if (key === 'y') { e.preventDefault(); surface.redo() }
    else if (key === '=' || key === '+') { e.preventDefault(); surface.zoomStep(1) }
    else if (key === '-') { e.preventDefault(); surface.zoomStep(-1) }
    else if (key === '0') { e.preventDefault(); surface.zoomTo(1) }
  })

  applyEraser(eraser)
  applyPresets(presets)
  return { closePopover, togglePopover }
}
