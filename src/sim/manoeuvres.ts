// Vehicle manoeuvres in the micro window near the camera (Roadcraft parking and loading docks): a Reeds-Shepp
// path from where the vehicle is to where it goes (the bay beside the kerb, the warehouse dock, back to the lane),
// driven at manoeuvring speed with a pause at each gear change. Only vehicles near the camera manoeuvre, and at
// most PLAN_BUDGET paths are planned per simulation step; the rest fall back to the plain behaviour. One small
// SoA table holds the active manoeuvres (dozens at most), so a step costs the manoeuvres alive, never the fleet.

import { Table } from '../core/table.ts';
import { planRS, poseAlong, type RSPath } from './reedsShepp.ts';

/** Paths planned per simulation step (each a few dozen trigonometric calls). */
export const PLAN_BUDGET = 4;
/** Only vehicles this close to the camera manoeuvre (m); farther away nobody sees it. */
export const MANOEUVRE_RADIUS = 350;
/** Manoeuvring speeds (m/s) and the pause at a gear change (s). */
const FWD_SPEED = 2.4, REV_SPEED = 1.4, GEAR_PAUSE = 0.8;

export const MKind = { Park: 1, Unpark: 2, Dock: 3 } as const;

const schema = {
  veh: Int32Array, kind: Uint8Array,
  ax: Float32Array, az: Float32Array, ayaw: Float32Array, y: Float32Array, r: Float32Array,
  k0: Int8Array, k1: Int8Array, k2: Int8Array, l0: Float32Array, l1: Float32Array, l2: Float32Array,
  total: Float32Array, d: Float32Array, pause: Float32Array, gear: Int8Array,
};

export class Manoeuvres {
  readonly t = new Table(schema, 64);
  /** Plans left in this step. */
  budget = PLAN_BUDGET;
  /** Paths planned and refused (no path) since the start, for the measurements. */
  planned = 0;
  refused = 0;
  private tmp = new Float64Array(4);

  /** Starts a new step: the planning budget refills. */
  beginStep(): void { this.budget = PLAN_BUDGET; }

  /** Plans a manoeuvre from pose a to pose b (vehicle centre, yaw as the poses) and returns its id, or −1. */
  start(veh: number, kind: number, ax: number, az: number, ayaw: number, bx: number, bz: number, byaw: number, y: number, r: number, maxReverse: number): number {
    if (this.budget <= 0) return -1;
    this.budget--;
    const p = planRS(ax, az, ayaw, bx, bz, byaw, r, maxReverse);
    if (!p || p.total > 60) { this.refused++; return -1; }
    this.planned++;
    const m = this.t.alloc(), c = this.t.cols;
    c.veh[m] = veh; c.kind[m] = kind;
    c.ax[m] = ax; c.az[m] = az; c.ayaw[m] = ayaw; c.y[m] = y; c.r[m] = r;
    c.k0[m] = p.kinds[0]; c.k1[m] = p.kinds[1]; c.k2[m] = p.kinds[2];
    c.l0[m] = p.lens[0]; c.l1[m] = p.lens[1]; c.l2[m] = p.lens[2];
    c.total[m] = p.total; c.d[m] = 0; c.pause[m] = 0;
    c.gear[m] = this.gearAt(m, 0);
    return m;
  }

  private path(m: number): RSPath {
    const c = this.t.cols;
    return { kinds: [c.k0[m], c.k1[m], c.k2[m]], lens: [c.l0[m], c.l1[m], c.l2[m]], total: c.total[m] };
  }

  /** Gear (1 forward, −1 reverse) at distance d along the manoeuvre. */
  gearAt(m: number, d: number): number {
    const c = this.t.cols, lens = [c.l0[m], c.l1[m], c.l2[m]];
    let at = 0;
    for (const l of lens) { if (Math.abs(l) < 1e-6) continue; at += Math.abs(l); if (d < at - 1e-6) return l < 0 ? -1 : 1; }
    for (let i = 2; i >= 0; i--) if (Math.abs(lens[i]) > 1e-6) return lens[i] < 0 ? -1 : 1;
    return 1;
  }

  /** Advances one manoeuvre; true when it reached its end. */
  advance(m: number, dt: number): boolean {
    const c = this.t.cols;
    if (c.pause[m] > 0) { c.pause[m] -= dt; return false; }
    const g = c.gear[m];
    c.d[m] = Math.min(c.total[m], c.d[m] + (g < 0 ? REV_SPEED : FWD_SPEED) * dt);
    const ng = this.gearAt(m, c.d[m]);
    if (ng !== g) { c.gear[m] = ng; c.pause[m] = GEAR_PAUSE; }
    return c.d[m] >= c.total[m] - 1e-4;
  }

  /** Pose of the vehicle centre on the manoeuvre: [x, z, yaw, gear] into out. */
  pose(m: number, out: Float64Array): void {
    const c = this.t.cols;
    poseAlong(this.path(m), c.r[m], c.ax[m], c.az[m], c.ayaw[m], c.d[m], this.tmp);
    out[0] = this.tmp[0]; out[1] = this.tmp[1]; out[2] = this.tmp[2]; out[3] = c.gear[m];
  }

  /** Still moving (not paused at a gear change and not at the end). */
  moving(m: number): boolean { const c = this.t.cols; return c.pause[m] <= 0 && c.d[m] < c.total[m] - 1e-4; }

  end(m: number): void { this.t.release(m); }

  clear(): void { this.t.clear(); }
}
