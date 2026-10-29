// Generates real tldraw snapshots (via tldraw's own store) into test/fixtures/*.json. Generated data only.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createShapeId, getIndexAbove, createTLStore, defaultBindingUtils, defaultShapeUtils, getSnapshot } from 'tldraw'
import { makeSnapshot, loadsInTldraw, shapeCount } from '../test/helpers/snapshots.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')
mkdirSync(dir, { recursive: true })
const write = (name, snapshot) => {
  loadsInTldraw(snapshot) // the real tldraw must accept every fixture
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(snapshot))
  console.log(`${name}: ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KiB, ${shapeCount(snapshot)} shapes`)
}

write('small', makeSnapshot({ strokes: 3 }))
write('s100', makeSnapshot({ strokes: 100, pointsPerStroke: 120 }))
write('s500', makeSnapshot({ strokes: 500, pointsPerStroke: 120 }))
const s1500 = makeSnapshot({ strokes: 1500, pointsPerStroke: 120 })
write('s1500', s1500)
write('s3000', makeSnapshot({ strokes: 3000, pointsPerStroke: 120 }))
write('img3mb', makeSnapshot({ strokes: 5, imageBytes: 3_000_000 }))
write('img8mb', makeSnapshot({ strokes: 5, imageBytes: 8_000_000 }))

// "A few new strokes" on top of s1500, and a camera-only change.
const plus3 = JSON.parse(JSON.stringify(s1500))
const store = plus3.document.store
const draws = Object.values(store).filter(r => r.typeName === 'shape' && r.type === 'draw')
let index = draws.map(d => d.index).sort().at(-1)
for (let i = 0; i < 3; i++) {
  index = getIndexAbove(index)
  const id = createShapeId()
  store[id] = { ...JSON.parse(JSON.stringify(draws[i])), id, index, x: 900 + i * 30, y: 900 }
}
write('s1500-plus3', plus3)
const moved = JSON.parse(JSON.stringify(s1500))
for (const state of Object.values(moved.session.pageStates ?? {})) state.camera = { x: -120, y: 45, z: 1.5 }
write('s1500-camera', moved)

process.exit(0)
