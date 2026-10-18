// Building wear (Roadcraft `world/buildings/types.ts` decayOf and `decayWatch.ts`): a building is new for 5 days
// of grace after it was built, then runs down over 30 days to falling apart, in tenths. Renovating starts it over.
// The watch keeps each building's next tenth in a heap: a clock tick pops only what is due, never scans the town.

/** City minutes a building stays new after it is built or renovated: five days. */
export const DECAY_GRACE = 5 * 1440;
/** City minutes from the first stains to falling apart, without maintenance: thirty days. */
export const DECAY_SPAN = 30 * 1440;

/**
 * "Built" minute of a generated building (or one from a save without it): spread over one tenth of the ageing by a
 * hash of its seed, so the whole town does not pass each tenth in the same minute.
 */
export function generatedBuilt(seed: number): number {
  let h = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % (DECAY_SPAN / 10);
}

/** Tenths of decay (0..10) of a building built at `built`, at city minute `now`. */
export function decayTenths(built: number, now: number): number {
  if (!Number.isFinite(built) || !Number.isFinite(now)) return 0;
  return Math.round(Math.max(0, Math.min(1, (now - built - DECAY_GRACE) / DECAY_SPAN)) * 10);
}

/** The city minute at which a building built at `built` reaches its next tenth after `tenths` (Infinity at 10). */
export function nextTenthAt(built: number, tenths: number): number {
  if (tenths >= 10) return Infinity;
  // decayTenths rounds: the next tenth starts half a tenth before it
  return built + DECAY_GRACE + DECAY_SPAN * (tenths + 0.5) / 10;
}

/** Min-heap of (minute, id) in typed arrays; stale entries are skipped by the caller. */
export class MinuteHeap {
  key = new Float64Array(1024);
  val = new Int32Array(1024);
  size = 0;

  push(k: number, v: number): void {
    if (this.size >= this.key.length) {
      const nk = new Float64Array(this.key.length * 2); nk.set(this.key); this.key = nk;
      const nv = new Int32Array(this.val.length * 2); nv.set(this.val); this.val = nv;
    }
    let i = this.size++;
    const K = this.key, V = this.val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = k; V[i] = v;
  }

  get topKey(): number { return this.size ? this.key[0] : Infinity; }

  pop(): number {
    const K = this.key, V = this.val;
    const top = V[0];
    const n = --this.size;
    if (n > 0) {
      const k = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= k) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = k; V[i] = v;
    }
    return top;
  }

  clear(): void { this.size = 0; }
}
