/**
 * Model-side costs at notebook scale, in Node on this machine. Browser rendering is measured in the
 * harness ("Benchmark redraw"), and only iPad numbers decide the acceptance criteria.
 * Usage: npm run bench [-- --write]   (--write updates docs/bench-results.json)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { InkDocument } from '../src/core/document'
import { strokesHitBy } from '../src/core/eraser'
import { parsePage, serializePage } from '../src/core/format'
import { strokeOutline } from '../src/core/geometry'
import { History } from '../src/core/history'
import { generateStrokes } from '../src/dev/generate'
import { Samples } from '../src/core/metrics'

const gc = (globalThis as { gc?: () => void }).gc
const heap = () => { gc?.(); return process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers }

function time(runs: number, fn: () => void): { p50: number; p95: number } {
  const s = new Samples(runs)
  for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); s.push(performance.now() - t) }
  return { p50: round(s.percentile(50)), p95: round(s.percentile(95)) }
}
const round = (v: number) => Math.round(v * 1000) / 1000

const COUNT = 3000
const before = heap()
const strokes = generateStrokes(COUNT)
const doc = new InkDocument()
doc.load(strokes)
const memoryMiB = round((heap() - before) / 1048576)
const points = strokes.reduce((n, s) => n + s.points.length / 4, 0)

const fresh = generateStrokes(COUNT, { seed: 2 })
const text = JSON.stringify(serializePage(strokes))
const results = {
  machine: { cpu: os.cpus()[0]?.model, node: process.version, platform: `${os.platform()} ${os.release()}` },
  measuredAt: new Date().toISOString(),
  strokes: COUNT,
  points,
  memoryMiB,
  savedBytes: Buffer.byteLength(text),
  savedMiB: round(Buffer.byteLength(text) / 1048576),
  ms: {
    outlineAllStrokes: time(10, () => { for (const s of strokes) strokeOutline(s.points, s.style.width) }),
    serializeFirstTime: time(1, () => JSON.stringify(serializePage(fresh))),
    serializeAutosaveCached: time(10, () => JSON.stringify(serializePage(strokes))),
    parsePage: time(10, () => { if (!parsePage(JSON.parse(text)).ok) throw new Error('parse failed') }),
    queryViewport1024x768: time(500, () => doc.query({ minX: 300, minY: 900, maxX: 1324, maxY: 1668 })),
    eraserHitTest: time(500, () => strokesHitBy(doc, 700, 1200, 10)),
    eraseThenUndo50: time(20, () => {
      const history = new History(doc)
      history.beginGroup()
      for (let i = 0; i < 50; i++) history.erase([strokes[i * 37].id])
      history.endGroup()
      history.undo()
    }),
  },
}
if (doc.size !== COUNT) throw new Error('erase/undo changed the document')

console.log(JSON.stringify(results, null, 2))
if (process.argv.includes('--write')) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'bench-results.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n')
  console.log(`wrote ${out}`)
}
