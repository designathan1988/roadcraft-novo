// What the page draws of each traffic light: the shared signals buffer (one byte per node). A light run actuated near
// the camera follows its queues and is written every step (the window is bounded by the camera); a timed light is a
// function of time and is written only when its cycle changes sub-phase, from a min-heap ordered by that time. Nothing
// walks every light of the map each step (D55: updateSignals wrote every signalled node every step). The sets of lights
// stay Traffic's (read through the host); the heap is this module's.

import type { SimNet } from '../lanes.ts';
import type { Signals } from '../signals.ts';

/** Seconds a scheduled write comes before the computed change (the cycle's float sums may put it a hair later). */
const EARLY = 1e-6;

export interface LightHost {
  readonly sim: SimNet;
  readonly sig: Signals;
  readonly signals: Uint8Array | null;
  /** The lights near the camera (run actuated). */
  readonly windowSignals: ReadonlySet<number>;
  /** Node n has no light any more (gone, or its plan has none): Traffic forgets it. */
  dropLight(n: number): void;
}

export class LightBoard {
  private readonly h: LightHost;
  /** Min-heap of (time, node), and each node's index in it (−1: not scheduled). */
  private heapT = new Float64Array(256);
  private heapN = new Int32Array(256);
  private size = 0;
  private pos = new Int32Array(0);

  constructor(host: LightHost) { this.h = host; }

  /** A light's plan changed, its node changed, or it left the window: written at the next step and scheduled from there. */
  touch(n: number): void { this.schedule(n, -Infinity); }

  /** A light's state as written for the drawing: 128 | amber << 6 | arms with green or amber (0: no light). */
  state(n: number): number {
    const sig = this.h.sig;
    if (this.h.sim.nodePhases[n] === 0) return 0;
    const st = sig.state(n), mask = (st & 3) < 2 ? sig.arms[n * 8 + (st >> 2)] : 0;
    return 128 | ((st & 3) === 1 ? 64 : 0) | (mask & 63);
  }

  /** After the lights stepped: the window's lights, and the timed ones whose sub-phase changed by now. */
  step(): void {
    const h = this.h, out = h.signals, sim = h.sim, t = h.sig.time;
    if (out) for (const n of h.windowSignals) if (n < out.length) out[n] = this.state(n);
    while (this.size > 0 && this.heapT[0] <= t) {
      const n = this.heapN[0];
      this.removeAt(0);
      if (!sim.net.nodes.alive[n] || sim.nodePhases[n] === 0) {
        if (out && n < out.length) out[n] = 0;
        h.dropLight(n);
        continue;
      }
      if (out && n < out.length) out[n] = this.state(n);
      const next = h.sig.nextChange(n, t);
      if (next < Infinity) this.schedule(n, Math.max(t, next - EARLY));
    }
  }

  private schedule(n: number, time: number): void {
    if (n >= this.pos.length) {
      const p = new Int32Array(Math.max(n + 1, this.pos.length * 2, 1024)).fill(-1);
      p.set(this.pos); this.pos = p;
    }
    let i = this.pos[n];
    if (i < 0) {
      if (this.size === this.heapT.length) {
        const t = new Float64Array(this.size * 2), m = new Int32Array(this.size * 2);
        t.set(this.heapT); m.set(this.heapN); this.heapT = t; this.heapN = m;
      }
      i = this.size++;
      this.heapN[i] = n; this.pos[n] = i;
    }
    this.heapT[i] = time;
    this.siftUp(this.siftDown(i));
  }

  private removeAt(i: number): void {
    const n = this.heapN[i];
    this.pos[n] = -1;
    const last = --this.size;
    if (i === last) return;
    this.heapT[i] = this.heapT[last]; this.heapN[i] = this.heapN[last]; this.pos[this.heapN[i]] = i;
    this.siftUp(this.siftDown(i));
  }

  private siftUp(i: number): number {
    const T = this.heapT;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (T[p] <= T[i]) break;
      this.swap(i, p);
      i = p;
    }
    return i;
  }

  private siftDown(i: number): number {
    const T = this.heapT;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.size && T[l] < T[m]) m = l;
      if (r < this.size && T[r] < T[m]) m = r;
      if (m === i) return i;
      this.swap(i, m);
      i = m;
    }
  }

  private swap(a: number, b: number): void {
    const T = this.heapT, N = this.heapN;
    const t = T[a]; T[a] = T[b]; T[b] = t;
    const n = N[a]; N[a] = N[b]; N[b] = n;
    this.pos[N[a]] = a; this.pos[N[b]] = b;
  }
}
