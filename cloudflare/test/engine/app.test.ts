/**
 * The engine Worker end to end in workerd: sign-in (fake Access), fail-closed configuration, the MCP tools and
 * ownership checks. Not covered: real Access, real ChatGPT, real Cloudflare limits.
 */
import { describe, expect, it } from 'vitest'
import { keyBetween } from '../../../engine/src/core/order'
import { call, E, rpc, signIn, strokeData, tool } from './helpers'

describe('engine Worker sign-in and configuration', () => {
  it('reports its name on /health and refuses /mcp without a token', async () => {
    expect(await (await call('/health')).json()).toEqual({ ok: true, app: 'nova-ink-engine', configured: true })
    const r = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(r.status).toBe(401)
  })

  it('fails closed without its storage bindings or any secret', async () => {
    for (const missing of ['PAGE', 'ENGINE_LIBRARY', 'OAUTH_KV', 'ALLOWED_EMAIL', 'PUBLIC_ORIGIN', 'ACCESS_CLIENT_SECRET']) {
      expect((await call('/mcp', { method: 'POST', body: '{}' }, { [missing]: undefined })).status, missing).toBe(503)
      expect((await call('/authorize', {}, { [missing]: undefined })).status, missing).toBe(503)
    }
  })

  it('someone other than the allowed email gets no token', async () => {
    expect(await signIn({ email: 'someone.else@example.com' })).toBeNull()
  })
})

describe('engine tools', () => {
  it('lists the notebook tools; only the open tool is visible to the model; serves the notebook app', async () => {
    const token = (await signIn())!
    const { body } = await rpc(token, 'tools/list')
    const tools = body.result.tools as any[]
    expect(tools.map(t => t.name).sort()).toEqual([
      'nb_add_page', 'nb_create_notebook', 'nb_heartbeat', 'nb_list', 'nb_list_checkpoints', 'nb_move_page', 'nb_open_page', 'nb_release',
      'nb_remove_notebook', 'nb_remove_page', 'nb_rename_notebook', 'nb_rename_page', 'nb_restore_checkpoint', 'nb_restore_notebook',
      'nb_restore_page', 'nb_save_page', 'open_nova_notebook',
    ])
    for (const t of tools) {
      if (t.name === 'open_nova_notebook') expect(t._meta.ui.resourceUri).toBe('ui://nova-ink-engine/notebook')
      else expect(t._meta.ui.visibility, t.name).toEqual(['app'])
    }
    const resource = await rpc(token, 'resources/read', { uri: 'ui://nova-ink-engine/notebook' })
    expect(resource.body.result.contents[0].text).toMatch(/<(!doctype|html)/i)
  })

  it('a whole session: list, open, save a delta, reopen, new page copies paper, trash and restore', async () => {
    const token = (await signIn())!
    const client = crypto.randomUUID()
    const list = await tool(token, 'nb_list')
    const book = list.notebooks[0].id, pageId = list.last.pageId

    const opened = await tool(token, 'nb_open_page', { pageId, clientId: client })
    expect(opened).toMatchObject({ ok: true, revision: 0, readOnly: false, page: { id: pageId, title: 'Page 1' } })
    const k1 = keyBetween(null, null), k2 = keyBetween(k1, null)
    const saved = await tool(token, 'nb_save_page', {
      pageId, clientId: client, saveId: 'a1', baseRevision: 0,
      adds: [{ key: k1, stroke: strokeData('s1') }, { key: k2, stroke: strokeData('s2', 40) }], paper: { color: 'dark', pattern: 'graph' },
    })
    expect(saved).toMatchObject({ ok: true, revision: 1, strokeCount: 2 })
    expect(saved.stats).toBeUndefined() // internal counters are not sent to the client
    const removed = await tool(token, 'nb_save_page', { pageId, clientId: client, saveId: 'a2', baseRevision: 1, removes: ['s1'] })
    expect(removed).toMatchObject({ ok: true, revision: 2, strokeCount: 1 })
    const again = await tool(token, 'nb_open_page', { pageId, clientId: client })
    expect(JSON.parse(again.rows).map((r: any) => r.stroke.id)).toEqual(['s2'])
    expect((await tool(token, 'nb_list')).notebooks[0].pages[0].revision).toBe(1) // the first save is recorded at once

    const added = await tool(token, 'nb_add_page', { notebookId: book })
    expect(added).toMatchObject({ ok: true, previousPageId: pageId })
    const fresh = await tool(token, 'nb_open_page', { pageId: added.pageId, clientId: client })
    expect(fresh).toMatchObject({ ok: true, revision: 0, paper: { color: 'dark', pattern: 'graph' } })

    expect(await tool(token, 'nb_remove_page', { pageId: added.pageId })).toMatchObject({ ok: true })
    expect(await tool(token, 'nb_open_page', { pageId: added.pageId, clientId: client })).toMatchObject({ ok: false, code: 'IN_TRASH' })
    expect(await tool(token, 'nb_save_page', { pageId: added.pageId, clientId: client, saveId: 'x', baseRevision: 0 })).toMatchObject({ ok: false, code: 'IN_TRASH' })
    expect(await tool(token, 'nb_restore_page', { pageId: added.pageId })).toMatchObject({ ok: true })
    expect(await tool(token, 'nb_open_page', { pageId: added.pageId, clientId: client })).toMatchObject({ ok: true })
    expect(await tool(token, 'nb_heartbeat', { pageId, clientId: client })).toMatchObject({ ok: true, readOnly: false })
    expect(await tool(token, 'nb_release', { pageId, clientId: client })).toMatchObject({ ok: true })
    expect(await tool(token, 'nb_list_checkpoints', { pageId })).toMatchObject({ ok: true })
  })

  it('a page id that is not in this user\'s library is NOT_FOUND, even if a page object exists', async () => {
    const token = (await signIn())!
    const stray = crypto.randomUUID()
    const direct = E.PAGE.get(E.PAGE.idFromName(`page:${stray}`)) as any
    const client = crypto.randomUUID()
    await direct.open({ clientId: client })
    await direct.save({ clientId: client, saveId: 's', baseRevision: 0, adds: [{ key: keyBetween(null, null), stroke: strokeData('x') }] })
    for (const [name, args] of [
      ['nb_open_page', { pageId: stray, clientId: client }],
      ['nb_save_page', { pageId: stray, clientId: client, saveId: 't', baseRevision: 1 }],
      ['nb_heartbeat', { pageId: stray, clientId: client }],
      ['nb_list_checkpoints', { pageId: stray }],
      ['nb_restore_checkpoint', { pageId: stray, clientId: client, saveId: 'r', checkpointRevision: 1, expectedRevision: 1 }],
      ['nb_rename_page', { pageId: stray, title: 'mine now' }],
      ['nb_remove_page', { pageId: stray }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await tool(token, name, args), name).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    }
  })

  it('a token without mcp:write can read but every change is refused', async () => {
    const token = (await signIn({ scopes: ['mcp:read'] }))!
    const list = await tool(token, 'nb_list')
    expect(list.ok).toBe(true)
    const pageId = list.last.pageId
    for (const [name, args] of [
      ['nb_save_page', { pageId, clientId: crypto.randomUUID(), saveId: 'w', baseRevision: 0 }],
      ['nb_create_notebook', { name: 'x' }],
      ['nb_add_page', { notebookId: list.notebooks[0].id }],
      ['nb_remove_page', { pageId }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await tool(token, name, args), name).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE' })
    }
  })
})
