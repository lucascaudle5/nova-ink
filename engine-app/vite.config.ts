import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The NOVA Ink notebook app for ChatGPT, built to one self-contained HTML file (dist/notebook.html).
// pdf.js stays out of that file (see pdf.ts); the dev server serves it straight from node_modules.
export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [viteSingleFile()],
  define: {
    __PDFJS_DEV_BASE__: JSON.stringify(command === 'serve'
      ? `/@fs/${resolve(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build').replace(/\\/g, '/').replace(/^\//, '')}/`
      : ''),
  },
  server: { host: '127.0.0.1', fs: { allow: [resolve(__dirname, '..')] } },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'notebook.html') },
    assetsInlineLimit: 100_000_000,
  },
}))
