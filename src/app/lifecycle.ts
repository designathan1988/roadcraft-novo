// The game's lifecycle as one state machine (Nystrom, Game Programming Patterns, "State"; audit §13.4): one state at a
// time instead of busy / generating / saveBlocked / status flags that combined freely. Long operations start only from
// Ready (a new city or an opening also from Failed, and the first city while Loading) and end in Ready (back in Loading
// for the first city: Ready comes once the game settled), or in Failed when a rebuild of the world broke
// halfway: there the world may be half built, so saving and editing are refused until another city is made or opened.
// Changed since the last save is a counter (each command bumps it): a save clears it only if nothing changed meanwhile.

export type LifeState = 'loading' | 'ready' | 'generating' | 'opening' | 'saving' | 'importing' | 'exporting' | 'failed';
export type Operation = 'generating' | 'opening' | 'saving' | 'importing' | 'exporting';

/** Operations that rebuild the world: a failure leaves it half built. */
const REBUILDS: ReadonlySet<Operation> = new Set(['generating', 'opening']);
/** Operations that may replace a half-built world (Failed): rebuilding it, or bringing another save into the slot. */
const REPLACE: ReadonlySet<Operation> = new Set(['generating', 'opening', 'importing']);

export class Lifecycle {
  private current: LifeState = 'loading';
  /** Where the running operation returns: Loading for the first city, Ready otherwise. */
  private back: 'loading' | 'ready' = 'ready';
  private changes = 0;
  private savedAt = 0;
  private readonly listeners: Array<(s: LifeState) => void> = [];

  get state(): LifeState { return this.current; }
  /** An operation is running (no other may start). */
  get busy(): boolean { return this.current !== 'ready' && this.current !== 'failed' && this.current !== 'loading'; }
  /** The world may be edited and saved: ready, not half built. */
  get editable(): boolean { return this.current === 'ready'; }
  /**
   * The player may change the world: it is whole and not being rebuilt (a save or an export copies it at its start,
   * so editing goes on while they write). Refused while loading, generating, opening, importing and when Failed.
   */
  get worldEditable(): boolean { return this.current === 'ready' || this.current === 'saving' || this.current === 'exporting'; }
  /** The last rebuild of the world failed (saving is refused). */
  get failed(): boolean { return this.current === 'failed'; }

  onChange(fn: (s: LifeState) => void): void { this.listeners.push(fn); }

  /** Resolves once no operation runs (true), or after `ms` with one still running (false). */
  whenIdle(ms: number): Promise<boolean> {
    if (!this.busy) return Promise.resolve(true);
    return new Promise((resolve) => {
      const fn = (): void => { if (this.busy) return; clearTimeout(timer); this.off(fn); resolve(true); };
      const timer = setTimeout(() => { this.off(fn); resolve(false); }, ms);
      this.listeners.push(fn);
    });
  }

  private off(fn: (s: LifeState) => void): void { const k = this.listeners.indexOf(fn); if (k >= 0) this.listeners.splice(k, 1); }

  /** The first city is up (from Loading). */
  loaded(): void { if (this.current === 'loading') this.set('ready'); }
  /** The game could not start (from Loading). */
  loadFailed(): void { if (this.current === 'loading') this.set('failed'); }

  /** Starts an operation; false when another runs or the state refuses it (nothing changes then). */
  begin(op: Operation): boolean {
    const from = this.current;
    const ok = from === 'ready' || (from === 'failed' && REPLACE.has(op)) || (from === 'loading' && REBUILDS.has(op));
    if (ok) { this.back = from === 'loading' ? 'loading' : 'ready'; this.set(op); }
    return ok;
  }

  /** Ends the running operation `op`: Ready, or Failed when a rebuild broke (`err` not null). */
  end(op: Operation, err: unknown = null): void {
    if (this.current !== op) throw new Error(`lifecycle: end ${op} while ${this.current}`);
    this.set(err !== null && REBUILDS.has(op) ? 'failed' : this.back);
  }

  /** A change to the world (a command, a setting saved with the map). */
  changed(): void { this.changes++; }
  /** The change counter: a save reads it when it copies the world and passes it back to `saved`. */
  get serial(): number { return this.changes; }
  /** The save written from the world as it was at `serial`: unsaved only if something changed after the copy. */
  saved(serial: number): void { this.savedAt = Math.max(this.savedAt, serial); }
  /** A world just made or opened: nothing to save. */
  clean(): void { this.savedAt = this.changes; }
  get unsaved(): boolean { return this.changes > this.savedAt; }

  private set(s: LifeState): void { this.current = s; for (const fn of this.listeners) fn(s); }
}
