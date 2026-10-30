import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The NOVA Ink notebook app for ChatGPT, built to one self-contained HTML file (dist/notebook.html).
export default defineConfig({
  root: __dirname,
  plugins: [viteSingleFile()],
  server: { host: '127.0.0.1', fs: { allow: [resolve(__dirname, '..')] } },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'notebook.html') },
    assetsInlineLimit: 100_000_000,
  },
})
