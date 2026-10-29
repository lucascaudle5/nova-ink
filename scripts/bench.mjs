// Local measurements on generated data. NOT Cloudflare numbers.
//  - rows written/read come from SQLite's own counters inside the Durable Object.
//  - CPU is the CPU time consumed by the local workerd process (read from the OS), divided by operation count.
//    It includes HTTP/JSON handling, the isolate, SQLite and gzip, but runs on this PC's CPU, so treat it as relative.
//    (Timers inside workerd are frozen during synchronous execution, so in-Worker timing is not possible.)
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startWorker, root } from '../test/node/harness.mjs'
import { diffSnapshots } from '../src/diff.ts'

const fixture = name => JSON.parse(readFileSync(path.join(root, 'test', 'fixtures', `${name}.json`), 'utf8'))
const A = randomUUID()
const workerdPids = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process workerd -ErrorAction SilentlyContinue).Id -join ","'], { encoding: 'utf8' }).trim().split(',').filter(Boolean).map(Number)
const cpuMs = pids => Number(execFileSync('powershell', ['-NoProfile', '-Command',
  `$t=0; foreach($i in @(${pids.join(',')})){ $t += (Get-Process -Id $i -ErrorAction SilentlyContinue).TotalProcessorTime.TotalMilliseconds }; $t`], { encoding: 'utf8' }).trim())

const persist = mkdtempSync(path.join(os.tmpdir(), 'nova-bench-'))
const before = new Set(workerdPids())
const w = await startWorker(persist)
await w.call('diagnostics', randomUUID())
const pids = workerdPids().filter(p => !before.has(p))
if (!pids.length) throw new Error('could not find the workerd process')

const rows = []
async function measure(label, count, fn) {
  const warm = Math.min(2, count)
  for (let i = 0; i < warm; i++) await fn(-1 - i)
  const c0 = cpuMs(pids), t0 = performance.now()
  const results = []
  for (let i = 0; i < count; i++) results.push(await fn(i))
  const wall = performance.now() - t0, cpu = cpuMs(pids) - c0
  const written = results.map(r => r?.stats?.rowsWritten).filter(Number.isFinite)
  const row = {
    operation: label, n: count, cpuMsPerOp: +(cpu / count).toFixed(1), wallMsPerOp: +(wall / count).toFixed(1),
    rowsReadPerOp: (() => { const r = results.map(r => r?.stats?.rowsRead).filter(Number.isFinite); return r.length ? +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(1) : '' })(),
    rowsWrittenPerOp: written.length ? +(written.reduce((a, b) => a + b, 0) / written.length).toFixed(1) : '',
  }
  rows.push(row); console.log(JSON.stringify(row))
  return results
}

const sizes = ['s100', 's500', 's1500', 's3000', 'img3mb', 'img8mb']
const snaps = Object.fromEntries(sizes.map(n => [n, fixture(n)]))
for (const name of (process.env.BENCH_ONLY === 'typical' ? [] : sizes)) {
  const snap = snaps[name]
  const bytes = Buffer.byteLength(JSON.stringify(snap))
  const label = `${name} (${(bytes / 1048576).toFixed(2)} MiB JSON)`
  const ids = []
  await measure(`full save, ${label}`, 5, i => {
    const id = randomUUID(); if (i >= 0) ids.push(id)
    return w.call('save', id, { clientId: A, saveId: `f${i}`, baseRevision: 0, ...diffSnapshots(null, snap) })
  })
  const id = randomUUID()
  await w.call('save', id, { clientId: A, saveId: 'seed', baseRevision: 0, ...diffSnapshots(null, snap) })
  await measure(`load (open), ${label}`, 10, () => w.call('open', id, { clientId: A }))
  await measure(`load (openRaw), ${label}`, 10, () => w.call('openRaw', id, { clientId: A }))
  await measure(`checkpoint write proxy (importCheckpoint), ${label}`, 3, i => w.call('importCheckpoint', id, { clientId: A, revision: 100 + i + 5, snapshot: snap }))
  await measure(`restore checkpoint (gunzip+diff, no changes), ${label}`, 3, async i => {
    const o = await w.call('open', id, { clientId: A })
    return w.call('restoreCheckpoint', id, { clientId: A, saveId: `rs${i}-${Math.random()}`, checkpointRevision: 105, expectedRevision: o.revision })
  })
}

// Typical edit: a few new strokes on a 1,500-stroke canvas, repeated, plus camera-only saves.
{
  const base = fixture('s1500')
  const id = randomUUID()
  let rev = (await w.call('save', id, { clientId: A, saveId: 'seed', baseRevision: 0, ...diffSnapshots(null, base) })).revision
  const draws = Object.values(base.document.store).filter(r => r.typeName === 'shape' && r.type === 'draw')
  let current = base, counter = 0
  const strokesPerSave = 3
  await measure(`typical save: +${strokesPerSave} strokes on 1,500-stroke canvas`, 30, async () => {
    const next = JSON.parse(JSON.stringify(current)); // new ids each save
    for (let k = 0; k < strokesPerSave; k++) {
      const nid = `shape:bench${++counter}`
      next.document.store[nid] = { ...JSON.parse(JSON.stringify(draws[k])), id: nid, index: `a${String(1000 + counter).padStart(5, '0')}`, x: counter }
    }
    const res = await w.call('save', id, { clientId: A, saveId: `t${counter}`, baseRevision: rev, ...diffSnapshots(current, next) })
    if (!res.ok) throw new Error(JSON.stringify(res))
    rev = res.revision; current = next
    return res
  })
  await measure('camera-only save on 1,500-stroke canvas', 30, async i => {
    const next = JSON.parse(JSON.stringify(current))
    for (const st of Object.values(next.session.pageStates ?? {})) st.camera = { x: i, y: i, z: 1 }
    const res = await w.call('save', id, { clientId: A, saveId: `c${counter++}-${i}`, baseRevision: rev, ...diffSnapshots(current, next) })
    rev = res.revision; current = next
    return res
  })
  await measure('heartbeat', 30, () => w.call('heartbeat', id, { clientId: A }))
}

await w.dispose()
rmSync(persist, { recursive: true, force: true })
writeFileSync(path.join(root, 'docs', 'bench-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, rows }, null, 2))
console.log('wrote docs/bench-results.json')
process.exit(0)
