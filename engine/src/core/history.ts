import type { InkDocument, Placed } from './document'
import type { Stroke } from './types'

type Command =
  | { kind: 'add'; stroke: Stroke }
  | { kind: 'remove'; entries: Placed[] }
  | { kind: 'group'; commands: Command[] }

/**
 * Undo/redo for one document. All edits made through History are undoable; edits made directly on
 * the document (load) are not, and callers should clear() after them.
 */
export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private group: Command[] | null = null

  constructor(private readonly doc: InkDocument, private readonly limit = 500) {}

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  addStroke(stroke: Stroke): void {
    this.doc.add(stroke)
    this.record({ kind: 'add', stroke })
  }

  erase(ids: Iterable<string>): Placed[] {
    const entries = this.doc.remove(ids)
    if (entries.length) this.record({ kind: 'remove', entries })
    return entries
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
      case 'add': this.doc.add(command.stroke); break
      case 'remove': this.doc.remove(command.entries.map(e => e.stroke.id)); break
      case 'group': for (const c of command.commands) this.apply(c); break
    }
  }

  private revert(command: Command): void {
    switch (command.kind) {
      case 'add': this.doc.remove([command.stroke.id]); break
      case 'remove': this.doc.restore(command.entries); break
      case 'group': for (let i = command.commands.length - 1; i >= 0; i--) this.revert(command.commands[i]); break
    }
  }
}
