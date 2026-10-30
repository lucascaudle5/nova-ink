import { createStroke } from '../core/stroke'
import type { Stroke } from '../core/types'

/** Deterministic PRNG so benchmarks and tests see the same strokes every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GenerateOptions {
  seed?: number
  /** Strokes per row of "handwriting". */
  columns?: number
  minPoints?: number
  maxPoints?: number
  /** Added to every y coordinate, to place a batch below existing work. */
  offsetY?: number
  idPrefix?: string
}

/**
 * Generated handwriting-like strokes laid out in lines, sampled like a 240 Hz pencil (4 ms apart).
 * Test data only; never mixed with real notebooks.
 */
export function generateStrokes(count: number, options: GenerateOptions = {}): Stroke[] {
  const random = mulberry32(options.seed ?? 1)
  const columns = options.columns ?? 40
  const minPoints = options.minPoints ?? 40
  const maxPoints = options.maxPoints ?? 160
  const idPrefix = options.idPrefix ?? 'gen'
  const strokes: Stroke[] = []
  for (let i = 0; i < count; i++) {
    const originX = 40 + (i % columns) * 36
    const originY = 60 + Math.floor(i / columns) * 48 + (options.offsetY ?? 0)
    const n = minPoints + Math.floor(random() * (maxPoints - minPoints + 1))
    const loops = 1 + random() * 3
    const height = 10 + random() * 14
    const width = 16 + random() * 14
    const phase = random() * Math.PI * 2
    const points: number[] = []
    for (let k = 0; k < n; k++) {
      const u = k / Math.max(1, n - 1)
      const a = u * loops * Math.PI * 2 + phase
      points.push(
        originX + u * width + Math.cos(a) * 4 + (random() - 0.5) * 0.4,
        originY + Math.sin(a) * height * 0.5 + (random() - 0.5) * 0.4,
        0.35 + 0.5 * Math.sin(u * Math.PI) + (random() - 0.5) * 0.05,
        k * 4,
      )
    }
    strokes.push(createStroke({ id: `${idPrefix}-${i}`, points, style: { color: '#1b1f24', width: 2.6 }, createdAt: 1_790_000_000_000 + i }))
  }
  return strokes
}
