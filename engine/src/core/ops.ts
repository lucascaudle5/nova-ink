import { createImage } from './image'
import { offsetImage, offsetStroke } from './selection'
import { densify, inkBounds, MAX_SHAPES, shapeProblem, shapeToInk } from './shapes'
import type { Shape } from './shapes'
import { createStroke } from './stroke'
import { inkClusters, overlaps, round1, unionOf } from './scene'
import type { SceneInput } from './scene'
import { POINT_STRIDE } from './types'
import type { Bounds, ImageItem, PageItem, Stroke } from './types'
import { typesetText } from './typeset'

/**
 * Bounded canvas operations ("draw this beside that", "move this", "make room below", ...) as plain data, and a pure
 * planner that turns a batch of them into the exact changes to a page. The same planner runs in the open notebook (one
 * undo step) and on the server (when nobody is editing), so both end with the same page.
 *
 * Rules built in:
 * - A batch is all or nothing: if any operation is refused, nothing changes.
 * - Everything NOVA draws is marked author 'ai', carries a group id, and gets a small boxed "N" tag, so it is
 *   recognisable without relying on color and moves as one piece.
 * - NOVA never deletes the student's own ink (`remove` only takes NOVA's marks); moving or grouping it needs an explicit operation.
 * - Ids of everything created or replaced are derived from the batch id, so planning the same batch twice is detectable
 *   (`alreadyApplied`) and a retry never duplicates anything.
 */
export type Side = 'right' | 'left' | 'below' | 'above'
export interface Place {
  x?: number
  y?: number
  relativeTo?: string
  side?: Side
  gap?: number
  align?: 'start' | 'center' | 'end'
}

