/**
 * Worker entry. Everything goes through createApp(): OAuth provider + Cloudflare Access sign-in + MCP.
 * The unauthenticated JSON API of the first spike was removed; the only way to reach a Durable Object now is an
 * authorized MCP tool call. If configuration is incomplete, every route except /health returns 503.
 */
import { createApp } from './app'
import { CanvasDO } from './canvas-do'
import { LibraryDO } from './library-do'

export { CanvasDO, LibraryDO }

export default createApp()
