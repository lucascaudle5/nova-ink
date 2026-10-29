/** Client-side helper: turns two tldraw snapshots into the change set the save protocol sends. */
import type { Changes, Snapshot } from './protocol'

export function diffSnapshots(base: Snapshot | null, next: Snapshot): Changes {
  const before = base?.document.store ?? {}
  const after = next.document.store
  const puts = []
  for (const [id, record] of Object.entries(after)) {
    if (!(id in before) || JSON.stringify(before[id]) !== JSON.stringify(record)) puts.push(record)
  }
  const removes = Object.keys(before).filter(id => !(id in after))
  const changes: Changes = { puts, removes }
  if (!base || JSON.stringify(base.document.schema) !== JSON.stringify(next.document.schema)) changes.schema = next.document.schema
  if (!base || JSON.stringify(base.session) !== JSON.stringify(next.session)) changes.session = next.session
  return changes
}
