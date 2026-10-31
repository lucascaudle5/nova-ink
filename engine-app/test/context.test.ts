import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptsPictures, notebookContext } from '../context'

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
  assert.match(notebookContext(view, 'screen'), /exactly what is on the student's screen/)
  assert.match(notebookContext(view, 'area'), /rectangle of the page the student chose/)
  assert.match(notebookContext(view, 'page'), /whole page/)
  assert.match(notebookContext(view, 'paused'), /paused sharing/)
  assert.match(notebookContext(view, 'unsupported'), /does not take pictures/)
  assert.match(notebookContext(view, 'too-large'), /too large/)
})

test('pictures go to a host that lists images or lists no kinds, never to one that lists only text', () => {
  assert.equal(acceptsPictures({ text: {}, image: {} }), true)
  assert.equal(acceptsPictures({}), true)
  assert.equal(acceptsPictures({ text: {} }), false)
  assert.equal(acceptsPictures(undefined), false)
})
