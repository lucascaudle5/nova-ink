import type { InkDocument, Placed, PlacedImage } from './document'
import type { ImageItem, Stroke } from './types'

type Command =
  | { kind: 'add'; strokes: Stroke[] }
  | { kind: 'remove'; entries: Placed[] }
  | { kind: 'replace'; removed: Placed; pieces: Stroke[] }
  | { kind: 'group'; commands: Command[] }
  /** before = null: inserted; after = null: deleted; both: moved or resized. */
  | { kind: 'image'; before: PlacedImage | null; after: ImageItem | null }

/**
 * Undo/redo for one document. All edits made through History are undoable; edits made directly on
 * the document (load) are not, and callers should clear() after them.
 */
export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private group: Command[] | null = null

  constructor(private readonly doc: InkDocument, private readonly limit = 500) {}

  get canUndo(): boolean { return this.undoStack.length > 0 || !!this.group?.length }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  addStroke(stroke: Stroke): void { this.addStrokes([stroke]) }

  /** Adds strokes as one undo step. */
  addStrokes(strokes: readonly Stroke[]): void {
    if (!strokes.length) return
    this.doc.addMany(strokes)
    this.record({ kind: 'add', strokes: [...strokes] })
  }

  erase(ids: Iterable<string>): Placed[] {
    const entries = this.doc.remove(ids)
    if (entries.length) this.record({ kind: 'remove', entries })
    return entries
  }

  /** Replaces a stroke with what is left of it after a partial erase. */
  cut(id: string, pieces: readonly Stroke[]): boolean {
    const removed = this.doc.replace(id, pieces)
    if (removed) this.record({ kind: 'replace', removed, pieces: [...pieces] })
    return !!removed
  }

  insertImage(image: ImageItem): void {
    this.doc.addImage(image)
    this.record({ kind: 'image', before: null, after: image })
  }

  deleteImage(id: string): boolean {
    const before = this.doc.removeImage(id)
    if (before) this.record({ kind: 'image', before, after: null })
    return !!before
  }

  /** Moves or resizes: `next` takes the placement's place. */
  replaceImage(id: string, next: ImageItem): boolean {
    const before = this.doc.replaceImage(id, next)
    if (before) this.record({ kind: 'image', before, after: next })
    return !!before
  }

  /** Everything until endGroup() becomes one undo step (one eraser gesture). */
  beginGroup(): void { if (!this.group) this.group = [] }

  endGroup(): void {
    const commands = this.group
    this.group = null
    if (commands?.length) this.push(commands.length === 1 ? commands[0] : { kind: 'group', commands })
  }

  undo(): boolean {
    this.endGroup()
    const command = this.undoStack.pop()
    if (!command) return false
    this.revert(command)
    this.redoStack.push(command)
    return true
  }

  redo(): boolean {
    this.endGroup()
    const command = this.redoStack.pop()
    if (!command) return false
    this.apply(command)
    this.undoStack.push(command)
    return true
  }

  clear(): void { this.undoStack = []; this.redoStack = []; this.group = null }

  private record(command: Command) {
    if (this.group) this.group.push(command)
    else this.push(command)
  }

  private push(command: Command) {
    this.undoStack.push(command)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }

  private apply(command: Command): void {
    switch (command.kind) {
      case 'add': this.doc.addMany(command.strokes); break
      case 'remove': this.doc.remove(command.entries.map(e => e.stroke.id)); break
      case 'replace': this.doc.replace(command.removed.stroke.id, command.pieces); break
      case 'group': for (const c of command.commands) this.apply(c); break
      case 'image':
        if (command.before && command.after) this.doc.replaceImage(command.before.image.id, command.after)
        else if (command.after) this.doc.addImage(command.after)
        else if (command.before) this.doc.removeImage(command.before.image.id)
        break
    }
  }

  private revert(command: Command): void {
    switch (command.kind) {
      case 'add': this.doc.remove(command.strokes.map(s => s.id)); break
      case 'remove': this.doc.restore(command.entries); break
      case 'replace':
        this.doc.remove(command.pieces.map(s => s.id))
        this.doc.restore([command.removed])
        break
      case 'group': for (let i = command.commands.length - 1; i >= 0; i--) this.revert(command.commands[i]); break
      case 'image':
        if (command.before && command.after) this.doc.replaceImage(command.after.id, command.before.image)
        else if (command.after) this.doc.removeImage(command.after.id)
        else if (command.before) this.doc.addImage(command.before.image, command.before.index)
        break
    }
  }
}
