// Runs CanvasSession against the real MCP server and store (in memory transport, temp directory), with fault hooks.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../../server.ts'
import { NotebookStore } from '../../storage.mjs'
import { CanvasSession } from '../../src/session.ts'
import { snapshotLoadError } from '../../src/snapshot.ts'
import { makeSnapshot, shapeCount } from './snapshots.mjs'

export class Backend {
  static async create() {
    const backend = new Backend(await mkdtemp(join(tmpdir(), 'nova-ink-session-')))
    await backend.start()
    return backend
  }
  constructor(dir) {
    this.dir = dir
    this.calls = []
    /** Override to inject faults: (name, args, call) => Promise<result>. */
    this.wrap = (_name, _args, call) => call()
  }
  async start() {
    this.store = new NotebookStore(this.dir, { log: () => {} })
    const server = createServer(this.store)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'nova-ink-session-test', version: '1.0.0' })
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    this.connection = { client, server }
  }
  /** Simulates a server process restart: same data directory, no in-memory leases. */
  async restart() {
    await this.connection.client.close()
    await this.connection.server.close()
    await this.start()
  }
  api = async (name, args) => {
    this.calls.push(name)
    const call = async () => {
      const result = await this.connection.client.callTool({ name, arguments: args })
      if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`)
      return result.structuredContent
    }
    return this.wrap(name, args, call)
  }
  async record(id) { return JSON.parse(await readFile(join(this.dir, 'canvases', `${id}.json`), 'utf8')) }
  async serverShapes(id) { const r = await this.record(id); return r.snapshot ? shapeCount(r.snapshot) : 0 }
  async close() {
    await this.connection.client.close()
    await this.connection.server.close()
    await rm(this.dir, { recursive: true, force: true })
  }
}

export class FakeEditor {
  constructor(snapshot) { this.snapshot = snapshot ?? makeSnapshot({ strokes: 0 }); this.readOnly = false }
  getSnapshot() { return structuredClone(this.snapshot) }
  setReadOnly(value) { this.readOnly = value }
}

export function newSession(backend, options = {}) {
  return new CanvasSession({
    api: backend.api, clientId: randomUUID(), autosaveMs: 60_000, retryDelaysMs: [60_000], heartbeatMs: 0,
    validateSnapshot: snapshotLoadError, ...options,
  })
}

/** Mounts a fake editor for the session's current mount, as React would. */
export function mount(session) {
  const { mount } = session.getState()
  if (!mount) throw new Error('nothing to mount')
  const editor = new FakeEditor(mount.snapshot ?? undefined)
  session.attachEditor(mount.key, editor)
  return editor
}

/** The user draws until the canvas holds `strokes` strokes. */
export function draw(session, editor, strokes) {
  if (editor.readOnly) throw new Error('editor is read only')
  editor.snapshot = makeSnapshot({ strokes })
  session.noteChange('document')
}

export function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
