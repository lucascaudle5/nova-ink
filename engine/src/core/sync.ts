import { serializeStroke } from './format'
import type { SerializedStroke } from './format'
import { keyBetween } from './order'
import type { Stroke } from './types'

export interface KeyedStroke { key: string; stroke: SerializedStroke }

/** What a save sends: strokes the server may not have (with their z-order keys) and ids it should drop. */
export interface PageDelta {
  adds: KeyedStroke[]
  removes: string[]
}

/**
 * Tracks which strokes the server has, so a save sends only the changes since the last confirmed one.
 * Strokes are immutable, so a stroke is either stored (same id, same content) or not.
 *
 * Send one delta at a time. If its reply never arrives, the server may or may not have applied it;
 * the next delta therefore re-sends its strokes and removes any of them that were erased meanwhile,
 * so applying the next delta brings the server to the page either way.
 */
export class PageSync {
  /** id -> key, known to be stored on the server. */
  private acked = new Map<string, string>()
  /** id -> key sent in deltas that were not confirmed; the server may have them. */
  private unconfirmed = new Map<string, string>()
  private targets = new WeakMap<PageDelta, Map<string, string>>()

  constructor(saved: Iterable<{ id: string; key: string }> = []) {
    for (const { id, key } of saved) this.acked.set(id, key)
  }

  get size(): number { return this.acked.size }

  /** True when `strokes` differ from what the server is known to have. Cheap; changes no state. */
  hasChanges(strokes: readonly Stroke[]): boolean {
    if (this.unconfirmed.size || strokes.length !== this.acked.size) return true
    return strokes.some(s => !this.acked.has(s.id))
  }

  /** Changes that make the server match `strokes` (in z-order). */
  delta(strokes: readonly Stroke[]): PageDelta {
    // Stored strokes keep their keys as long as those keys still increase along the page.
    const fixed = new Array<string | null>(strokes.length).fill(null)
    let last: string | null = null
    strokes.forEach((s, i) => {
      const key = this.acked.get(s.id)
      if (key !== undefined && (last === null || key > last)) { fixed[i] = key; last = key }
    })
    const nextFixed = new Array<string | null>(strokes.length).fill(null)
    for (let i = strokes.length - 2, next: string | null = fixed[strokes.length - 1] ?? null; i >= 0; i--) {
      nextFixed[i] = next
      if (fixed[i] !== null) next = fixed[i]
    }

    const adds: KeyedStroke[] = []
    const target = new Map<string, string>()
    let prev: string | null = null
    strokes.forEach((s, i) => {
      if (fixed[i] !== null) { prev = fixed[i]; target.set(s.id, fixed[i]!); return }
      const upper = nextFixed[i]
      const sent = this.unconfirmed.get(s.id)
      const key = sent !== undefined && (prev === null || sent > prev) && (upper === null || sent < upper) ? sent : keyBetween(prev, upper)
      target.set(s.id, key)
      adds.push({ key, stroke: serializeStroke(s) })
      prev = key
    })
    const removes = [...new Set([...this.acked.keys(), ...this.unconfirmed.keys()])].filter(id => !target.has(id))
    for (const { key, stroke } of adds) this.unconfirmed.set(stroke.id, key)
    const delta = { adds, removes }
    this.targets.set(delta, target)
    return delta
  }

  /** Records that the server applied `delta`, the most recent one sent. */
  acknowledge(delta: PageDelta): void {
    const target = this.targets.get(delta)
    if (!target) throw new Error('acknowledge() needs a delta returned by delta()')
    this.acked = new Map(target)
    this.unconfirmed.clear()
  }
}

export function isEmptyDelta(delta: PageDelta): boolean {
  return !delta.adds.length && !delta.removes.length
}
