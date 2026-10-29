/**
 * Auth + MCP tests in the local Workers runtime (workerd). Cloudflare Access is replaced by a fake that signs real
 * RS256 ID tokens and serves a real JWKS, so the Worker's verification code runs for real. What this CANNOT prove:
 * that real Access, real ChatGPT (CIMD client registration) or real Cloudflare limits behave the same.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Snapshot } from '../../src/protocol'
import small from '../fixtures/small.json'
import s100 from '../fixtures/s100.json'

const E = env as any
const ORIGIN = 'https://nova-ink-test.example.workers.dev'
const CLIENT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const BASE = `https://nova-test.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`
const OWNER = 'owner@example.com'
const CLIENT_SECRET = 'test-client-secret-not-real'
const REDIRECT = 'https://client.example/cb'

let privateKey: CryptoKey
let jwk: any
let otherPrivateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey
})

// ---- fake Cloudflare Access ---------------------------------------------------------------------------------------
type Grant = { nonce: string; email: string; audience?: string; issuer?: string; key?: 'good' | 'other'; omitNonce?: boolean; expired?: boolean }
const codes = new Map<string, Grant>()
let tokenCalls = 0

async function fakeAccessFetch(url: string, init?: RequestInit): Promise<Response> {
  if (url === `${BASE}/jwks`) return Response.json({ keys: [jwk] })
  if (url === `${BASE}/token`) {
    tokenCalls++
    const body = new URLSearchParams(String(init?.body))
    const grant = codes.get(body.get('code') ?? '')
    if (!grant || body.get('client_secret') !== CLIENT_SECRET || body.get('client_id') !== CLIENT_ID || body.get('redirect_uri') !== `${ORIGIN}/callback` || !body.get('code_verifier')) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    codes.delete(body.get('code')!)
    const now = Math.floor(Date.now() / 1000)
    const jwt = new SignJWT({ email: grant.email, ...(grant.omitNonce ? {} : { nonce: grant.nonce }) })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(grant.issuer ?? BASE).setAudience(grant.audience ?? CLIENT_ID).setSubject('sub-1')
      .setIssuedAt(now).setExpirationTime(grant.expired ? now - 3600 : now + 300)
    return Response.json({ id_token: await jwt.sign(grant.key === 'other' ? otherPrivateKey : privateKey), token_type: 'Bearer' })
  }
  return new Response('unexpected fetch', { status: 599 })
}

const app = createApp({ fetch: fakeAccessFetch })

function goodEnv(overrides: Record<string, unknown> = {}) {
  return {
    CANVAS: E.CANVAS, LIBRARY: E.LIBRARY, OAUTH_KV: E.OAUTH_KV,
    PUBLIC_ORIGIN: ORIGIN, ACCESS_CLIENT_ID: CLIENT_ID, ACCESS_CLIENT_SECRET: CLIENT_SECRET,
    ACCESS_TOKEN_URL: `${BASE}/token`, ACCESS_AUTHORIZATION_URL: `${BASE}/authorization`, ACCESS_JWKS_URL: `${BASE}/jwks`,
    ALLOWED_EMAIL: OWNER, ...overrides,
  } as any
}

async function call(url: string, init: RequestInit = {}, envOverrides: Record<string, unknown> = {}) {
  const ctx = createExecutionContext()
  const response = await app.fetch(new Request(url.startsWith('http') ? url : `${ORIGIN}${url}`, init), goodEnv(envOverrides), ctx)
  await waitOnExecutionContext(ctx)
  return response
}

const jar = (responses: Response[]) => {
  const cookies = new Map<string, string>()
  for (const r of responses) for (const line of r.headers.getSetCookie()) {
    const [pair] = line.split(';'); const eq = pair.indexOf('=')
    const name = pair.slice(0, eq), value = pair.slice(eq + 1)
    if (value === '' || /max-age=0/i.test(line)) cookies.delete(name); else cookies.set(name, value)
  }
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) }
}

async function registerClient() {
  const r = await call('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test ChatGPT', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  })
  expect(r.status).toBe(201)
  return (await r.json() as any).client_id as string
}

/** Runs the whole OAuth dance. Returns tokens, or the final redirect when sign-in did not complete. */
async function signIn(opts: { email?: string; grant?: Partial<Grant>; scopes?: string[]; envOverrides?: Record<string, unknown> } = {}) {
  const clientId = await registerClient()
  const { verifier, challenge } = await pkce()
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'mcp:read mcp:write offline_access', state: 'client-state',
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`,
  })
  const consent = await call(`/authorize?${query}`)
  expect(consent.status).toBe(200)
  const html = await consent.text()
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]
  expect(handle).toBeTruthy()
  expect(html).not.toContain('<script')

  const form = new URLSearchParams({ handle: handle!, decision: 'approve' })
  for (const s of opts.scopes ?? ['mcp:read', 'mcp:write', 'offline_access']) form.append('scope', s)
  const approve = await call('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar([consent]) }, body: form })
  expect(approve.status).toBe(302)
  const toAccess = new URL(approve.headers.get('location')!)
  expect(toAccess.origin + toAccess.pathname).toBe(`${BASE}/authorization`)
  expect(toAccess.searchParams.get('client_id')).toBe(CLIENT_ID)
  expect(toAccess.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`)
  expect(toAccess.searchParams.get('code_challenge_method')).toBe('S256')

  codes.set('upstream-code', { nonce: toAccess.searchParams.get('nonce')!, email: opts.email ?? OWNER, ...opts.grant })
  const back = await call(`/callback?code=upstream-code&state=${encodeURIComponent(toAccess.searchParams.get('state')!)}`, { headers: { cookie: jar([consent, approve]) } })
  expect(back.status).toBe(302)
  const redirect = new URL(back.headers.get('location')!)
  if (redirect.origin + redirect.pathname !== REDIRECT || !redirect.searchParams.get('code')) return { redirect }

  const token = await call('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  })
  const tokens = await token.json() as any
  return { redirect, tokens, clientId, status: token.status }
}

