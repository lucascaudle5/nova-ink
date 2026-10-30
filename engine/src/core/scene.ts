import type { Bounds, ImageItem, Stroke } from './types'

/**
 * What is on a page, described in plain data so a tool (or a test) can point at things: pictures, named groups, and
 * clusters of the student's own loose ink. Pure; shared by the live editor and the server.
 */
export interface SceneInput { strokes: readonly Stroke[]; images: readonly ImageItem[] }

export interface SceneImage { id: string; group?: string; picture: string; x: number; y: number; w: number; h: number; angle: number; bounds: Bounds }
export interface SceneGroup { id: string; label: string; author: 'nova' | 'student' | 'mixed'; bounds: Bounds; strokes: number; images: number }
export interface SceneRegion { ref: string; bounds: Bounds; strokes: number }
export interface SceneSummary {
  strokes: number
  images: number
  bounds: Bounds | null
  pictures: SceneImage[]
  groups: SceneGroup[]
  /** Clusters of loose student ink; `ref` can be given to an operation as a target. */
  regions: SceneRegion[]
}

export const REGION_GAP = 24
export const MAX_REGIONS = 60

export const round1 = (v: number) => Math.round(v * 10) / 10
export const roundBounds = (b: Bounds): Bounds => ({ minX: round1(b.minX), minY: round1(b.minY), maxX: round1(b.maxX), maxY: round1(b.maxY) })

export function unionOf(list: readonly Bounds[]): Bounds | null {
  if (!list.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of list) { minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY) }
  return { minX, minY, maxX, maxY }
}

export const overlaps = (a: Bounds, b: Bounds, pad = 0) => a.minX < b.maxX + pad && b.minX < a.maxX + pad && a.minY < b.maxY + pad && b.minY < a.maxY + pad

/** The human-readable part of a group id made by NOVA: `nova-free-body-diagram-1a2b3c4d` -> "free body diagram". */
export function groupLabel(id: string): string {
  const m = /^nova-(.*)-[0-9a-f]{8}$/.exec(id)
  return (m ? m[1] : id).replace(/-/g, ' ')
}

/** Groups loose (ungrouped, student) strokes whose bounds are within `gap` of each other. Ordered top to bottom, left to right. */
export function inkClusters(strokes: readonly Stroke[], gap = REGION_GAP): Array<{ ids: string[]; bounds: Bounds }> {
  const loose = strokes.filter(s => !s.group && s.author === 'student')
  const parent = loose.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const order = loose.map((_, i) => i).sort((a, b) => loose[a].bounds.minX - loose[b].bounds.minX)
  for (let a = 0; a < order.length; a++) {
    const A = loose[order[a]].bounds
    for (let b = a + 1; b < order.length; b++) {
      const B = loose[order[b]].bounds
      if (B.minX > A.maxX + gap) break
      if (B.minY <= A.maxY + gap && A.minY <= B.maxY + gap) parent[find(order[b])] = find(order[a])
    }
  }
  const byRoot = new Map<number, number[]>()
  loose.forEach((_, i) => { const r = find(i); const list = byRoot.get(r); if (list) list.push(i); else byRoot.set(r, [i]) })
  const out = [...byRoot.values()].map(members => ({ ids: members.map(i => loose[i].id), bounds: unionOf(members.map(i => loose[i].bounds))! }))
  return out.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX)
}

export function describeScene(scene: SceneInput): SceneSummary {
  const { strokes, images } = scene
  const groups = new Map<string, { strokes: Stroke[]; images: ImageItem[] }>()
  const entry = (id: string) => { let g = groups.get(id); if (!g) { g = { strokes: [], images: [] }; groups.set(id, g) } return g }
  for (const s of strokes) if (s.group) entry(s.group).strokes.push(s)
  for (const i of images) if (i.group) entry(i.group).images.push(i)
  const sceneGroups: SceneGroup[] = [...groups].map(([id, g]) => {
    const authors = new Set([...g.strokes.map(s => s.author), ...g.images.map(i => i.author)])
    return {
      id, label: groupLabel(id), author: authors.size > 1 ? 'mixed' as const : authors.has('ai') ? 'nova' as const : 'student' as const,
      bounds: roundBounds(unionOf([...g.strokes.map(s => s.bounds), ...g.images.map(i => i.bounds)])!), strokes: g.strokes.length, images: g.images.length,
    }
  })
  const regions = inkClusters(strokes).slice(0, MAX_REGIONS).map(c => ({ ref: `ink:${c.ids[0]}`, bounds: roundBounds(c.bounds), strokes: c.ids.length }))
  const all = unionOf([...strokes.map(s => s.bounds), ...images.map(i => i.bounds)])
  return {
    strokes: strokes.length, images: images.length, bounds: all ? roundBounds(all) : null,
    pictures: images.map(i => ({ id: i.id, ...(i.group ? { group: i.group } : {}), picture: i.image, x: round1(i.x), y: round1(i.y), w: round1(i.w), h: round1(i.h), angle: i.angle, bounds: roundBounds(i.bounds) })),
    groups: sceneGroups, regions,
  }
}
