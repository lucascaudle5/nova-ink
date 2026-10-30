import { CAP, DESCENT, glyphFor } from './font'
import type { Poly } from './font'

/**
 * Lays out plain text and a small subset of math markup as stroke polylines (see font.ts). Pure; page units.
 *
 * Math markup: `x^2`, `x^{2}`, `F_{AB}`, `\frac{a}{b}`, `\sqrt{x}`, Greek and symbols by name (`\Sigma`, `\theta`,
 * `\cdot`, `\times`, `\pm`, `\le`, `\ge`, `\approx`, `\rightarrow`, `\deg`, `\infty`, `\int`, `\partial`, ...) or typed
 * directly (`Σ`, `θ`, `°`). `\\` or a newline starts a new line. Braces group. Anything else is drawn as typed.
 */
export interface Typeset {
  /** Polylines in page coordinates (y down), starting at the requested origin: x is the left edge, y the top of the first line. */
  polylines: Poly[]
  width: number
  height: number
}

/** Box in layout space: y UP from the baseline. */
interface Box { polys: Poly[]; w: number; up: number; down: number }

const GAP = 1.1
const SPACE = 2.6
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Phi: 'Φ', Pi: 'Π', Theta: 'Θ', Lambda: 'Λ',
  cdot: '·', times: '×', div: '÷', pm: '±', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  rightarrow: '→', to: '→', leftarrow: '←', uparrow: '↑', downarrow: '↓', infty: '∞', int: '∫', partial: '∂', sum: 'Σ',
  deg: '°', degree: '°', circ: '°', prime: "'", sin: '', cos: '', tan: '',
}
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'ln', 'log', 'exp', 'max', 'min', 'lim'])

const shift = (poly: Poly, dx: number, dy: number): Poly => poly.map(([x, y]) => [x + dx, y + dy])
const scalePoly = (poly: Poly, k: number): Poly => poly.map(([x, y]) => [x * k, y * k])
const place = (box: Box, dx: number, dy: number): Poly[] => box.polys.map(poly => shift(poly, dx, dy))

function glyphBox(ch: string, k: number): Box {
  const glyph = glyphFor(ch)
  return { polys: glyph.strokes.map(s => scalePoly(s, k)), w: glyph.w * k, up: CAP * k, down: ch.match(/[gjpqyβγηζμρχψξ]/) ? DESCENT * k : 0 }
}

/** Boxes side by side along the baseline. */
function row(boxes: Box[], k: number): Box {
  const polys: Poly[] = []
  let x = 0, up = 0, down = 0
  for (const b of boxes) {
    polys.push(...place(b, x, 0))
    x += b.w + GAP * k
    up = Math.max(up, b.up); down = Math.max(down, b.down)
  }
  return { polys, w: Math.max(0, x - GAP * k), up, down }
}

// ---- parsing math ----

type Node =
  | { t: 'char'; ch: string }
  | { t: 'space' }
  | { t: 'group'; items: Node[] }
  | { t: 'frac'; num: Node; den: Node }
  | { t: 'sqrt'; body: Node }
  | { t: 'script'; base: Node | null; sup: Node | null; sub: Node | null }

class Parser {
  i = 0
  constructor(private readonly s: string) {}
  private peek() { return this.s[this.i] }

  sequence(until?: string): Node[] {
    const items: Node[] = []
    while (this.i < this.s.length && this.peek() !== until) {
      let atom = this.atom()
      if (atom === null) continue
      let sup: Node | null = null, sub: Node | null = null
      for (;;) {
        if (this.peek() === '^' && !sup) { this.i++; sup = this.argument() } else if (this.peek() === '_' && !sub) { this.i++; sub = this.argument() } else break
      }
      if (sup || sub) atom = { t: 'script', base: atom, sup, sub }
      items.push(atom)
    }
    return items
  }

  private argument(): Node {
    if (this.peek() === '{') { this.i++; const items = this.sequence('}'); if (this.peek() === '}') this.i++; return { t: 'group', items } }
    if (this.peek() === '\\') return this.atom() ?? { t: 'group', items: [] }
    const ch = this.s[this.i++] ?? ''
    return ch ? { t: 'char', ch } : { t: 'group', items: [] }
  }

