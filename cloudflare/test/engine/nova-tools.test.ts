/**
 * The tools NOVA (the model) sees, end to end through the MCP endpoint: reading a page, drawing and arranging, organizing,
 * and the source-document flow where the open notebook renders pages. Disposable synthetic fixtures only; the "PDF" and
 * "pictures" are a few bytes with the right signature (the server never decodes them; the notebook renders in a browser).
 */
import { describe, expect, it } from 'vitest'
import { keyBetween } from '../../../engine/src/core/order'
import { rpc, signIn, strokeData, tool } from './helpers'

const CHUNK = 192 * 1024
const b64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
const rid = () => `req_${crypto.randomUUID()}`
const fakePdf = (size = 5000) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = (i * 7) & 0xff; b.set([...'%PDF-1.7'].map(c => c.charCodeAt(0)), 0); return b }
const fakePng = (size = 3000) => { const b = new Uint8Array(size); b.set([0x89, 0x50, 0x4e, 0x47], 0); return b }

async function uploadSource(token: string, sourceId: string, name: string, bytes: Uint8Array) {
  const count = Math.ceil(bytes.length / CHUNK)
  for (let i = 0; i < count; i++) await tool(token, 'nb_put_source_chunk', { sourceId, name, bytes: bytes.length, count, index: i, data: b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) })
}
async function uploadPicture(token: string, imageId: string, w = 1520, h = 1970) {
  const bytes = fakePng()
  await tool(token, 'nb_put_image', { imageId, mime: 'image/png', width: w, height: h, bytes: bytes.length, count: 1, index: 0, data: b64(bytes) })
}
async function pageWithInk(token: string) {
  const book = await tool(token, 'nb_create_notebook', { name: 'Statics review (test)' })
  const client = crypto.randomUUID()
  await tool(token, 'nb_open_page', { pageId: book.pageId, clientId: client })
  const k1 = keyBetween(null, null)
  await tool(token, 'nb_save_page', { pageId: book.pageId, clientId: client, saveId: 'a1', baseRevision: 0, adds: [{ key: k1, stroke: strokeData('work1', 400) }, { key: keyBetween(k1, null), stroke: strokeData('work2', 410) }] })
  return { ...book, client }
}

