import { CodecError, fromBase64, toBase64, unzigzag, VarintReader, writeVarint, zigzag } from './codec'
import { DEFAULT_PAPER, isPaper } from './paper'
import type { Paper } from './paper'
import { createImage, IMAGE_ID } from './image'
import { createStroke, MAX_POINTS_PER_STROKE } from './stroke'
import { isImage, POINT_STRIDE, ROTATIONS } from './types'
import type { Author, ImageItem, PageItem, Rotation, Stroke } from './types'

/**
 * NOVA ink page format, version 1 (experimental: not used by any saved notebook yet).
 *
 * { format: "nova-ink", version: 1, paper?: { color, pattern }, strokes: [{ id, author, color, width, createdAt, n, points }] }
 *
 * `points` is base64 of zigzag varints: for each point, the deltas from the previous point of
 * round(x * 100), round(y * 100), round(pressure * 1000) and round(dt ms). Positions are kept to
 * 0.01 page units. Parsing refuses unknown or newer data instead of guessing.
 */
export const FORMAT = 'nova-ink'
export const FORMAT_VERSION = 1
const XY_SCALE = 100
const PRESSURE_SCALE = 1000
const AUTHORS: readonly Author[] = ['student', 'ai']

export interface SerializedStroke {
  id: string
  author: Author
  color: string
  width: number
  createdAt: number
  n: number
  points: string
}

export interface SerializedPage {
  format: typeof FORMAT
  version: typeof FORMAT_VERSION
  /** Optional; pages without it use DEFAULT_PAPER. */
  paper?: Paper
  strokes: SerializedStroke[]
}

export type ParseResult =
  | { ok: true; strokes: Stroke[]; paper: Paper }
  | { ok: false; code: 'NOT_NOVA_INK' | 'FORMAT_NEWER' | 'INVALID'; message: string }

export function encodePoints(points: ArrayLike<number>): string {
  const bytes: number[] = []
  let px = 0, py = 0, pp = 0, pt = 0
  for (let i = 0; i + POINT_STRIDE - 1 < points.length; i += POINT_STRIDE) {
    const x = Math.round(points[i] * XY_SCALE), y = Math.round(points[i + 1] * XY_SCALE)
    const p = Math.round(points[i + 2] * PRESSURE_SCALE), t = Math.round(points[i + 3])
    writeVarint(bytes, zigzag(x - px)); writeVarint(bytes, zigzag(y - py))
    writeVarint(bytes, zigzag(p - pp)); writeVarint(bytes, zigzag(t - pt))
    px = x; py = y; pp = p; pt = t
  }
  return toBase64(bytes)
}

export function decodePoints(text: string, count: number): Float32Array {
  const reader = new VarintReader(fromBase64(text))
  const out = new Float32Array(count * POINT_STRIDE)
  let x = 0, y = 0, p = 0, t = 0
  for (let i = 0; i < count; i++) {
    x += unzigzag(reader.read()); y += unzigzag(reader.read())
    p += unzigzag(reader.read()); t += unzigzag(reader.read())
    if (p < 0 || p > PRESSURE_SCALE) throw new CodecError('Pressure out of range')
    if (t < 0) throw new CodecError('Negative point time')
    const o = i * POINT_STRIDE
    out[o] = x / XY_SCALE; out[o + 1] = y / XY_SCALE; out[o + 2] = p / PRESSURE_SCALE; out[o + 3] = t
  }
  if (!reader.done) throw new CodecError('Extra bytes after the last point')
  return out
}

// Strokes are immutable, so each is encoded once; an autosave then costs only the strokes added since.
const encoded = new WeakMap<Stroke, SerializedStroke>()

export function serializeStroke(s: Stroke): SerializedStroke {
  let out = encoded.get(s)
  if (!out) {
    out = Object.freeze({
      id: s.id, author: s.author, color: s.style.color, width: s.style.width, createdAt: s.createdAt,
      n: s.points.length / POINT_STRIDE, points: encodePoints(s.points),
    })
    encoded.set(s, out)
  }
  return out
}

export function serializePage(strokes: readonly Stroke[], paper?: Paper): SerializedPage {
  const page: SerializedPage = { format: FORMAT, version: FORMAT_VERSION, strokes: strokes.map(serializeStroke) }
  if (paper) page.paper = { color: paper.color, pattern: paper.pattern }
  return page
}

export function parsePage(data: unknown): ParseResult {
  if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== FORMAT) {
    return { ok: false, code: 'NOT_NOVA_INK', message: 'This is not a NOVA ink page.' }
  }
  const { version, strokes } = data as { version?: unknown; strokes?: unknown }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return invalid('The page has no valid format version.')
  if (version > FORMAT_VERSION) {
    return { ok: false, code: 'FORMAT_NEWER', message: `This page was saved by a newer NOVA Ink (format ${version}; this build reads up to ${FORMAT_VERSION}). Nothing was changed.` }
  }
  if (!Array.isArray(strokes)) return invalid('The page has no stroke list.')
  const { paper } = data as { paper?: unknown }
  if (paper !== undefined && !isPaper(paper)) return invalid('The page has an unknown paper style.')
  const out: Stroke[] = []
  const ids = new Set<string>()
  for (let i = 0; i < strokes.length; i++) {
    const parsed = parseStroke(strokes[i], `Stroke ${i + 1}`)
    if (!parsed.ok) return invalid(parsed.message)
    if (ids.has(parsed.stroke.id)) return invalid(`Stroke ${i + 1} repeats id ${parsed.stroke.id}.`)
    ids.add(parsed.stroke.id)
    out.push(parsed.stroke)
  }
  return { ok: true, strokes: out, paper: paper ? { color: paper.color, pattern: paper.pattern } : { ...DEFAULT_PAPER } }
}

