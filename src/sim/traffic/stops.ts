// Bus stops: the cell index the drawing reads near the camera, the people waiting at stops, and the line figures.
// Owns only the stop index and its scratch map; lines and bus sets arrive by parameter.

import { MAP_HALF } from '../../config.ts';
import { STOP_CELL, STOP_CELLS, indexStops as buildStopIndex, type SimLine } from './lines.ts';

/** People arriving per second at each stop (background demand). */
export const WAIT_RATE = 1 / 9;

export class Stops {
  private start = new Int32Array(STOP_CELLS * STOP_CELLS + 1);
  private line: Int32Array = new Int32Array(0);
  private idx: Int32Array = new Int32Array(0);
  private placed = new Map<number, number>();

  /** Sorts every stop into its cell (when the lines change), so the drawing reads only the cells near the camera. */
  index(lines: SimLine[]): void {
    const r = buildStopIndex(lines, this.start);
    this.line = r.line; this.idx = r.idx;
  }

  /** Those waiting at stops near the camera (standing people, up to 14 per stop). */
  write(lines: SimLine[], camX: number, camZ: number, time: number, data: Float32Array, stride: number, start: number, max: number): number {
    let n = 0;
    // only the cells within 600 m of the camera (the stop index), never every stop of every line
    const i0 = Math.max(0, Math.floor((camX - 600 + MAP_HALF) / STOP_CELL)), i1 = Math.min(STOP_CELLS - 1, Math.floor((camX + 600 + MAP_HALF) / STOP_CELL));
    const j0 = Math.max(0, Math.floor((camZ - 600 + MAP_HALF) / STOP_CELL)), j1 = Math.min(STOP_CELLS - 1, Math.floor((camZ + 600 + MAP_HALF) / STOP_CELL));
    // the stops of several lines at one place share it: each person gets the next free place there
    const placed = this.placed;
    placed.clear();
    for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
      const cell = cj * STOP_CELLS + ci;
      for (let e = this.start[cell]; e < this.start[cell + 1]; e++) {
        const ln = lines[this.line[e]], i = this.idx[e];
        const x = ln.stopX[i], z = ln.stopZ[i];
        if (Math.abs(x - camX) > 600 || Math.abs(z - camZ) > 600) continue;
        const w = Math.min(14, Math.floor(Math.min(120, ln.waiting[i] + (time - ln.lastT[i]) * WAIT_RATE)));
        const yaw = ln.stopYaw[i];
        const ax = Math.cos(yaw), az = -Math.sin(yaw); // along the sidewalk
        const spot = Math.round(x / 3) * 100003 + Math.round(z / 3);
        const first = placed.get(spot) ?? 0;
        placed.set(spot, first + w);
        for (let k = 0; k < w && start + n < max; k++) {
          const h = ((i * 7 + k * 13 + ln.id * 31) % 97) / 97;
          // places in three rows, 0.8 m apart along the kerb, spreading out both ways from the stop's sign
          const j = first + k, col = Math.floor(j / 3), row = j % 3;
          const along = (col % 2 ? -1 : 1) * Math.ceil(col / 2) * 0.8 + (h - 0.5) * 0.12;
          const back = -0.6 + row * 0.7;
          const px = x + ax * along + Math.sin(yaw) * back, pz = z + az * along + Math.cos(yaw) * back;
          const o = (start + n) * stride;
          const fy = yaw + (h - 0.5) * 0.9;
          data[o] = px; data[o + 1] = ln.stopY[i]; data[o + 2] = pz; data[o + 3] = fy;
          data[o + 4] = px; data[o + 5] = ln.stopY[i]; data[o + 6] = pz; data[o + 7] = fy;
          data[o + 8] = 3 * 256 + ((k * 5 + i) % 16);
          data[o + 9] = 1;
          data[o + 10] = (Math.imul(ln.id * 131 + i * 31 + k, 2654435761) >>> 16) & 0xffff;
          n++;
        }
      }
    }
    return n;
  }

  /** Line figures for the interface (passengers per hour). */
  stats(lines: SimLine[], busSets: Array<Set<number>>, time: number, dtReport: number): Array<{ id: number; buses: number; perHour: number; waiting: number }> {
    return lines.map((ln, i) => {
      const have = busSets[i].size;
      // per simulated hour (paused: nothing to measure, the figure stays)
      if (dtReport > 0) {
        const rate = ln.boardings / dtReport * 3600;
        ln.perHour = ln.perHour === 0 ? rate : ln.perHour * 0.9 + rate * 0.1;
        ln.boardings = 0;
      }
      let w = 0;
      for (let k = 0; k < ln.waiting.length; k++) w += Math.min(120, ln.waiting[k] + (time - ln.lastT[k]) * WAIT_RATE);
      return { id: ln.id, buses: have, perHour: Math.round(ln.perHour), waiting: Math.round(w) };
    });
  }
}
