// Road paint rules of Roadcraft 4.0 (world/roads/markingStyle.ts and the layout rules of world/roads/markings.ts and
// parkingLayout.ts), as pure data and functions: the regional styles (centre colour, dashes by speed, legends), the
// stroked letters of PARE/STOP and ÔNIBUS/BUS, where a legend, a bus word, a mini-roundabout island and parking bays
// go along a road. Nothing here draws: the road shader (render/roads.ts) reads these numbers (lines are painted in the
// shader, never as quads with a material per colour). Lengths in metres, along the road (v) and across it (u).

/** The regional standard of road paint, chosen per map ('br': Brazil/CONTRAN). */
export type MarkingStyleId = 'classic' | 'br' | 'us' | 'eu';

export const PAINT_YELLOW = 0xe1c45a, PAINT_WHITE = 0xeee8d7;

export interface MarkingStyle {
  readonly id: MarkingStyleId;
  /** Colour of a line between opposing flows; null: the road class's own. */
  readonly centre: number | null;
  /** A broken line's dash and gap (m), by the road's speed. */
  dash(speedKmh: number): readonly [number, number];
  /** The word painted along a bus lane, and before a stop line. */
  readonly busText: string;
  readonly stopText: string;
  /** Height of a legend's letters along the road (m), by the road's speed. */
  legendHeight(speedKmh: number): number;
}

export function markingStyle(id: MarkingStyleId | undefined): MarkingStyle {
  const tall = (v: number) => (v > 80 ? 2.4 : 1.6);
  switch (id) {
    case 'br':
      return { id, centre: PAINT_YELLOW, busText: 'ÔNIBUS', stopText: 'PARE', dash: (v) => (v < 60 ? [3, 6] : v < 80 ? [3, 9] : [4, 12]), legendHeight: tall };
    case 'us':
      return { id, centre: PAINT_YELLOW, busText: 'BUS', stopText: 'STOP', dash: () => [3, 9], legendHeight: tall };
    case 'eu':
      return { id, centre: PAINT_WHITE, busText: 'BUS', stopText: 'STOP', dash: () => [3, 9], legendHeight: tall };
    default:
      return { id: 'classic', centre: null, busText: 'ÔNIBUS', stopText: 'PARE', dash: () => [3.2, 3.2], legendHeight: () => 1.6 };
  }
}

type Line = ReadonlyArray<readonly [number, number]>;

function ring(cx: number, cy: number, rx: number, ry: number): Array<[number, number]> {
  return Array.from({ length: 17 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as [number, number]; });
}

/** The letters of the legends, stroked: polylines in a box one unit wide (x across, y along the road, 0 at the foot). */
export const GLYPHS: Readonly<Record<string, readonly Line[]>> = {
  O: [ring(0.5, 0.41, 0.5, 0.41)],
  Ô: [ring(0.5, 0.36, 0.5, 0.36), [[0.15, 0.82], [0.5, 1], [0.85, 0.82]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  I: [[[0.5, 0], [0.5, 1]]],
  B: [[[0, 0], [0, 1], [0.7, 1], [0.9, 0.88], [0.9, 0.62], [0.7, 0.52], [0, 0.52]], [[0.7, 0.52], [0.95, 0.4], [0.95, 0.12], [0.75, 0], [0, 0]]],
  U: [[[0, 1], [0, 0.18], [0.18, 0], [0.82, 0], [1, 0.18], [1, 1]]],
  P: [[[0, 0], [0, 1], [0.75, 1], [1, 0.85], [1, 0.62], [0.75, 0.48], [0, 0.48]]],
  A: [[[0, 0], [0.5, 1], [1, 0]], [[0.22, 0.42], [0.78, 0.42]]],
  R: [[[0, 0], [0, 1], [0.75, 1], [1, 0.85], [1, 0.62], [0.75, 0.48], [0, 0.48]], [[0.5, 0.48], [1, 0]]],
  E: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0, 0.5], [0.8, 0.5]]],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  S: [[[1, 0.88], [0.85, 1], [0.15, 1], [0, 0.86], [0, 0.62], [0.15, 0.52], [0.85, 0.48], [1, 0.38], [1, 0.14], [0.85, 0], [0.15, 0], [0, 0.12]]],
};