/** Validates and decodes one serialized stroke (as stored per row by a server). `where` prefixes the message. */
export function parseStroke(data: unknown, where = 'Stroke'): { ok: true; stroke: Stroke } | { ok: false; message: string } {
  const s = data as Partial<SerializedStroke> | null
  const bad = (problem: string) => ({ ok: false as const, message: `${where} ${problem}` })
  if (!s || typeof s !== 'object') return bad('is not an object.')
  if (typeof s.id !== 'string' || !STROKE_ID.test(s.id)) return bad('has an invalid id.')
  if (!AUTHORS.includes(s.author as Author)) return bad('has an unknown author.')
  if (typeof s.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.color)) return bad('has an invalid color.')
  if (typeof s.width !== 'number' || !Number.isFinite(s.width) || s.width < 0.1 || s.width > 200) return bad('has an invalid width.')
  if (typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt)) return bad('has an invalid time.')
  if (typeof s.n !== 'number' || !Number.isInteger(s.n) || s.n < 1 || s.n > MAX_POINTS_PER_STROKE) return bad('has an invalid point count.')
  if (typeof s.points !== 'string') return bad('has no point data.')
  let points: Float32Array
  try { points = decodePoints(s.points, s.n) }
  catch (error) { return { ok: false, message: `${where}: ${error instanceof Error ? error.message : String(error)}.` } }
  return { ok: true, stroke: createStroke({ id: s.id, author: s.author as Author, style: { color: s.color, width: s.width }, createdAt: s.createdAt, points }) }
}

export const STROKE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * An image placement as stored per row: { id, kind: "image", author, createdAt, image, x, y, w, h, rotation? }.
 * Positions are kept to 0.01 page units. `image` names a picture stored separately by the host.
 * `rotation` is written only when it is not 0, so unrotated rows read the same in older versions.
 */
export interface SerializedImage {
  id: string
  kind: 'image'
  author: Author
  createdAt: number
  image: string
  x: number
  y: number
  w: number
  h: number
  rotation?: Rotation
}
export type SerializedItem = SerializedStroke | SerializedImage

const round2 = (v: number) => Math.round(v * XY_SCALE) / XY_SCALE
const encodedImages = new WeakMap<ImageItem, SerializedImage>()

export function serializeImage(i: ImageItem): SerializedImage {
  let out = encodedImages.get(i)
  if (!out) {
    out = Object.freeze({
      id: i.id, kind: 'image' as const, author: i.author, createdAt: i.createdAt, image: i.image,
      x: round2(i.x), y: round2(i.y), w: round2(i.w), h: round2(i.h),
      ...(i.rotation ? { rotation: i.rotation } : {}),
    })
    encodedImages.set(i, out)
  }
  return out
}

export function serializeItem(item: PageItem): SerializedItem {
  return isImage(item) ? serializeImage(item) : serializeStroke(item)
}

export function parseImage(data: unknown, where = 'Image'): { ok: true; image: ImageItem } | { ok: false; message: string } {
  const s = data as Partial<SerializedImage> | null
  const bad = (problem: string) => ({ ok: false as const, message: `${where} ${problem}` })
  if (!s || typeof s !== 'object' || s.kind !== 'image') return bad('is not an image.')
  if (typeof s.id !== 'string' || !STROKE_ID.test(s.id)) return bad('has an invalid id.')
  if (!AUTHORS.includes(s.author as Author)) return bad('has an unknown author.')
  if (typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt)) return bad('has an invalid time.')
  if (typeof s.image !== 'string' || !IMAGE_ID.test(s.image)) return bad('has an invalid picture reference.')
  if (s.rotation !== undefined && !ROTATIONS.includes(s.rotation)) return bad('has an invalid rotation.')
  try {
    return { ok: true, image: createImage({ id: s.id, author: s.author as Author, createdAt: s.createdAt, image: s.image, x: s.x as number, y: s.y as number, w: s.w as number, h: s.h as number, rotation: s.rotation }) }
  } catch (error) {
    return bad(`has an invalid position or size (${error instanceof Error ? error.message : String(error)}).`)
  }
}

/** A stored row: an image when it says `kind: "image"`, otherwise a stroke. Any other `kind` is refused. */
export function parseItem(data: unknown, where = 'Item'): { ok: true; item: PageItem } | { ok: false; message: string } {
  const kind = data && typeof data === 'object' ? (data as { kind?: unknown }).kind : undefined
  if (kind === 'image') { const r = parseImage(data, where); return r.ok ? { ok: true, item: r.image } : r }
  if (kind !== undefined) return { ok: false, message: `${where} is of an unknown kind; it may come from a newer NOVA Ink.` }
  const r = parseStroke(data, where)
  return r.ok ? { ok: true, item: r.stroke } : r
}

function invalid(message: string): ParseResult {
  return { ok: false, code: 'INVALID', message: `${message} Nothing was loaded.` }
}
