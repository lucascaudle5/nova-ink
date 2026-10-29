import cors from 'cors'
import type { Request, Response } from 'express'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createServer } from './server.js'

if (process.argv.includes('--stdio')) {
  await createServer().connect(new StdioServerTransport())
} else {
  const port = Number(process.env.PORT || 3001)
  const bindAddress = process.env.BIND_ADDRESS || '127.0.0.1'
  const app = createMcpExpressApp({ host: bindAddress })
  app.use(cors())
  app.get('/health', (_req: Request, res: Response) => res.json({ ok: true, app: 'nova-ink-mcp', phase: 'persistent-canvas-test' }))
  app.all('/mcp', async (req: Request, res: Response) => {
    const server = createServer()
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error('MCP request failed', error)
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })
  app.listen(port, bindAddress, () => {
    console.error(`NOVA Ink MCP listening on http://${bindAddress}:${port}/mcp`)
    console.error('To use from ChatGPT iPad, deploy this endpoint to a reachable HTTPS host with access controls.')
  })
}
