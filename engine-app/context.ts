/**
 * What Claude is told, without a model turn, about the open notebook: where the student is and, unless the student
 * paused it, a picture of their work. The host keeps only the latest update and shows it to the model with the
 * student's next message. No DOM, no network.
 */

export interface NotebookView {
  notebook: { id: string; name: string } | null
  page: { id: string; title: string; number: number; of: number } | null
  paper: { color: string; pattern: string }
  zoom: number
  onScreen: { strokes: number; pictures: number }
  selected: { strokes: number; pictures: number }
  /** The current save status as shown in the notebook (Saved, Not synced…). */
  status: string
}

/**
 * What the attached picture shows: the screen, a rectangle the student snipped, or the whole page; or why there is
 * no picture: the page is empty, the student paused sharing, the host takes no pictures, or it would be too large.
 */
export type Seen = 'screen' | 'area' | 'page' | 'empty' | 'paused' | 'unsupported' | 'too-large'

const count = (c: { strokes: number; pictures: number }) =>
  [c.strokes ? `${c.strokes} stroke${c.strokes === 1 ? '' : 's'}` : '', c.pictures ? `${c.pictures} picture${c.pictures === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') || 'nothing'

const SEEN_TEXT: Record<Seen, string> = {
  screen: 'The attached picture is exactly what is on the student\'s screen now.',
  area: 'The attached picture is a rectangle of the page the student chose (a snip); the rest of the page is not shown.',
  page: 'The attached picture is the student\'s whole page, fitted to its content.',
  empty: 'There is no work on screen, so no picture is attached.',
  paused: 'The student paused sharing their page, so no picture is attached. Ask them to describe the work, or to turn sharing back on from the notebook\'s More menu.',
  unsupported: 'This Claude app does not take pictures from the notebook, so the student\'s handwriting is not included. Ask them to describe the work or attach a screenshot.',
  'too-large': 'The picture of the work is too large to attach. Ask the student to zoom in on the part they mean, or to snip it.',
}

export function notebookContext(view: NotebookView, seen: Seen): string {
  if (!view.notebook || !view.page) return 'NOVA Ink is open on the library; no page is open.'
  const selected = view.selected.strokes + view.selected.pictures > 0
  return [
    'NOVA Ink is open; the student writes by hand and asks their questions in this chat.',
    `Notebook: "${view.notebook.name}" (notebookId ${view.notebook.id}).`,
    `Page: "${view.page.title}", page ${view.page.number} of ${view.page.of} (pageId ${view.page.id}), ${view.paper.color} ${view.paper.pattern} paper, zoom ${Math.round(view.zoom * 100)}%.`,
    `On screen: ${count(view.onScreen)}.${selected ? ` Selected: ${count(view.selected)}.` : ''} Save status: ${view.status}.`,
    SEEN_TEXT[seen],
    'nova_read_page gives the page\'s layout, not its handwriting. Answer what the student asks; do not offer hints or draw on the page unless they ask.',
  ].join('\n')
}

/** Content kinds a host says it accepts, as in the MCP Apps host capabilities. */
export type Modalities = object | undefined

/** Whether the host takes pictures in model context. A channel declared without listing kinds is taken to accept them. */
export function acceptsPictures(modalities: Modalities): boolean {
  return !!modalities && (Object.keys(modalities).length === 0 || 'image' in modalities)
}

/** Largest base64 picture put in the model context. */
export const MAX_PICTURE_BASE64 = 3_000_000

/** Base64 of a blob without building one huge string of characters in a single call. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
