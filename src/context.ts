// Canvas context must never be misrepresented as verified handwriting recognition.
export type ContextShape = { id: string; type: string; x: number; y: number; props: unknown }
export type PageBounds = { x: number; y: number; w: number; h: number }

export function intersectsViewport(a: PageBounds, viewport: PageBounds): boolean {
  if (![a.x, a.y, a.w, a.h, viewport.x, viewport.y, viewport.w, viewport.h].every(Number.isFinite)) return false
  return a.x <= viewport.x + viewport.w && a.x + a.w >= viewport.x && a.y <= viewport.y + viewport.h && a.y + a.h >= viewport.y
}

export function containedInViewport(a: PageBounds, viewport: PageBounds): boolean {
  if (![a.x, a.y, a.w, a.h, viewport.x, viewport.y, viewport.w, viewport.h].every(Number.isFinite)) return false
  return a.x >= viewport.x && a.y >= viewport.y && a.x + a.w <= viewport.x + viewport.w && a.y + a.h <= viewport.y + viewport.h
}

/** What the Ask panel tells the student will be shared. Keep in step with makeCanvasContext and the image export. */
export const DISCLOSURE = {
  viewport: 'ChatGPT receives an image of exactly what is on screen, plus the text of shapes that are fully on screen. Anything off screen, including the hidden parts of shapes cut off at the edge, is not shared.',
  selection: 'ChatGPT receives an image of the selected shapes in full (including off-screen parts and anything inside selected frames or groups), plus their text.',
}

// visibleIds must come from the live tldraw editor's page-space bounds calculation.
// containedIds lists visible shapes that are entirely on screen; only their text is shared in viewport scope.
export function makeCanvasContext(
  shapes: ContextShape[], selectedIds: string[], prompt: string, visibleIds?: string[], containedIds?: string[],
) {
  const selected = new Set(selectedIds)
  const visible = visibleIds === undefined ? null : new Set(visibleIds)
  const contained = containedIds === undefined ? null : new Set(containedIds)
  const viewportScope = !selected.size && visible !== null
  const inScope = selected.size
    ? shapes.filter(shape => selected.has(shape.id))
    : visible === null ? shapes : shapes.filter(shape => visible.has(shape.id))
  let partiallyVisibleShapes = 0
  const sample = inScope.slice(0, 24).map(shape => {
    const cutOff = viewportScope && contained !== null && !contained.has(shape.id)
    if (cutOff) partiallyVisibleShapes++
    return {
      id: shape.id, type: shape.type, x: Math.round(shape.x), y: Math.round(shape.y),
      props: cutOff ? { partiallyVisible: true, note: 'extends off screen; text not shared' } : compactProps(shape.props),
    }
  })
  return {
    source: 'NOVA Ink MCP App shape metadata, not a verified handwriting transcription',
    question: prompt.slice(0, 1200),
    scope: selected.size ? 'selected shapes' : visible === null ? 'current page' : 'visible viewport',
    totalShapesOnPage: shapes.length,
    scopeShapes: inScope.length,
    peripheralShapes: Math.max(0, shapes.length - inScope.length),
    shownShapes: sample.length,
    ...(viewportScope ? { partiallyVisibleShapes } : {}),
    shapes: sample,
    limitation: 'A separate PNG may accompany this metadata. Never claim to visually read handwriting unless the PNG was successfully provided and examined. Work outside the scoped image has not been inspected.',
  }
}

function compactProps(props: unknown) {
  if (!props || typeof props !== 'object') return {}
  const p = props as Record<string, unknown>
  const r: Record<string, unknown> = {}
  for (const key of ['text', 'geo', 'color', 'size', 'w', 'h', 'scale', 'richText', 'segments']) {
    const value = p[key]
    if (typeof value === 'string') r[key] = value.slice(0, 600)
    else if (typeof value === 'number') r[key] = value
    else if (key === 'segments' && Array.isArray(value)) r[key] = `[${value.length} stroke segments; not included in text context]`
  }
  return r
}
