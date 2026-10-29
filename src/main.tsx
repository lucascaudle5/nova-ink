import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { Box, DefaultToolbar, getSnapshot, Tldraw } from 'tldraw'
import type { Editor, TLRecord } from 'tldraw'
import { containedInViewport, DISCLOSURE, intersectsViewport, makeCanvasContext } from './context'
import { CanvasSession } from './session'
import type { Api, ApiData, SaveStatus, SessionState } from './session'
import { snapshotLoadError } from './snapshot'
import 'tldraw/tldraw.css'
import './styles.css'

type Mode = 'inline' | 'fullscreen'
const VERSION = '0.2.3'
const tldrawComponents = {
  Toolbar: null,
  TopPanel: () => <DefaultToolbar orientation="horizontal" />,
}
// Pasted images are stored inside the canvas snapshot; keep them small enough to save.
const MAX_IMAGE_DIMENSION = 2048
const MAX_ASSET_BYTES = 8 * 1024 * 1024

const LABELS: Record<SaveStatus, string> = {
  loading: 'Loading', saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', failed: 'Not saved',
  conflict: 'Conflict', readOnly: 'Read only', recovery: 'Recovery needed', unavailable: 'Offline',
}

/** Reused across reopenings when the host allows storage, so a quick reopen resumes editing instead of read-only. */
function persistentClientId(): string {
  const key = 'nova-ink-client-id'
  try {
    const existing = window.localStorage.getItem(key)
    if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing
    const fresh = crypto.randomUUID()
    window.localStorage.setItem(key, fresh)
    return fresh
  } catch { return crypto.randomUUID() }
}

function makeApi(app: App): Api {
  return async (name, args) => {
    const result = await app.callServerTool({ name, arguments: args })
    const data = result.structuredContent as ApiData | undefined
    if (result.isError || !data || typeof data.ok !== 'boolean') {
      const text = result.content?.find(item => item.type === 'text')
      throw new Error(text && 'text' in text ? String(text.text) : `${name}: no valid server response`)
    }
    return data
  }
}

const SESSION_INSTANCE_FIELDS = ['currentPageId', 'isGridMode', 'isToolLocked', 'isFocusMode', 'exportBackground'] as const

/** Camera and notebook preferences are worth saving; cursor, focus and read-only toggles are not. */
function isMeaningfulSessionChange(updated: Record<string, [TLRecord, TLRecord]>, added: Record<string, TLRecord>) {
  for (const record of Object.values(added)) if (record.typeName === 'camera') return true
  for (const [from, to] of Object.values(updated)) {
    if (to.typeName === 'camera') return true
    if (to.typeName === 'instance') {
      const a = from as unknown as Record<string, unknown>, b = to as unknown as Record<string, unknown>
      if (SESSION_INSTANCE_FIELDS.some(field => a[field] !== b[field])) return true
    }
  }
  return false
}

/** Two taps instead of window.confirm, which sandboxed host frames may block. */
function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; className?: string }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(t) }, [armed])
  return <button className={`${className ?? 'secondary'}${armed ? ' armed' : ''}`} disabled={disabled}
    onClick={() => { if (armed) { setArmed(false); onConfirm() } else setArmed(true) }}>{armed ? confirmLabel : label}</button>
}