let rpcId = 0
async function mcp(token: string | null, method: string, params?: unknown) {
  const response = await call('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const raw = await response.text()
  let body: any = null
  try { body = JSON.parse(raw) } catch { const line = raw.split('\n').find(l => l.startsWith('data:')); if (line) body = JSON.parse(line.slice(5)) }
  return { response, body }
}
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const { body } = await mcp(token, 'tools/call', { name, arguments: args })
  if (body?.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`)
  return body.result.structuredContent as any
}

// ------------------------------------------------------------------------------------------------------------------

describe('unauthenticated requests are refused', () => {
  it('/mcp without a token, with garbage, and on every method', async () => {
    for (const authorization of [undefined, 'Bearer nonsense', 'Bearer ', 'Basic Zm9vOmJhcg==']) {
      const r = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toMatch(/Bearer/i)
      expect(await r.text()).not.toContain('ink_open_canvas')
    }
    for (const method of ['GET', 'DELETE']) expect((await call('/mcp', { method })).status).toBe(401)
  })

  it('publishes OAuth discovery, and the protected resource points at this Worker', async () => {
    const meta = await (await call('/.well-known/oauth-authorization-server')).json() as any
    expect(meta.issuer).toBe(ORIGIN)
    expect(meta.scopes_supported).toEqual(expect.arrayContaining(['mcp:read', 'mcp:write', 'offline_access']))
    const resource = await (await call('/.well-known/oauth-protected-resource/mcp')).json() as any
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] })
  })

  it('an unknown route and the old unauthenticated API do not exist', async () => {
    expect((await call('/api/canvas/00000000-0000-4000-8000-000000000000/open', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await call('/api/save-as-new', { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('a host other than PUBLIC_ORIGIN is refused', async () => {
    const r = await call('https://evil.example.workers.dev/mcp', { method: 'POST' })
    expect(r.status).toBe(421)
  })
})

describe('the wrong person or a bad ID token never gets a code', () => {
  it('a different email is refused even with a perfectly valid, correctly signed ID token', async () => {
    const out: any = await signIn({ email: 'someone.else@example.com' })
    expect(out.redirect.searchParams.get('error')).toBe('access_denied')
    expect(out.redirect.searchParams.get('code')).toBeNull()
    expect(out.tokens).toBeUndefined()
  })

  it('email comparison ignores case and surrounding space only', async () => {
    const ok: any = await signIn({ email: '  OWNER@Example.com ' })
    expect(ok.tokens?.access_token).toBeTruthy()
    const lookalike: any = await signIn({ email: 'owner@example.com.evil.test' })
    expect(lookalike.redirect.searchParams.get('error')).toBe('access_denied')
  })

  for (const [name, grant] of Object.entries({
    'wrong audience': { audience: 'someone-elses-client' },
    'wrong issuer': { issuer: 'https://nova-test.cloudflareaccess.com/cdn-cgi/access/sso/oidc/other' },
    'signed by another key': { key: 'other' as const },
    'nonce missing': { omitNonce: true },
    'nonce replayed from another login': { nonce: 'not-the-nonce-we-sent' },
    'expired': { expired: true },
  } as Record<string, Partial<Grant>>)) {
    it(`ID token with ${name} is refused`, async () => {
      const out: any = await signIn({ grant })
      expect(out.redirect.searchParams.get('error')).toBe('access_denied')
      expect(out.redirect.searchParams.get('code')).toBeNull()
    })
  }

  it('a callback with no matching state/cookie (replay from another browser) is refused', async () => {
    const r = await call('/callback?code=upstream-code&state=forged')
    expect(r.status).toBe(400)
    expect(r.headers.get('location')).toBeNull()
  })

  it('Deny returns access_denied to the client without contacting Access', async () => {
    const clientId = await registerClient()
    const { challenge } = await pkce()
    const consent = await call(`/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'mcp:read', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` })}`)
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]
    const before = tokenCalls
    const deny = await call('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar([consent]) }, body: new URLSearchParams({ handle, decision: 'deny' }) })
    expect(deny.status).toBe(302)
    expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
    expect(tokenCalls).toBe(before)
  })
})

