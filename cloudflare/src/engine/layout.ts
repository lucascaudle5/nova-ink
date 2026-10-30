/**
 * Where rendered source pages and crops go on a page. Pure, so it is tested without a Worker.
 * Pictures are scaled so a whole page is LAYOUT_WIDTH wide; a crop keeps that same scale, so a problem cut out of a page
 * is the size it had on the page. Positions are page units (about one CSS pixel at 100% zoom).
 */
import type { Op } from '../../../engine/src/core/ops'

export type Layout = 'full' | 'top_left'
export const LAYOUT_WIDTH: Record<Layout, number> = { full: 760, top_left: 520 }
export const MARGIN = 80
/** Free space left under each picture when several share a page. */
export const WORKING_SPACE = 520
export const MAX_ITEMS = 40

export interface Crop { x: number; y: number; w: number; h: number }
export interface Item { page: number; crop?: Crop; title?: string }
export interface Output { imageId: string; width: number; height: number }

export const cropOk = (c: Crop | undefined) => c === undefined || (c.x >= 0 && c.y >= 0 && c.w >= 0.02 && c.h >= 0.02 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001)

/** The size a picture takes on the page. */
export function displaySize(layout: Layout, item: Item, output: Output): { w: number; h: number } {
  const w = Math.round(LAYOUT_WIDTH[layout] * (item.crop?.w ?? 1))
  return { w, h: Math.max(8, Math.round((w * output.height) / output.width)) }
}

export function pictureOp(layout: Layout, item: Item, output: Output, name: string, at: { x: number; y: number }): { op: Op; bottom: number } {
  const { w, h } = displaySize(layout, item, output)
  return { op: { op: 'picture', image: output.imageId, w, h, name, place: { x: at.x, y: at.y } }, bottom: at.y + h }
}

/** Several pictures one under another on one page, each followed by `space` of free room. */
export function stackOps(layout: Layout, items: readonly Item[], outputs: readonly Output[], names: readonly string[], startY: number, space = WORKING_SPACE): Op[] {
  const ops: Op[] = []
  let y = startY
  items.forEach((item, i) => {
    const { op, bottom } = pictureOp(layout, item, outputs[i], names[i], { x: MARGIN, y })
    ops.push(op)
    y = bottom + space
  })
  return ops
}

/** "5-7" or "5, 7, 9-10" as a list of page numbers. */
export function parsePageList(text: string, max = MAX_ITEMS): number[] | null {
  const out: number[] = []
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:\s*[-\u2013\u2014]\s*(\d{1,4}))?$/.exec(part)
    if (!m) return null
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a || b - a >= max) return null
    for (let p = a; p <= b; p++) out.push(p)
    if (out.length > max) return null
  }
  return out.length ? out : null
}
