import assert from 'node:assert/strict'
import test from 'node:test'
import { notebookContext } from '../context'
import { askDelivery } from '../ask'

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
  const text = notebookContext(view)
  assert.match(text, /"Dynamics HW" \(notebookId nb-1\)/)
  assert.match(text, /"Problem 6-66", page 2 of 5 \(pageId pg-2\), cream graph paper, zoom 90%/)
  assert.match(text, /On screen: 12 strokes and 1 picture\. Save status: Saved\./)
  assert.ok(!text.includes('Selected'), 'no selection line when nothing is selected')
  assert.match(text, /Do not offer hints the student did not ask for/)
})

test('a selection is described; the library has no page', () => {
  assert.match(notebookContext({ ...view, selected: { strokes: 3, pictures: 0 } }), /Selected: 3 strokes\./)
  assert.equal(notebookContext({ ...view, page: null }), 'NOVA Ink is open on the library; no page is open.')
})

test('the picture goes in the message when the host takes images, else staged in the model context, else nowhere', () => {
  assert.equal(askDelivery({ message: { text: {}, image: {} } }), 'message')
  assert.equal(askDelivery({ message: {} }), 'message', 'a channel with no kinds listed is taken to accept pictures')
  assert.equal(askDelivery({ message: { text: {} }, updateModelContext: { text: {}, image: {} } }), 'context')
  assert.equal(askDelivery({ message: { text: {} }, updateModelContext: { text: {} } }), null)
  assert.equal(askDelivery({ updateModelContext: { image: {} } }), null, 'without messages nothing can be asked')
  assert.equal(askDelivery(undefined), null)
})
