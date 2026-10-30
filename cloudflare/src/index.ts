/**
 * Worker entry. Everything goes through createApp(): OAuth provider + Cloudflare Access sign-in + MCP.
 * The unauthenticated JSON API of the first spike was removed; the only way to reach a Durable Object now is an
 * authorized MCP tool call. If configuration is incomplete, every route except /health returns 503.
 */
import { createApp, type AppOptions } from './app'
import { CanvasDO } from './canvas-do'
import { LibraryDO } from './library-do'
import { createNovaServer } from './mcp'

export { CanvasDO, LibraryDO }

export const TLDRAW_TEST_APP: AppOptions = {
  app: 'nova-ink-cf-test', bindings: ['CANVAS', 'LIBRARY'], notebookLabel: 'your private NOVA Ink test notebook',
  homeTitle: 'NOVA Ink test Worker', createServer: ctx => createNovaServer(ctx),
}

export default createApp(undefined, TLDRAW_TEST_APP)