describe('missing or malformed configuration fails closed', () => {
  const required = ['PUBLIC_ORIGIN', 'ACCESS_CLIENT_ID', 'ACCESS_CLIENT_SECRET', 'ACCESS_TOKEN_URL', 'ACCESS_AUTHORIZATION_URL', 'ACCESS_JWKS_URL', 'ALLOWED_EMAIL']
  const routes: Array<[string, RequestInit]> = [
    ['/mcp', { method: 'POST', body: '{}' }], ['/mcp', { method: 'GET' }], ['/authorize?response_type=code', {}], ['/authorize', { method: 'POST' }],
    ['/callback?code=x&state=y', {}], ['/oauth/token', { method: 'POST' }], ['/oauth/register', { method: 'POST', body: '{}' }],
    ['/.well-known/oauth-authorization-server', {}], ['/.well-known/oauth-protected-resource/mcp', {}], ['/', {}], ['/anything', {}],
  ]
  for (const missing of required) {
    it(`without ${missing}, every route except /health returns 503`, async () => {
      for (const [path, init] of routes) {
        const r = await call(path, init, { [missing]: undefined })
        expect(r.status, `${path} without ${missing}`).toBe(503)
        expect(await r.text()).not.toMatch(/ink_|access_token|client_id/)
      }
      const health = await (await call('/health', {}, { [missing]: undefined })).json() as any
      expect(health).toEqual({ ok: true, app: 'nova-ink-cf-test', configured: false })
    })
  }

  it('with nothing set at all (a fresh deploy) it also refuses', async () => {
    const none = Object.fromEntries(required.map(k => [k, undefined]))
    for (const [path, init] of routes) expect((await call(path, init, none)).status).toBe(503)
  })

  it('empty strings count as missing', async () => {
    for (const k of required) expect((await call('/mcp', { method: 'POST', body: '{}' }, { [k]: '   ' })).status).toBe(503)
  })

  it('a missing KV or Durable Object binding counts as missing', async () => {
    for (const k of ['OAUTH_KV', 'CANVAS', 'LIBRARY']) expect((await call('/mcp', { method: 'POST', body: '{}' }, { [k]: undefined })).status).toBe(503)
  })

  it('Access URLs that are not on a Cloudflare Access team domain are refused, so the client secret cannot be sent elsewhere', async () => {
    const bad: Array<Record<string, string>> = [
      { ACCESS_TOKEN_URL: 'https://attacker.example/cdn-cgi/access/sso/oidc/x/token' },
      { ACCESS_JWKS_URL: 'https://attacker.example/cdn-cgi/access/sso/oidc/x/jwks' },
      { ACCESS_AUTHORIZATION_URL: 'https://attacker.example/cdn-cgi/access/sso/oidc/x/authorization' },
      { ACCESS_TOKEN_URL: `http://nova-test.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}/token` },
      { ACCESS_TOKEN_URL: `https://nova-test.cloudflareaccess.com.attacker.example/cdn-cgi/access/sso/oidc/${CLIENT_ID}/token` },
      { ACCESS_TOKEN_URL: 'https://nova-test.cloudflareaccess.com/cdn-cgi/access/sso/oidc/different-app/token' },
      { ACCESS_JWKS_URL: 'https://other-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/' + CLIENT_ID + '/jwks' },
      { PUBLIC_ORIGIN: 'http://nova-ink-test.example.workers.dev' },
      { PUBLIC_ORIGIN: `${ORIGIN}/extra` },
      { ALLOWED_EMAIL: 'not-an-email' },
    ]
    for (const override of bad) expect((await call('/mcp', { method: 'POST', body: '{}' }, override)).status, JSON.stringify(override)).toBe(503)
  })
})

