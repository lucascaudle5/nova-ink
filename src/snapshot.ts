import { createTLStore, defaultBindingUtils, defaultShapeUtils, loadSnapshot } from 'tldraw'
import type { TLEditorSnapshot } from 'tldraw'

/** Loads the snapshot into a throwaway store. Returns why tldraw rejects it, or null if it loads. */
export function snapshotLoadError(snapshot: unknown): string | null {
  const store = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils })
  try {
    loadSnapshot(store, snapshot as TLEditorSnapshot)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    store.dispose()
  }
}
