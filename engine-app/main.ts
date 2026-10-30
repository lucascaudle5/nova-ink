import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps'
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { InkSurface } from '../engine/src/dom/surface'
import { $, el, mountTools, readStored, writeStored } from '../engine/harness/tools'
import { MockServer } from './mock-server'
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
  const add = el('button', { className: 'text primary', disabled: !current })
  add.append(icon(ICON_PLUS), document.createTextNode(' Page'))
  add.addEventListener('click', () => void session.addPage())
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
const sheet = $<HTMLDivElement>('library-sheet')
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
    if (name !== n.name) await session.renameNotebook(n.id, name)
    if (folderId !== (n.folderId ?? null) || color !== (n.color ?? DEFAULT_COVER)) await session.updateNotebook(n.id, { folderId, color })
  }
  const input = nameField(n?.name ?? `Notebook ${state.notebooks.filter(b => !b.deletedAt).length + 1}`, 'Notebook name', () => void submit())
  const body = [label('Name'), input, label('Cover'), swatches(color, c => { color = c }), label('Folder'), move]
  const buttons = [action('Cancel', closeSheet, 'text'), action(n ? 'Save' : 'Create', () => void submit(), 'text primary')]
  if (n) buttons.unshift(confirmButton('Move to trash', 'Tap again to trash it', () => { closeSheet(); void trashNotebook(n.id) }, 'text danger'))
  openSheet(n ? 'Notebook' : 'New notebook', body, buttons)
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
    // ChatGPT may notify the app before removing it; best effort only.
    app.onteardown = async () => { await session.teardown(); return {} }
    try { await app.connect(new PostMessageTransport(window.parent, window.parent)) } catch (error) {
      $('status-text').textContent = `Could not connect to ChatGPT: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    applyHost(app.getHostContext())
  }
  await session.start()
  if (preview && new URLSearchParams(location.search).has('library')) showLibrary(true)
}
void boot()
