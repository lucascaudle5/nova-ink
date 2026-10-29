import cors from 'cors'
import type { NextFunction, Request, Response } from 'express'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { createServer, VERSION } from './server.js'
import { MAX_SNAPSHOT_BYTES } from './storage.mjs'
import type { NotebookStore } from './storage.mjs'

/** Room for the largest accepted snapshot plus the JSON-RPC envelope; the store enforces the snapshot limit itself. */
export const HTTP_BODY_LIMIT_BYTES = MAX_SNAPSHOT_BYTES + 4 * 1024 * 1024

export function createHttpApp(store: NotebookStore, { host = '127.0.0.1', bodyLimitBytes = HTTP_BODY_LIMIT_BYTES } = {}) {
  const app = createMcpExpressApp({ host, jsonLimit: `${bodyLimitBytes}b` })
  app.use(cors())
  app.get('/health', (_req: Request, res: Response) => res.json({ ok: true, app: 'nova-ink-mcp', version: VERSION }))
  app.all('/mcp', async (req: Request, res: Response) => {
    const server = createServer(store)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error('[nova-ink] MCP request failed', error)
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })
  app.use((error: { type?: string; status?: number; length?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error)
    if (error?.type === 'entity.too.large') {
      const size = error.length ? `${(error.length / 1048576).toFixed(1)} MB` : 'too large'
      console.error(`[nova-ink] rejected request body (${size})`)
      return res.status(413).json({ jsonrpc: '2.0', error: { code: -32600, message: `NOVA Ink request is ${size}; the limit is ${(bodyLimitBytes / 1048576).toFixed(0)} MB. Nothing was saved.` }, id: null })
    }
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Malformed JSON request.' }, id: null })
    }
    console.error('[nova-ink] request error', error)
    return res.status(error?.status ?? 500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
  })
  return app
}
