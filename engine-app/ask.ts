/** Ask NOVA: what the student chooses, what Claude is told, and when nothing is sent. No DOM, no network. */

export type HelpLevel = 'nudge' | 'concept' | 'next' | 'check'

/** The hint ladder. The student picks the level; each maps to one fixed instruction. */
export const HELP_LEVELS: Record<HelpLevel, { label: string; instruction: string }> = {
  nudge: { label: 'Nudge', instruction: 'Give only a small nudge in the right direction, without naming the method or the answer.' },
  concept: { label: 'Concept', instruction: 'Name the concept or principle that applies and explain it briefly, without applying it to this problem.' },
  next: { label: 'Next step', instruction: 'Show only the next step, then stop.' },
  check: { label: 'Check my work', instruction: 'Point to the first error, if any, without solving the rest.' },
}
export const HELP_ORDER: readonly HelpLevel[] = ['nudge', 'concept', 'next', 'check']

/**
 * What the picture covers: what is on screen now, only what the student selected, a rectangle the student drew (a snip),
 * or the whole page fitted to its content (a snip set to the whole page).
 */
export type AskScope = 'screen' | 'selection' | 'area' | 'page'

/** Shown in the sheet before sending. */
export const ASK_DISCLOSURE = 'Claude sees only the picture you send: what is on screen, your selection, or the area you choose.'

export const MAX_QUESTION = 1200
/** Largest base64 image the message may carry. */
export const MAX_IMAGE_BASE64 = 3_000_000

export interface AskInput {
  scope: AskScope
  notebook: string
  pageTitle: string
  /** 1-based position among the notebook's pages, and how many there are. */
  pageNumber: number
  pageCount: number
  paper: { color: string; pattern: string }
  /** Camera zoom, 1 = 100%. */
  zoom: number
  /** Strokes and pictures in the picture: those in view, selected, inside the area, or on the whole page, by scope. */
  visibleStrokes: number
  visiblePictures: number
  helpLevel: HelpLevel
  /** The student's optional note; empty when they just picked a level. */
  question: string
}

export interface AskContext {
  source: 'nova-ink-engine'
  scope: AskScope
  notebook: string
  page: { title: string; number: number; of: number; paper: string }
  zoomPercent: number
  /** Counts in the picture sent. */
  shown: { strokes: number; pictures: number }
  helpLevel: string
  /** Null when the student added no note. */
  note: string | null
}

/** The short description sent with the picture. Counts only; never stroke coordinates. */
export function askContext(input: AskInput): AskContext {
  return {
    source: 'nova-ink-engine',
    scope: input.scope,
    notebook: input.notebook,
    page: { title: input.pageTitle, number: input.pageNumber, of: input.pageCount, paper: `${input.paper.color} ${input.paper.pattern}` },
    zoomPercent: Math.round(input.zoom * 100),
    shown: { strokes: input.visibleStrokes, pictures: input.visiblePictures },
    helpLevel: HELP_LEVELS[input.helpLevel].label,
    note: input.question.trim().slice(0, MAX_QUESTION) || null,
  }
}

const SCOPE_TEXT: Record<AskScope, string> = {
  screen: 'Student-initiated request from NOVA Ink. The picture is exactly what is on the student\'s screen now.',
  selection: 'Student-initiated request from NOVA Ink. The picture shows only the part of the page the student selected (a lasso selection), cropped to it; the rest of their work is not shown.',
  area: 'Student-initiated request from NOVA Ink. The picture is a rectangle of the page the student chose (a snip), which may be only part of what is on the page.',
  page: 'Student-initiated request from NOVA Ink. The picture is the student\'s entire canvas for this page: everything on it, fitted to its content, not just what was on screen.',
}

/** The message text: the student's request, the fixed instruction for the chosen level, then the context. */
export function askText(input: AskInput): string {
  const context = askContext(input)
  return [
    SCOPE_TEXT[input.scope],
    `Help level: ${context.helpLevel}. ${HELP_LEVELS[input.helpLevel].instruction}`,
    'Do not draw on or change the notebook, and do not offer more help than this level.',
    context.note ? `Student's note: ${context.note}` : 'The student added no note; answer for the chosen help level from what is on screen.',
    `Context: ${JSON.stringify(context)}`,
  ].join('\n')
}

const EMPTY_REFUSAL: Record<AskScope, string> = {
  screen: 'There is no work on screen to show Claude. Pan to your work first.',
  selection: 'Nothing is selected, so there is nothing to show Claude.',
  area: 'There is no work inside that rectangle. Drag it over your work.',
  page: 'This page is empty, so there is nothing to show Claude.',
}
const LARGE_REFUSAL: Record<AskScope, string> = {
  screen: 'The picture of the screen is too large to send (over 3 MB). Zoom in on the part you want checked.',
  selection: 'The picture of the selection is too large to send (over 3 MB), even shrunk. Select less.',
  area: 'The picture of that area is too large to send (over 3 MB), even shrunk. Choose a smaller area.',
  page: 'The picture of the whole page is too large to send (over 3 MB), even shrunk. Choose a smaller area instead.',
}

/** A reason nothing should be sent, or null when the request is fine. A note is optional. */
export function askRefusal(input: { scope: AskScope; visibleStrokes: number; visiblePictures: number }, imageBase64Length: number | null): string | null {
  if (input.visibleStrokes + input.visiblePictures === 0) return EMPTY_REFUSAL[input.scope]
  if (imageBase64Length !== null && imageBase64Length > MAX_IMAGE_BASE64) return LARGE_REFUSAL[input.scope]
  return null
}

export interface AskMessage {
  role: 'user'
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
}

/** The message for `app.sendMessage`: text first, then the PNG. */
export function askMessage(input: AskInput, pngBase64: string): AskMessage {
  return { role: 'user', content: [{ type: 'text', text: askText(input) }, { type: 'image', data: pngBase64, mimeType: 'image/png' }] }
}

/** Content kinds a host says it accepts, as in the MCP Apps host capabilities (`message`, `updateModelContext`). */
export type Modalities = object | undefined

/**
 * How the picture can reach the model: inside the message, staged in the model context with the message carrying
 * only text, or not at all. A host that declares a channel without listing kinds is taken to accept pictures.
 */
export function askDelivery(caps: { message?: Modalities; updateModelContext?: Modalities } | undefined): 'message' | 'context' | null {
  const accepts = (m: Modalities) => !!m && (Object.keys(m).length === 0 || 'image' in m)
  if (!caps?.message) return null
  if (accepts(caps.message)) return 'message'
  if (accepts(caps.updateModelContext)) return 'context'
  return null
}

/** Base64 of a blob without building one huge string of characters in a single call. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