/** The give-way triangle on the road (shark's tooth). */
export const YIELD_SYMBOL: { strokes: Line[]; width: number } = {
  strokes: [[[0.5, 0], [1, 1], [0, 1], [0.5, 0]], [[0.5, 0.3], [0.78, 0.9], [0.22, 0.9], [0.5, 0.3]]],
  width: 1,
};

/** A word's strokes, letters side by side `gap` letter widths apart, in letter units. */
export function wordStrokes(text: string, gap = 0.35): { strokes: Array<Array<[number, number]>>; width: number } {
  const strokes: Array<Array<[number, number]>> = [];
  let x = 0;
  for (const ch of text) {
    for (const line of GLYPHS[ch] ?? []) strokes.push(line.map(([gx, gy]) => [gx + x, gy] as [number, number]));
    x += 1 + gap;
  }
  return { strokes, width: Math.max(0, x - gap) };
}

/** Painted legend stroke width (m), and the gap between a legend and the stop line it announces. */
export const LEGEND_STROKE = 0.2, LEGEND_GAP = 1.5;

/**
 * A stop or give-way legend in one lane, as straight stroke pieces in metres: u across the lane from its centre,
 * v along the road measured back from the stop line (the foot of the letters nearest the junction). Null when the
 * approach is too short (the foot would be under 2 m from the segment's far end). `kind`: stop word or yield symbol.
 */
export function legendStrokes(style: MarkingStyle, kind: 'stop' | 'yield', laneWidth: number, speedKmh: number, stopAt: number):
  { pieces: Array<[number, number, number, number]>; foot: number; height: number } | null {
  const height = kind === 'stop' ? style.legendHeight(speedKmh) : 3;
  const foot = stopAt - LEGEND_GAP - height;
  if (foot < 2) return null;
  const word = kind === 'stop' ? wordStrokes(style.stopText) : YIELD_SYMBOL;
  const letterW = kind === 'stop' ? Math.min((laneWidth * 0.78) / word.width, height * 0.5) : Math.min(laneWidth * 0.55, 1.5);
  const total = word.width * letterW;
  const pieces: Array<[number, number, number, number]> = [];
  for (const line of word.strokes) for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1], [x1, y1] = line[i];
    // letters read from the driver's seat: x across from the lane's left, y up the road towards the junction
    pieces.push([x0 * letterW - total / 2, LEGEND_GAP + height * (1 - y0), x1 * letterW - total / 2, LEGEND_GAP + height * (1 - y1)]);
  }
  return { pieces, foot, height };
}

/** Where the bus-lane word goes along a stretch of `length` m: 12 m in from each end, then every 70 m. */
export function busWordStations(length: number): number[] {
  const out: number[] = [];
  for (let v = 12; v <= length - 12; v += 70) out.push(v);
  return out;
}

/** A mini-roundabout's painted island: radius from the nearest mouth (m), the ring's stroke, and the fill's rings. */
export function miniIsland(nearestMouth: number): { r: number; stroke: number; fill: number[] } {
  const r = Math.max(2, Math.min(4, nearestMouth * 0.4));
  const fill: number[] = [];
  for (let k = r - 0.22; k > 0.12; k -= 0.22) fill.push(k);
  return { r, stroke: 0.2, fill };
}

/** Parking bays (4.0 parkingLayout.ts): pitch along the kerb, depth, the dashes of the inner edge, clearances. */
export const PARKING = { pitch: 6, depth: 2, dash: 1, gap: 1, cornerClear: 5, crossingClear: 2, line: 0.12 } as const;

/**
 * Bay divisions along a parking strip from `from` to `to` m (after the clearances at the ends): as many 6 m bays as
 * fit, centred; returns the stations of the white cross lines (both ends and every division).
 */
export function parkingBays(from: number, to: number): number[] {
  const run = to - from, n = Math.floor(run / PARKING.pitch);
  if (n < 1) return [];
  const start = from + (run - n * PARKING.pitch) / 2;
  return Array.from({ length: n + 1 }, (_, i) => start + i * PARKING.pitch);
}
