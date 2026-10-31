/**
 * What Claude is told, without a model turn, about the open notebook: where the student is and whether a picture of
 * their work is waiting in nova_read_page. The host keeps only the latest update and shows it to the model with the
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
 * What the picture stored for Claude shows: the screen, a rectangle the student snipped, or the whole page; or why
 * there is none: the page is empty, the student paused it, it would be too large, or another device is editing.
 */
export type Seen = 'screen' | 'area' | 'page' | 'empty' | 'paused' | 'too-large' | 'elsewhere'

/** The kinds of Seen that come with a picture. */
export const SHOWN: ReadonlySet<Seen> = new Set(['screen', 'area', 'page'])

const count = (c: { strokes: number; pictures: number }) =>
  [c.strokes ? `${c.strokes} stroke${c.strokes === 1 ? '' : 's'}` : '', c.pictures ? `${c.pictures} picture${c.pictures === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') || 'nothing'

const SEEN_TEXT: Record<Seen, string> = {
  screen: 'The student is showing you exactly what is on their screen.',
  area: 'The student is showing you a rectangle of the page they snipped; the rest of the page is not shown.',
  page: 'The student is showing you their whole page.',
  empty: 'There is no work on screen, so there is no picture to show you.',
  paused: 'The student paused showing you their page, so there is no picture of it. Ask them to describe the work, or to turn showing back on from the notebook\'s More menu.',
  'too-large': 'The picture of the work is too large to show you. Ask the student to zoom in on the part they mean, or to snip it.',
  elsewhere: 'Another of the student\'s devices is editing this page; the picture comes from that device.',
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
    SHOWN.has(seen) || seen === 'elsewhere'
      ? `To see the student's work, including their handwriting, call nova_read_page with pageId ${view.page.id}: its result includes this picture as an image. Call it again for each new question, since the work changes.`
      : 'nova_read_page gives the page\'s layout, not its handwriting.',
    'Answer what the student asks; do not offer hints or draw on the page unless they ask.',
  ].join('\n')
}

/** Largest base64 picture stored for Claude; the server refuses more (it must stay under its 2 MB row limit). */
export const MAX_VIEW_BASE64 = 1_500_000

/** Base64 of a blob without building one huge string of characters in a single call. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
