/**
 * The Worker application: Cloudflare's OAuth provider in front, Access for SaaS (OIDC) as the identity step,
 * and the MCP endpoint behind it.
 *
 *   ChatGPT --(OAuth 2.1 + PKCE)--> /authorize (our consent page) --> Cloudflare Access login --> /callback
 *   /callback: verify ID token (signature, issuer, audience, nonce, expiry) + ALLOWED_EMAIL --> issue our own code/tokens
 *   ChatGPT --(Bearer token)--> /mcp  (only reached with a valid token for this resource; scopes enforced per tool)
 *
 * Fail closed: when configuration is incomplete every route except /health returns 503, and nothing is served.
 */
import {
  AuthorizationError, CimdFetchError, OAuthProvider, authorizationErrorRedirect, insufficientScope,
  type ConsentDescription, type OAuthResourceAuth,
} from '@cloudflare/workers-oauth-provider'
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server'
import { AccessError, accessAuthorizeUrl, exchangeAndVerify, randomToken, userIdFor, type FetchLike } from './access'
import { readConfig, type AppConfig, type BaseEnv } from './config'

export const SCOPES = ['mcp:read', 'mcp:write', 'offline_access']
/** A save can carry a 12 MiB snapshot plus the JSON-RPC envelope. */
export const MAX_MCP_BODY_BYTES = 16 * 1024 * 1024

export type AppDeps = { fetch: FetchLike }
type Env = BaseEnv & Record<string, unknown>

export type ServerContext = {
  env: any
  userId: string
  scopes: string[]
  waitUntil: (promise: Promise<unknown>) => void
  /** Content-Length of the MCP request, for the payload-size log line. */
  bytesIn: number | null
}

