/**
 * Rendering jobs NOVA asks for ("put pages 5 to 7 of this review into my notebook"). The server cannot render a PDF, so the
 * open notebook does it: it fetches the stored original, renders the requested pages or crops, stores each picture, and
 * reports back; the server then makes the pages and places the pictures. DOM-free (rendering is injected) so it is tested in Node.
 */
import type { Data, StoredPicture } from './session'

export interface Crop { x: number; y: number; w: number; h: number }
export interface JobItem { page: number; crop?: Crop; title?: string }
export interface Job { jobId: string; kind: string; params: { sourceId: string; items: JobItem[] }; source?: { name?: string } | null }

export interface RenderedSource {
  pageCount: number
  /** Renders a whole page, or the rectangle `crop` (fractions of the page) of it. */
  render(page: number, crop?: Crop): Promise<StoredPicture>
  close(): Promise<void>
}

export interface JobDeps {
  rpc(name: string, args: Record<string, unknown>): Promise<Data>
  uploadImage(picture: StoredPicture): Promise<string | null>
  open(bytes: Uint8Array): Promise<RenderedSource>
  say(text: string): void
  /** Called after a job was reported, so new pages show up in the notebook list. */
  changed(): Promise<unknown> | void
}

function unbase64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export class JobRunner {
  private running = false
  constructor(private readonly deps: JobDeps) {}

  get busy(): boolean { return this.running }

  /** Runs at most one waiting job. Returns true if it ran one (successfully or not). */
  async poll(): Promise<boolean> {
    if (this.running) return false
    this.running = true
    try {
      const listed = await this.deps.rpc('nb_jobs', {})
      const job = listed.ok ? (listed.jobs as Job[] | undefined)?.find(j => j.kind === 'place_source') : undefined
      if (!job) return false
      await this.run(job)
      return true
    } catch { return false } finally { this.running = false }
  }

  private async fail(job: Job, message: string) {
    this.deps.say(message)
    await this.deps.rpc('nb_job_done', { jobId: job.jobId, failure: message.slice(0, 300) })
  }

  private async run(job: Job) {
    const { rpc, say } = this.deps
    const name = job.source?.name ?? 'the document'
    say(`NOVA is getting ${name} ready…`)
    // the stored original
    const first = await rpc('nb_get_source_chunk', { sourceId: job.params.sourceId, index: 0 })
    if (!first.ok) { await this.fail(job, `The document could not be read (${first.message ?? 'not found'}).`); return }
    const bytes = new Uint8Array(first.bytes)
    let offset = 0
    for (let index = 0; index < first.count; index++) {
      const piece = index === 0 ? first : await rpc('nb_get_source_chunk', { sourceId: job.params.sourceId, index })
      if (!piece.ok) return   // a network problem: the job stays waiting and is tried again
      const chunk = unbase64(piece.data)
      if (offset + chunk.length > bytes.length) { await this.fail(job, 'The stored document is damaged.'); return }
      bytes.set(chunk, offset); offset += chunk.length
    }
    let doc: RenderedSource
    try { doc = await this.deps.open(bytes) } catch (error) { await this.fail(job, `The document could not be opened (${error instanceof Error ? error.message : String(error)}).`); return }
    try {
      const over = job.params.items.find(i => i.page > doc.pageCount)
      if (over) { await this.fail(job, `That document has ${doc.pageCount} pages; page ${over.page} does not exist.`); return }
      const outputs: Array<{ imageId: string; width: number; height: number }> = []
      for (let i = 0; i < job.params.items.length; i++) {
        const item = job.params.items[i]
        say(`NOVA is preparing page ${item.page}${item.crop ? ' (a problem)' : ''} — ${i + 1} of ${job.params.items.length}…`)
        let picture: StoredPicture
        try { picture = await doc.render(item.page, item.crop) } catch (error) { await this.fail(job, `Page ${item.page} could not be rendered (${error instanceof Error ? error.message : String(error)}).`); return }
        const imageId = await this.deps.uploadImage(picture)
        if (!imageId) return   // upload problems are shown by the session; the job stays waiting
        outputs.push({ imageId, width: picture.width, height: picture.height })
      }
      const done = await rpc('nb_job_done', { jobId: job.jobId, outputs })
      if (!done.ok) { say(`NOVA could not finish placing the pages (${done.message ?? 'the server refused it'}).`); return }
      say(done.status === 'done' ? `NOVA placed ${outputs.length} ${outputs.length === 1 ? 'picture' : 'pictures'} from ${name} in your notebook.` : `NOVA could not place the pages: ${done.message ?? 'the server refused it'}.`)
      await this.deps.changed()
    } finally { await doc.close().catch(() => {}) }
  }
}
