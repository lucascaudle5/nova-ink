import type { TLEditorSnapshot } from 'tldraw'
export declare const DEFAULT_DATA_DIR: string
export declare const MAX_SNAPSHOT_BYTES: number
export declare const LEASE_MS: number
export interface CanvasMeta { id: string; name: string; createdAt: string; updatedAt: string }
export type StorageResult = { ok: boolean; code?: string; message?: string; canvas?: CanvasMeta; canvases?: CanvasMeta[]; lastOpenedId?: string | null; revision?: number; readOnly?: boolean; leaseExpiresAt?: string; savedAt?: string; snapshot?: TLEditorSnapshot | null }
export declare class NotebookStore {
  constructor(dir?: string)
  list(): Promise<StorageResult>
  create(name: string): Promise<StorageResult>
  open(id: string, clientId: string): Promise<StorageResult>
  heartbeat(id: string, clientId: string): Promise<StorageResult>
  release(id: string, clientId: string): Promise<StorageResult>
  save(id: string, clientId: string, revision: number, snapshot: Record<string,unknown>): Promise<StorageResult>
}
