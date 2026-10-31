/**
 * Turns the picture the student shows Claude into text, for hosts that pass no images to the model (Claude's voice
 * mode). Runs a Workers AI vision model only when Claude looks; the caller caches the text with the picture.
 */

/** The smallest slice of the Workers AI binding used here, so tests can supply a fake. */
export interface VisionAi { run(model: string, input: Record<string, unknown>): Promise<unknown> }

/** Tried in order. Scout runs on the free allowance (exact on a synthetic statics page in ~3 s); GLM needs Workers Paid. */
export const VISION_MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/zai-org/glm-5.3-flash'] as const
export const TRANSCRIBE_TIMEOUT_MS = 25_000

const PROMPT = `This is a picture of a student's engineering notebook: printed problem text and/or their handwriting on grid paper.
Transcribe it so someone who cannot see it can follow the work exactly:
- Printed text: word for word.
- Handwritten work: line by line, top to bottom, exactly as written, including mistakes. Write math in plain text (e.g. "ΣFx = 0: F - W sin30° = 0", "x^2", "(a)/(b)").
- Drawings (free-body diagrams, axes, arrows, labels): describe briefly what is drawn, where, and which labels and directions they have.
- Write [illegible] for anything you cannot read. Do not solve, correct, or comment on the work.`

export type Transcript = { text: string; model: string }

/** The text of a chat-style or a plain Workers AI response. */
function replyText(out: unknown): string {
  const o = out as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
  const text = typeof o?.response === 'string' ? o.response : o?.choices?.[0]?.message?.content
  return typeof text === 'string' ? text.trim() : ''
}

export async function transcribe(ai: VisionAi, picture: { data: string; mimeType: string }, timeoutMs = TRANSCRIBE_TIMEOUT_MS): Promise<Transcript | { error: string }> {
  const messages = [{ role: 'user', content: [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: `data:${picture.mimeType};base64,${picture.data}` } },
  ] }]
  let last = 'no vision model answered'
  for (const model of VISION_MODELS) {
    try {
      const input: Record<string, unknown> = { messages, max_tokens: 1500, temperature: 0 }
      if (model.includes('glm')) input.reasoning_effort = 'low'
      const out = await Promise.race([
        ai.run(model, input),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
      ])
      const text = replyText(out)
      if (text) return { text, model }
      last = `${model} returned no text`
    } catch (error) {
      last = `${model}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { error: last }
}
