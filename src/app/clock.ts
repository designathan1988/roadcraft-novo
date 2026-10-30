// The game clock's controls, one owner (audit §13.4, a region parallel to the lifecycle): paused or running at 1×, 2×
// or 4×. The simulation runs at the chosen speed; the time of day advances at the same speed unless it is held
// (a photo at a set hour, ?hour). Listeners hear every change (the simulation worker is told the speed it runs at).

export class Clock {
  private pausedNow = false;
  private sim = 1;
  private day = 1;
  private readonly listeners: Array<() => void> = [];

  get paused(): boolean { return this.pausedNow; }
  /** The chosen speed (1, 2, 4); paused keeps it. */
  get speed(): number { return this.sim; }
  /** Game hours per real minute of the time of day: the speed, or 0 when the hour is held. */
  get daySpeed(): number { return this.day; }
  /** The speed the simulation runs at now: 0 when paused. */
  get running(): number { return this.pausedNow ? 0 : this.sim; }

  onChange(fn: () => void): void { this.listeners.push(fn); }

  togglePause(): void { this.pausedNow = !this.pausedNow; this.changed(); }

  /** 0 pauses; 1, 2, 4 run at that speed (the time of day follows, unless held). */
  setSpeed(n: number): void {
    this.pausedNow = n === 0;
    if (n > 0) { this.sim = n; if (this.day > 0) this.day = n; }
    this.changed();
  }

  /** The time of day stops where it is (photos at a set hour); the simulation keeps its speed. */
  holdHour(): void { this.day = 0; }

  private changed(): void { for (const fn of this.listeners) fn(); }
}
