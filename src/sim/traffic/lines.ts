// Bus/train lines as the simulation sees them: the page's stops resolved to lanes, and the stop index the drawing
// reads by cell. Pure geometry; the vehicles, riders and waiting queues stay in Traffic.
import { MAP_HALF } from '../../config.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import { bez, bezD } from '../../roads/geometry.ts';
import { stopSpot } from '../../roads/kerb.ts';
import { laneCount, laneId, type SimNet } from '../lanes.ts';

export interface SimLine {
  id: number; color: number; buses: number;
  /** 0 bus, 1 train, 2 metro (rails). */
  mode: number;
  stopLane: number[]; stopV: number[]; waiting: number[]; lastT: number[];
  /** Who is waiting at each stop, by destination stop (real people and background demand). */
  waitTo: Float64Array[];
  /** Of those, the people who walked to the stop (pedestrians: they step off as pedestrians again). */
  realTo: Float64Array[];
  /** Stop position on the sidewalk (to draw those waiting). */
  stopX: number[]; stopZ: number[]; stopY: number[]; stopYaw: number[];
  /** Boardings since the last report, and the hourly average. */
  boardings: number; perHour: number;
  /** Terminal stops (resolved index): long dwell. */
  term: Set<number>;
}

/** Line received from the page: stops as (x, z) points on the sidewalk. */
export interface LineSpec {
  id: number; color: number; buses: number; stops: number[]; mode?: number; /** indices of the stops that are terminals */ term?: number[];
  /** Bus line that runs as a ring (last stop → first). Otherwise (Roadcraft) it runs out and back: the return trip
   *  stops on the other side of the street, and both ends are terminals. Trains always follow their stations in order. */
  loop?: boolean;
}

/** Cell of the stop index (m) and cells per side of the map. */
export const STOP_CELL = 600, STOP_CELLS = Math.ceil(2 * MAP_HALF / STOP_CELL);

/** A line from the page with its stops resolved to lanes. */
export function resolveLine(sp: LineSpec, sim: SimNet, time: number): SimLine {
  const net = sim.net, sc = net.segs.cols;
  const rail = (sp.mode ?? 0) > 0;
  const ln: SimLine = { id: sp.id, color: sp.color, buses: sp.buses, mode: sp.mode ?? 0, stopLane: [], stopV: [], waiting: [], lastT: [],
    stopX: [], stopZ: [], stopY: [], stopYaw: [], waitTo: [], realTo: [], boardings: 0, perHour: 0, term: new Set<number>() };
  /** One stop at (x, z); `flip`: the stop of the return trip, across the street. False if no road there. */
  const addStop = (x: number, z: number, i: number, flip: boolean): boolean => {
    // bus: nearest ordinary road; train and metro: nearest rail
    const hit = net.nearestSeg(x, z, 40, (sg) => PROFILE_INFO[sc.profile[sg]].rail === rail);
    if (!hit) return false;
    const [seg, t] = hit;
    const q = net.quad(seg);
    const pp = new Float64Array(2), dd = new Float64Array(2);
    bez(q, t, pp); bezD(q, t, dd);
    // return trip: the same stop mirrored across the street's centre line
    if (flip) { x = 2 * pp[0] - x; z = 2 * pp[1] - z; }
    // side: u+ (left of a→b) is the sidewalk of those driving from b to a
    const u = (x - pp[0]) * dd[1] - (z - pp[1]) * dd[0];
    let dir = u > 0 ? -1 : 1;
    if (rail) {
      // station: the line heads to the next station on the track of its direction
      const ni = (i + 2) % sp.stops.length, nx = sp.stops[ni] - x, nz = sp.stops[ni + 1] - z;
      dir = nx * dd[0] + nz * dd[1] >= 0 ? 1 : -1;
    }
    if (laneCount(sc.profile[seg], dir) === 0) dir = -dir;
    if (laneCount(sc.profile[seg], dir) === 0) return false;
    const lane = laneId(seg, dir, 0);
    const L = sim.laneLen(lane);
    const along = sim.sAlong(seg, t);
    const v = dir > 0 ? along - sim.segS0(seg) : sim.segS1(seg) - along;
    if (sp.term?.includes(i / 2)) ln.term.add(ln.stopLane.length);
    ln.stopLane.push(lane);
    ln.stopV.push(Math.max(Math.min(8, L * 0.4), Math.min(L - 14, v)));
    ln.waiting.push(0); ln.lastT.push(time);
    const lp = new Float64Array(4);
    sim.lanePoint(lane, ln.stopV[ln.stopV.length - 1], lp);
    // the people wait on the sidewalk on the stop's side (where the shelter is drawn, `stopSpot`), not where the
    // click landed: on the carriageway the riders walked out into the road to wait there
    const spot = new Float64Array(3);
    if (rail) { spot[0] = x; spot[1] = z; } else stopSpot(q, sc.profile[seg], t, x, z, spot);
    ln.stopX.push(spot[0]); ln.stopZ.push(spot[1]); ln.stopY.push(lp[1] + 0.15);
    ln.stopYaw.push(Math.atan2(lp[0] - spot[0], lp[2] - spot[1])); // facing the road
    return true;
  };
  const kept: number[] = [];
  for (let i = 0; i + 1 < sp.stops.length; i += 2) if (addStop(sp.stops[i], sp.stops[i + 1], i, false)) kept.push(i);
  // Roadcraft bus lines go out and back: the stops of the return trip on the other side, the two ends terminals
  if (!rail && !sp.loop && kept.length >= 2) {
    ln.term.add(0); ln.term.add(ln.stopLane.length - 1);
    for (let k = kept.length - 2; k >= 1; k--) addStop(sp.stops[kept[k]], sp.stops[kept[k] + 1], kept[k], true);
  }
  ln.waitTo = ln.stopLane.map(() => new Float64Array(ln.stopLane.length));
  ln.realTo = ln.stopLane.map(() => new Float64Array(ln.stopLane.length));
  return ln;
}

/** Sorts every stop into its cell (when the lines change), so the drawing reads only the cells near the camera. */
export function indexStops(lines: readonly SimLine[], start: Int32Array): { line: Int32Array; idx: Int32Array } {
  const cellOf = (x: number, z: number) => {
    const i = Math.min(STOP_CELLS - 1, Math.max(0, Math.floor((x + MAP_HALF) / STOP_CELL)));
    const j = Math.min(STOP_CELLS - 1, Math.max(0, Math.floor((z + MAP_HALF) / STOP_CELL)));
    return j * STOP_CELLS + i;
  };
  let n = 0;
  for (const ln of lines) n += ln.stopX.length;
  start.fill(0);
  const line = new Int32Array(n), idx = new Int32Array(n);
  lines.forEach((ln) => { for (let i = 0; i < ln.stopX.length; i++) start[cellOf(ln.stopX[i], ln.stopZ[i]) + 1]++; });
  for (let c = 0; c < STOP_CELLS * STOP_CELLS; c++) start[c + 1] += start[c];
  const fill = start.slice(0, STOP_CELLS * STOP_CELLS);
  lines.forEach((ln, li) => { for (let i = 0; i < ln.stopX.length; i++) { const k = fill[cellOf(ln.stopX[i], ln.stopZ[i])]++; line[k] = li; idx[k] = i; } });
  return { line, idx };
}