describe('the picture the student shows Claude', () => {
  it('the editing notebook stores it, nova_read_page returns it as image content (not in the JSON), and pausing removes it', async () => {
    const token = (await signIn())!
    const { pageId, client } = await pageWithInk(token)
    const data = b64(fakePng())
    const call = async () => (await rpc(token, 'tools/call', { name: 'nova_read_page', arguments: { pageId } })).body.result

    let result = await call()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].text).toMatch(/No image: the notebook is closed, paused, or showing an empty screen\./)
    expect(result.structuredContent.view).toBeNull()

    expect(await tool(token, 'nb_put_view', { pageId, clientId: client, view: { seen: 'screen', mime: 'image/png', data, width: 1180, height: 820 } })).toMatchObject({ ok: true })
    result = await call()
    expect(result.content[1]).toEqual({ type: 'image', data, mimeType: 'image/png' })
    expect(result.content[2]).toEqual({ type: 'resource', resource: { uri: `nova-ink://pages/${pageId}/view.png`, mimeType: 'image/png', blob: data } })
    expect(result.content[0].text.split('\n')[0]).toMatch(/The attached image is exactly what is on the student's screen, taken \d+ s ago\.$/)
    // with an image there is no structuredContent a host could show the model instead; the text carries the data
    expect(result.structuredContent).toBeUndefined()
    const text = result.content[0].text as string
    expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toMatchObject({ ok: true, page: { id: pageId }, view: { width: 1180, height: 820 } })
    expect(text).not.toContain(data)

    // nova_look: just the picture, for the page open in the notebook when no pageId is given
    const look = (await rpc(token, 'tools/call', { name: 'nova_look', arguments: {} })).body.result
    expect(look.structuredContent).toBeUndefined()
    expect(look.content.map((c: any) => c.type)).toEqual(['text', 'image', 'resource'])
    expect(look.content[1]).toEqual({ type: 'image', data, mimeType: 'image/png' })
    expect(look.content[0].text).toMatch(/^The student is on page 1 of 1, "Page 1", in notebook "Statics review \(test\)"\. The attached image is exactly what is on the student's screen, taken \d+ s ago\./)
    // tests have no Workers AI, so the transcription is reported missing instead of invented
    expect(look.content[0].text).toMatch(/No transcription is available \(.+\); if you cannot see the image, ask the student to read out their work\./)

    // another device holding the page cannot replace it
    const other = crypto.randomUUID()
    expect(await tool(token, 'nb_put_view', { pageId, clientId: other, view: null })).toMatchObject({ ok: false, code: 'LEASE_HELD' })
    const gif = (await rpc(token, 'tools/call', { name: 'nb_put_view', arguments: { pageId, clientId: client, view: { seen: 'screen', mime: 'image/gif', data, width: 1, height: 1 } } })).body
    expect(!!gif.error || gif.result.isError === true, 'only PNG or JPEG is stored').toBe(true)
    expect((await call()).content[1].data).toBe(data)

    expect(await tool(token, 'nb_put_view', { pageId, clientId: client, view: null })).toMatchObject({ ok: true })
    expect((await call()).content).toHaveLength(1)
    expect(await tool(token, 'nova_look', { pageId })).toMatchObject({ ok: true, pageId, shows: null })
    expect(await tool(token, 'nb_put_view', { pageId: crypto.randomUUID(), clientId: client, view: null })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const reader = (await signIn({ scopes: ['mcp:read'] }))!
    expect(await tool(reader, 'nb_put_view', { pageId, clientId: client, view: null })).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE' })
  })
})

describe('NOVA reads and edits a page through the model tools', () => {
  it('lists notebooks, reads a page, draws beside the student ink while the notebook is open, and the editor settles it', async () => {
    const token = (await signIn())!
    const { pageId, client } = await pageWithInk(token)

    const listed = await tool(token, 'nova_list_notebooks')
    expect(listed.notebooks.some((n: any) => n.pages.some((p: any) => p.id === pageId))).toBe(true)

    const read = await tool(token, 'nova_read_page', { pageId })
    expect(read).toMatchObject({ ok: true, revision: 1, editorOpen: true, pendingRequests: 0, page: { id: pageId } })
    expect(read.regions).toHaveLength(1)
    const ref = read.regions[0].ref as string
    // A host that hands the model only the text still gives it the ids it needs to draw.
    const { body } = await rpc(token, 'tools/call', { name: 'nova_read_page', arguments: { pageId } })
    const text = body.result.content[0].text as string
    expect(text.split('\n')[0]).toMatch(/^Page 1 of 1, "Page 1", in notebook "Statics review \(test\)", at revision 1/)
    // the page the student has open is known without asking them
    expect(listed.openPage).toMatchObject({ pageId, pageNumber: 1, pageCount: 1, notebook: 'Statics review (test)' })
    expect(await tool(token, 'nova_read_page', {})).toMatchObject({ ok: true, page: { id: pageId, number: 1, of: 1 } })
    expect(await tool(token, 'nova_look', {})).toMatchObject({ ok: true, pageId, title: 'Page 1', shows: null })
    expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toMatchObject({ ok: true, page: { id: pageId }, regions: [{ ref }] })
    const { body: appOnly } = await rpc(token, 'tools/call', { name: 'nb_list', arguments: {} })
    expect(appOnly.result.content[0].text).not.toContain('{')
    expect(ref).toBe('ink:work1')

    const requestId = rid()
    const edit = await tool(token, 'nova_edit_page', {
      pageId, requestId, expectedRevision: 1,
      operations: [{ op: 'draw', name: 'Free body diagram', place: { relativeTo: ref, side: 'right', gap: 60 }, shapes: [
        { type: 'rect', x: 0, y: 0, w: 70, h: 45 }, { type: 'arrow', x1: 35, y1: 22, x2: 130, y2: 22 }, { type: 'text', x: 134, y: 14, text: 'T' }, { type: 'equation', x: 0, y: 70, text: '\\Sigma F_x = 0' },
      ] }],
    })
    expect(edit).toMatchObject({ ok: true, status: 'queued', editorOpen: true })
    expect(edit.groups[0].id).toMatch(/^nova-free-body-diagram-/)
    // the editor is open, so nothing was written behind its back
    expect((await tool(token, 'nova_read_page', { pageId })).revision).toBe(1)
    // retry with the same id: same request, not a second drawing
    expect(await tool(token, 'nova_edit_page', { pageId, requestId, operations: [{ op: 'ungroup', targets: ['x'] }] })).toMatchObject({ ok: true, duplicate: true, status: 'queued' })

    // a follow-up can use the new group id before the editor has applied the first request
    const move = await tool(token, 'nova_edit_page', { pageId, requestId: rid(), operations: [{ op: 'move', targets: [edit.groups[0].id], dy: 120 }] })
    expect(move).toMatchObject({ ok: true, status: 'queued' })

    const beat = await tool(token, 'nb_heartbeat', { pageId, clientId: client })
    expect(beat.pendingOps.map((o: any) => o.requestId)).toEqual([requestId, move.requestId])
    const status = await tool(token, 'nova_op_status', { pageId, requestIds: [requestId] })
    expect(status.requests[0].status).toBe('queued')
  })

  it('with the notebook closed, the same request is saved directly, and the page reads back with NOVA marked as the author', async () => {
    const token = (await signIn())!
    const { pageId, client } = await pageWithInk(token)
    await tool(token, 'nb_release', { pageId, clientId: client })
    const edit = await tool(token, 'nova_edit_page', { pageId, requestId: rid(), operations: [{ op: 'draw', name: 'Axes', place: { x: 900, y: 40 }, shapes: [{ type: 'arrow', x1: 0, y1: 100, x2: 100, y2: 100 }, { type: 'arrow', x1: 0, y1: 100, x2: 0, y2: 0 }, { type: 'text', x: 104, y: 94, text: 'x' }] }] })
    expect(edit).toMatchObject({ ok: true, status: 'saved', revision: 2 })
    const read = await tool(token, 'nova_read_page', { pageId })
    expect(read).toMatchObject({ revision: 2, editorOpen: false })
    expect(read.groups).toEqual([expect.objectContaining({ id: edit.groups[0].id, author: 'nova' })])
    expect(read.regions.map((r: any) => r.ref)).toEqual(['ink:work1'])
    // a later editor opens with it already there, and the library knows the page was saved
    const opened = await tool(token, 'nb_open_page', { pageId, clientId: crypto.randomUUID() })
    expect(opened.revision).toBe(2)
    expect(opened.page.revision).toBeGreaterThanOrEqual(2)
  })

  it('a preview shows where labels would land without drawing anything, and the real drawing lands there', async () => {
    const token = (await signIn())!
    const { pageId, client } = await pageWithInk(token)
    const operations = [{ op: 'draw', name: 'Force', place: { relativeTo: 'ink:work1', side: 'right', gap: 60 }, shapes: [
      { type: 'arrow', x1: 0, y1: 20, x2: 120, y2: 20 }, { type: 'text', x: 128, y: 12, text: 'T' },
    ] }]
    const requestId = rid()
    const { body } = await rpc(token, 'tools/call', { name: 'nova_edit_page', arguments: { pageId, requestId, operations, preview: true } })
    const text = body.result.content[0].text as string
    expect(text).toMatch(/^Preview only; nothing is on the page yet\. It would do: Drew "Force" \(2 shapes\) at x/)
    expect(text).not.toMatch(/nova-force-/)
    expect(text).toMatch(/Labels would land: "T" at x/)
    expect(text).toMatch(/```\nArea x[\s\S]*\*+ *T[\s\S]*```\nIf every label sits next to what it names/)
    const preview = body.result.structuredContent
    expect(preview).toMatchObject({ ok: true, preview: true, revision: 1 })
    expect(preview.groups).toBeUndefined()
    // nothing stored: no request waiting for the editor, no status for the id, still revision 1
    expect((await tool(token, 'nb_heartbeat', { pageId, clientId: client })).pendingOps).toEqual([])
    expect(await tool(token, 'nova_read_page', { pageId })).toMatchObject({ revision: 1, pendingRequests: 0, groups: [] })
    // the same requestId then draws it, exactly where the preview said
    const drawn = await tool(token, 'nova_edit_page', { pageId, requestId, operations })
    expect(drawn).toMatchObject({ ok: true, status: 'queued' })
    expect(drawn.duplicate).toBeUndefined()
    expect(drawn.labels).toEqual([{ ...preview.labels[0], group: drawn.groups[0].id }])
    expect(await tool(token, 'nova_edit_page', { pageId, requestId: rid(), operations: [{ op: 'nope' }], preview: true })).toMatchObject({ ok: false, code: 'INVALID_OPS' })
    expect(await tool(token, 'nova_edit_page', { pageId, requestId: rid(), operations, preview: true, expectedRevision: 9 })).toMatchObject({ ok: false, code: 'STALE_REVISION' })
  })

  it('after a draw, the text says where each label landed and sketches the area; nova_read_page sketches on request', async () => {
    const token = (await signIn())!
    const { pageId } = await pageWithInk(token)
    const { body } = await rpc(token, 'tools/call', { name: 'nova_edit_page', arguments: { pageId, requestId: rid(), operations: [{ op: 'draw', name: 'Force', place: { relativeTo: 'ink:work1', side: 'right', gap: 60 }, shapes: [
      { type: 'arrow', x1: 0, y1: 20, x2: 120, y2: 20 }, { type: 'text', x: 128, y: 12, text: 'T' },
    ] }] } })
    const text = body.result.content[0].text as string
    expect(text).toMatch(/^Done: /)
    expect(text).toMatch(/Labels landed: "T" at x -?\d+--?\d+, y -?\d+--?\d+\./)
    const drawing = text.slice(text.indexOf('```\n') + 4, text.lastIndexOf('\n```'))
    expect(drawing).toMatch(/^Area x -?\d+ to \d+, y -?\d+ to \d+/)
    expect(drawing).toContain('#')
    expect(drawing).toMatch(/\*+ *T/)
    // the sketch is in the text once, not repeated inside the JSON
    expect(text.slice(text.lastIndexOf('\n```') + 4)).not.toContain('Area x')
    expect(body.result.structuredContent).toMatchObject({ ok: true, labels: [{ text: 'T' }] })

    const read = (await rpc(token, 'tools/call', { name: 'nova_read_page', arguments: { pageId, sketch: 'ink:work1' } })).body.result.content[0].text as string
    expect(read).toMatch(/\nRough sketch:\n```\nArea x/)
    expect(read).toContain('+')
    expect((await rpc(token, 'tools/call', { name: 'nova_read_page', arguments: { pageId } })).body.result.content[0].text).not.toContain('Rough sketch')
    expect(await tool(token, 'nova_read_page', { pageId, sketch: 'nope' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('refuses what it should: stale revision, unknown ids, deleting the student\'s ink, pages that are not this user\'s, a read-only token', async () => {
    const token = (await signIn())!
    const { pageId, client } = await pageWithInk(token)
    await tool(token, 'nb_release', { pageId, clientId: client })
    expect(await tool(token, 'nova_edit_page', { pageId, requestId: rid(), expectedRevision: 5, operations: [{ op: 'move', targets: ['ink:work1'], dx: 1 }] })).toMatchObject({ ok: false, code: 'STALE_REVISION' })
    expect(await tool(token, 'nova_edit_page', { pageId, requestId: rid(), operations: [{ op: 'move', targets: ['nope'], dx: 1 }] })).toMatchObject({ ok: false, code: 'INVALID_OPS' })
    expect(await tool(token, 'nova_edit_page', { pageId, requestId: rid(), operations: [{ op: 'remove', targets: ['ink:work1'] }] })).toMatchObject({ ok: false, code: 'INVALID_OPS' })
    expect(await tool(token, 'nova_edit_page', { pageId: crypto.randomUUID(), requestId: rid(), operations: [{ op: 'ungroup', targets: ['a'] }] })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await tool(token, 'nova_read_page', { pageId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect((await tool(token, 'nova_read_page', { pageId })).revision).toBe(1)

    const reader = (await signIn({ scopes: ['mcp:read'] }))!
    expect(await tool(reader, 'nova_read_page', { pageId })).toMatchObject({ ok: true })
    expect(await tool(reader, 'nova_edit_page', { pageId, requestId: rid(), operations: [{ op: 'ungroup', targets: ['a'] }] })).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE' })
    expect(await tool(reader, 'nova_organize', { requestId: rid(), action: 'create_notebook', name: 'No' })).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE' })
    expect(await tool(reader, 'nova_place_source', { requestId: rid(), sourceId: 's', notebookId: crypto.randomUUID(), pages: '1' })).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE' })
    expect((await rpc(null, 'tools/call', { name: 'nova_read_page', arguments: { pageId } })).response.status).toBe(401)
  })

  it('a page in the trash cannot be edited', async () => {
    const token = (await signIn())!
    const { pageId, client } = await pageWithInk(token)
    await tool(token, 'nb_release', { pageId, clientId: client })
    await tool(token, 'nb_remove_page', { pageId })
    expect(await tool(token, 'nova_edit_page', { pageId, requestId: rid(), operations: [{ op: 'ungroup', targets: ['a'] }] })).toMatchObject({ ok: false, code: 'IN_TRASH' })
  })
})

describe('organizing is idempotent and never deletes', () => {
  it('creates a notebook and adds pages once per request id, renames and moves pages', async () => {
    const token = (await signIn())!
    const requestId = rid()
    const first = await tool(token, 'nova_organize', { requestId, action: 'create_notebook', name: 'Exam 4 review (test)' })
    const again = await tool(token, 'nova_organize', { requestId, action: 'create_notebook', name: 'Exam 4 review (test)' })
    expect(first.ok && again.ok && again.duplicate).toBe(true)
    expect(again.notebookId).toBe(first.notebookId)
    const added = await tool(token, 'nova_organize', { requestId: rid(), action: 'add_page', notebookId: first.notebookId, title: 'Problem 2' })
    const third = await tool(token, 'nova_organize', { requestId: rid(), action: 'add_page', notebookId: first.notebookId, title: 'Problem 3' })
    await tool(token, 'nova_organize', { requestId: rid(), action: 'move_page', pageId: third.pageId, afterPageId: null })
    await tool(token, 'nova_organize', { requestId: rid(), action: 'rename_page', pageId: added.pageId, title: 'Problem 2 (pulley)' })
    const book = (await tool(token, 'nova_list_notebooks')).notebooks.find((n: any) => n.id === first.notebookId)
    expect(book.pages.map((p: any) => p.title)).toEqual(['Problem 3', 'Page 1', 'Problem 2 (pulley)'])
    expect(await tool(token, 'nova_organize', { requestId: rid(), action: 'add_page' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await tool(token, 'nova_organize', { requestId: rid(), action: 'add_page', notebookId: crypto.randomUUID() })).toMatchObject({ ok: false })
  })
})

describe('source documents: stored as uploaded, rendered by the open notebook, placed with their origin recorded', () => {
  it('place pages 5-7: a pending job, the notebook renders and reports, three pages each hold one picture with room around it; a repeat does nothing new', async () => {
    const token = (await signIn())!
    const book = await tool(token, 'nova_organize', { requestId: rid(), action: 'create_notebook', name: 'Review set (test)' })
    await uploadSource(token, 'src-statics-1', 'Exam_Review_Synthetic.pdf', fakePdf(CHUNK + 777))
    expect((await tool(token, 'nova_list_notebooks')).sources).toEqual([expect.objectContaining({ id: 'src-statics-1', name: 'Exam_Review_Synthetic.pdf', bytes: CHUNK + 777 })])
    expect(await tool(token, 'nb_get_source_chunk', { sourceId: 'src-statics-1', index: 1 })).toMatchObject({ ok: true, index: 1, count: 2 })

    const requestId = rid()
    const args = { requestId, sourceId: 'src-statics-1', notebookId: book.notebookId, pages: '5-7', layout: 'top_left', afterPageId: book.pageId }
    const placed = await tool(token, 'nova_place_source', args)
    expect(placed).toMatchObject({ ok: true, status: 'pending' })
    expect(await tool(token, 'nova_place_source', args)).toMatchObject({ ok: true, duplicate: true, jobId: placed.jobId })

    const jobs = (await tool(token, 'nb_jobs')).jobs
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ jobId: placed.jobId, params: { sourceId: 'src-statics-1', layout: 'top_left', items: [{ page: 5 }, { page: 6 }, { page: 7 }] }, source: { name: 'Exam_Review_Synthetic.pdf' } })

    // the notebook renders and uploads, then reports
    const outputs = []
    for (const p of [5, 6, 7]) { await uploadPicture(token, `render-${placed.jobId.slice(0, 8)}-${p}`); outputs.push({ imageId: `render-${placed.jobId.slice(0, 8)}-${p}`, width: 1520, height: 1970 }) }
    const done = await tool(token, 'nb_job_done', { jobId: placed.jobId, outputs })
    expect(done).toMatchObject({ ok: true, status: 'done' })
    expect(done.pages).toHaveLength(3)
    expect(done.pages.map((p: any) => p.status)).toEqual(['saved', 'saved', 'saved'])
    expect(await tool(token, 'nb_job_done', { jobId: placed.jobId, outputs })).toMatchObject({ ok: true, duplicate: true, status: 'done' })
    expect((await tool(token, 'nb_jobs')).jobs).toHaveLength(0)
    expect((await tool(token, 'nova_op_status', { jobIds: [placed.jobId] })).jobs[0]).toMatchObject({ status: 'done' })

    const notebook = (await tool(token, 'nova_list_notebooks')).notebooks.find((n: any) => n.id === book.notebookId)
    expect(notebook.pages.map((p: any) => p.title)).toEqual(['Page 1', 'Exam_Review_Synthetic p.5', 'Exam_Review_Synthetic p.6', 'Exam_Review_Synthetic p.7'])

    const first = await tool(token, 'nova_read_page', { pageId: notebook.pages[1].id })
    expect(first.pictures).toHaveLength(1)
    expect(first.pictures[0]).toMatchObject({ x: 80, y: 80, w: 520, source: { sourceId: 'src-statics-1', sourceName: 'Exam_Review_Synthetic.pdf', page: 5 } })
    expect(first.pictures[0].h).toBe(Math.round(520 * 1970 / 1520))
    expect(first.groups[0]).toMatchObject({ label: expect.stringContaining('exam review synthetic p 5'), author: 'student' })
    // free room beside the problem for NOVA's diagram: place it to the right, clear of the picture
    const fbd = await tool(token, 'nova_edit_page', { pageId: notebook.pages[1].id, requestId: rid(), operations: [{ op: 'draw', name: 'FBD', place: { relativeTo: first.groups[0].id, side: 'right', gap: 40 }, shapes: [{ type: 'rect', x: 0, y: 0, w: 60, h: 40 }] }] })
    expect(fbd.status).toBe('saved')
    const after = await tool(token, 'nova_read_page', { pageId: notebook.pages[1].id })
    expect(after.groups.find((g: any) => g.author === 'nova').bounds.minX).toBeGreaterThanOrEqual(80 + 520 + 40 - 5)
  })

  it('crops: stacked on one page with working space between, each keeps its page number and crop rectangle', async () => {
    const token = (await signIn())!
    const book = await tool(token, 'nova_organize', { requestId: rid(), action: 'create_notebook', name: 'Crops (test)' })
    await uploadSource(token, 'src-crops', 'Crops.pdf', fakePdf())
    const placed = await tool(token, 'nova_place_source', {
      requestId: rid(), sourceId: 'src-crops', notebookId: book.notebookId, mode: 'stack_on_page', pageId: book.pageId,
      items: [{ page: 2, crop: { x: 0.05, y: 0.1, w: 0.9, h: 0.3 }, title: 'Problem 6-65' }, { page: 2, crop: { x: 0.05, y: 0.45, w: 0.5, h: 0.3 }, title: 'Problem 6-66' }],
    })
    const outputs = []
    for (const [i, size] of [[0, [1368, 590]], [1, [760, 590]]] as const) { await uploadPicture(token, `crop-${placed.jobId.slice(0, 8)}-${i}`, size[0], size[1]); outputs.push({ imageId: `crop-${placed.jobId.slice(0, 8)}-${i}`, width: size[0], height: size[1] }) }
    expect(await tool(token, 'nb_job_done', { jobId: placed.jobId, outputs })).toMatchObject({ ok: true, status: 'done' })
    const read = await tool(token, 'nova_read_page', { pageId: book.pageId })
    expect(read.pictures).toHaveLength(2)
    const [a, b] = read.pictures
    expect(a.source).toMatchObject({ page: 2, crop: { x: 0.05, y: 0.1, w: 0.9, h: 0.3 } })
    expect(b.source.crop).toEqual({ x: 0.05, y: 0.45, w: 0.5, h: 0.3 })
    expect(a.w).toBe(684)        // 760 * 0.9: a crop keeps the scale of its page
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + 500)  // generous working space under the first problem
    expect(read.groups.map((g: any) => g.label)).toEqual(expect.arrayContaining(['problem 6 65', 'problem 6 66']))
  })

  it('refuses a missing document, a bad crop, a page beyond the document, and a failed render fails the job without touching pages', async () => {
    const token = (await signIn())!
    const book = await tool(token, 'nova_organize', { requestId: rid(), action: 'create_notebook', name: 'Refusals (test)' })
    expect(await tool(token, 'nova_place_source', { requestId: rid(), sourceId: 'nope', notebookId: book.notebookId, pages: '1' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    await uploadSource(token, 'src-small', 'Small.pdf', fakePdf())
    expect(await tool(token, 'nova_place_source', { requestId: rid(), sourceId: 'src-small', notebookId: book.notebookId, items: [{ page: 1, crop: { x: 0.8, y: 0.1, w: 0.5, h: 0.3 } }] })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await tool(token, 'nova_place_source', { requestId: rid(), sourceId: 'src-small', notebookId: crypto.randomUUID(), pages: '1' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await tool(token, 'nova_place_source', { requestId: rid(), sourceId: 'src-small', notebookId: book.notebookId, pages: 'abc' })).toMatchObject({ ok: false })
    const job = await tool(token, 'nova_place_source', { requestId: rid(), sourceId: 'src-small', notebookId: book.notebookId, pages: '9' })
    expect(await tool(token, 'nb_job_done', { jobId: job.jobId, failure: 'That document has 4 pages.' })).toMatchObject({ ok: true, status: 'failed' })
    expect((await tool(token, 'nova_op_status', { jobIds: [job.jobId] })).jobs[0]).toMatchObject({ status: 'failed', message: 'That document has 4 pages.' })
    const notebook = (await tool(token, 'nova_list_notebooks')).notebooks.find((n: any) => n.id === book.notebookId)
    expect(notebook.pages).toHaveLength(1)
    // a PDF source must be a PDF, and a picture must be complete
    expect(await tool(token, 'nb_put_source_chunk', { sourceId: 'not-pdf', name: 'x.pdf', bytes: 10, count: 1, index: 0, data: b64(new Uint8Array(10)) })).toMatchObject({ ok: false, code: 'INVALID_DOCUMENT' })
    const j2 = await tool(token, 'nova_place_source', { requestId: rid(), sourceId: 'src-small', notebookId: book.notebookId, pages: '1' })
    expect(await tool(token, 'nb_job_done', { jobId: j2.jobId, outputs: [{ imageId: 'never-uploaded', width: 100, height: 100 }] })).toMatchObject({ ok: true, status: 'failed' })
  })
})
