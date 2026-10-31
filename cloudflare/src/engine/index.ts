/**
 * Worker entry for the engine notebook (`nova-ink-engine`): the same sign-in layer as the tldraw test Worker
 * (OAuth for Claude, Cloudflare Access with one allowed email, fail closed) in front of the engine tools.
 *
 * Also serves pdf.js at /assets/pdfjs/<file> without sign-in: public library code (no user data), fetched by
 * the notebook only when the user imports a PDF, so the notebook itself stays small.
 */
import { createApp, type AppOptions } from '../app'
import { NotebookLibraryDO } from './library-do'
import { createEngineServer } from './mcp'
import { PageDO } from './page-do'
import { PDFJS_FILES, PDFJS_VERSION } from './pdfjs.generated'

export { NotebookLibraryDO, PageDO }

export const ENGINE_APP: AppOptions = {
  app: 'nova-ink-engine', bindings: ['PAGE', 'ENGINE_LIBRARY'], notebookLabel: 'your private NOVA Ink notebook',
  homeTitle: 'NOVA Ink notebook', createServer: createEngineServer,
}

const app = createApp(undefined, ENGINE_APP)
const PDFJS_PREFIX = '/assets/pdfjs/'

export function servePdfjs(request: Request): Response | null {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(PDFJS_PREFIX)) return null
  const body = request.method === 'GET' || request.method === 'HEAD' ? PDFJS_FILES[url.pathname.slice(PDFJS_PREFIX.length)] : undefined
  if (body === undefined) return new Response('Not found', { status: 404 })
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // The notebook runs on Claude's sandbox origin (*.claudemcpcontent.com), so module imports need CORS.
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'x-pdfjs-version': PDFJS_VERSION,
    },
  })
}

export default {
  fetch(request: Request, env: Parameters<typeof app.fetch>[1], ctx: ExecutionContext): Promise<Response> | Response {
    return servePdfjs(request) ?? app.fetch(request, env, ctx)
  },
}
