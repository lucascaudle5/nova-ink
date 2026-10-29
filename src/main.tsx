import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { getSnapshot, Tldraw } from 'tldraw'
import type { Editor, TLEditorSnapshot } from 'tldraw'
import { intersectsViewport, makeCanvasContext } from './context'
import 'tldraw/tldraw.css'
import './styles.css'

type Mode = 'inline' | 'fullscreen'
type CanvasMeta = { id: string; name: string; createdAt: string; updatedAt: string }
type OpenedCanvas = { canvas: CanvasMeta; revision: number; snapshot: TLEditorSnapshot | null; readOnly: boolean }
type ApiData = { ok: boolean; code?: string; message?: string; revision?: number; readOnly?: boolean; savedAt?: string; canvas?: CanvasMeta; canvases?: CanvasMeta[]; lastOpenedId?: string; snapshot?: TLEditorSnapshot | null }
type SaveLabel = 'Loading' | 'Saved' | 'Saving' | 'Not synced' | 'Read only'

const clientId = crypto.randomUUID()
function useServerApi(app: App | null) {
  return async (name: string, args: Record<string, unknown>): Promise<ApiData> => {
    if (!app) throw new Error('The ChatGPT host is not connected.')
    const result = await app.callServerTool({ name, arguments: args })
    const data = result.structuredContent as ApiData | undefined
    if (result.isError || !data || typeof data.ok !== 'boolean') throw new Error(`${name}: No valid server response`)
    return data
  }
}

