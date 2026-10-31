// The open stretches of a lot's edge: sample points along it that no boundary part or ground-floor wall covers.
// The sample spacing and the run trimming are Roadcraft 4.0's lotBoundaryRuns.ts values; the method is not: a
// boolean sample row is marked by walking each cover's interval, then read once into runs.
export type CoverBox =
  | { readonly kind: 'centre'; readonly cx: number; readonly cy: number; readonly hw: number; readonly hd: number }
  | { readonly kind: 'span'; readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number };

const START = 0.3, STEP = 0.25, SLACK = 1e-6, MIN_RUN = 0.4;

/** Sample positions from START while the sample fits inside the edge (the same walk the 4.0 edge makes). */
function sampleRow(len: number): Float64Array {
  const count = Math.floor((len - 2 * START + SLACK) / STEP) + 1;
  const row = new Float64Array(Math.max(0, count));
  for (let i = 0; i < row.length; i++) row[i] = START + i * STEP;
  return row;
}

/** First index whose sample satisfies `holds`; `row.length` when none does (holds is false then true along the row). */
function firstTrue(row: Float64Array, holds: (t: number) => boolean): number {
  let i = 0;
  while (i < row.length && !holds(row[i]!)) i++;
  return i;
}

export function openRunsAlong(len: number, along: 'x' | 'y', fixed: number, boxes: readonly CoverBox[]): [number, number][] {
  const row = sampleRow(len);
  const covered = new Uint8Array(row.length);
  for (const box of boxes) {
    let from: number, to: number;
    if (box.kind === 'centre') {
      // Across the edge the box must reach the fixed coordinate; along it, the covered samples are |t - c| <= h.
      const alongC = along === 'x' ? box.cx : box.cy;
      const alongH = along === 'x' ? box.hw : box.hd;
      const acrossC = along === 'x' ? box.cy : box.cx;
      const acrossH = along === 'x' ? box.hd : box.hw;
      if (Math.abs(fixed - acrossC) > acrossH) continue;
      from = firstTrue(row, (t) => t >= alongC - alongH);
      to = firstTrue(row, (t) => t > alongC + alongH);
    } else {
      const lo = along === 'x' ? box.x0 : box.y0;
      const hi = along === 'x' ? box.x1 : box.y1;
      const loAcross = along === 'x' ? box.y0 : box.x0;
      const hiAcross = along === 'x' ? box.y1 : box.x1;
      if (fixed < loAcross || fixed > hiAcross) continue;
      from = firstTrue(row, (t) => t >= lo);
      to = firstTrue(row, (t) => t > hi);
    }
    for (let i = from; i < to; i++) covered[i] = 1;
  }
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < row.length; i++) {
    const t = row[i]!;
    if (!covered[i]) {
      if (start < 0) start = t;
      continue;
    }
    if (start >= 0) {
      const end = t - STEP;
      if (end - start >= MIN_RUN) runs.push([Math.max(0, start - STEP), Math.min(len, end + STEP)]);
      start = -1;
    }
  }
  if (start >= 0) {
    const end = row[row.length - 1]!;
    if (end - start >= MIN_RUN) runs.push([Math.max(0, start - STEP), Math.min(len, end + STEP)]);
  }
  return runs;
}
