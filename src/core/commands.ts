// An edit is a command: apply and invert. Undo applies the inverse.
// No cloning or serializing the world.

export interface Command {
  readonly label: string;
  /** Applies the edit. A command that fails half way should put back what it did before throwing (RoadJournal does). */
  apply(): void;
  invert(): void;
  /** Tries to absorb a following command (e.g. brush dabs of the same stroke). */
  merge?(next: Command): boolean;
}

export class CommandStack {
  private done: Command[] = [];
  private undone: Command[] = [];
  /** Open command that still accepts merges (brush stroke in progress). */
  private open: Command | null = null;
  readonly limit: number;
  onChange: () => void = () => {};
  /** A new command was added (not called on merge, undo or redo). */
  onPush: (cmd: Command) => void = () => {};
  /**
   * An undo or redo threw. The step stays where it was (still to undo, or still to redo), so the player can try again
   * once whatever blocked it is gone; the command itself rolled back what it had done (see Command.apply).
   */
  onError: (err: unknown, cmd: Command, redo: boolean) => void = (err) => { console.error(err); };

  constructor(limit = 500) { this.limit = limit; }

  /** Applies and records. */
  run(cmd: Command): void {
    cmd.apply();
    this.push(cmd);
  }

  /** Records a command that was already applied (e.g. incremental edit). */
  push(cmd: Command): void {
    this.undone.length = 0;
    if (this.open && this.open.merge?.(cmd)) { this.onChange(); return; }
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.onPush(cmd);
    this.onChange();
  }

  /** Starts a group that merges commands until endGroup. */
  beginGroup(cmd: Command): void {
    this.push(cmd);
    this.open = cmd;
  }

  endGroup(): void { this.open = null; }

  /** Undoes the last step. False when there is none or it failed (then it stays the last step, see onError). */
  undo(): boolean {
    this.open = null;
    const c = this.done[this.done.length - 1];
    if (!c) return false;
    try { c.invert(); } catch (err) { this.onError(err, c, false); return false; }
    this.done.pop();
    this.undone.push(c);
    this.onChange();
    return true;
  }

  /** Redoes the last undone step. False when there is none or it failed (then it stays to redo, see onError). */
  redo(): boolean {
    this.open = null;
    const c = this.undone[this.undone.length - 1];
    if (!c) return false;
    try { c.apply(); } catch (err) { this.onError(err, c, true); return false; }
    this.undone.pop();
    this.done.push(c);
    this.onChange();
    return true;
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }

  clear(): void { this.done.length = 0; this.undone.length = 0; this.open = null; this.onChange(); }
}