function InkWorkspace({ app, host }: { app: App | null; host: McpUiHostContext | undefined }) {
  const api = useServerApi(app)
  const editorRef = useRef<Editor | null>(null)
  const revisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentRef = useRef<OpenedCanvas | null>(null)
  const busyRef = useRef(false)
  const [library, setLibrary] = useState<CanvasMeta[]>([])
  const [opened, setOpened] = useState<OpenedCanvas | null>(null)
  const [instanceEpoch, setInstanceEpoch] = useState(0)
  const [loading, setLoading] = useState(true)
  const [libraryVisible, setLibraryVisible] = useState(false)
  const [newName, setNewName] = useState('')
  const [status, setStatus] = useState('Connecting to notebook storage…')
  const [saveLabel, setSaveLabel] = useState<SaveLabel>('Loading')
  const [localCount, setLocalCount] = useState(0)
  const [modeBusy, setModeBusy] = useState(false)
  const [showDiagnostic, setShowDiagnostic] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [question, setQuestion] = useState('Am I approaching this problem correctly?')
  const safeTop = host?.safeAreaInsets?.top ?? 0
  const safeBottom = host?.safeAreaInsets?.bottom ?? 0

  const markNotSynced = (message: string) => {
    setSaveLabel('Not synced')
    setStatus(message)
  }

  const flush = async (): Promise<boolean> => {
    if (savingRef.current) return false
    const current = currentRef.current
    const editor = editorRef.current
    if (!app || !current || !editor) return true
    if (current.readOnly) return true
    if (!dirtyRef.current) return true
    savingRef.current = true
    dirtyRef.current = false
    setSaveLabel('Saving')
    setStatus('Sending notebook snapshot to the private server…')
    try {
      const snapshot = getSnapshot(editor.store)
      const outcome = await api('ink_save_canvas', {
        canvasId: current.canvas.id, clientId, expectedRevision: revisionRef.current, snapshot,
      })
      if (!outcome.ok || !Number.isSafeInteger(outcome.revision)) {
        dirtyRef.current = true
        if (outcome.code === 'CONFLICT' || outcome.code === 'LEASE_LOST') {
          current.readOnly = true
          editor.updateInstanceState({ isReadonly: true })
        }
        markNotSynced(outcome.message || 'Server rejected the save. Work is only in memory. Do not close this notebook.')
        return false
      }
      revisionRef.current = outcome.revision!
      if (dirtyRef.current) {
        setSaveLabel('Saving')
        setStatus('More changes pending…')
      } else {
        setSaveLabel('Saved')
        setStatus(`Server confirmed revision ${outcome.revision} · ${new Date(outcome.savedAt || Date.now()).toLocaleTimeString()}`)
      }
      return true
    } catch (e) {
      dirtyRef.current = true
      markNotSynced(`Save failed: ${String(e)}. Keep the notebook open and retry Save now.`)
      return false
    } finally {
      savingRef.current = false
    }
  }

  const saveAll = async (): Promise<boolean> => {
    if (timerRef.current) clearTimeout(timerRef.current)
    // Wait for a currently in-flight save without allowing a stale second write.
    for (let i = 0; savingRef.current && i < 80; i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (savingRef.current) return false
    if (!await flush()) return false
    for (let i = 0; dirtyRef.current && i < 6; i++) if (!await flush()) return false
    return !dirtyRef.current
  }

  const queueSave = () => {
    if (!currentRef.current || currentRef.current.readOnly) return
    dirtyRef.current = true
    setSaveLabel('Saving')
    setStatus('Changes awaiting server confirmation…')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void saveAll() }, 650)
  }

  const openCanvas = async (id: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const old = currentRef.current
      if (old && old.canvas.id !== id) {
        if (!await saveAll()) { markNotSynced('Cannot switch canvases until the current canvas is saved.'); return }
        if (!old.readOnly) await api('ink_release_editor', { canvasId: old.canvas.id, clientId })
      }
      const data = await api('ink_open_canvas', { canvasId: id, clientId })
      if (!data.ok || !data.canvas || typeof data.revision !== 'number') throw new Error(data.message || 'Failed to open canvas')
      const next: OpenedCanvas = { canvas: data.canvas, revision: data.revision, snapshot: data.snapshot ?? null, readOnly: !!data.readOnly }
      editorRef.current = null
      currentRef.current = next
      revisionRef.current = data.revision
      dirtyRef.current = false
      savingRef.current = false
      setOpened(next)
      setInstanceEpoch(x => x + 1)
      setSaveLabel(next.readOnly ? 'Read only' : 'Saved')
      setStatus(next.readOnly ? 'Another device is editing this canvas. Viewing server-saved state.' : `Loaded server revision ${data.revision}.`)
      setLibraryVisible(false)
    } catch (e) { markNotSynced(`Open failed: ${String(e)}`) }
    finally { setLoading(false); busyRef.current = false }
  }

  useEffect(() => {
    if (!app) return
    let alive = true
    async function start() {
      try {
        const result = await api('ink_list_canvases', {})
        if (!alive) return
        if (!result.ok || !result.canvases?.length || !result.lastOpenedId) throw new Error(result.message || 'Missing canvas library')
        setLibrary(result.canvases)
        void openCanvas(result.lastOpenedId)
      } catch (e) { if (alive) { setLoading(false); markNotSynced(`Notebook service unavailable: ${String(e)}`) } }
    }
    void start()
    return () => { alive = false }
  }, [app])

  // While this particular app frame remains active, renew its edit lease.
  // A second device is read-only until the first explicitly releases or its lease expires.
  useEffect(() => {
    if (!app || !opened || opened.readOnly) return
    const interval = setInterval(async () => {
      try {
        const result = await api('ink_heartbeat', { canvasId: opened.canvas.id, clientId })
        if (!result.ok || result.readOnly) {
          editorRef.current?.updateInstanceState({ isReadonly: true })
          if (currentRef.current) currentRef.current.readOnly = true
          markNotSynced('Editing lease lost. Any recent changes are NOT confirmed saved.')
        }
      } catch { markNotSynced('Storage connection interrupted; check Save now before closing.') }
    }, 15_000)
    return () => clearInterval(interval)
  }, [app, opened?.canvas.id, opened?.readOnly])

  // ChatGPT can notify an MCP App before removing its view. Flush, then release
  // the editor lease only if the server confirmed the last changes. This is
  // best-effort: an app crash or abrupt OS suspension may skip teardown.
  useEffect(() => {
    if (!app) return
    app.onteardown = async () => {
      const current = currentRef.current
      if (current && !current.readOnly && await saveAll()) {
        try { await api('ink_release_editor', { canvasId: current.canvas.id, clientId }) } catch { /* lease expires */ }
      }
      return {}
    }
    return () => { app.onteardown = undefined }
  }, [app])

  const onMount = (editor: Editor) => {
    editorRef.current = editor
    editor.updateInstanceState({ isReadonly: !!currentRef.current?.readOnly })
    setLocalCount(editor.getCurrentPageShapes().length)
    const unlisten = editor.store.listen(() => {
      setLocalCount(editor.getCurrentPageShapes().length)
      queueSave()
    }, { scope: 'all', source: 'user' })
    return () => { unlisten(); if (editorRef.current === editor) editorRef.current = null }
  }

  const refreshLibrary = async () => {
    try { const res = await api('ink_list_canvases', {}); if (res.ok && res.canvases) setLibrary(res.canvases) }
    catch (e) { setStatus(`Library refresh failed: ${String(e)}`) }
  }
  const createCanvas = async () => {
    if (!newName.trim()) return
    if (dirtyRef.current && !await saveAll()) return
    try {
      const res = await api('ink_create_canvas', { name: newName.trim() })
      if (!res.ok || !res.canvas) throw new Error(res.message)
      setNewName('')
      await refreshLibrary()
      await openCanvas(res.canvas.id)
    } catch (e) { setStatus(`Create failed: ${String(e)}`) }
  }
  const releaseEditor = async () => {
    if (!opened || opened.readOnly) return
    if (!await saveAll()) return
    try {
      const res = await api('ink_release_editor', { canvasId: opened.canvas.id, clientId })
      if (!res.ok) throw new Error(res.message)
      if (currentRef.current) currentRef.current.readOnly = true
      editorRef.current?.updateInstanceState({ isReadonly: true })
      setOpened({ ...opened, readOnly: true })
      setSaveLabel('Read only')
      setStatus('Editing released; you may open the canvas for editing from another device.')
    } catch (e) { markNotSynced(`Could not release editing: ${String(e)}`) }
  }
  const retryEdit = async () => {
    if (!opened) return
    if (dirtyRef.current) { setStatus('Unsaved edits exist here; do not reload or take control elsewhere.'); return }
    try {
      const res = await api('ink_open_canvas', { canvasId: opened.canvas.id, clientId })
      if (!res.ok || !res.canvas || typeof res.revision !== 'number') throw new Error(res.message)
      // Reload from server to avoid mixing read-only stale document with current work.
      editorRef.current = null
      currentRef.current = { canvas: res.canvas, revision: res.revision, snapshot: res.snapshot ?? null, readOnly: !!res.readOnly }
      revisionRef.current = res.revision
      setOpened({ ...currentRef.current })
      setInstanceEpoch(x => x + 1)
      setSaveLabel(res.readOnly ? 'Read only' : 'Saved')
      setStatus(res.readOnly ? 'Other editor still holds the lease.' : `Editing resumed at revision ${res.revision}.`)
    } catch (e) { setStatus(`Retry failed: ${String(e)}`) }
  }

  const ask = async () => {
    if (!app || !editorRef.current) return setStatus('Notebook or ChatGPT host unavailable.')
    const editor = editorRef.current
    const shapes = editor.getCurrentPageShapes()
    const selectedIds = editor.getSelectedShapeIds().map(id => String(id))
    const viewport = editor.getViewportPageBounds()
    const visibleIds = shapes.filter(shape => {
      const bounds = editor.getShapePageBounds(shape)
      return bounds != null && intersectsViewport(bounds, viewport)
    }).map(shape => String(shape.id))
    const userQuestion = question.trim().slice(0, 1200)
    if (!userQuestion) return setStatus('Enter a question before sending.')
    const context = makeCanvasContext(shapes, selectedIds, userQuestion, visibleIds)
    const ids = new Set(selectedIds.length ? selectedIds : visibleIds)
    const target = shapes.filter(shape => ids.has(String(shape.id)))
    if (target.length > 80) return setStatus('Too many visible shapes; zoom in or select a smaller area.')
    if (target.length === 0) return setStatus('No visible work to inspect. Pan to your work or select shapes.')
    try {
      if (dirtyRef.current && !await saveAll()) return
      setStatus('Rendering selected or visible work for ChatGPT…')
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      let imageStatus = 'No image provided.'
      try {
        const image = await editor.toImageDataUrl(target, { format: 'png', scale: 0.75, pixelRatio: 1, background: true })
        const png = image.url.split(',')[1]
        if (png && png.length <= 3_000_000) {
          content.push({ type: 'image', data: png, mimeType: 'image/png' })
          imageStatus = `Scoped canvas PNG included (${image.width}x${image.height}).`
        } else imageStatus = 'Image too large; only metadata included.'
      } catch (e) { imageStatus = `Render failed (${String(e)}); metadata only.` }
      content.unshift({ type: 'text', text: JSON.stringify({
        ...context, canvasId: opened?.canvas.id, canvasName: opened?.canvas.name,
        serverRevision: revisionRef.current, imageStatus,
        requestedHelp: 'Student-initiated chat hint. Offer minimal correction for local mistakes; substantive guidance for invalid approaches. Do not solve everything unless asked. Never modify canvas without consent.',
      }) })
      const answer = await app.sendMessage({ role: 'user', content })
      if (answer.isError) throw new Error('ChatGPT rejected the message')
      setAskOpen(false)
      setStatus(`Sent canvas context to ChatGPT. ${imageStatus}`)
    } catch (e) { setStatus(`Ask NOVA failed: ${String(e)}`) }
  }

  const requestMode = async (mode: Mode) => {
    if (!app) return
    setModeBusy(true)
    try { const response = await app.requestDisplayMode({ mode }); setStatus(`Host reported ${response.mode}.`) }
    catch (e) { setStatus(`Host rejected display change: ${String(e)}`) }
    finally { setModeBusy(false) }
  }

  return <div className="ink-app" style={{ paddingTop: safeTop, paddingBottom: safeBottom }}>
    <header className="topbar">
      <div className="logo">N</div>
      <div className="title"><strong>NOVA Ink</strong><span>{opened?.canvas.name || 'Private notebook'} · v0.2.1</span></div>
      <div className="grow" />
      <button className="secondary" onClick={() => { setLibraryVisible(x => !x); void refreshLibrary() }}>Canvases</button>
      <span className={`save-indicator ${saveLabel === 'Saved' ? 'saved' : saveLabel === 'Not synced' ? 'unsynced' : ''}`}>{saveLabel}</span>
      <button className="secondary save-now" onClick={() => void saveAll()} disabled={!opened || opened.readOnly}>Save now</button>
      <button className="primary" onClick={() => setAskOpen(x => !x)} disabled={!app || !opened}>Ask NOVA</button>
    </header>
    {libraryVisible && <section className="canvas-library" aria-label="Canvas library">
      <div className="library-title"><strong>My canvases</strong><button className="secondary" onClick={() => setLibraryVisible(false)}>Close</button></div>
      <div className="library-items">{library.map(c => <button key={c.id} className={opened?.canvas.id === c.id ? 'current-canvas' : ''} onClick={() => void openCanvas(c.id)}>{c.name}</button>)}</div>
      <div className="create-row"><input value={newName} maxLength={80} placeholder="New canvas name" onChange={e => setNewName(e.target.value)} /><button onClick={() => void createCanvas()} disabled={!newName.trim()}>Create</button></div>
      <p>Canvases are stored in the server's local data directory, not this ChatGPT conversation.</p>
    </section>}
    {showDiagnostic && <aside className="diagnostic"><p>Host: {host?.displayMode || 'unknown'} · Available: {(host?.availableDisplayModes || []).join(', ')}</p><div className="diag-actions"><button disabled={!app || modeBusy} onClick={() => void requestMode('fullscreen')}>Fullscreen</button><button disabled={!app || modeBusy} onClick={() => void requestMode('inline')}>Inline</button><button disabled={!opened || opened.readOnly} onClick={() => void releaseEditor()}>Release editing</button><button disabled={!opened} onClick={() => void retryEdit()}>Refresh / request editing</button></div></aside>}
    {askOpen && <section className="ask-panel"><div className="ask-top"><strong>Ask NOVA</strong><button onClick={() => setAskOpen(false)}>Close</button></div><label htmlFor="ink-question">What would you like help with?</label><textarea id="ink-question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={1200} rows={2}/><div className="help-choice"><span>● Chat hint</span><span className="inactive">○ Annotate canvas — planned</span></div><p>ChatGPT receives the selected shapes or current viewport only. You stay in control of when to request help.</p><button className="primary" onClick={() => void ask()} disabled={!app || !question.trim()}>Send to ChatGPT</button></section>}
    {opened && opened.readOnly && <div className="read-only-bar">Another editor may hold this canvas. <button onClick={() => void retryEdit()}>Refresh / request editing</button></div>}
    <div className="canvas-area">
      {!opened ? <div className="canvas-loading">{loading ? 'Loading your last canvas…' : 'Notebook unavailable. Check the status below.'}</div> :
        <Tldraw key={`${opened.canvas.id}-${instanceEpoch}`} snapshot={opened.snapshot ?? undefined} onMount={onMount} />}
    </div>
    <footer className="footnote"><span>{localCount} shapes · <button className="footer-tool" onClick={() => setShowDiagnostic(v => !v)}>Host tools</button></span><span role="status" title={status}>{status}</span></footer>
  </div>
}

function Root() {
  const [host, setHost] = useState<McpUiHostContext | undefined>()
  const { app, error } = useApp({
    appInfo: { name: 'NOVA Ink', version: '0.2.1' }, capabilities: {},
    onAppCreated(instance) {
      instance.onhostcontextchanged = update => setHost(current => ({ ...current, ...update }))
      instance.onerror = e => console.error('NOVA Ink MCP error', e)
    },
  })
  useEffect(() => { if (app) setHost(app.getHostContext()) }, [app])
  return <>{error && <div className="host-warning">ChatGPT connection error: {error.message}</div>}<InkWorkspace app={app ?? null} host={host}/></>
}

createRoot(document.getElementById('root')!).render(<Root />)
