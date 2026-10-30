/** Fixed-size ring of recent measurements with percentiles. */
export class Samples {
  private values: number[] = []
  private next = 0
  total = 0

  constructor(private readonly capacity = 600) {}

  push(value: number): void {
    if (!Number.isFinite(value)) return
    this.total++
    if (this.values.length < this.capacity) this.values.push(value)
    else { this.values[this.next] = value; this.next = (this.next + 1) % this.capacity }
  }

  get count(): number { return this.values.length }

  /** Nearest-rank percentile, p in [0, 100]. NaN when empty. */
  percentile(p: number): number {
    if (!this.values.length) return NaN
    const sorted = [...this.values].sort((a, b) => a - b)
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
  }

  max(): number { return this.values.length ? Math.max(...this.values) : NaN }

  clear(): void { this.values = []; this.next = 0; this.total = 0 }
}
