/**
 * The notebook app's session logic (engine-app/session.ts) against the real engine Worker and Durable Objects in
 * workerd, through the same MCP tool calls the app makes inside ChatGPT. Not covered: the ChatGPT host bridge.
 */
import { describe, expect, it } from 'vitest'
import { createStroke } from '../../../engine/src/core/stroke'
import type { Paper } from '../../../engine/src/core/paper'
import type { Camera, ImageItem, Stroke } from '../../../engine/src/core/types'
import { NotebookSession } from '../../../engine-app/session'
import type { Api, PageEditor } from '../../../engine-app/session'
import { signIn, tool } from './helpers'

class Editor implements PageEditor {
  list: Stroke[] = []
  page: Paper = { color: 'white', pattern: 'blank' }
  view: Camera = { x: 0, y: 0, z: 1 }
  readOnly = false
  pictures: ImageItem[] = []
  items() { return [...this.pictures, ...this.list] }
  paper() { return this.page }
  camera() { return this.view }
  load(strokes: Stroke[], images: ImageItem[], paper: Paper, camera: Camera | null) { this.list = strokes; this.pictures = images; this.page = paper; this.view = camera ?? { x: 0, y: 0, z: 1 } }
  setReadOnly(readOnly: boolean) { this.readOnly = readOnly }
}

const line = (x: number) => createStroke({ points: [x, 0, 0.5, 0, x + 10, 10, 0.5, 16, x + 30, 4, 0.5, 30], style: { color: '#1b1f24', width: 2.6 } })

function device(api: Api) {
  const editor = new Editor()
  const session = new NotebookSession({ api, clientId: crypto.randomUUID(), editor, autosaveMs: 60_000, cameraSaveMs: 60_000, heartbeatMs: 0, retryDelaysMs: [60_000] })
  const draw = (x: number) => { editor.list = [...editor.list, line(x)]; session.changed() }
  return { editor, session, draw }
}

describe('notebook app session against the engine Worker', () => {
  it('saves, survives a lost reply, hands editing between devices and copies stranded work to a new page', async () => {
    const token = (await signIn())!
    let dropNextSaveReply = false
    const api: Api = async (name, args) => {
      const data = await tool(token, name, args)
      if (name === 'nb_save_page' && dropNextSaveReply) { dropNextSaveReply = false; throw new Error('reply lost') }
      return data
    }

    const ipad = device(api)
    await ipad.session.start()
    expect(ipad.session.getState()).toMatchObject({ status: 'saved', editable: true })
    ipad.draw(0); ipad.draw(50)
    ipad.editor.page = { color: 'cream', pattern: 'graph' }
    ipad.session.changed()
    await ipad.session.save()
    expect(ipad.session.getState()).toMatchObject({ status: 'saved', revision: 1 })

    ipad.editor.list = ipad.editor.list.slice(1)
    ipad.draw(100)
    ipad.session.changed()
    dropNextSaveReply = true
    await ipad.session.save()
    expect(ipad.session.getState().status).toBe('notSynced')
    await ipad.session.save()
    expect(ipad.session.getState()).toMatchObject({ status: 'saved', revision: 2 })

    const pc = device(api)
    await pc.session.start()
    expect(pc.session.getState()).toMatchObject({ status: 'readOnly', editable: false, revision: 2 })
    expect(pc.editor.readOnly).toBe(true)
    expect(pc.editor.list.map(s => s.id).sort()).toEqual(ipad.editor.list.map(s => s.id).sort())
    expect(pc.editor.page).toEqual({ color: 'cream', pattern: 'graph' })

    await pc.session.takeOver()
    expect(pc.session.getState()).toMatchObject({ status: 'saved', editable: true })
    ipad.draw(200)
    await ipad.session.heartbeat()
    expect(ipad.session.getState()).toMatchObject({ status: 'conflict', conflict: 'lease' })
    await ipad.session.save()
    expect(ipad.session.getState().revision).toBe(2)

    expect(await ipad.session.copyToNewPage()).toBe(true)
    expect(ipad.session.getState()).toMatchObject({ status: 'saved', editable: true, conflict: null })
    const copyId = ipad.session.getState().pageId!
    const reopened = await tool(token, 'nb_open_page', { pageId: copyId, clientId: crypto.randomUUID() })
    expect(JSON.parse(reopened.rows)).toHaveLength(3)
    expect(reopened.paper).toEqual({ color: 'cream', pattern: 'graph' })
    expect(reopened.page.title).toBe('Page 1 (copy)')

    pc.draw(300)
    await pc.session.save()
    expect(pc.session.getState()).toMatchObject({ status: 'saved', revision: 3 })
    await pc.session.teardown()
    await ipad.session.teardown()
    ipad.session.dispose(); pc.session.dispose()
  })

  it('notebooks and pages: add, switch with a save first, trash and restore', async () => {
    const token = (await signIn())!
    const api: Api = (name, args) => tool(token, name, args)
    const d = device(api)
    await d.session.start()
    await d.session.createNotebook('Physics')
    const book = () => d.session.getState().notebooks.find(n => n.name === 'Physics')!
    expect(d.session.getState()).toMatchObject({ notebookId: book().id, editable: true })
    const first = d.session.getState().pageId!
    d.draw(0)
    await d.session.addPage()
    const second = d.session.getState().pageId!
    expect(second).not.toBe(first)
    expect(book().pages.map(p => p.id)).toEqual([first, second])
    expect((await tool(token, 'nb_open_page', { pageId: first, clientId: crypto.randomUUID() })).revision).toBe(1)

    await d.session.removePage(second)
    expect(d.session.getState().pageId).toBe(first)
    expect(d.editor.list).toHaveLength(1)
    await d.session.restorePage(second)
    expect(d.session.getState().pageId).toBe(second)
    expect(book().pages.every(p => !p.deletedAt)).toBe(true)

    const mine = d.session.getState().notebooks.find(n => n.name === 'My Notebook')!
    expect(await d.session.openNotebook(mine.id)).toBe(true)
    expect(d.session.getState().notebookId).toBe(mine.id)
    await d.session.teardown()
    d.session.dispose()
  })
})
