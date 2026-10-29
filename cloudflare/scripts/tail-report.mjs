// Turns `wrangler tail --format json` output into a table of per-invocation CPU / wall time for the go/no-go checks.
//
//   npx wrangler tail nova-ink-test --format json | node scripts/tail-report.mjs
//   node scripts/tail-report.mjs saved-tail.jsonl
//
// Rows come from the Worker's own log lines (no content, no tokens are ever logged):
//   {"diag":1,"run","size","op"}   one Durable Object invocation of nova_ink_diagnostics
//   {"evt":"tool","tool","ms","bytesIn","code"}   one MCP tool call handled by the Worker
// CPU/wall fields: I have NOT seen a real tail sample yet, so this accepts the names Cloudflare uses in trace events
// (cpuTime, wallTime, CPUTimeMs, WallTimeMs, ...). If a row shows "?" for CPU, look at the raw event printed with --raw
// and tell me the field name; the dashboard (Workers & Pages -> nova-ink-test -> Metrics) also charts CPU time.
import { createReadStream } from 'node:fs'
import readline from 'node:readline'

const args = process.argv.slice(2)
const raw = args.includes('--raw')
const file = args.find(a => !a.startsWith('--'))
const input = file ? createReadStream(file) : process.stdin

const pick = (event, names) => { for (const n of names) if (typeof event[n] === 'number') return event[n]; return null }
const fmt = v => v === null || v === undefined ? '?' : (Math.round(v * 100) / 100).toString()

const rows = []
const problems = []
let seen = 0
const rl = readline.createInterface({ input })
rl.on('line', line => {
  let event
  try { event = JSON.parse(line) } catch { return }
  if (!event || typeof event !== 'object') return
  seen++
  if (raw && seen <= 3) console.error('RAW EVENT:', JSON.stringify(event).slice(0, 1500))
  const cpu = pick(event, ['cpuTime', 'cpuTimeMs', 'CPUTimeMs', 'cpu_time_ms', 'cpuMs'])
  const wall = pick(event, ['wallTime', 'wallTimeMs', 'WallTimeMs', 'wall_time_ms', 'wallMs'])
  const outcome = event.outcome ?? event.Outcome ?? '?'
  if (outcome !== 'ok' && outcome !== '?') problems.push(`${outcome} at ${event.eventTimestamp ?? ''}`)
  const when = event.eventTimestamp ?? Date.now()
  for (const log of event.logs ?? []) {
    for (const message of log.message ?? []) {
      let parsed
      try { parsed = typeof message === 'string' ? JSON.parse(message) : message } catch { continue }
      if (parsed?.diag) rows.push({ when, kind: 'object', name: `${parsed.size} / ${parsed.op}`, run: parsed.run, outcome, cpu, wall })
      else if (parsed?.evt === 'tool') rows.push({ when, kind: 'tool', name: parsed.tool, bytesIn: parsed.bytesIn, code: parsed.code, outcome, cpu, wall })
    }
  }
})
rl.on('close', () => {
  rows.sort((a, b) => String(a.when).localeCompare(String(b.when)))
  console.log(`events read: ${seen}, matched rows: ${rows.length}`)
  console.log('\nkind    | step / tool                                            | cpu ms | wall ms | outcome | extra')
  console.log('--------|--------------------------------------------------------|--------|---------|---------|------')
  for (const r of rows) {
    const extra = r.kind === 'tool' ? `${r.bytesIn ? `${(r.bytesIn / 1048576).toFixed(2)} MiB in` : ''} ${r.code ?? ''}`.trim() : `run ${r.run}`
    console.log(`${r.kind.padEnd(7)} | ${String(r.name).padEnd(54)} | ${fmt(r.cpu).padStart(6)} | ${fmt(r.wall).padStart(7)} | ${String(r.outcome).padEnd(7)} | ${extra}`)
  }
  if (problems.length) console.log(`\nNON-OK OUTCOMES (limit hit?):\n  ${problems.join('\n  ')}`)
  else console.log('\nNo non-ok outcomes (no exceededCpu / exceededMemory) in this capture.')
  if (rows.length && rows.every(r => r.cpu === null)) console.log('\nCPU fields were not found in the events. Re-run with --raw to see the event shape.')
})
