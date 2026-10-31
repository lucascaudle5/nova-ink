/**
 * What Claude is told, without a model turn, about the open notebook: where the student is, never what they wrote.
 * The host keeps only the latest update and shows it to the model with the student's next message. No DOM, no network.
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

const count = (c: { strokes: number; pictures: number }) =>
  [c.strokes ? `${c.strokes} stroke${c.strokes === 1 ? '' : 's'}` : '', c.pictures ? `${c.pictures} picture${c.pictures === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') || 'nothing'

export function notebookContext(view: NotebookView): string {
  if (!view.notebook || !view.page) return 'NOVA Ink is open on the library; no page is open.'
  const selected = view.selected.strokes + view.selected.pictures > 0
  return [
    'NOVA Ink is open. This is where the student is, not what they wrote; the student\'s handwriting is not included.',
    `Notebook: "${view.notebook.name}" (notebookId ${view.notebook.id}).`,
    `Page: "${view.page.title}", page ${view.page.number} of ${view.page.of} (pageId ${view.page.id}), ${view.paper.color} ${view.paper.pattern} paper, zoom ${Math.round(view.zoom * 100)}%.`,
    `On screen: ${count(view.onScreen)}.${selected ? ` Selected: ${count(view.selected)}.` : ''} Save status: ${view.status}.`,
    'To see the work, ask the student to send it with Ask NOVA; nova_read_page gives the page\'s layout, not its handwriting. Do not offer hints the student did not ask for.',
  ].join('\n')
}
