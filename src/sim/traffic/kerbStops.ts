// Drop-offs at the kerb: some cars (4 in 10, by vehicle and destination) are taking someone somewhere; near the
// camera they stop at the kerb with the hazard lights on, the passenger gets out onto the sidewalk and the car goes on
// to another trip; far away the trip simply ends there. The vehicle table and the counters stay with Traffic.

import { laneDir, laneIdx, laneSeg, type SimNet } from '../lanes.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import { End, VehPhase, type VehAccess } from './state.ts';

/** The vehicle columns the drop-offs write (every other column they only read). */
export type KerbWrites = 'phase' | 'dwell' | 'served' | 's' | 'v' | 'brk' | 'pk' | 'why' | 'dest';

/** What the drop-offs need from Traffic; every field is the owner's state, not a copy. */
export interface KerbHost {
  readonly sim: SimNet;
  readonly cols: VehAccess<KerbWrites>;
  /** Centre pose of a vehicle whose front is at s on the lane, moved du metres to the driver's left: [x, y, z, yaw]. */
  centrePose(lane: number, s: number, len: number, du: number, out: Float64Array): void;
  /** A node for the next trip's destination (by the zones), or -1. */
  nextDestination(): number;
  replanFrom(v: number, node: number): void;
  /** A drop-off trip ended: counted as arrived and as a kerb stop. */
  countTrip(): void;
  /** The passenger stepped out at (x, z). */
  dropOff(x: number, z: number): void;
}

export class KerbStops {
  private h: KerbHost;
  private readonly pose = new Float64Array(4);

  constructor(host: KerbHost) { this.h = host; }

  /** A car whose trip is dropping someone off: the same rule near and far. */
  dropsOff(v: number): boolean {
    const c = this.h.cols;
    return c.kind[v] === 0 && c.line[v] < 0 && ((Math.imul(v * 31 + c.dest[v], 2654435761) >>> 0) % 10) < 4;
  }

  /** The drop-off trip ends (counted) and the car starts another from `node`; false if there is nowhere to go. */
  endTrip(v: number, node: number): boolean {
    const c = this.h.cols;
    const b = this.h.nextDestination();
    if (b < 0 || b === node) return false;
    this.h.countTrip();
    c.dest[v] = b;
    this.h.replanFrom(v, node);
    return !c.phase[v];
  }

  /** Stops at the kerb of `lane` if this car drops someone off there; false if it does not. */
  tryStop(v: number, lane: number): boolean {
    const c = this.h.cols;
    if (laneIdx(lane) !== 0 || !this.dropsOff(v)) return false;
    if (!PROFILE_INFO[this.h.sim.net.segs.cols.profile[laneSeg(lane)]].walk) return false;
    c.phase[v] = VehPhase.KerbStop; c.dwell[v] = 0; c.served[v] = 0;
    return true;
  }

  /** At the kerb: brake, edge to the kerb, let the passenger out, then pick a new trip and pull out. */
  step(v: number, lane: number, dt: number): void {
    const c = this.h.cols, sim = this.h.sim;
    // brakes gently, harder if the car ahead is close (it stops behind it, never inside it)
    const lead = c.prev[v];
    const room = lead >= 0 ? c.s[lead] - c.len[lead] - c.s[v] - 1 : 1e9;
    const brake = Math.min(9, Math.max(3, (c.v[v] * c.v[v]) / (2 * Math.max(0.1, room))));
    const nv = Math.max(0, c.v[v] - brake * dt);
    let s = Math.min(sim.laneLen(lane) - 0.3, c.s[v] + (c.v[v] + nv) * 0.5 * dt);
    if (lead >= 0) s = Math.min(s, Math.max(c.s[v], c.s[lead] - c.len[lead] - 0.5));
    c.s[v] = s;
    c.v[v] = nv; c.brk[v] = 1;
    c.pk[v] = Math.min(1, c.pk[v] + dt / 2);
    if (nv > 0) return;
    c.dwell[v] += dt;
    if (c.dwell[v] > 1.5 && !c.served[v]) {
      c.served[v] = 1;
      const p = this.pose;
      // the door side: the middle of the sidewalk on the right
      const info = PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(lane)]], dir = laneDir(lane);
      const wu = dir > 0 ? info.walkRight : info.walkLeft;
      this.h.centrePose(lane, c.s[v], c.len[v], Number.isNaN(wu) ? -3 : (wu - sim.laneU(lane)) * dir, p);
      this.h.dropOff(p[0], p[2]);
    }
    if (c.dwell[v] > 6) {
      // the passenger is out: that trip ended; the car pulls out on another (the bay-leaving slide takes it back)
      c.phase[v] = VehPhase.Driving; c.served[v] = 0; c.dwell[v] = 1.3;
      if (!this.endTrip(v, sim.laneTo(lane))) { this.h.countTrip(); c.why[v] = End.NoTrip; c.phase[v] = VehPhase.Leaving; }
    }
  }
}
