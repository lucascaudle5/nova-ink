/** Wire types shared by the Worker, the Durable Object and (later) the client. */

export type TLRecord = { id: string; typeName: string; [key: string]: unknown }

/** What a client sends: only what changed since `baseRevision`. */
export type Changes = {
  puts?: TLRecord[]
  removes?: string[]
  /** tldraw `session` snapshot (camera, selection, current page). Omit when unchanged. */
  session?: unknown
  /** tldraw `document.schema`. Omit when unchanged. */
  schema?: unknown
}

export type SaveRequest = Changes & {
  clientId: string
  saveId: string
  baseRevision: number
}

export type Snapshot = { document: { store: Record<string, TLRecord>; schema: unknown }; session: unknown }

export type CheckpointInfo = { revision: number; savedAt: string; bytes: number }

export type WriteStats = { rowsWritten: number; rowsRead: number }

export type ApiResult = {
  ok: boolean
  code?: string
  message?: string
  warning?: string
  revision?: number
  savedAt?: string
  replayed?: boolean
  ownLastSaveId?: string | null
  readOnly?: boolean
  leaseExpiresAt?: string
  snapshot?: Snapshot | null
  checkpoints?: CheckpointInfo[]
  restoredRevision?: number
  recoveryCopyPreserved?: boolean
  checkpointed?: boolean
  stats?: WriteStats
  [key: string]: unknown
}
