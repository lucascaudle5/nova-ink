import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps'
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { InkSurface } from '../engine/src/dom/surface'
import { $, el, mountTools } from '../engine/harness/tools'
import { MockServer } from './mock-server'
import { NotebookSession } from './session'
import type { Api, Data, PageEditor, PageInfo, SessionState, Status } from './session'
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
const tools = mountTools(surface, { storagePrefix: 'nova-ink-engine-app', onOpenPopover: () => closePanels() })

const editor: PageEditor = {
  strokes: () => surface.doc.strokes,
  paper: () => surface.paper,
  camera: () => surface.camera,
  load(strokes, paper, camera) {
    surface.setPaper(paper)
    surface.load(strokes)
    if (camera) surface.setCamera(camera)
    else surface.fitToContent()
  },
  setReadOnly(readOnly) {
    surface.readOnly = readOnly
    document.body.classList.toggle('read-only', readOnly)
    for (const b of document.querySelectorAll<HTMLButtonElement>('.toolbar button, #page')) b.disabled = readOnly
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
  api = mock.api
  ;(window as unknown as { novaMock: MockServer }).novaMock = mock
} else {
  app = new App({ name: 'NOVA Ink', version: VERSION }, {})
  api = hostApi(app)
}

const session = new NotebookSession({ api, clientId: persistentClientId(), editor })
surface.onChange(() => session.changed())

function applyHost(context: McpUiHostContext | undefined) {
  host = context
  const top = context?.safeAreaInsets?.top ?? 0
  document.documentElement.style.setProperty('--top', `max(12px, env(safe-area-inset-top), ${top + 12}px)`)
  renderMenu()
}

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
  const select = el('select', { title: 'Notebook', ariaLabel: 'Notebook' })
  for (const n of state.notebooks.filter(n => !n.deletedAt)) select.append(el('option', { value: n.id, textContent: n.name, selected: n.id === state.notebookId }))
  select.addEventListener('change', () => void session.openNotebook(select.value))
  if (renaming === `notebook:${current?.id}` && current) header.append(renameInput(current.name, name => void session.renameNotebook(current.id, name)))
  else header.append(select)
  const newBook = el('button', { className: 'text', title: 'New notebook' })
  newBook.append(icon(ICON_PLUS), document.createTextNode(' Notebook'))
  newBook.addEventListener('click', () => {
    const count = state.notebooks.filter(n => !n.deletedAt).length
    void session.createNotebook(`Notebook ${count + 1}`).then(() => { renaming = `notebook:${session.getState().notebookId}`; render() })
  })
  header.append(newBook)

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
    const trashedBooks = state.notebooks.filter(n => n.deletedAt)
    if (!trashedPages.length && !trashedBooks.length) list.append(el('div', { className: 'empty', textContent: 'The trash is empty.' }))
    for (const p of trashedPages) {
      const row = el('div', { className: 'row trash' })
      row.append(el('button', { className: 'open', textContent: p.title, disabled: true }), iconButton('Restore page', ICON_RESTORE, () => void session.restorePage(p.id)))
      list.append(row)
    }
    for (const n of trashedBooks) {
      const row = el('div', { className: 'row trash' })
      row.append(el('button', { className: 'open', textContent: `Notebook: ${n.name}`, disabled: true }), iconButton('Restore notebook', ICON_RESTORE, () => void session.restoreNotebook(n.id)))
      list.append(row)
    }
  }

  const footer = el('footer')
  const add = el('button', { className: 'text primary', disabled: !current })
  add.append(icon(ICON_PLUS), document.createTextNode(' Page'))
  add.addEventListener('click', () => void session.addPage())
  footer.append(add)
  if (current) {
    footer.append(action('Rename notebook', () => { renaming = `notebook:${current.id}`; render() }))
    const removeBook = confirmButton('Trash notebook', 'Tap again to trash it', () => void session.removeNotebook(current.id).then(res => {
      if (res.ok) { const next = session.getState().notebooks.find(n => !n.deletedAt); if (next) void session.openNotebook(next.id) }
    }))
    footer.append(removeBook)
  }
  footer.append(action(showTrash ? 'Hide trash' : 'Show trash', () => { showTrash = !showTrash; render() }))
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
window.addEventListener('keydown', e => { if (e.key === 'Escape') { openMenu(false); closePanels() } })

// ---- Lifecycle ----

let rendered: SessionState | null = null
function render() {
  const state = session.getState()
  renderStatus(state)
  renderPages(state)
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
    // ChatGPT may notify the app before removing it; best effort only.
    app.onteardown = async () => { await session.teardown(); return {} }
    try { await app.connect(new PostMessageTransport(window.parent, window.parent)) } catch (error) {
      $('status-text').textContent = `Could not connect to ChatGPT: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    applyHost(app.getHostContext())
  }
  await session.start()
}
void boot()