function StatusBanner({ state, session, onShowBackups }: { state: SessionState; session: CanvasSession; onShowBackups: () => void }) {
  const busy = !!state.busy
  const actions: React.ReactNode[] = []
  const rescue = <button key="rescue" className="primary" disabled={busy} onClick={() => void session.saveAsNewCanvas()}>Save my version as a new canvas</button>
  const discard = <ConfirmButton key="discard" label="Discard my changes" confirmLabel="Tap again to discard" disabled={busy} onConfirm={() => void session.discardAndReload()} />
  const takeOver = <ConfirmButton key="take" label="Take over editing" confirmLabel="Tap again: the other device will stop saving" disabled={busy} onConfirm={() => void session.reconnect({ takeOver: true })} />
  let tone = 'info'
  switch (state.status) {
    case 'failed':
      tone = 'warn'
      actions.push(<button key="retry" className="secondary" disabled={busy} onClick={() => void session.save()}>Retry now</button>, rescue)
      break
    case 'conflict':
      tone = 'danger'
      actions.push(rescue)
      if (state.conflict === 'lease') actions.push(<button key="again" className="secondary" disabled={busy} onClick={() => void session.reconnect()}>Try again</button>, takeOver)
      actions.push(discard)
      break
    case 'readOnly':
      if (state.hasUnsavedChanges) { tone = 'danger'; actions.push(rescue) }
      actions.push(<button key="refresh" className="secondary" disabled={busy} onClick={() => void session.reconnect()}>Refresh / request editing</button>, takeOver)
      break
    case 'recovery':
      tone = 'danger'
      actions.push(<button key="backups" className="primary" disabled={busy} onClick={onShowBackups}>Choose a backup</button>)
      if (state.recovery?.kind !== 'INCOMPATIBLE') actions.push(<ConfirmButton key="fresh" label="Start this canvas over" confirmLabel="Tap again: start blank (damaged files are kept)" disabled={busy} onConfirm={() => void session.startFresh()} />)
      break
    case 'unavailable':
      tone = 'danger'
      break
  }
  const show = actions.length > 0 || tone !== 'info' || state.busy || state.offline || state.notice
  if (!show) return null
  return <section className={`status-banner ${tone}`} role="status" aria-live="polite">
    {state.busy && <p className="banner-busy">{state.busy}</p>}
    {(tone !== 'info' || actions.length > 0) && <p>{state.message}</p>}
    {state.offline && state.status !== 'failed' && <p>The notebook server isn't answering right now. NOVA Ink keeps checking.</p>}
    {state.notice && <p>{state.notice} <button className="link" onClick={() => session.dismissNotice()}>Dismiss</button></p>}
    {actions.length > 0 && <div className="banner-actions">{actions}</div>}
  </section>
}

function BackupPanel({ session, state, onClose }: { session: CanvasSession; state: SessionState; onClose: () => void }) {
  const [backups, setBackups] = useState<Array<{ revision: number; savedAt?: string }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const target = state.recovery?.canvas ?? state.canvas
  useEffect(() => {
    let alive = true
    setBackups(null); setError(null)
    session.listBackups().then(list => { if (alive) setBackups(list) }, e => { if (alive) setError(String(e instanceof Error ? e.message : e)) })
    return () => { alive = false }
  }, [session, target?.id, state.revision])
  const canRestore = !!state.recovery || state.editable
  return <section className="backup-panel" aria-label="Saved canvas backups">
    <div className="library-title"><strong>{state.recovery ? `Recover “${target?.name}”` : `Backups of “${target?.name}”`}</strong><button className="secondary" onClick={onClose}>Close</button></div>
    <p>{state.recovery ? 'Choose a saved version. A damaged file is kept in the server’s recovery folder.' : 'Restoring creates a new version; the current version is kept as a backup.'}</p>
    {!canRestore && <p>This device doesn’t have editing control, so it can’t restore. Request editing first.</p>}
    {error ? <span>Could not list backups: {error}</span> : backups === null ? <span>Reading backups…</span> : backups.length === 0 ? <span>No valid saved backups are available.</span> :
      <div className="backup-items">{backups.map(item => <ConfirmButton key={item.revision} disabled={!canRestore || !!state.busy}
        label={`Version ${item.revision}${item.savedAt ? ` · ${new Date(item.savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}`}
        confirmLabel={`Tap again to restore version ${item.revision}`}
        onConfirm={() => { void session.restoreBackup(item.revision).then(ok => { if (ok) onClose() }) }} />)}</div>}
  </section>
}

function InkWorkspace({ app, host }: { app: App; host: McpUiHostContext | undefined }) {
  const session = useMemo(() => new CanvasSession({ api: makeApi(app), clientId: persistentClientId(), validateSnapshot: snapshotLoadError }), [app])
  const state = useSyncExternalStore(session.subscribe, session.getState)
  const editorRef = useRef<Editor | null>(null)
  const [libraryVisible, setLibraryVisible] = useState(false)
  const [backupsVisible, setBackupsVisible] = useState(false)
  const [newName, setNewName] = useState('')
  const [localCount, setLocalCount] = useState(0)
  const [modeBusy, setModeBusy] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [askStatus, setAskStatus] = useState<string | null>(null)
  const [question, setQuestion] = useState('Am I approaching this problem correctly?')
  const safeTop = host?.safeAreaInsets?.top ?? 0
  const safeBottom = host?.safeAreaInsets?.bottom ?? 0

  useEffect(() => {
    void session.start()
    const onVisibility = () => { if (document.visibilityState === 'hidden') session.onHidden(); else session.onVisible() }
    const onPageHide = () => session.onHidden()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    // ChatGPT may notify the app before removing it; this is best effort and may be skipped.
    app.onteardown = async () => { await session.teardown(); return {} }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      app.onteardown = undefined
      session.dispose()
    }
  }, [app, session])

  useEffect(() => { if (state.recovery) setBackupsVisible(true) }, [state.recovery?.canvas.id, state.recovery?.kind])

  const onMount = (key: string) => (editor: Editor) => {
    editorRef.current = editor
    session.attachEditor(key, {
      getSnapshot: () => getSnapshot(editor.store),
      setReadOnly: readOnly => { if (editor.getInstanceState().isReadonly !== readOnly) editor.updateInstanceState({ isReadonly: readOnly }) },
    })
    setLocalCount(editor.getCurrentPageShapes().length)
    const stopDocument = editor.store.listen(() => {
      setLocalCount(editor.getCurrentPageShapes().length)
      session.noteChange('document')
    }, { scope: 'document', source: 'user' })
    const stopSession = editor.store.listen(entry => {
      if (isMeaningfulSessionChange(entry.changes.updated as Record<string, [TLRecord, TLRecord]>, entry.changes.added as Record<string, TLRecord>)) session.noteChange('session')
    }, { scope: 'session', source: 'user' })
    return () => {
      stopDocument(); stopSession()
      session.detachEditor(key)
      if (editorRef.current === editor) editorRef.current = null
    }
  }

  const openFromLibrary = async (id: string) => {
    if (id === state.canvas?.id && !state.recovery) { setLibraryVisible(false); return }
    if (await session.openCanvas(id)) setLibraryVisible(false)
  }
  const createCanvas = async () => {
    const name = newName.trim()
    if (!name) return
    if (await session.createCanvas(name)) { setNewName(''); setLibraryVisible(false) }
  }

  const ask = async () => {
    const editor = editorRef.current
    if (!editor || !state.canvas) return setAskStatus('Open a canvas first.')
    const shapes = editor.getCurrentPageShapes()
    const selectedIds = editor.getSelectedShapeIds().map(id => String(id))
    const viewport = editor.getViewportPageBounds()
    const visibleIds: string[] = [], containedIds: string[] = []
    for (const shape of shapes) {
      const bounds = editor.getShapePageBounds(shape)
      if (!bounds || !intersectsViewport(bounds, viewport)) continue
      visibleIds.push(String(shape.id))
      if (containedInViewport(bounds, viewport)) containedIds.push(String(shape.id))
    }
    const userQuestion = question.trim().slice(0, 1200)
    if (!userQuestion) return setAskStatus('Enter a question before sending.')
    const context = makeCanvasContext(shapes, selectedIds, userQuestion, visibleIds, containedIds)
    const ids = new Set(selectedIds.length ? selectedIds : visibleIds)
    const target = shapes.filter(shape => ids.has(String(shape.id)))
    if (target.length > 80) return setAskStatus('Too many visible shapes; zoom in or select a smaller area.')
    if (target.length === 0) return setAskStatus('No visible work to inspect. Pan to your work or select shapes.')
    try {
      setAskStatus('Rendering your work for ChatGPT…')
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      let imageStatus = 'No image provided.'
      try {
        // In viewport scope the image is clipped to the screen so off-screen parts of cut-off shapes are not shared.
        const clip = selectedIds.length ? {} : { bounds: new Box(viewport.x, viewport.y, viewport.w, viewport.h), padding: 0 }
        const image = await editor.toImageDataUrl(target, { format: 'png', scale: 0.75, pixelRatio: 1, background: true, ...clip })
        const png = image.url.split(',')[1]
        if (png && png.length <= 3_000_000) {
          content.push({ type: 'image', data: png, mimeType: 'image/png' })
          imageStatus = `Scoped canvas PNG included (${image.width}x${image.height}).`
        } else imageStatus = 'Image too large; only metadata included.'
      } catch (e) { imageStatus = `Render failed (${String(e)}); metadata only.` }
      content.unshift({ type: 'text', text: JSON.stringify({
        ...context, canvasName: state.canvas.name, imageStatus,
        requestedHelp: 'Student-initiated chat hint. Offer minimal correction for local mistakes; substantive guidance for invalid approaches. Do not solve everything unless asked. Never modify canvas without consent.',
      }) })
      const answer = await app.sendMessage({ role: 'user', content })
      if (answer.isError) throw new Error('ChatGPT rejected the message')
      setAskOpen(false)
      setAskStatus(null)
    } catch (e) { setAskStatus(`Ask NOVA failed: ${String(e)}`) }
  }

  const requestMode = async (mode: Mode) => {
    setModeBusy(true)
    try { await app.requestDisplayMode({ mode }) } catch { /* the host decides */ }
    finally { setModeBusy(false) }
  }

  const label = LABELS[state.status]
  const tone = state.status === 'saved' ? 'saved' : ['failed', 'conflict', 'recovery', 'unavailable'].includes(state.status) ? 'unsynced' : ''
  const scopeText = editorRef.current?.getSelectedShapeIds().length ? DISCLOSURE.selection : DISCLOSURE.viewport

  return <div className="ink-app" style={{ paddingTop: safeTop, paddingBottom: safeBottom }}>
    <header className="topbar">
      <div className="logo">N</div>
      <div className="title"><strong>NOVA Ink</strong><span>{state.canvas?.name || 'Private notebook'} · v{VERSION}</span></div>
      <div className="grow" />
      <button className="secondary" onClick={() => { setLibraryVisible(x => !x); void session.refreshLibrary() }}>Canvases</button>
      <span className={`save-indicator ${tone}`} title={state.message}>{label}</span>
      <button className="secondary save-now" onClick={() => void session.save()} disabled={!state.editable || !state.hasUnsavedChanges || state.status === 'conflict'}>Save now</button>
      <button className="primary" onClick={() => { setAskOpen(x => !x); setAskStatus(null) }} disabled={!state.mount}>Ask NOVA</button>
    </header>
    <StatusBanner state={state} session={session} onShowBackups={() => setBackupsVisible(true)} />
    {libraryVisible && <section className="canvas-library" aria-label="Canvas library">
      <div className="library-title"><strong>My canvases</strong><button className="secondary" onClick={() => setLibraryVisible(false)}>Close</button></div>
      <div className="library-items">{state.library.map(c => <button key={c.id} disabled={!!state.busy} className={state.canvas?.id === c.id ? 'current-canvas' : ''} onClick={() => void openFromLibrary(c.id)}>{c.name}</button>)}</div>
      <div className="create-row"><input value={newName} maxLength={80} placeholder="New canvas name" onChange={e => setNewName(e.target.value)} /><button onClick={() => void createCanvas()} disabled={!newName.trim() || !!state.busy}>Create</button></div>
      <p>Canvases are stored in the server's local data directory, not this ChatGPT conversation.</p>
    </section>}
    {showTools && <aside className="diagnostic"><p>Host: {host?.displayMode || 'unknown'} · Available: {(host?.availableDisplayModes || []).join(', ')} · Saved version {state.revision}</p><div className="diag-actions">
      <button disabled={modeBusy} onClick={() => void requestMode('fullscreen')}>Fullscreen</button>
      <button disabled={modeBusy} onClick={() => void requestMode('inline')}>Inline</button>
      <button disabled={!state.editable || !!state.busy} onClick={() => void session.release()}>Release editing</button>
      <button disabled={!state.canvas || !!state.busy} onClick={() => void session.reconnect()}>Refresh / request editing</button>
      <button disabled={!state.canvas} onClick={() => setBackupsVisible(true)}>Backups…</button>
    </div></aside>}
    {askOpen && <section className="ask-panel"><div className="ask-top"><strong>Ask NOVA</strong><button onClick={() => setAskOpen(false)}>Close</button></div><label htmlFor="ink-question">What would you like help with?</label><textarea id="ink-question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={1200} rows={2}/><div className="help-choice"><span>● Chat hint</span><span className="inactive">○ Annotate canvas — planned</span></div><p>{scopeText} You stay in control of when to request help.</p>{askStatus && <p className="ask-status">{askStatus}</p>}<button className="primary" onClick={() => void ask()} disabled={!question.trim()}>Send to ChatGPT</button></section>}
    {backupsVisible && (state.canvas || state.recovery) && <BackupPanel session={session} state={state} onClose={() => setBackupsVisible(false)} />}
    <div className="canvas-area">
      {!state.mount ? <div className="canvas-loading">{state.status === 'loading' ? 'Loading your last canvas…' : state.status === 'recovery' ? 'This canvas needs recovery. Choose a backup above.' : 'Notebook unavailable. See the message above.'}</div> :
        <Tldraw key={state.mount.key} snapshot={(state.mount.snapshot ?? undefined) as never} onMount={onMount(state.mount.key)} components={tldrawComponents}
          maxImageDimension={MAX_IMAGE_DIMENSION} maxAssetSize={MAX_ASSET_BYTES} />}
    </div>
    <footer className="footnote"><span>{localCount} shapes · <button className="footer-tool" onClick={() => setShowTools(v => !v)}>Host tools</button></span><span>{state.status === 'saved' || state.status === 'saving' || state.status === 'unsaved' ? state.message : ''}</span></footer>
  </div>
}

function Root() {
  const [host, setHost] = useState<McpUiHostContext | undefined>()
  const { app, error } = useApp({
    appInfo: { name: 'NOVA Ink', version: VERSION }, capabilities: {},
    onAppCreated(instance) {
      instance.onhostcontextchanged = update => setHost(current => ({ ...current, ...update }))
      instance.onerror = e => console.error('NOVA Ink MCP error', e)
    },
  })
  useEffect(() => { if (app) setHost(app.getHostContext()) }, [app])
  return <>
    {error && <div className="host-warning">ChatGPT connection error: {error.message}</div>}
    {app ? <InkWorkspace app={app} host={host} /> : <div className="ink-app"><div className="canvas-loading">Connecting to ChatGPT…</div></div>}
  </>
}

createRoot(document.getElementById('root')!).render(<Root />)
