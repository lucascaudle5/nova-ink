/**
 * Configuration check. FAIL CLOSED: if anything required is missing or malformed, `readConfig` returns
 * { ok: false } and the Worker answers every route except /health with an error. Values are never logged or returned.
 *
 * Secrets (wrangler secret put): ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET, ACCESS_TOKEN_URL, ACCESS_AUTHORIZATION_URL,
 *   ACCESS_JWKS_URL, ALLOWED_EMAIL
 * Plain var (wrangler.jsonc, not secret): PUBLIC_ORIGIN, e.g. https://nova-ink-test.<subdomain>.workers.dev
 * Bindings: OAUTH_KV, CANVAS, LIBRARY
 */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import type { CanvasDO } from './canvas-do'
import type { LibraryDO } from './library-do'

export interface AppEnv {
  CANVAS: DurableObjectNamespace<CanvasDO>
  LIBRARY: DurableObjectNamespace<LibraryDO>
  OAUTH_KV: KVNamespace
  /** Injected by OAuthProvider into the env its handlers receive. */
  OAUTH_PROVIDER: OAuthHelpers
  PUBLIC_ORIGIN?: string
  ACCESS_CLIENT_ID?: string
  ACCESS_CLIENT_SECRET?: string
  ACCESS_TOKEN_URL?: string
  ACCESS_AUTHORIZATION_URL?: string
  ACCESS_JWKS_URL?: string
  ALLOWED_EMAIL?: string
}

export type AppConfig = {
  origin: string
  clientId: string
  clientSecret: string
  tokenUrl: string
  authorizationUrl: string
  jwksUrl: string
  /** Expected `iss` of the ID token: the authorization URL without its trailing /authorization. */
  issuer: string
  allowedEmail: string
}

const TEAM_HOST = /^[a-z0-9-]+\.cloudflareaccess\.com$/

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

function parseUrl(value: string | null): URL | null {
  if (!value) return null
  try { return new URL(value) } catch { return null }
}

export function readConfig(env: Partial<AppEnv>): { ok: true; config: AppConfig } | { ok: false } {
  if (!env.OAUTH_KV || !env.CANVAS || !env.LIBRARY) return { ok: false }
  const origin = parseUrl(text(env.PUBLIC_ORIGIN))
  const clientId = text(env.ACCESS_CLIENT_ID)
  const clientSecret = text(env.ACCESS_CLIENT_SECRET)
  const token = parseUrl(text(env.ACCESS_TOKEN_URL))
  const authorize = parseUrl(text(env.ACCESS_AUTHORIZATION_URL))
  const jwks = parseUrl(text(env.ACCESS_JWKS_URL))
  const email = text(env.ALLOWED_EMAIL)?.toLowerCase() ?? null
  if (!origin || !clientId || !clientSecret || !token || !authorize || !jwks || !email || !email.includes('@')) return { ok: false }

  // The Worker's own origin: https, or http on localhost for `wrangler dev`. No path, query or credentials.
  const localDev = origin.protocol === 'http:' && (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1')
  if ((origin.protocol !== 'https:' && !localDev) || origin.pathname !== '/' || origin.search || origin.hash || origin.username) return { ok: false }

  // The client secret is sent to ACCESS_TOKEN_URL, so all three Access URLs must be on a Cloudflare Access team domain
  // and share one issuer base. A mistyped or malicious value therefore cannot send the secret elsewhere.
  for (const url of [token, authorize, jwks]) {
    if (url.protocol !== 'https:' || !TEAM_HOST.test(url.hostname) || url.search || url.hash || url.username) return { ok: false }
  }
  if (!authorize.pathname.endsWith('/authorization')) return { ok: false }
  const base = authorize.pathname.slice(0, -'/authorization'.length)
  if (!base.startsWith('/cdn-cgi/access/sso/oidc/') || token.hostname !== authorize.hostname || jwks.hostname !== authorize.hostname) return { ok: false }
  if (token.pathname !== `${base}/token` || jwks.pathname !== `${base}/jwks`) return { ok: false }

  return {
    ok: true,
    config: {
      origin: origin.origin, clientId, clientSecret, tokenUrl: token.toString(), authorizationUrl: authorize.toString(), jwksUrl: jwks.toString(),
      issuer: `https://${authorize.hostname}${base}`, allowedEmail: email,
    },
  }
}
