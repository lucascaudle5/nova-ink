import { applyPlanToScene } from './ops'
import type { Plan, PlacedLabel } from './ops'
import { unionOf } from './scene'
import type { SceneInput } from './scene'
import type { Bounds } from './types'
import { POINT_STRIDE } from './types'

/**
 * A rough character picture of one area of a page, for a model that cannot see images (Claude in voice mode): the
 * student's writing, pictures, NOVA's marks, and the labels NOVA just wrote spelled out where they landed. A cell is
 * twice as tall as it is wide, roughly the shape of a monospace character.
 */
export const SKETCH_LEGEND = '# student\'s writing, : picture, + NOVA\'s earlier marks, * what NOVA just drew, letters = NOVA\'s new labels where they landed'

const MAX_COLS = 72, MAX_ROWS = 36, MIN_W = 320, MIN_H = 200, MAX_LABEL = 24
const RANK: Record<string, number> = { ' ': 0, ':': 1, '#': 2, '+': 3, '*': 4 }

export interface SketchMarks {
  /** Items NOVA just added or changed, drawn as '*'. */
  fresh: ReadonlySet<string>
  /** NOVA's new labels: written out as text instead of their strokes. */
  labels: readonly PlacedLabel[]
}

/** The area to sketch around `focus`: padded, at least MIN_W × MIN_H, centred on it. */
export function sketchArea(focus: Bounds): Bounds {
  const w = focus.maxX - focus.minX, h = focus.maxY - focus.minY
  const pad = Math.max(60, 0.3 * Math.max(w, h))
  const cx = (focus.minX + focus.maxX) / 2, cy = (focus.minY + focus.maxY) / 2
  const hw = Math.max(MIN_W, w + 2 * pad) / 2, hh = Math.max(MIN_H, h + 2 * pad) / 2
  return { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh }
}

/** A sketch of the page after `plan`, around what it adds or changes, or null when it adds or changes nothing. */
export function sketchOfPlan(scene: SceneInput, plan: Plan): string | null {
  const changed = [...plan.adds, ...plan.replaces.map(([, item]) => item)]
  const focus = unionOf(changed.map(i => i.bounds))
  if (!focus) return null
  return sketch(applyPlanToScene(scene, plan), sketchArea(focus), { fresh: new Set(changed.map(i => i.id)), labels: plan.labels ?? [] })
}

export function sketch(scene: SceneInput, area: Bounds, marks: SketchMarks = { fresh: new Set(), labels: [] }): string {
  const w = area.maxX - area.minX, h = area.maxY - area.minY
  let cell = w / MAX_COLS
  if (h / (cell * 2) > MAX_ROWS) cell = h / (MAX_ROWS * 2)
  const cols = Math.max(1, Math.ceil(w / cell)), rows = Math.max(1, Math.ceil(h / (cell * 2)))
  const grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '))
  const put = (x: number, y: number, ch: string) => {
    const c = Math.floor((x - area.minX) / cell), r = Math.floor((y - area.minY) / (cell * 2))
    if (r < 0 || r >= rows || c < 0 || c >= cols) return
    if ((RANK[ch] ?? 9) >= (RANK[grid[r][c]] ?? 9)) grid[r][c] = ch
  }
  const inside = (b: Bounds) => b.maxX >= area.minX && b.minX <= area.maxX && b.maxY >= area.minY && b.minY <= area.maxY

  for (const image of scene.images) {
    if (!inside(image.bounds)) continue
    for (let y = image.bounds.minY + cell; y < image.bounds.maxY; y += cell * 2) for (let x = image.bounds.minX + cell / 2; x < image.bounds.maxX; x += cell) put(x, y, ':')
  }
  const labelStrokes = new Set(marks.labels.flatMap(l => l.strokeIds))
  for (const stroke of scene.strokes) {
    if (labelStrokes.has(stroke.id) || !inside(stroke.bounds)) continue
    const ch = marks.fresh.has(stroke.id) ? '*' : stroke.author === 'ai' ? '+' : '#'
    const p = stroke.points, n = p.length / POINT_STRIDE
    for (let i = 0; i < n; i++) {
      const x = p[i * POINT_STRIDE], y = p[i * POINT_STRIDE + 1]
      if (i === 0) { put(x, y, ch); continue }
      const px = p[(i - 1) * POINT_STRIDE], py = p[(i - 1) * POINT_STRIDE + 1]
      const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (cell / 2)))
      for (let s = 1; s <= steps; s++) put(px + (x - px) * s / steps, py + (y - py) * s / steps, ch)
    }
  }
  for (const label of marks.labels) {
    const text = label.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
    const r = Math.floor(((label.bounds.minY + label.bounds.maxY) / 2 - area.minY) / (cell * 2))
    const c0 = Math.floor((label.bounds.minX - area.minX) / cell)
    if (r < 0 || r >= rows) continue
    for (let i = 0; i < text.length; i++) if (c0 + i >= 0 && c0 + i < cols) grid[r][c0 + i] = text[i]
  }

  const n = (v: number) => String(Math.round(v))
  const edge = '.' + '-'.repeat(cols) + '.'
  return [
    `Area x ${n(area.minX)} to ${n(area.maxX)}, y ${n(area.minY)} to ${n(area.maxY)} (y grows down); one character is ${n(cell)} units wide and ${n(cell * 2)} tall.`,
    `Legend: ${SKETCH_LEGEND}.`,
    edge, ...grid.map(row => '|' + row.join('') + '|'), edge,
  ].join('\n')
}
