/**
 * PDF import: renders PDF pages to canvases with pdf.js, which is NOT bundled into the notebook. It is loaded the
 * first time a PDF is imported, from the engine Worker's /assets/pdfjs/ (the Worker writes its origin into the
 * nova-asset-origin meta tag and declares it to the host's CSP) or, in the local preview, from node_modules.
 * pdf.js runs on the main thread: importing its worker module registers the in-page handler, so no Worker
 * (which a sandboxed frame could not start from another origin) is needed.
 *
 * Some hosts (Gemini's MCP Apps) allow only inline scripts in the notebook's frame and refuse a script from another
 * address. When the direct import fails, the module text is fetched and imported from a data: URL instead (the host
 * must list the Worker in connectDomains and data: in resourceDomains, which the Worker declares).
 */
import type * as PdfJs from 'pdfjs-dist'

declare const __PDFJS_DEV_BASE__: string

type PdfLib = typeof PdfJs

/** Longest side of a rendered page in pixels: readable when zoomed, and modest in memory on an iPad. */
export const PDF_MAX_SIDE = 1600
/** Pages imported at once; larger documents import their first pages and say so. */
export const PDF_MAX_PAGES = 30
/** A PDF point (1/72 in) in page units, so a Letter page is 816 units wide, as at 96 units per inch. */
export const PAGE_UNITS_PER_POINT = 4 / 3

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

function pdfjsBase(): string | null {
  if (__PDFJS_DEV_BASE__) return __PDFJS_DEV_BASE__
  const origin = document.querySelector<HTMLMetaElement>('meta[name="nova-asset-origin"]')?.content ?? ''
  return /^https:\/\/[^/]+$/.test(origin) ? `${origin}/assets/pdfjs/` : null
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Imports a module script: directly, and if the host refuses that, by fetching the text and importing it as a data: URL. */
export async function importScript(
  url: string,
  direct: (url: string) => Promise<unknown> = u => import(/* @vite-ignore */ u),
  get: (url: string) => Promise<Response> = u => fetch(u),
): Promise<unknown> {
  try { return await direct(url) } catch (first) {
    let text: string
    try {
      const res = await get(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
    } catch { throw first }
    return await direct(`data:text/javascript;base64,${toBase64(text)}`)
  }
}

let loading: Promise<PdfLib> | null = null
function loadPdfjs(): Promise<PdfLib> {
  if (!loading) {
    loading = (async () => {
      const base = pdfjsBase()
      if (!base) throw new Error('PDF import is not available in this copy of the notebook')
      await importScript(`${base}pdf.worker.min.mjs`)
      return await importScript(`${base}pdf.min.mjs`) as PdfLib
    })()
    loading.catch(() => { loading = null })
  }
  return loading
}

export interface RenderedPdfPage {
  /** 1-based page number. */
  number: number
  canvas: HTMLCanvasElement
  /** Page size in PDF points. */
  widthPt: number
  heightPt: number
}

export interface PdfDocument {
  pageCount: number
  /** Renders one page (1-based) on a white background, at most PDF_MAX_SIDE pixels on its longest side. */
  render(number: number, maxSide?: number): Promise<RenderedPdfPage>
  close(): Promise<void>
}

export async function openPdf(data: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({
    data,
    // Nothing is fetched besides pdf.js itself: no font, CMap or WebAssembly downloads, and glyphs are drawn as
    // paths instead of loaded as web fonts.
    useWasm: false,
    disableFontFace: true,
    enableXfa: false,
  })
  const doc = await task.promise.catch(error => { void task.destroy(); throw error })
  return {
    pageCount: doc.numPages,
    async render(number, maxSide = PDF_MAX_SIDE) {
      const page = await doc.getPage(number)
      const base = page.getViewport({ scale: 1 })
      const scale = maxSide / Math.max(base.width, base.height)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      page.cleanup()
      return { number, canvas, widthPt: base.width, heightPt: base.height }
    },
    close: () => task.destroy(),
  }
}