/** What differs between the Workers that share this sign-in layer. */
export type AppOptions = {
  /** Reported by /health. */
  app: string
  /** Storage bindings that must exist, or the Worker fails closed. */
  bindings: readonly string[]
  /** Shown on the consent page: "... wants to connect to <notebookLabel>." */
  notebookLabel: string
  homeTitle: string
  createServer: (ctx: ServerContext) => McpServer
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const page = (title: string, body: string, status = 200, headers?: Headers) => {
  const out = new Headers(headers)
  out.set('content-type', 'text/html; charset=utf-8')
  out.set('cache-control', 'no-store')
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}`, { status, headers: out })
}

function consentPage(details: ConsentDescription, handle: string, label: string): string {
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.'
  const scopes = SCOPES.map(s => `<label><input type="checkbox" name="scope" value="${escapeHtml(s)}" checked ${s === 'mcp:read' ? 'disabled' : ''}> ${escapeHtml(s)}</label>`).join('<br>')
  return `<p><strong>${escapeHtml(details.clientName)}</strong> wants to connect to ${escapeHtml(label)}. ${origin}</p>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.${details.redirectIsLoopback ? ' <strong>That is an app on this computer.</strong>' : ''}</p>
<p>Next you will sign in with Cloudflare Access. Only the owner's email can finish.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p>${scopes}</p>
  <p><button name="decision" value="approve">Allow and sign in</button> <button name="decision" value="deny">Deny</button></p>
</form>`
}

/** An AuthorizationError with a validated redirect goes back to the client; otherwise it is shown here. */
function authorizationFailure(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return new Response(null, { status: 302, headers: { Location: error.redirectTo, 'cache-control': 'no-store' } })
    return page('Sign-in problem', `<p>${escapeHtml(error.description)}</p><p>Start again from ChatGPT.</p>`, 400)
  }
  if (error instanceof CimdFetchError) return page('Sign-in problem', '<p>This app could not be verified.</p>', 400)
  throw error
}

export function createApp(given: AppDeps | undefined, options: AppOptions) {
  const deps: AppDeps = given ?? { fetch: (input, init) => fetch(input, init) }
  const providers = new Map<string, OAuthProvider<Env>>()
  const configOf = (env: Env) => readConfig(env, options.bindings)

  // ---- /authorize and /callback (the OAuth provider's defaultHandler) ----------------------------------

  async function authorizeGet(request: Request, env: Env): Promise<Response> {
    const oauth = env.OAUTH_PROVIDER
    try {
      const authRequest = await oauth.parseAuthRequest(request)
      const details = await oauth.describeConsent(authRequest)
      const consent = await oauth.beginConsent(authRequest)
      return page('Connect NOVA Ink', consentPage(details, consent.handle, options.notebookLabel), 200, consent.headers)
    } catch (error) { return authorizationFailure(error) }
  }

  async function authorizePost(request: Request, env: Env, config: AppConfig): Promise<Response> {
    const oauth = env.OAUTH_PROVIDER
    try {
      const form = await request.formData()
      const handle = String(form.get('handle') ?? '')
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle)
        return new Response(null, { status: 302, headers: denied.headers })
      }
      const scope = [...new Set(['mcp:read', ...form.getAll('scope').map(String).filter(s => SCOPES.includes(s))])]
      const approved = await oauth.approveConsent(request, handle, { scope })
      const verifier = randomToken(48)
      const nonce = randomToken(24)
      const upstream = await oauth.beginUpstream(approved.request, { data: { verifier, nonce }, headers: approved.headers })
      upstream.headers.set('Location', await accessAuthorizeUrl(config, { state: upstream.state, nonce, verifier }))
      upstream.headers.set('cache-control', 'no-store')
      return new Response(null, { status: 302, headers: upstream.headers })
    } catch (error) { return authorizationFailure(error) }
  }

  async function callback(request: Request, env: Env, config: AppConfig): Promise<Response> {
    const oauth = env.OAUTH_PROVIDER
    let resumed
    try { resumed = await oauth.finishUpstream<{ verifier?: unknown; nonce?: unknown }>(request) } catch (error) { return authorizationFailure(error) }
    const { request: original, data, headers } = resumed
    const redirect = (location: string) => { headers.set('Location', location); headers.set('cache-control', 'no-store'); return new Response(null, { status: 302, headers }) }

    const params = new URL(request.url).searchParams
    const code = params.get('code')
    if (params.get('error') || !code || typeof data?.verifier !== 'string' || typeof data?.nonce !== 'string') {
      return redirect(authorizationErrorRedirect(original, 'access_denied'))
    }
    let email: string
    try { ({ email } = await exchangeAndVerify(config, deps.fetch, { code, verifier: data.verifier, nonce: data.nonce })) }
    catch (error) {
      if (error instanceof AccessError && error.code === 'UPSTREAM') {
        console.error(`[nova-ink] callback: ${error.message}`)
        return redirect(authorizationErrorRedirect(original, 'server_error'))
      }
      console.warn(`[nova-ink] callback refused: ${error instanceof AccessError ? error.code : 'unexpected'}`) // never the email or token
      return redirect(authorizationErrorRedirect(original, 'access_denied'))
    }
    const userId = await userIdFor(email)
    const { redirectTo } = await oauth.completeAuthorization({ request: original, userId, metadata: {}, scope: original.scope, props: { userId } })
    return redirect(redirectTo)
  }

  async function defaultHandler(request: Request, env: Env): Promise<Response> {
    const parsed = configOf(env)
    if (!parsed.ok) return notConfigured()
    const { pathname } = new URL(request.url)
    if (pathname === '/authorize' && request.method === 'GET') return authorizeGet(request, env)
    if (pathname === '/authorize' && request.method === 'POST') return authorizePost(request, env, parsed.config)
    if (pathname === '/callback' && request.method === 'GET') return callback(request, env, parsed.config)
    if (pathname === '/') return page(options.homeTitle, '<p>Private deployment. Nothing to see here.</p>')
    return json({ ok: false, code: 'NOT_FOUND', message: 'Unknown route' }, 404)
  }

  // ---- /mcp (only reached with a valid access token for this resource) ----------------------------------

  async function mcp(request: Request, env: Env, ctx: ExecutionContext & { props?: unknown; auth?: OAuthResourceAuth }): Promise<Response> {
    const auth = ctx.auth
    const props = ctx.props as { userId?: unknown } | undefined
    if (!auth || typeof props?.userId !== 'string' || !/^[0-9a-f]{32}$/.test(props.userId)) return json({ ok: false, code: 'UNAUTHORIZED', message: 'No valid identity.' }, 401)
    if (!auth.scope.includes('mcp:read')) return insufficientScope(auth, ['mcp:read'])
    const length = Number(request.headers.get('content-length'))
    const userId = props.userId
    const scopes = [...auth.scope]
    const handler = createMcpHandler(
      () => options.createServer({ env, userId, scopes, waitUntil: p => ctx.waitUntil(p), bytesIn: Number.isFinite(length) && length > 0 ? length : null }),
      { maxRequestBodySize: MAX_MCP_BODY_BYTES },
    )
    return handler.fetch(request, { authInfo: { token: '', clientId: auth.clientId ?? '', scopes, ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}) } })
  }

  function providerFor(config: AppConfig): OAuthProvider<Env> {
    let provider = providers.get(config.origin)
    if (!provider) {
      provider = new OAuthProvider<Env>({
        apiRoute: '/mcp',
        apiHandler: { fetch: (request, env, ctx) => mcp(request, env as Env, ctx as never) },
        defaultHandler: { fetch: (request, env) => defaultHandler(request, env as Env) },
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/oauth/token',
        clientRegistrationEndpoint: '/oauth/register',
        scopesSupported: SCOPES,
        requiredScopes: ['mcp:read', 'mcp:write'],
        resourceMetadata: { resource: `${config.origin}/mcp`, authorization_servers: [config.origin] },
        clientIdMetadataDocumentEnabled: true,
      })
      providers.set(config.origin, provider)
    }
    return provider
  }

  const notConfigured = () => json({ ok: false, code: 'NOT_CONFIGURED', message: 'This Worker is not configured. Nothing is served.' }, 503)

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)
      const parsed = configOf(env)
      // Only non-sensitive fact available without configuration: whether it is configured.
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, app: options.app, configured: parsed.ok })
      if (!parsed.ok) return notConfigured()
      // Serve only on the pinned origin (blocks stray hostnames and issuer confusion).
      if (url.origin !== parsed.config.origin) return json({ ok: false, code: 'WRONG_HOST', message: 'Unexpected host.' }, 421)
      return providerFor(parsed.config).fetch(request, env, ctx)
    },
  }
}
