import { describe, expect, it } from 'vitest'
import { transcribe, VISION_MODELS } from '../../src/engine/transcribe'

const picture = { data: 'iVBORw0KGgo=', mimeType: 'image/png' }

describe('transcribing the picture for hosts without images', () => {
  it('sends the picture as a data URL with the instructions, and returns the first model\'s text', async () => {
    const calls: Array<{ model: string; input: any }> = []
    const out = await transcribe({ run: async (model, input) => { calls.push({ model, input }); return { response: '  W = mg  ' } } }, picture)
    expect(out).toEqual({ text: 'W = mg', model: VISION_MODELS[0] })
    expect(calls).toHaveLength(1)
    const content = calls[0].input.messages[0].content
    expect(content[0].text).toMatch(/Do not solve, correct, or comment/)
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } })
  })

  it('falls back to the next model on an error or empty answer, reads chat-style replies, and reports when all fail', async () => {
    const fallback = await transcribe({ run: async model => { if (model === VISION_MODELS[0]) throw new Error('capacity'); return { choices: [{ message: { content: 'F = 196.2 N' } }] } } }, picture)
    expect(fallback).toEqual({ text: 'F = 196.2 N', model: VISION_MODELS[1] })
    expect(await transcribe({ run: async () => ({ response: '' }) }, picture)).toEqual({ error: `${VISION_MODELS[1]} returned no text` })
    expect(await transcribe({ run: () => new Promise(() => {}) }, picture, 20)).toEqual({ error: `${VISION_MODELS[1]}: timed out` })
  })
})
