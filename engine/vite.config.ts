import { defineConfig } from 'vite'

// The harness is a plain page served from harness/; it imports the engine from ../src.
// Default host is localhost only. `npx vite --host` exposes it on the LAN for iPad testing.
export default defineConfig({
  root: 'harness',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
})
