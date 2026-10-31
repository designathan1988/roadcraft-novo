// The open stretches of a lot's edge: the samples along it that no boundary part or ground-floor wall covers.
// Values from Roadcraft 4.0 lotBoundaryRuns.ts; no test per sample against every part (binary searches per cover).
export type CoverBox =
  | { readonly kind: 'centre'; readonly cx: number; readonly cy: number; readonly hw: number; readonly hd: number }
  | { readonly kind: 'span'; readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number };

const FIRST = 0.3, STEP = 0.25;

function firstWhere(ts: readonly number[], holds: (t: number) => boolean): number {
  let lo = 0, hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (holds(ts[mid]!)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export function openRunsAlong(len: number, along: 'x' | 'y', fixed: number, boxes: readonly CoverBox[]): [number, number][] {
  const ts: number[] = [];
  for (let t = FIRST; t <= len - FIRST + 1e-6; t += STEP) ts.push(t);
  const n = ts.length;
  const cover = new Int32Array(n + 1);
  for (const b of boxes) {
    let first: number, end: number;
    if (b.kind === 'centre') {
      const [c, h, cAcross, hAcross] = along === 'x' ? [b.cx, b.hw, b.cy, b.hd] : [b.cy, b.hd, b.cx, b.hw];
      if (!(Math.abs(fixed - cAcross) <= hAcross)) continue;
      first = firstWhere(ts, (t) => t - c >= -h);
      end = firstWhere(ts, (t) => t - c > h);
    } else {
      const [lo, hi, loAcross, hiAcross] = along === 'x' ? [b.x0, b.x1, b.y0, b.y1] : [b.y0, b.y1, b.x0, b.x1];
      if (!(fixed >= loAcross && fixed <= hiAcross)) continue;
      first = firstWhere(ts, (t) => t >= lo);
      end = firstWhere(ts, (t) => t > hi);
    }
    if (first < end) { cover[first]!++; cover[end]!--; }
  }
  const runs: [number, number][] = [];
  let from = -1, depth = 0;
  for (let k = 0; k < n; k++) {
    const t = ts[k]!;
    depth += cover[k]!;
    const open = depth === 0;
    if (open && from < 0) from = t;
    if ((!open || t + STEP > len - FIRST) && from >= 0) {
      const to = open ? t : t - STEP;
      if (to - from >= 0.4) runs.push([Math.max(0, from - STEP), Math.min(len, to + STEP)]);
      from = -1;
    }
  }
  return runs;
}
