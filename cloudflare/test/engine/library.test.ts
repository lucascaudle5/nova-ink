/** NotebookLibraryDO: notebooks, ordered pages, trash (nothing destroyed), last opened page. */
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { E } from './helpers'

const newLibrary = () => E.ENGINE_LIBRARY.get(E.ENGINE_LIBRARY.idFromName(`engine-library:${crypto.randomUUID()}`)) as any
const titles = (list: any, notebookId: string) => list.notebooks.find((n: any) => n.id === notebookId).pages.filter((p: any) => !p.deletedAt).map((p: any) => p.title)

describe('notebooks and pages', () => {
  it('a new library starts with one notebook and one page, and remembers the last page', async () => {
    const lib = newLibrary()
    const first = await lib.list()
    expect(first.notebooks).toHaveLength(1)
    expect(first.notebooks[0]).toMatchObject({ name: 'My Notebook', pages: [{ title: 'Page 1', revision: 0 }] })
    expect(first.last).toEqual({ notebookId: first.notebooks[0].id, pageId: first.notebooks[0].pages[0].id })
    expect((await lib.list()).notebooks).toHaveLength(1) // not created twice
  })

  it('adds pages at the end or after a page, and reports which page the new one follows', async () => {
    const lib = newLibrary()
    const { notebooks } = await lib.list()
    const book = notebooks[0].id, p1 = notebooks[0].pages[0].id
    const p2 = await lib.addPage({ notebookId: book })
    expect(p2).toMatchObject({ ok: true, previousPageId: p1 })
    const between = await lib.addPage({ notebookId: book, afterPageId: p1, title: 'Notes' })
    expect(between.previousPageId).toBe(p1)
    const list = await lib.list()
    expect(titles(list, book)).toEqual(['Page 1', 'Notes', 'Page 2'])
    expect(list.last.pageId).toBe(between.pageId)
  })

  it('moves pages within and between notebooks', async () => {
    const lib = newLibrary()
    const { notebooks } = await lib.list()
    const book = notebooks[0].id, p1 = notebooks[0].pages[0].id
    const p2 = (await lib.addPage({ notebookId: book })).pageId
    const p3 = (await lib.addPage({ notebookId: book })).pageId
    expect(await lib.movePage({ pageId: p3, afterPageId: null })).toMatchObject({ ok: true })
    expect(titles(await lib.list(), book)).toEqual(['Page 3', 'Page 1', 'Page 2'])
    expect(await lib.movePage({ pageId: p1, afterPageId: p2 })).toMatchObject({ ok: true })
    expect(titles(await lib.list(), book)).toEqual(['Page 3', 'Page 2', 'Page 1'])
    const other = await lib.createNotebook({ name: 'Statics' })
    expect(await lib.movePage({ pageId: p2, afterPageId: other.pageId, notebookId: other.notebookId })).toMatchObject({ ok: true })
    expect(titles(await lib.list(), other.notebookId)).toEqual(['Page 1', 'Page 2'])
    expect(await lib.movePage({ pageId: p2, afterPageId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('removing puts pages and notebooks in the trash; restoring brings them back; nothing is destroyed', async () => {
    const lib = newLibrary()
    const { notebooks } = await lib.list()
    const book = notebooks[0].id, p1 = notebooks[0].pages[0].id
    const p2 = (await lib.addPage({ notebookId: book })).pageId
    await lib.setLast({ pageId: p2 })
    await lib.removePage({ pageId: p2 })
    let list = await lib.list()
    expect(list.notebooks[0].pages.find((p: any) => p.id === p2).deletedAt).toBeTruthy()
    expect(list.last.pageId).toBe(p1) // falls back to a page outside the trash
    expect((await lib.getPage(p2)).deletedAt).toBeTruthy()
    await lib.restorePage({ pageId: p2 })
    expect((await lib.getPage(p2)).deletedAt).toBeNull()

    expect(await lib.removeNotebook({ notebookId: book })).toMatchObject({ ok: false, code: 'LAST_NOTEBOOK' })
    const other = await lib.createNotebook({ name: 'Other' })
    expect(await lib.removeNotebook({ notebookId: book })).toMatchObject({ ok: true })
    expect((await lib.getPage(p1)).deletedAt).toBeTruthy() // pages of a trashed notebook count as trashed
    list = await lib.list()
    expect(list.last.notebookId).toBe(other.notebookId)
    expect(list.notebooks.find((n: any) => n.id === book).pages).toHaveLength(2) // still there
    await lib.restorePage({ pageId: p1 }) // restoring a page also restores its notebook
    expect((await lib.list()).notebooks.find((n: any) => n.id === book).deletedAt).toBeNull()
  })

  it('renames, refuses empty names, and does not know ids from elsewhere', async () => {
    const lib = newLibrary()
    const { notebooks } = await lib.list()
    expect(await lib.renameNotebook({ notebookId: notebooks[0].id, name: '  Dynamics  ' })).toMatchObject({ ok: true })
    expect(await lib.renamePage({ pageId: notebooks[0].pages[0].id, title: 'HW 3' })).toMatchObject({ ok: true })
    expect((await lib.list()).notebooks[0]).toMatchObject({ name: 'Dynamics', pages: [{ title: 'HW 3' }] })
    expect(await lib.renameNotebook({ notebookId: notebooks[0].id, name: '   ' })).toMatchObject({ ok: false, code: 'INVALID_NAME' })
    expect(await lib.getPage(crypto.randomUUID())).toBeNull()
    expect(await lib.addPage({ notebookId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('a library saved before folders existed gains the new columns and keeps its notebooks unchanged', async () => {
    const lib = newLibrary()
    const before = await lib.list()
    await runInDurableObject(lib, async (instance: any, state: DurableObjectState) => {
      state.storage.sql.exec('ALTER TABLE notebooks DROP COLUMN folder_id')
      state.storage.sql.exec('ALTER TABLE notebooks DROP COLUMN color')
      state.storage.sql.exec('DROP TABLE folders')
      instance.ensureSchema()
    })
    const after = await lib.list()
    expect(after.folders).toEqual([])
    expect(after.notebooks).toEqual(before.notebooks)
    expect(after.last).toEqual(before.last)
  })

  it('folders hold notebooks; covers have a color; removing a folder keeps its notebooks at the top level', async () => {
    const lib = newLibrary()
    const { notebooks } = await lib.list()
    const mine = notebooks[0].id
    expect(notebooks[0]).toMatchObject({ folderId: null, color: null })
    const dynamics = (await lib.createFolder({ name: 'Dynamics' })).folderId
    const hw = await lib.createNotebook({ name: 'HW', folderId: dynamics, color: '#1f6feb' })
    expect(hw).toMatchObject({ ok: true })
    expect(await lib.updateNotebook({ notebookId: mine, folderId: dynamics })).toMatchObject({ ok: true })
    expect(await lib.updateNotebook({ notebookId: mine, color: '#d1242f' })).toMatchObject({ ok: true })
    let list = await lib.list()
    expect(list.folders.map((f: any) => f.name)).toEqual(['Dynamics'])
    expect(list.notebooks.map((n: any) => [n.name, n.folderId, n.color])).toEqual([['My Notebook', dynamics, '#d1242f'], ['HW', dynamics, '#1f6feb']])
    expect(list.notebooks[1].editedAt >= list.notebooks[1].createdAt).toBe(true)

    expect(await lib.updateNotebook({ notebookId: mine, color: 'red' })).toMatchObject({ ok: false, code: 'INVALID_COLOR' })
    expect(await lib.updateNotebook({ notebookId: mine, folderId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await lib.renameFolder({ folderId: dynamics, name: 'Dynamics (AE 312)' })).toMatchObject({ ok: true })

    expect(await lib.removeFolder({ folderId: dynamics })).toMatchObject({ ok: true })
    list = await lib.list()
    expect(list.folders[0]).toMatchObject({ name: 'Dynamics (AE 312)' })
    expect(list.folders[0].deletedAt).toBeTruthy()
    expect(list.notebooks.map((n: any) => [n.folderId, n.deletedAt])).toEqual([[null, null], [null, null]])
    expect(await lib.createNotebook({ name: 'X', folderId: dynamics })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    await lib.restoreFolder({ folderId: dynamics })
    expect((await lib.list()).folders[0].deletedAt).toBeNull()
  })
})