export type Op =
  | { op: 'draw'; name?: string; place: Place; shapes: Shape[] }
  | { op: 'move'; targets: string[]; dx?: number; dy?: number; place?: Place }
  | { op: 'make_room'; below: string; amount: number }
  | { op: 'align'; targets: string[]; edge: 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY' }
  | { op: 'distribute'; targets: string[]; axis: 'x' | 'y'; gap?: number }
  | { op: 'group'; targets: string[]; name?: string }
  | { op: 'ungroup'; targets: string[] }
  | { op: 'remove'; targets: string[] }
  | { op: 'duplicate'; targets: string[]; place: Place }
  /** Puts a stored picture (a rendered source page or crop) on the page, in its own group so it keeps a stable name. */
  | { op: 'picture'; image: string; w: number; h: number; name?: string; place: Place }

export const MAX_OPS = 40
export const NOVA_COLOR = '#7c3aed'
export const NOVA_WIDTH = 2.2
export const DEFAULT_GAP = 40
const NUDGE = 24
const MAX_NUDGES = 60
export const MAX_MOVE = 200_000

export interface Plan {
  adds: PageItem[]
  removes: string[]
  replaces: Array<[string, PageItem]>
  summary: string[]
  warnings: string[]
  groups: Array<{ id: string; name: string; bounds: Bounds }>
  /** True when nothing would change (including a batch that was already applied). */
  empty: boolean
  alreadyApplied?: boolean
}
export type PlanResult = ({ ok: true } & Plan) | { ok: false; message: string; opIndex?: number }

// ---------------------------------------------------------------- validation

const isNum = (v: unknown, max = MAX_MOVE): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
const isRefs = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= 200 && v.every(r => typeof r === 'string' && r.length >= 1 && r.length <= 80)

function placeProblem(place: unknown, required: boolean): string | null {
  if (place === undefined) return required ? 'a place is required (x and y, or relativeTo with a side)' : null
  const p = place as Record<string, unknown>
  if (!p || typeof p !== 'object') return 'place must be an object'
  if (p.relativeTo !== undefined) {
    if (typeof p.relativeTo !== 'string' || !p.relativeTo) return 'relativeTo must be an id'
    if (p.side !== undefined && !['right', 'left', 'below', 'above'].includes(p.side as string)) return 'side must be right, left, below or above'
    if (p.align !== undefined && !['start', 'center', 'end'].includes(p.align as string)) return 'align must be start, center or end'
    if (p.gap !== undefined && !(isNum(p.gap, 5000) && (p.gap as number) >= 0)) return 'gap must be 0 to 5000'
    return null
  }
  return isNum(p.x) && isNum(p.y) ? null : 'a place needs numeric x and y, or relativeTo'
}

/** Checks untrusted input; the message names the first problem. */
export function parseOps(input: unknown): { ok: true; ops: Op[] } | { ok: false; message: string; opIndex?: number } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, message: 'Give at least one operation.' }
  if (input.length > MAX_OPS) return { ok: false, message: `At most ${MAX_OPS} operations in one batch.` }
  for (let i = 0; i < input.length; i++) {
    const o = input[i] as Record<string, unknown>
    const bad = (m: string) => ({ ok: false as const, message: `Operation ${i + 1} (${String(o?.op)}): ${m}`, opIndex: i })
    if (!o || typeof o !== 'object') return bad('must be an object')
    switch (o.op) {
      case 'draw': {
        if (o.name !== undefined && (typeof o.name !== 'string' || o.name.length > 60)) return bad('name must be 60 characters or fewer')
        const pp = placeProblem(o.place, true)
        if (pp) return bad(pp)
        if (!Array.isArray(o.shapes) || o.shapes.length < 1 || o.shapes.length > MAX_SHAPES) return bad(`shapes must be 1 to ${MAX_SHAPES} items`)
        for (let k = 0; k < o.shapes.length; k++) { const sp = shapeProblem(o.shapes[k]); if (sp) return bad(`shape ${k + 1}: ${sp}`) }
        break
      }
      case 'move': {
        if (!isRefs(o.targets)) return bad('targets must list 1 to 200 ids')
        if (o.place === undefined && !(isNum(o.dx) || isNum(o.dy))) return bad('give dx and/or dy, or a place')
        if ((o.dx !== undefined && !isNum(o.dx)) || (o.dy !== undefined && !isNum(o.dy))) return bad('dx and dy must be numbers')
        const pp = placeProblem(o.place, false)
        if (pp) return bad(pp)
        break
      }
      case 'make_room': if (typeof o.below !== 'string' || !o.below || !isNum(o.amount, 5000) || (o.amount as number) <= 0) return bad('needs below (an id) and an amount of 1 to 5000'); break
      case 'align': if (!isRefs(o.targets) || (o.targets as string[]).length < 2 || !['left', 'right', 'top', 'bottom', 'centerX', 'centerY'].includes(o.edge as string)) return bad('needs 2 or more targets and an edge (left, right, top, bottom, centerX, centerY)'); break
      case 'distribute': if (!isRefs(o.targets) || (o.targets as string[]).length < 3 || !['x', 'y'].includes(o.axis as string) || (o.gap !== undefined && !(isNum(o.gap, 5000) && (o.gap as number) >= 0))) return bad('needs 3 or more targets, an axis (x or y) and an optional gap'); break
      case 'group': if (!isRefs(o.targets) || (o.name !== undefined && (typeof o.name !== 'string' || o.name.length > 60))) return bad('needs targets and an optional name of 60 characters or fewer'); break
      case 'ungroup':
      case 'remove': if (!isRefs(o.targets)) return bad('targets must list 1 to 200 ids'); break
      case 'duplicate': { if (!isRefs(o.targets)) return bad('targets must list 1 to 200 ids'); const pp = placeProblem(o.place, true); if (pp) return bad(pp); break }
      case 'picture': {
        if (typeof o.image !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.image)) return bad('image must be a stored picture id')
        if (!isNum(o.w, 20000) || !isNum(o.h, 20000) || (o.w as number) < 8 || (o.h as number) < 8) return bad('w and h must be 8 to 20000')
        if (o.name !== undefined && (typeof o.name !== 'string' || o.name.length > 60)) return bad('name must be 60 characters or fewer')
        const pp = placeProblem(o.place, true)
        if (pp) return bad(pp)
        break
      }
      default: return bad('unknown operation')
    }
  }
  return { ok: true, ops: input as Op[] }
}

