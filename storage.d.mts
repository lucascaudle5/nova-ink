import type { TLEditorSnapshot } from 'tldraw'
export declare const DEFAULT_DATA_DIR: string
export declare const MAX_SNAPSHOT_BYTES: number
export declare const LEASE_MS: number
export declare const BACKUP_COUNT: number
export declare const MANIFEST_VERSION: number
export declare function hasSnapshotShape(snapshot: unknown): boolean
export interface CanvasMeta { id: string; name: string; createdAt: string; updatedAt: string; revision?: number; createdBySaveId?: string }
export interface StorageNotice { kind: string; message: string }
export type StorageResult = {
  ok: boolean; code?: string; message?: string; warning?: string; notice?: StorageNotice
  canvas?: CanvasMeta; canvases?: CanvasMeta[]; lastOpenedId?: string | null
  revision?: number; ownLastSaveId?: string | null; replayed?: boolean
  readOnly?: boolean; leaseExpiresAt?: string; savedAt?: string
  restoredRevision?: number; recoveryCopyPreserved?: boolean
  backups?: Array<{ revision: number; savedAt?: string }>
  snapshot?: TLEditorSnapshot | null; bytes?: number; limit?: number
}
export declare class NotebookStore {
  constructor(dir?: string, options?: { log?: (...args: unknown[]) => void })
  dir: string
  leases: Map<string, { clientId: string; until: number }>
  list(): Promise<StorageResult>
  create(name: string): Promise<StorageResult>
  saveAsNew(name: string, clientId: string, snapshot: Record<string, unknown>, saveId: string): Promise<StorageResult>
  open(id: string, clientId: string, options?: { takeOver?: boolean }): Promise<StorageResult>
  listBackups(id: string): Promise<StorageResult>
  restoreBackup(id: string, clientId: string, backupRevision: number, expectedCurrentRevision: number | null): Promise<StorageResult>
  startFresh(id: string, clientId: string): Promise<StorageResult>
  heartbeat(id: string, clientId: string): Promise<StorageResult>
  release(id: string, clientId: string): Promise<StorageResult>
  save(id: string, clientId: string, revision: number, snapshot: Record<string, unknown>, saveId?: string): Promise<StorageResult>
}