describe('valid auth reaches the MCP tools', () => {
  it('the same tool names and widget resource as the Windows server, plus the diagnostics tools', async () => {
    const { tokens } = await signIn() as any
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()
    const { body } = await mcp(tokens.access_token, 'tools/list')
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual([
      'ink_create_canvas', 'ink_heartbeat', 'ink_list_backups', 'ink_list_canvases', 'ink_open_canvas', 'ink_release_editor', 'ink_restore_backup',
      'ink_save_as_new_canvas', 'ink_save_canvas', 'ink_start_canvas_fresh', 'nova_ink_diag_payload', 'nova_ink_diagnostics', 'open_nova_ink',
    ].sort())
    const open = body.result.tools.find((t: any) => t.name === 'open_nova_ink')
    expect(open._meta.ui.resourceUri).toBe('ui://nova-ink/canvas')
    expect(body.result.tools.find((t: any) => t.name === 'ink_save_canvas')._meta.ui.visibility).toEqual(['app'])

    const resource = await mcp(tokens.access_token, 'resources/read', { uri: 'ui://nova-ink/canvas' })
    expect(resource.body.result.contents[0].text).toMatch(/<(!doctype|html)/i)
    expect(resource.body.result.contents[0]._meta['openai/ui'].preferredDisplayMode).toBe('fullscreen')
  })

  it('a full session: list, create, open, save, conflict, replay, checkpoint restore, release', async () => {
    const { tokens } = await signIn() as any
    const t = tokens.access_token
    const client = crypto.randomUUID()

    const list = await tool(t, 'ink_list_canvases')
    expect(list).toMatchObject({ ok: true })
    expect(list.canvases.length).toBeGreaterThan(0)
    const created = await tool(t, 'ink_create_canvas', { name: 'Test canvas' })
    expect(created).toMatchObject({ ok: true, canvas: { name: 'Test canvas', revision: 0 } })
    const id = created.canvas.id

    const opened = await tool(t, 'ink_open_canvas', { canvasId: id, clientId: client })
    expect(opened).toMatchObject({ ok: true, revision: 0, snapshot: null, readOnly: false, canvas: { id } })

    const saved = await tool(t, 'ink_save_canvas', { canvasId: id, clientId: client, expectedRevision: 0, saveId: 'a1', snapshot: small })
    expect(saved).toMatchObject({ ok: true, revision: 1 })
    const replay = await tool(t, 'ink_save_canvas', { canvasId: id, clientId: client, expectedRevision: 0, saveId: 'a1', snapshot: small })
    expect(replay).toMatchObject({ ok: true, revision: 1, replayed: true })

    // whole-snapshot save: a stroke removed and others kept
    const fewer = JSON.parse(JSON.stringify(s100)) as Snapshot
    const second = await tool(t, 'ink_save_canvas', { canvasId: id, clientId: client, expectedRevision: 1, saveId: 'a2', snapshot: fewer })
    expect(second).toMatchObject({ ok: true, revision: 2 })
    const reopened = await tool(t, 'ink_open_canvas', { canvasId: id, clientId: client })
    expect(reopened.snapshot).toEqual(s100)
    expect(reopened.canvas.revision).toBeGreaterThan(0) // Library learned the canvas was saved

    const stale = await tool(t, 'ink_save_canvas', { canvasId: id, clientId: client, expectedRevision: 1, saveId: 'a3', snapshot: small })
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', revision: 2 })
    const other = await tool(t, 'ink_save_canvas', { canvasId: id, clientId: crypto.randomUUID(), expectedRevision: 2, saveId: 'a4', snapshot: small })
    expect(other).toMatchObject({ ok: false, code: 'LEASE_HELD' })

    const backups = await tool(t, 'ink_list_backups', { canvasId: id })
    expect(backups.ok).toBe(true)
    expect(backups.backups.length).toBeGreaterThan(0)
    const restored = await tool(t, 'ink_restore_backup', { canvasId: id, clientId: client, backupRevision: backups.backups[0].revision, expectedCurrentRevision: 2 })
    expect(restored).toMatchObject({ ok: true, revision: 3 })

    expect(await tool(t, 'ink_heartbeat', { canvasId: id, clientId: client })).toMatchObject({ ok: true, readOnly: false })
    expect(await tool(t, 'ink_release_editor', { canvasId: id, clientId: client })).toMatchObject({ ok: true })
    expect(await tool(t, 'ink_start_canvas_fresh', { canvasId: id, clientId: client })).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' })
  })

  it('save-as-new is idempotent and lists the new canvas', async () => {
    const { tokens } = await signIn() as any
    const t = tokens.access_token
    const args = { name: 'My copy', clientId: crypto.randomUUID(), saveId: 'copy-1', snapshot: small }
    const first = await tool(t, 'ink_save_as_new_canvas', args)
    expect(first).toMatchObject({ ok: true, revision: 1, canvas: { name: 'My copy' } })
    const retry = await tool(t, 'ink_save_as_new_canvas', args)
    expect(retry).toMatchObject({ ok: true, replayed: true, canvas: { id: first.canvas.id } })
    expect((await tool(t, 'ink_list_canvases')).canvases.filter((c: any) => c.id === first.canvas.id)).toHaveLength(1)
    const bad = await tool(t, 'ink_save_as_new_canvas', { ...args, saveId: 'copy-2', snapshot: { nope: 1 } })
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('a canvas id that is not in this user\'s library is NOT_FOUND, even if a canvas object exists for it', async () => {
    const { tokens } = await signIn() as any
    const t = tokens.access_token
    const stray = crypto.randomUUID()
    const direct = E.CANVAS.get(E.CANVAS.idFromName(stray)) as any
    await direct.initFromSnapshot({ clientId: crypto.randomUUID(), saveId: 's', snapshot: small })
    for (const [name, args] of [
      ['ink_open_canvas', { canvasId: stray, clientId: crypto.randomUUID() }],
      ['ink_save_canvas', { canvasId: stray, clientId: crypto.randomUUID(), expectedRevision: 1, snapshot: small }],
      ['ink_heartbeat', { canvasId: stray, clientId: crypto.randomUUID() }],
      ['ink_list_backups', { canvasId: stray }],
      ['ink_restore_backup', { canvasId: stray, clientId: crypto.randomUUID(), backupRevision: 1, expectedCurrentRevision: 1 }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await tool(t, name, args), name).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    }
  })

  it('the refresh token works and keeps working after rotation; the old access token is not needed', async () => {
    const out: any = await signIn()
    const refresh = (refreshToken: string) => call('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: out.clientId }),
    }).then(r => r.json()) as Promise<any>
    const first = await refresh(out.tokens.refresh_token)
    expect(first.access_token).toBeTruthy()
    expect(first.access_token).not.toBe(out.tokens.access_token)
    expect((await tool(first.access_token, 'ink_list_canvases')).ok).toBe(true)
    const second = await refresh(first.refresh_token)
    expect(second.access_token).toBeTruthy()
    expect((await tool(second.access_token, 'ink_list_canvases')).ok).toBe(true)
    // no new sign-in through Access was needed for either refresh
  })

  it('a token without mcp:write can read but every write tool is refused', async () => {
    const out: any = await signIn({ scopes: ['mcp:read'] })
    const t = out.tokens.access_token
    expect(out.tokens.scope).not.toContain('mcp:write')
    expect((await tool(t, 'ink_list_canvases')).ok).toBe(true)
    for (const [name, args] of [
      ['ink_create_canvas', { name: 'x' }],
      ['ink_save_canvas', { canvasId: crypto.randomUUID(), clientId: crypto.randomUUID(), expectedRevision: 0, snapshot: small }],
      ['ink_save_as_new_canvas', { name: 'x', clientId: crypto.randomUUID(), saveId: 'z', snapshot: small }],
      ['nova_ink_diagnostics', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await tool(t, name, args), name).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE' })
    }
  })

  it('a revoked-by-expiry or tampered access token is refused', async () => {
    const out: any = await signIn()
    const t: string = out.tokens.access_token
    const tampered = t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa')
    expect((await mcp(tampered, 'tools/list')).response.status).toBe(401)
  })
})

describe('diagnostics (generated data only)', () => {
  it('runs every step for a generated canvas, reports each one, and leaves nothing behind', async () => {
    const { tokens } = await signIn() as any
    const out = await tool(tokens.access_token, 'nova_ink_diagnostics', { sizes: ['s100'] })
    expect(out.ok).toBe(true)
    const steps = out.sizes[0].steps
    expect(steps.map((s: any) => s.step)).toEqual([
      'generate (in object)', 'full save (first save)', 'open', 'open (raw/fast)', 'save +3 strokes (1st edit: includes inline checkpoint)',
      'save +3 strokes (steady state)', 'save camera only', 'forced checkpoint', 'heartbeat',
    ])
    for (const s of steps) expect(s, JSON.stringify(s)).toMatchObject({ ok: true })
    expect(steps[1].rowsWritten).toBeGreaterThan(100)   // 102 records + schema/session/head
    expect(steps[2].records).toBe(102)
    expect(steps[4].rowsWritten).toBeGreaterThan(steps[5].rowsWritten) // the first edit also wrote a checkpoint
    expect(out.summary).toContain('s100 | open')
    // generated canvases are not in the library
    expect((await tool(tokens.access_token, 'ink_list_canvases')).canvases.some((c: any) => /DIAG/.test(c.name))).toBe(false)
  })

  it('materialize creates a listed canvas that opens with the generated strokes', async () => {
    const { tokens } = await signIn() as any
    const t = tokens.access_token
    const out = await tool(t, 'nova_ink_diagnostics', { sizes: ['s100'], materialize: true })
    const id = out.sizes[0].canvasId
    const opened = await tool(t, 'ink_open_canvas', { canvasId: id, clientId: crypto.randomUUID() })
    expect(opened).toMatchObject({ ok: true, revision: expect.any(Number) })
    expect(Object.keys(opened.snapshot.document.store).length).toBeGreaterThan(100)
    expect((await tool(t, 'ink_list_canvases')).canvases.some((c: any) => c.id === id && /DIAG s100/.test(c.name))).toBe(true)
  })

  it('refuses to generate over, save to, or delete a real canvas', async () => {
    const real = E.CANVAS.get(E.CANVAS.idFromName(crypto.randomUUID())) as any
    await real.initFromSnapshot({ clientId: crypto.randomUUID(), saveId: 'real', snapshot: small })
    for (const op of ['generate', 'fullSave', 'incrementalSave', 'purge', 'checkpoint']) {
      expect(await real.diagOp({ op, run: 'x', size: 's100', strokes: 100 }), op).toMatchObject({ ok: false, code: 'NOT_DIAGNOSTIC' })
    }
    expect((await real.open({ clientId: crypto.randomUUID() })).snapshot).toEqual(small)
  })

  it('the payload probe echoes sizes and returns the requested filler', async () => {
    const { tokens } = await signIn() as any
    const out = await tool(tokens.access_token, 'nova_ink_diag_payload', { echo: 'y'.repeat(1000), respondBytes: 2000 })
    expect(out).toMatchObject({ ok: true, receivedChars: 1000, respondedBytes: 2000 })
    expect(out.filler.length).toBe(2000)
  })
})