// ---------------------------------------------------------------- planning

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'drawing'
/** Short stable text from a batch id (letters and digits only). */
const compact = (id: string) => id.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)

/** The same item under a new id and group (null = no group). */
function withId<T extends PageItem>(item: T, id: string, group: string | null): T {
  if ((item as ImageItem).kind === 'image') {
    const i = item as ImageItem
    return createImage({ id, image: i.image, author: i.author, x: i.x, y: i.y, w: i.w, h: i.h, angle: i.angle, createdAt: i.createdAt, group: group ?? undefined }) as T
  }
  const s = item as Stroke
  return createStroke({ id, points: s.points, style: s.style, author: s.author, createdAt: s.createdAt, group: group ?? undefined }) as T
}

/** 8 hex digits from text (FNV-1a): enough to keep two groups made in one batch apart. */
function hash8(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const isImg = (item: PageItem): item is ImageItem => (item as ImageItem).kind === 'image'

class Planner {
  strokes: Stroke[]
  images: ImageItem[]
  readonly original: Set<string>
  /** Current id -> id of the original item it descends from (moves and regroupings replace items). */
  private origin = new Map<string, string>()
  private added = new Set<string>()
  private removed = new Set<string>()
  warnings: string[] = []
  summary: string[] = []
  groups: Plan['groups'] = []
  private counter = 0
  private groupCounter = 0
  private opIndex = 0
  readonly prefix: string

  constructor(scene: SceneInput, readonly opId: string) {
    this.strokes = [...scene.strokes]
    this.images = [...scene.images]
    this.original = new Set([...scene.strokes, ...scene.images].map(i => i.id))
    this.prefix = `n${compact(opId)}`
  }

  startOp(index: number) { this.opIndex = index; this.counter = 0 }
  newId(): string { return `${this.prefix}${this.opIndex.toString(36)}x${(this.counter++).toString(36)}` }
  newGroup(name: string): string { return `nova-${slug(name)}-${hash8(`${this.opId}:${this.opIndex}:${this.groupCounter++}`)}` }

  all(): PageItem[] { return [...this.images, ...this.strokes] }
  find(id: string): PageItem | undefined { return this.strokes.find(s => s.id === id) ?? this.images.find(i => i.id === id) }

  swap(old: PageItem, next: PageItem) {
    const list = isImg(old) ? this.images : this.strokes
    const at = list.findIndex(i => i.id === old.id)
    if (at < 0) throw new Error('internal: item vanished')
    ;(list as PageItem[])[at] = next
    this.origin.set(next.id, this.origin.get(old.id) ?? old.id)
    this.origin.delete(old.id)
    if (this.added.has(old.id)) { this.added.delete(old.id); this.added.add(next.id); this.origin.delete(next.id) }
  }
  append(item: PageItem) { (isImg(item) ? this.images : this.strokes).push(item as never); this.added.add(item.id) }
  drop(item: PageItem) {
    const list = (isImg(item) ? this.images : this.strokes) as PageItem[]
    const at = list.findIndex(i => i.id === item.id)
    if (at >= 0) list.splice(at, 1)
    if (this.added.has(item.id)) this.added.delete(item.id)
    else this.removed.add(this.origin.get(item.id) ?? item.id)
    this.origin.delete(item.id)
  }

  /** Items a reference points at: a group, a picture, a stroke, or `ink:<stroke id>` for a cluster of loose ink. */
  resolve(ref: string): PageItem[] | null {
    if (ref.startsWith('ink:')) {
      const id = ref.slice(4)
      const cluster = inkClusters(this.strokes).find(c => c.ids.includes(id))
      if (!cluster) return null
      const set = new Set(cluster.ids)
      return this.strokes.filter(s => set.has(s.id))
    }
    const members = this.all().filter(i => i.group === ref)
    if (members.length) return members
    const one = this.find(ref)
    return one ? [one] : null
  }

  boundsOf(items: readonly PageItem[]): Bounds { return unionOf(items.map(i => i.bounds))! }

  finish(): Plan {
    const adds = this.all().filter(i => this.added.has(i.id))
    const replaces: Array<[string, PageItem]> = []
    for (const item of this.all()) {
      const from = this.origin.get(item.id)
      if (from && !this.added.has(item.id)) replaces.push([from, item])
    }
    const removes = [...this.removed]
    // The z-order of untouched and replaced items is kept; new items land on top (pictures among pictures).
    return { adds, removes, replaces, summary: this.summary, warnings: this.warnings, groups: this.groups, empty: !adds.length && !removes.length && !replaces.length }
  }
}

function targetsOf(p: Planner, refs: string[], what = 'target'): { ok: true; items: PageItem[] } | { ok: false; message: string } {
  const items: PageItem[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const found = p.resolve(ref)
    if (!found) return { ok: false, message: `The ${what} "${ref}" is not on this page (it may have moved or been deleted). Read the page again to get current ids.` }
    for (const i of found) if (!seen.has(i.id)) { seen.add(i.id); items.push(i) }
  }
  return { ok: true, items }
}

/** Top-left for a rectangle of `size`, from absolute coordinates or beside another thing, nudged off anything in the way. */
function placeRect(p: Planner, size: { w: number; h: number }, place: Place, exclude: ReadonlySet<string>): { x: number; y: number } | { message: string } {
  if (place.relativeTo === undefined) return { x: place.x!, y: place.y! }
  const target = p.resolve(place.relativeTo)
  if (!target) return { message: `"${place.relativeTo}" is not on this page. Read the page again to get current ids.` }
  const tb = p.boundsOf(target)
  const side = place.side ?? 'right', gap = place.gap ?? DEFAULT_GAP, align = place.align ?? 'start'
  const along = (lo: number, hi: number, len: number) => (align === 'start' ? lo : align === 'center' ? (lo + hi - len) / 2 : hi - len)
  let x: number, y: number, dx = 0, dy = 0
  if (side === 'right' || side === 'left') {
    x = side === 'right' ? tb.maxX + gap : tb.minX - gap - size.w
    y = along(tb.minY, tb.maxY, size.h)
    dx = side === 'right' ? NUDGE : -NUDGE
  } else {
    y = side === 'below' ? tb.maxY + gap : tb.minY - gap - size.h
    x = along(tb.minX, tb.maxX, size.w)
    dy = side === 'below' ? NUDGE : -NUDGE
  }
  const obstacles = p.all().filter(i => !exclude.has(i.id) && !target.some(t => t.id === i.id)).map(i => i.bounds)
  const rect = (px: number, py: number): Bounds => ({ minX: px, minY: py, maxX: px + size.w, maxY: py + size.h })
  let n = 0
  while (n < MAX_NUDGES && obstacles.some(o => overlaps(rect(x, y), o, 4))) { x += dx; y += dy; n++ }
  if (n > 0) p.warnings.push(n === MAX_NUDGES ? `No clear space was found ${side} of "${place.relativeTo}"; it was placed over other content.` : `Moved ${n * NUDGE} units ${side} to avoid existing work.`)
  return { x, y }
}

function inkLines(shapes: readonly Shape[]) {
  const lines: Array<{ points: Array<[number, number]>; color?: string; width: number }> = []
  for (const shape of shapes) {
    const base = shape.type === 'text' || shape.type === 'equation' ? Math.max(1.4, (shape.size ?? 18) / 12) : NOVA_WIDTH
    for (const l of shapeToInk(shape)) lines.push({ points: l.points, color: l.color, width: l.width ?? base })
  }
  return lines
}

function strokeFrom(points: Array<[number, number]>, color: string, width: number, id: string, group: string, now: number): Stroke {
  const dense = densify(points, 5)
  const flat = new Float32Array(dense.length * POINT_STRIDE)
  dense.forEach(([x, y], i) => { flat[i * POINT_STRIDE] = x; flat[i * POINT_STRIDE + 1] = y; flat[i * POINT_STRIDE + 2] = 0.5; flat[i * POINT_STRIDE + 3] = i * 8 })
  return createStroke({ id, points: flat, style: { color, width }, author: 'ai', createdAt: now, group })
}

/** The small boxed "N" that marks a NOVA group (readable in a screenshot, not just by color). */
function badge(x: number, y: number): Array<[number, number][]> {
  const box: Array<[number, number]> = [[x, y], [x + 15, y], [x + 15, y + 15], [x, y + 15], [x, y]]
  const n = typesetText('N', 9, x + 3.6, y + 3)
  return [box, ...n.polylines]
}

export function planOps(scene: SceneInput, ops: readonly Op[], options: { opId: string; now?: number }): PlanResult {
  const p = new Planner(scene, options.opId)
  const now = options.now ?? Date.now()
  // A batch whose results are already on the page has been applied: do nothing, report it.
  if (p.all().some(i => i.id.startsWith(p.prefix))) {
    return { ok: true, adds: [], removes: [], replaces: [], summary: ['This batch was already applied.'], warnings: [], groups: [], empty: true, alreadyApplied: true }
  }
  try {
    for (let index = 0; index < ops.length; index++) {
      p.startOp(index)
      const op = ops[index]
      const fail = (message: string): PlanResult => ({ ok: false, message: `Operation ${index + 1} (${op.op}): ${message}`, opIndex: index })
      switch (op.op) {
        case 'draw': {
          const lines = inkLines(op.shapes)
          const box = inkBounds(lines)
          if (!box) return fail('nothing to draw')
          const size = { w: box.maxX - box.minX, h: box.maxY - box.minY }
          const spot = placeRect(p, size, op.place, new Set())
          if ('message' in spot) return fail(spot.message)
          const dx = spot.x - box.minX, dy = spot.y - box.minY
          const group = p.newGroup(op.name ?? 'drawing')
          let k = 0
          const made: Stroke[] = []
          for (const l of lines) made.push(strokeFrom(l.points.map(([x, y]) => [x + dx, y + dy] as [number, number]), l.color ?? NOVA_COLOR, l.width, p.newId(), group, now))
          for (const poly of badge(spot.x, spot.y - 19)) made.push(strokeFrom(poly, NOVA_COLOR, 1.2, p.newId(), group, now + k++))
          for (const s of made) p.append(s)
          const gb = p.boundsOf(made)
          p.groups.push({ id: group, name: op.name ?? 'drawing', bounds: { minX: round1(gb.minX), minY: round1(gb.minY), maxX: round1(gb.maxX), maxY: round1(gb.maxY) } })
          p.summary.push(`Drew "${op.name ?? 'drawing'}" (${op.shapes.length} shapes) as group ${group} at x ${round1(spot.x)}, y ${round1(spot.y)}, ${Math.round(size.w)} by ${Math.round(size.h)}.`)
          break
        }
        case 'move': {
          const t = targetsOf(p, op.targets)
          if (!t.ok) return fail(t.message)
          const ids = new Set(t.items.map(i => i.id))
          let dx = op.dx ?? 0, dy = op.dy ?? 0
          if (op.place) {
            const b = p.boundsOf(t.items)
            const spot = placeRect(p, { w: b.maxX - b.minX, h: b.maxY - b.minY }, op.place, ids)
            if ('message' in spot) return fail(spot.message)
            dx = spot.x - b.minX; dy = spot.y - b.minY
          }
          shift(p, t.items, dx, dy)
          p.summary.push(`Moved ${t.items.length} item(s) by ${round1(dx)}, ${round1(dy)}.`)
          break
        }
        case 'make_room': {
          const t = targetsOf(p, [op.below], 'target')
          if (!t.ok) return fail(t.message)
          const ids = new Set(t.items.map(i => i.id))
          const tb = p.boundsOf(t.items)
          const below = p.all().filter(i => !ids.has(i.id) && i.bounds.minY >= tb.maxY - 0.5 && i.bounds.maxX >= tb.minX - 20 && i.bounds.minX <= tb.maxX + 20)
          shift(p, below, 0, op.amount)
          p.summary.push(`Moved ${below.length} item(s) below "${op.below}" down by ${op.amount}.`)
          if (!below.length) p.warnings.push('Nothing was below that item, so nothing moved.')
          break
        }
        case 'align': {
          const units = unitsOf(p, op.targets)
          if ('message' in units) return fail(units.message)
          const bs = units.map(u => p.boundsOf(u))
          const pick = (b: Bounds) => op.edge === 'left' ? b.minX : op.edge === 'right' ? b.maxX : op.edge === 'top' ? b.minY : op.edge === 'bottom' ? b.maxY : op.edge === 'centerX' ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2
          const goal = op.edge === 'right' || op.edge === 'bottom' ? Math.max(...bs.map(pick)) : op.edge === 'left' || op.edge === 'top' ? Math.min(...bs.map(pick)) : pick(unionOf(bs)!)
          const horizontal = op.edge === 'left' || op.edge === 'right' || op.edge === 'centerX'
          units.forEach((u, i) => { const d = goal - pick(bs[i]); shift(p, u, horizontal ? d : 0, horizontal ? 0 : d) })
          p.summary.push(`Aligned ${units.length} things by their ${op.edge}.`)
          break
        }
        case 'distribute': {
          const units = unitsOf(p, op.targets)
          if ('message' in units) return fail(units.message)
          const x = op.axis === 'x'
          const entries = units.map(u => ({ u, b: p.boundsOf(u) })).sort((a, b) => (x ? a.b.minX - b.b.minX : a.b.minY - b.b.minY))
          const lo = (b: Bounds) => (x ? b.minX : b.minY), hi = (b: Bounds) => (x ? b.maxX : b.maxY)
          const total = entries.reduce((s, e) => s + hi(e.b) - lo(e.b), 0)
          const gap = op.gap ?? (hi(entries[entries.length - 1].b) - lo(entries[0].b) - total) / (entries.length - 1)
          let at = lo(entries[0].b)
          for (const e of entries) { const d = at - lo(e.b); shift(p, e.u, x ? d : 0, x ? 0 : d); at += hi(e.b) - lo(e.b) + gap }
          p.summary.push(`Spaced ${entries.length} things evenly (gap ${round1(gap)}).`)
          if (gap < 0) p.warnings.push('The things overlap, so the gap is negative; give a larger gap or move them apart first.')
          break
        }
        case 'group': {
          const t = targetsOf(p, op.targets)
          if (!t.ok) return fail(t.message)
          const group = p.newGroup(op.name ?? 'group')
          for (const item of t.items) p.swap(item, withId(item, p.newId(), group))
          const b = p.boundsOf(t.items)
          p.groups.push({ id: group, name: op.name ?? 'group', bounds: { minX: round1(b.minX), minY: round1(b.minY), maxX: round1(b.maxX), maxY: round1(b.maxY) } })
          p.summary.push(`Grouped ${t.items.length} item(s) as ${group}.`)
          break
        }
        case 'ungroup': {
          const t = targetsOf(p, op.targets)
          if (!t.ok) return fail(t.message)
          const grouped = t.items.filter(i => i.group)
          for (const item of grouped) p.swap(item, withId(item, p.newId(), null))
          p.summary.push(`Ungrouped ${grouped.length} item(s).`)
          break
        }
        case 'remove': {
          const t = targetsOf(p, op.targets)
          if (!t.ok) return fail(t.message)
          const mine = t.items.filter(i => i.author === 'ai')
          if (mine.length !== t.items.length) return fail('NOVA only removes what NOVA drew. The student deletes their own work.')
          for (const item of t.items) p.drop(item)
          p.summary.push(`Removed ${t.items.length} NOVA mark(s).`)
          break
        }
        case 'picture': {
          const spot = placeRect(p, { w: op.w, h: op.h }, op.place, new Set())
          if ('message' in spot) return fail(spot.message)
          const group = p.newGroup(op.name ?? 'picture')
          const pic = createImage({ id: p.newId(), image: op.image, x: spot.x, y: spot.y, w: op.w, h: op.h, createdAt: now, group })
          p.append(pic)
          const b = pic.bounds
          p.groups.push({ id: group, name: op.name ?? 'picture', bounds: { minX: round1(b.minX), minY: round1(b.minY), maxX: round1(b.maxX), maxY: round1(b.maxY) } })
          p.summary.push(`Placed "${op.name ?? 'picture'}" as group ${group} at x ${round1(spot.x)}, y ${round1(spot.y)}, ${Math.round(op.w)} by ${Math.round(op.h)}.`)
          break
        }
        case 'duplicate': {
          const t = targetsOf(p, op.targets)
          if (!t.ok) return fail(t.message)
          const b = p.boundsOf(t.items)
          const spot = placeRect(p, { w: b.maxX - b.minX, h: b.maxY - b.minY }, op.place, new Set())
          if ('message' in spot) return fail(spot.message)
          const dx = spot.x - b.minX, dy = spot.y - b.minY
          const groupMap = new Map<string, string>()
          for (const item of t.items) {
            const moved = isImg(item) ? offsetImage(item, dx, dy) : offsetStroke(item, dx, dy)
            let group = item.group
            if (group) { if (!groupMap.has(group)) groupMap.set(group, p.newGroup(`copy-of-${group.replace(/^nova-|-[0-9a-f]{8}$/g, '')}`)); group = groupMap.get(group) }
            p.append(withId(moved, p.newId(), group ?? null))
          }
          p.summary.push(`Copied ${t.items.length} item(s) to x ${round1(spot.x)}, y ${round1(spot.y)}.`)
          break
        }
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, ...p.finish() }
}

/** The scene after a plan: replacements in place, removals gone, additions on top. Used to plan a batch on top of queued ones. */
export function applyPlanToScene(scene: SceneInput, plan: Pick<Plan, 'adds' | 'removes' | 'replaces'>): { strokes: Stroke[]; images: ImageItem[] } {
  const swap = new Map(plan.replaces)
  const gone = new Set(plan.removes)
  const keep = <T extends PageItem>(list: readonly T[]) => list.filter(i => !gone.has(i.id)).map(i => (swap.get(i.id) as T | undefined) ?? i)
  return {
    strokes: [...keep(scene.strokes), ...plan.adds.filter((i): i is Stroke => !isImg(i))],
    images: [...keep(scene.images), ...plan.adds.filter(isImg)],
  }
}

function unitsOf(p: Planner, refs: string[]): PageItem[][] | { message: string } {
  const units: PageItem[][] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const t = targetsOf(p, [ref])
    if (!t.ok) return { message: t.message }
    const items = t.items.filter(i => !seen.has(i.id))
    for (const i of items) seen.add(i.id)
    if (items.length) units.push(items)
  }
  return units.length >= 2 ? units : { message: 'Needs at least two different things.' }
}

function shift(p: Planner, items: readonly PageItem[], dx: number, dy: number) {
  if (!dx && !dy) return
  for (const item of items) {
    const moved = isImg(item) ? offsetImage(item, dx, dy) : offsetStroke(item, dx, dy)
    p.swap(item, withId(moved, p.newId(), item.group ?? null))
  }
}
