/**
 * Worker entry. Routes JSON requests to one CanvasDO per canvas.
 * NO AUTHENTICATION in this spike: it must never be deployed as is (see docs, "Auth design").
 */
import { CanvasDO, type Env } from './canvas-do'

export { CanvasDO }

const OPS = new Set(['open', 'openRaw', 'save', 'heartbeat', 'release', 'listCheckpoints', 'restoreCheckpoint', 'initFromSnapshot', 'importCheckpoint', 'diagnostics'])
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

/** Deterministic canvas id for "save as new": a retry of the same saveId lands on the same object, which replays. */
export async function canvasIdForSaveId(saveId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`save-as-new:${saveId}`)))
  const hex = [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST') return json({ ok: false, code: 'METHOD', message: 'POST only' }, 405)

    // POST /api/save-as-new  { name, clientId, saveId, snapshot }
    if (url.pathname === '/api/save-as-new') {
      const body = await request.json() as any
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''
      if (!name) return json({ ok: false, code: 'INVALID_NAME', message: 'Enter a canvas name.' })
      if (typeof body.saveId !== 'string' || !body.saveId || body.saveId.length > 64) return json({ ok: false, code: 'INVALID_REQUEST', message: 'Missing save id.' })
      const id = await canvasIdForSaveId(body.saveId)
      const stub = env.CANVAS.get(env.CANVAS.idFromName(id))
      const result = await stub.initFromSnapshot({ clientId: body.clientId, saveId: body.saveId, snapshot: body.snapshot }) as any
      return json(result.ok ? { ...result, canvas: { id, name } } : result)
    }

    // POST /api/canvas/:id/:op
    const match = /^\/api\/canvas\/([0-9a-f-]{36})\/([A-Za-z]+)$/.exec(url.pathname)
    if (!match || !OPS.has(match[2])) return json({ ok: false, code: 'NOT_FOUND', message: 'Unknown route' }, 404)
    const [, id, op] = match
    const body = op === 'listCheckpoints' || op === 'diagnostics' ? undefined : await request.json()
    const stub = env.CANVAS.get(env.CANVAS.idFromName(id)) as any
    const out = await (body === undefined ? stub[op]() : stub[op](body))
    // openRaw returns finished JSON text; passing it through avoids a parse + stringify of the whole canvas.
    return typeof out === 'string' ? new Response(out, { headers: { 'content-type': 'application/json' } }) : json(out)
  },
}
