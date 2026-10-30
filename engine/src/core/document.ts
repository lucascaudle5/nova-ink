import { intersects } from './geometry'
import type { Bounds, ImageItem, Stroke } from './types'

/** A stroke with its z-order position at the moment it was removed. */
export interface Placed { stroke: Stroke; index: number }
/** An image placement with its position in the image list at the moment it was removed. */
export interface PlacedImage { image: ImageItem; index: number }

export interface DocumentChange {
  added: Placed[]
  removed: Placed[]
  /** True when the change replaced the whole document (load). */
  reset: boolean
  /** True when image placements changed (they are drawn under all ink). */
  images?: boolean
}

/**
 * Ordered stroke list (array order is z-order) plus image placements, which are always under the ink
 * (their own order: later on top). Ids are unique across both. Plain data plus change events; knows
 * nothing about rendering, input, storage or hosts.
 */
export class InkDocument {
  private list: Stroke[] = []
  private byId = new Map<string, Stroke>()
  private imageList: ImageItem[] = []
  private imagesById = new Map<string, ImageItem>()
  private listeners = new Set<(change: DocumentChange) => void>()
  /** Increments on every change; useful for dirty tracking. */
  revision = 0

  get strokes(): readonly Stroke[] { return this.list }
  get images(): readonly ImageItem[] { return this.imageList }
  get size(): number { return this.list.length }
  get(id: string): Stroke | undefined { return this.byId.get(id) }
  has(id: string): boolean { return this.byId.has(id) }
  getImage(id: string): ImageItem | undefined { return this.imagesById.get(id) }

  onChange(listener: (change: DocumentChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  add(stroke: Stroke): void {
    this.assertNew([stroke])
    this.list.push(stroke)
    this.byId.set(stroke.id, stroke)
    this.emit({ added: [{ stroke, index: this.list.length - 1 }], removed: [], reset: false })
  }

  /** Appends several strokes as one change. */
  addMany(strokes: readonly Stroke[]): void {
    if (!strokes.length) return
    this.assertNew(strokes)
    const first = this.list.length
    for (const stroke of strokes) { this.list.push(stroke); this.byId.set(stroke.id, stroke) }
    this.emit({ added: strokes.map((stroke, k) => ({ stroke, index: first + k })), removed: [], reset: false })
  }

  /**
   * Swaps one stroke for `pieces` at the same z-order position (partial erase). Returns the removed
   * stroke with its index, or null if `id` is unknown.
   */
  replace(id: string, pieces: readonly Stroke[]): Placed | null {
    const index = this.list.findIndex(s => s.id === id)
    if (index < 0) return null
    this.assertNew(pieces)
    const stroke = this.list[index]
    this.list.splice(index, 1, ...pieces)
    this.byId.delete(id)
    for (const piece of pieces) this.byId.set(piece.id, piece)
    this.emit({ added: pieces.map((piece, k) => ({ stroke: piece, index: index + k })), removed: [{ stroke, index }], reset: false })
    return { stroke, index }
  }

  /** Removes strokes by id. Returns what was removed with original indices, ascending. Unknown ids are ignored. */
  remove(ids: Iterable<string>): Placed[] {
    const wanted = new Set(ids)
    const removed: Placed[] = []
    const kept: Stroke[] = []
    this.list.forEach((stroke, index) => {
      if (wanted.has(stroke.id)) removed.push({ stroke, index })
      else kept.push(stroke)
    })
    if (!removed.length) return removed
    this.list = kept
    for (const { stroke } of removed) this.byId.delete(stroke.id)
    this.emit({ added: [], removed, reset: false })
    return removed
  }

  /** Re-inserts strokes at the indices recorded by remove(). */
  restore(entries: readonly Placed[]): void {
    if (!entries.length) return
    const sorted = [...entries].sort((a, b) => a.index - b.index)
    this.assertNew(sorted.map(e => e.stroke))
    for (const { stroke, index } of sorted) {
      this.list.splice(Math.min(index, this.list.length), 0, stroke)
      this.byId.set(stroke.id, stroke)
    }
    this.emit({ added: sorted, removed: [], reset: false })
  }

  // ---- image placements ----

  /** Puts a placement on top of the other images (still under all ink), or at `index`. */
  addImage(image: ImageItem, index = this.imageList.length): void {
    this.assertNew([image])
    this.imageList.splice(Math.min(index, this.imageList.length), 0, image)
    this.imagesById.set(image.id, image)
    this.emit({ added: [], removed: [], reset: false, images: true })
  }

  removeImage(id: string): PlacedImage | null {
    const index = this.imageList.findIndex(i => i.id === id)
    if (index < 0) return null
    const [image] = this.imageList.splice(index, 1)
    this.imagesById.delete(id)
    this.emit({ added: [], removed: [], reset: false, images: true })
    return { image, index }
  }

  /** Swaps a placement for `next` at the same position (move or resize). */
  replaceImage(id: string, next: ImageItem): PlacedImage | null {
    const index = this.imageList.findIndex(i => i.id === id)
    if (index < 0) return null
    this.assertNew([next])
    const image = this.imageList[index]
    this.imageList[index] = next
    this.imagesById.delete(id)
    this.imagesById.set(next.id, next)
    this.emit({ added: [], removed: [], reset: false, images: true })
    return { image, index }
  }

  /** Replaces the whole document, e.g. after loading a saved notebook page. */
  load(strokes: readonly Stroke[], images: readonly ImageItem[] = []): void {
    const ids = new Set<string>()
    for (const item of [...strokes, ...images]) {
      if (ids.has(item.id)) throw new Error(`Duplicate stroke id ${item.id}`)
      ids.add(item.id)
    }
    this.list = [...strokes]
    this.byId = new Map(this.list.map(s => [s.id, s]))
    this.imageList = [...images]
    this.imagesById = new Map(this.imageList.map(i => [i.id, i]))
    this.emit({ added: this.list.map((stroke, index) => ({ stroke, index })), removed: [], reset: true, images: true })
  }

  /** Strokes whose bounds intersect `area`, in z-order. Linear scan; see docs for when to add a spatial index. */
  query(area: Bounds): Stroke[] {
    const out: Stroke[] = []
    for (const stroke of this.list) if (intersects(stroke.bounds, area)) out.push(stroke)
    return out
  }

  queryImages(area: Bounds): ImageItem[] {
    return this.imageList.filter(i => intersects(i.bounds, area))
  }

  contentBounds(): Bounds | null {
    if (!this.list.length && !this.imageList.length) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const { bounds: b } of [...this.list, ...this.imageList]) {
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    }
    return { minX, minY, maxX, maxY }
  }

  private assertNew(items: ReadonlyArray<{ id: string }>) {
    const seen = new Set<string>()
    for (const s of items) {
      if (this.byId.has(s.id) || this.imagesById.has(s.id) || seen.has(s.id)) throw new Error(`Duplicate stroke id ${s.id}`)
      seen.add(s.id)
    }
  }

  private emit(change: DocumentChange) {
    this.revision++
    for (const listener of this.listeners) listener(change)
  }
}
