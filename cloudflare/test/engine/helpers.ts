/**
 * Engine Worker test helpers: a fake Cloudflare Access (real RS256 ID tokens and JWKS), the whole OAuth sign-in,
 * and MCP tool calls. Same approach as test/workers/auth.test.ts; real Access and real ChatGPT are not covered.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { expect } from 'vitest'
import { createApp } from '../../src/app'
import { ENGINE_APP } from '../../src/engine/index'
import { createStroke } from '../../../engine/src/core/stroke'
import { serializeStroke } from '../../../engine/src/core/format'

export const E = env as any
export const ORIGIN = 'https://nova-ink-engine.example.workers.dev'
const CLIENT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const BASE = `https://nova-test.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`
export const OWNER = 'owner@example.com'
const CLIENT_SECRET = 'test-client-secret-not-real'
const REDIRECT = 'https://client.example/cb'

const pair = await generateKeyPair('RS256', { extractable: true })
const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
const codes = new Map<string, { nonce: string; email: string }>()

async function fakeAccessFetch(url: string, init?: RequestInit): Promise<Response> {
  if (url === `${BASE}/jwks`) return Response.json({ keys: [jwk] })
  if (url === `${BASE}/token`) {
    const body = new URLSearchParams(String(init?.body))
    const grant = codes.get(body.get('code') ?? '')
    if (!grant || body.get('client_secret') !== CLIENT_SECRET) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    codes.delete(body.get('code')!)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await new SignJWT({ email: grant.email, nonce: grant.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(BASE).setAudience(CLIENT_ID).setSubject('sub-1').setIssuedAt(now).setExpirationTime(now + 300).sign(pair.privateKey)
    return Response.json({ id_token: jwt, token_type: 'Bearer' })
  }
  return new Response('unexpected fetch', { status: 599 })
}

export const app = createApp({ fetch: fakeAccessFetch }, ENGINE_APP)

export function goodEnv(overrides: Record<string, unknown> = {}) {
  return {
    PAGE: E.PAGE, ENGINE_LIBRARY: E.ENGINE_LIBRARY, OAUTH_KV: E.OAUTH_KV,
    PUBLIC_ORIGIN: ORIGIN, ACCESS_CLIENT_ID: CLIENT_ID, ACCESS_CLIENT_SECRET: CLIENT_SECRET,
    ACCESS_TOKEN_URL: `${BASE}/token`, ACCESS_AUTHORIZATION_URL: `${BASE}/authorization`, ACCESS_JWKS_URL: `${BASE}/jwks`,
    ALLOWED_EMAIL: OWNER, ...overrides,
  } as any
}

export async function call(url: string, init: RequestInit = {}, envOverrides: Record<string, unknown> = {}) {
  const ctx = createExecutionContext()
  const response = await app.fetch(new Request(url.startsWith('http') ? url : `${ORIGIN}${url}`, init), goodEnv(envOverrides), ctx)
  await waitOnExecutionContext(ctx)
  return response
}

const jar = (responses: Response[]) => {
  const cookies = new Map<string, string>()
  for (const r of responses) for (const line of r.headers.getSetCookie()) {
    const [pairText] = line.split(';'); const eq = pairText.indexOf('=')
    const name = pairText.slice(0, eq), value = pairText.slice(eq + 1)
    if (value === '' || /max-age=0/i.test(line)) cookies.delete(name); else cookies.set(name, value)
  }
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
}
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The whole OAuth dance as `email`; returns the access token (or null if sign-in was refused). */
export async function signIn(opts: { email?: string; scopes?: string[] } = {}): Promise<string | null> {
  const reg = await call('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test ChatGPT', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  })
  const clientId = (await reg.json() as any).client_id as string
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const consent = await call(`/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'mcp:read mcp:write offline_access', state: 's',
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`,
  })}`)
  const html = await consent.text()
  expect(html).toContain('your private NOVA Ink notebook')
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]
  const form = new URLSearchParams({ handle, decision: 'approve' })
  for (const s of opts.scopes ?? ['mcp:read', 'mcp:write', 'offline_access']) form.append('scope', s)
  const approve = await call('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar([consent]) }, body: form })
  const toAccess = new URL(approve.headers.get('location')!)
  codes.set('upstream-code', { nonce: toAccess.searchParams.get('nonce')!, email: opts.email ?? OWNER })
  const back = await call(`/callback?code=upstream-code&state=${encodeURIComponent(toAccess.searchParams.get('state')!)}`, { headers: { cookie: jar([consent, approve]) } })
  const redirect = new URL(back.headers.get('location')!)
  const code = redirect.searchParams.get('code')
  if (!code) return null
  const token = await call('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  })
  return (await token.json() as any).access_token
}

let rpcId = 0
export async function rpc(token: string | null, method: string, params?: unknown, protocol = '2025-06-18') {
  const response = await call('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol, ...(protocol >= '2026' ? { 'mcp-method': method } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const raw = await response.text()
  let body: any = null
  try { body = JSON.parse(raw) } catch { const line = raw.split('\n').find(l => l.startsWith('data:')); if (line) body = JSON.parse(line.slice(5)) }
  return { response, body }
}

export async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args })
  if (body?.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`)
  return body.result.structuredContent as any
}

/** A serialized stroke as the notebook app sends it. */
export function strokeData(id: string, x = 0) {
  return serializeStroke(createStroke({ id, style: { color: '#1f2937', width: 2 }, createdAt: 1_700_000_000_000, points: [x, 0, 0.5, 0, x + 10, 5, 0.5, 8, x + 20, 3, 0.5, 16] }))
}
