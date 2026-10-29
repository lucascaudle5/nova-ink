import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createHttpApp } from './http.js'
import { createServer } from './server.js'
import { NotebookStore } from './storage.mjs'

const store = new NotebookStore()

if (process.argv.includes('--stdio')) {
  await createServer(store).connect(new StdioServerTransport())
} else {
  const port = Number(process.env.PORT || 3001)
  const bindAddress = process.env.BIND_ADDRESS || '127.0.0.1'
  createHttpApp(store, { host: bindAddress }).listen(port, bindAddress, () => {
    console.error(`NOVA Ink MCP listening on http://${bindAddress}:${port}/mcp`)
    console.error(`Notebook data: ${store.dir}`)
  })
}