  private atom(): Node | null {
    const ch = this.s[this.i++]
    if (ch === '{') { const items = this.sequence('}'); if (this.peek() === '}') this.i++; return { t: 'group', items } }
    if (ch === '}') return null
    if (ch === ' ') return { t: 'space' }
    if (ch === '^' || ch === '_') return { t: 'script', base: null, sup: ch === '^' ? this.argument() : null, sub: ch === '_' ? this.argument() : null }
    if (ch !== '\\') return { t: 'char', ch }
    // a command
    const next = this.s[this.i]
    if (next && !/[A-Za-z]/.test(next)) { this.i++; return next === ' ' ? { t: 'space' } : { t: 'char', ch: next } }
    let name = ''
    while (/[A-Za-z]/.test(this.s[this.i] ?? '')) name += this.s[this.i++]
    if (name === 'frac') return { t: 'frac', num: this.argument(), den: this.argument() }
    if (name === 'sqrt') return { t: 'sqrt', body: this.argument() }
    if (FUNCTIONS.has(name)) return { t: 'group', items: [...name].map(c => ({ t: 'char' as const, ch: c })) }
    const symbol = SYMBOLS[name]
    return symbol ? { t: 'char', ch: symbol } : { t: 'group', items: [...name].map(c => ({ t: 'char' as const, ch: c })) }
  }
}

// ---- laying out math ----

const SCRIPT = 0.62

function layout(node: Node, k: number): Box {
  switch (node.t) {
    case 'char': return glyphBox(node.ch, k)
    case 'space': return { polys: [], w: SPACE * k, up: 0, down: 0 }
    case 'group': return row(node.items.map(n => layout(n, k)), k)
    case 'script': {
      const base = node.base ? layout(node.base, k) : { polys: [], w: 0, up: CAP * k, down: 0 }
      const polys = [...base.polys]
      let w = base.w, up = base.up, down = base.down
      const x = base.w + GAP * k * 0.6
      let extra = 0
      if (node.sup) {
        const s = layout(node.sup, k * SCRIPT)
        const dy = base.up - CAP * k * SCRIPT * 0.55
        polys.push(...place(s, x, dy)); extra = Math.max(extra, s.w); up = Math.max(up, dy + s.up)
      }
      if (node.sub) {
        const s = layout(node.sub, k * SCRIPT)
        const dy = -CAP * k * 0.22
        polys.push(...place(s, x, dy)); extra = Math.max(extra, s.w); down = Math.max(down, -dy + s.down)
      }
      w += GAP * k * 0.6 + extra
      return { polys, w, up, down }
    }
    case 'frac': {
      const small = k * 0.78
      const num = layout(node.num, small), den = layout(node.den, small)
      const w = Math.max(num.w, den.w) + 2 * k
      const axis = 4.2 * k
      const polys: Poly[] = [[[0, axis], [w, axis]]]
      polys.push(...place(num, (w - num.w) / 2, axis + 1.4 * k + num.down))
      polys.push(...place(den, (w - den.w) / 2, axis - 1.4 * k - den.up))
      return { polys, w, up: axis + 1.4 * k + num.down + num.up, down: Math.max(0, den.up + 1.4 * k - axis + den.down) }
    }
    case 'sqrt': {
      const body = layout(node.body, k)
      const top = Math.max(body.up, CAP * k) + 1.2 * k
      const lead = 3.6 * k
      const polys: Poly[] = [[[0, 3.6 * k], [0.9 * k, 4.2 * k], [2.1 * k, -body.down], [lead, top], [lead + body.w + 1.6 * k, top]]]
      polys.push(...place(body, lead + 0.8 * k, 0))
      return { polys, w: lead + body.w + 1.6 * k, up: top, down: body.down }
    }
  }
}

function cleanPolys(polys: Poly[]): Poly[] { return polys.filter(p => p.length > 0) }

/** Lays `lines` of boxes out down the page, left-aligned at (x, y), converting to y-down page coordinates. */
function stack(lines: Box[], k: number, x: number, y: number): Typeset {
  const out: Poly[] = []
  let top = y, width = 0
  for (const line of lines) {
    const baseline = top + Math.max(line.up, CAP * k)
    for (const poly of line.polys) out.push(poly.map(([px, py]) => [x + px, baseline - py] as [number, number]))
    width = Math.max(width, line.w)
    top = baseline + Math.max(line.down, DESCENT * k) + 1.8 * k
  }
  return { polylines: cleanPolys(out), width, height: Math.max(0, top - y - 1.8 * k) }
}

/** Plain text, one character at a time (no markup). `size` is the capital height in page units. */
export function typesetText(text: string, size: number, x = 0, y = 0): Typeset {
  const k = size / CAP
  const lines = text.split(/\r?\n/).map(line => row([...line].map(ch => (ch === ' ' ? ({ polys: [], w: SPACE * k, up: 0, down: 0 } as Box) : glyphBox(ch, k))), k))
  return stack(lines, k, x, y)
}

/** Math markup (see the top of this file). */
export function typesetMath(source: string, size: number, x = 0, y = 0): Typeset {
  const k = size / CAP
  const lines = source.split(/\\\\|\r?\n/).map(line => layout({ t: 'group', items: new Parser(line).sequence() }, k))
  return stack(lines, k, x, y)
}
