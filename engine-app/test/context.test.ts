import assert from 'node:assert/strict'
import test from 'node:test'
import { notebookContext } from '../context'

const view = {
  notebook: { id: 'nb-1', name: 'Dynamics HW' },
  page: { id: 'pg-2', title: 'Problem 6-66', number: 2, of: 5 },
  paper: { color: 'cream', pattern: 'graph' },
  zoom: 0.9,
  onScreen: { strokes: 12, pictures: 1 },
  selected: { strokes: 0, pictures: 0 },
  status: 'Saved',
}

test('the context names the notebook and page with their ids, and counts what is on screen', () => {
  const text = notebookContext(view, 'screen')
  assert.match(text, /"Dynamics HW" \(notebookId nb-1\)/)
  assert.match(text, /"Problem 6-66", page 2 of 5 \(pageId pg-2\), cream graph paper, zoom 90%/)
  assert.match(text, /On screen: 12 strokes and 1 picture\. Save status: Saved\./)
  assert.ok(!text.includes('Selected'), 'no selection line when nothing is selected')
  assert.match(text, /do not offer hints or draw on the page unless they ask/)
})

test('a selection is described; the library has no page', () => {
  assert.match(notebookContext({ ...view, selected: { strokes: 3, pictures: 0 } }, 'screen'), /Selected: 3 strokes\./)
  assert.equal(notebookContext({ ...view, page: null }, 'screen'), 'NOVA Ink is open on the library; no page is open.')
})

test('the context says what the picture shows, or why there is none', () => {
  assert.match(notebookContext(view, 'screen'), /exactly what is on their screen/)
  assert.match(notebookContext(view, 'area'), /rectangle of the page they snipped/)
  assert.match(notebookContext(view, 'page'), /whole page/)
  assert.match(notebookContext(view, 'paused'), /paused showing you/)
  assert.match(notebookContext(view, 'too-large'), /too large/)
  assert.match(notebookContext(view, 'elsewhere'), /Another of the student's devices/)
})

test('when there is a picture, Claude is told to fetch it with nova_read_page for this page', () => {
  for (const seen of ['screen', 'area', 'page', 'elsewhere'] as const) assert.match(notebookContext(view, seen), /call nova_read_page with pageId pg-2: its result includes this picture as an image/)
  for (const seen of ['empty', 'paused', 'too-large'] as const) {
    const text = notebookContext(view, seen)
    assert.ok(!/call nova_read_page/.test(text), seen)
    assert.match(text, /layout, not its handwriting/)
  }
})
