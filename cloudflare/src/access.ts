/**
 * Cloudflare Access for SaaS (OIDC) client. The Worker is the relying party:
 *   /authorize --> Access authorization endpoint --> /callback --> code exchange --> ID token verification.
 * Verification: signature via the app's JWKS, issuer, audience (= our Access client id), expiry, nonce, then the
 * email against ALLOWED_EMAIL. Nothing here logs tokens or claims.
 */
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose'
import type { AppConfig } from './config'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class AccessError extends Error {
  constructor(readonly code: 'UPSTREAM' | 'INVALID_TOKEN' | 'WRONG_USER', message: string) { super(message) }
}

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const randomToken = (bytes = 32) => base64Url(crypto.getRandomValues(new Uint8Array(bytes)))

export async function s256(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

export const callbackUrl = (config: AppConfig) => `${config.origin}/callback`

export async function accessAuthorizeUrl(config: AppConfig, p: { state: string; nonce: string; verifier: string }): Promise<string> {
  const url = new URL(config.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', callbackUrl(config))
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', p.state)
  url.searchParams.set('nonce', p.nonce)
  url.searchParams.set('code_challenge', await s256(p.verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** Exchanges the code, verifies the ID token and the allowed email. Returns the verified email. */
export async function exchangeAndVerify(config: AppConfig, doFetch: FetchLike, p: { code: string; verifier: string; nonce: string }): Promise<{ email: string }> {
  const signal = AbortSignal.timeout(10_000)
  let tokenResponse: Response
  try {
    tokenResponse = await doFetch(config.tokenUrl, {
      method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: p.code, redirect_uri: callbackUrl(config),
        client_id: config.clientId, client_secret: config.clientSecret, code_verifier: p.verifier,
      }),
    })
  } catch { throw new AccessError('UPSTREAM', 'Could not reach Cloudflare Access.') }
  if (!tokenResponse.ok) throw new AccessError('UPSTREAM', `Cloudflare Access refused the code (${tokenResponse.status}).`)
  let idToken: unknown
  try { idToken = ((await tokenResponse.json()) as { id_token?: unknown }).id_token } catch { throw new AccessError('UPSTREAM', 'Cloudflare Access sent an unreadable reply.') }
  if (typeof idToken !== 'string' || !idToken) throw new AccessError('INVALID_TOKEN', 'Cloudflare Access sent no ID token.')

  let keys: { keys: JWK[] }
  try {
    const response = await doFetch(config.jwksUrl, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(String(response.status))
    keys = await response.json() as { keys: JWK[] }
  } catch { throw new AccessError('UPSTREAM', 'Could not fetch the Cloudflare Access signing keys.') }

  let claims: Record<string, unknown>
  try {
    const verified = await jwtVerify(idToken, createLocalJWKSet(keys), {
      issuer: config.issuer, audience: config.clientId, algorithms: ['RS256', 'ES256'], clockTolerance: 30,
    })
    claims = verified.payload as Record<string, unknown>
  } catch { throw new AccessError('INVALID_TOKEN', 'The ID token did not verify.') }

  if (claims.nonce !== p.nonce) throw new AccessError('INVALID_TOKEN', 'The ID token nonce did not match.')
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (!email || email !== config.allowedEmail) throw new AccessError('WRONG_USER', 'This account is not allowed.')
  return { email }
}

/** Stable, ':'-free user id (the OAuth provider forbids ':'). The email itself is never stored in grants or props. */
export async function userIdFor(email: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nova-ink-user:${email}`)))
  return [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
}
