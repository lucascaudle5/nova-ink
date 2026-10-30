import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ASK_DISCLOSURE, askContext, askMessage, askRefusal, askText, HELP_LEVELS, HELP_ORDER, MAX_IMAGE_BASE64, MAX_QUESTION } from '../ask'
import type { AskInput } from '../ask'

const input: AskInput = {
  notebook: 'Dynamics', pageTitle: 'HW 6', pageNumber: 3, pageCount: 5, paper: { color: 'cream', pattern: 'graph' },
  zoom: 1.256, visibleStrokes: 42, visiblePictures: 1, helpLevel: 'check', question: '  Is my free-body diagram right?  ',
}

test('context describes the page, zoom, counts, level and trimmed question, and carries no coordinates', () => {
  const context = askContext(input)
  assert.deepEqual(context, {
    source: 'nova-ink-engine', notebook: 'Dynamics',
    page: { title: 'HW 6', number: 3, of: 5, paper: 'cream graph' },
    zoomPercent: 126, visible: { strokes: 42, pictures: 1 }, helpLevel: 'Check my work', question: 'Is my free-body diagram right?',
  })
  assert.equal(JSON.stringify(context).includes('points'), false)
})

test('the question is cut to 1,200 characters', () => {
  assert.equal(askContext({ ...input, question: 'x'.repeat(5000) }).question.length, MAX_QUESTION)
})

test('every help level has one fixed instruction, and its text is sent with the message', () => {
  assert.deepEqual([...HELP_ORDER].sort(), Object.keys(HELP_LEVELS).sort())
  assert.equal(HELP_LEVELS.check.instruction, 'Point to the first error, if any, without solving the rest.')
  for (const level of HELP_ORDER) {
    const text = askText({ ...input, helpLevel: level })
    assert.ok(text.includes(HELP_LEVELS[level].instruction))
    assert.ok(text.includes(`Help level: ${HELP_LEVELS[level].label}.`))
  }
  assert.ok(askText(input).includes('Do not draw on or change the notebook'))
})

test('the message is the text followed by the PNG', () => {
  const message = askMessage(input, 'AAAA')
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].type, 'text')
  assert.deepEqual(message.content[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' })
})

test('nothing is sent for an empty question, an empty view, or an image over 3 MB', () => {
  const ok = { question: 'why?', visibleStrokes: 1, visiblePictures: 0 }
  assert.equal(askRefusal(ok, 1000), null)
  assert.match(askRefusal({ ...ok, question: '   ' }, 1000)!, /question/)
  assert.match(askRefusal({ ...ok, visibleStrokes: 0 }, 1000)!, /no work on screen/)
  assert.equal(askRefusal({ ...ok, visibleStrokes: 0, visiblePictures: 1 }, 1000), null, 'a picture alone is work')
  assert.match(askRefusal(ok, MAX_IMAGE_BASE64 + 1)!, /too large/)
  assert.equal(askRefusal(ok, MAX_IMAGE_BASE64), null)
})

test('the disclosure says ChatGPT sees what is on screen', () => {
  assert.equal(ASK_DISCLOSURE, 'ChatGPT will see what is on screen now.')
})
