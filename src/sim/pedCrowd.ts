// The walkers near the camera seeing each other and the vehicles, as Roadcraft 4.0's walkers (sim/agents/walk.ts,
// SUMO's striping): the stripes across the sidewalk, the gap and its headway, stepping aside, overtaking, the jam. The
// people table and the routes stay with Peds (src/sim/peds.ts), read through PedCrowdHost; the near grid, the others
// a walker sees and the vehicles near the camera are this module's own.

import { PROFILE_INFO } from '../roads/profiles.ts';
import type { Table } from '../core/table.ts';
import type { SimNet } from './lanes.ts';
import { WAYS, type pedSchema } from './pedLayout.ts';

/**
 * Near the camera people walk as roadcraft 4.0's walkers (sim/agents/walk.ts, SUMO's striping): within NEAR_R m of it,
 * every step. Stripe width, body, shoulders, look ahead, the gap kept and its headway, acceleration and braking, the
 * stripe's hold and switch gain, the lateral penalty and share, the step aside and the jam: walk.ts:23-65.
 */
const NEAR_R = 160;
const STRIPE = 0.65, BODY_R = 0.27, SHOULDERS = 0.5, LOOK = 8, MOVING = 0.1, KEEP = 0.45, HEADWAY = 0.5;
const PED_ACCEL = 1.2, PED_BRAKE = 2.5, SWITCH_GAIN = 1.2, AIM_HOLD = 0.6, HELD_SWITCH = 0.5;
const LATERAL_PENALTY = 1 / STRIPE, LATERAL_SHARE = 0.4, SIDESTEP_RATE = 0.45;
const JAM_AFTER = 20, JAM_AFTER_CROSSING = 10, JAM_SHARE = 0.25, ONCOMING_CONFLICT = 50;
/** Closer than this (m, centre to centre) two walkers are one inside the other: they move apart across their ways. */
const CLOSE = 0.5;
/** Grid of the near walkers (`seeEachOther`): cell size (m, the look ahead, walk.ts:96) and hash slots. */
const NEAR_CELL = LOOK, NEAR_SLOTS = 1 << 14;

/** What the near walkers need from Peds; every field is the owner's state, not a copy. */
export interface PedCrowdHost {
  readonly t: Table<typeof pedSchema>;
  readonly sim: SimNet;
  readonly time: number;
  readonly camX: number;
  readonly camZ: number;
  /** Each node's first person (the window lists). */
  readonly head: Int32Array;
  readonly ways: Float32Array;
  posShown(p: number): number[];
  sideU(profile: number, side: number): [number, number];
  trackOff(p: number, profile: number, u: number): number;
}

export class PedCrowd {
  private h: PedCrowdHost;

  constructor(host: PedCrowdHost) { this.h = host; }

  // near walkers, gathered every step (reused arrays)
  private nearP = new Int32Array(4096);
  private nearX = new Float32Array(4096); private nearZ = new Float32Array(4096);
  private nearHx = new Float32Array(4096); private nearHz = new Float32Array(4096);
  private nearV = new Float32Array(4096);
  private nearNext = new Int32Array(4096);
  private nearHead = new Int32Array(NEAR_SLOTS).fill(-1);
  private nearKey = new Int32Array(NEAR_SLOTS);
  private nearNodes: number[] = [];
  // the others a walker sees (`seeEachOther`): along, across, coming the other way
  private othAlong = new Float32Array(512); private othLat = new Float32Array(512); private othOn = new Uint8Array(512);
  private othR = new Float32Array(512);
  // the vehicles near the camera (`setBodies`): x, z, yaw, half length, half width each; by cell
  private bodies: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private bodyN = 0;
  private bodyNext = new Int32Array(0);
  private bodyHead = new Int32Array(NEAR_SLOTS).fill(-1);
  private bodyKey = new Int32Array(NEAR_SLOTS);

  /** The vehicles near the camera this step (traffic `writeBodies`): solid to the walkers. */
  setBodies(b: Float32Array, n: number): void {
    this.bodies = b; this.bodyN = n;
    if (this.bodyNext.length < n) this.bodyNext = new Int32Array(Math.max(1024, n * 2));
  }

  private bodySlot(ix: number, iz: number): number {
    const key = (ix & 0xffff) | ((iz & 0xffff) << 16);
    let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
    while (this.bodyHead[h] >= 0 && this.bodyKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
    this.bodyKey[h] = key;
    return h;
  }

  private nearSlot(ix: number, iz: number): number {
    const key = (ix & 0xffff) | ((iz & 0xffff) << 16);
    let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
    while (this.nearHead[h] >= 0 && this.nearKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
    this.nearKey[h] = key;
    return h;
  }

  /**
   * People near the camera walk as roadcraft 4.0's walkers do (sim/agents/walk.ts `stepWalkers`, SUMO's striping
   * model), each step: the others within LOOK ahead in its own frame (how far along, how far across, coming the other
   * way or not, through a grid of cells: only who is near); the stripe across its way with the most room ahead, keeping
   * right (walk.ts:1736-1762); its speed the room ahead in that stripe less the gap kept, over the headway, eased by
   * its acceleration and braking (walk.ts:1837-1840); a step aside towards the stripe, faster the slower it walks
   * (walk.ts:1846-1858); held too long, it is let through slowly (walk.ts:1816-1836). Its progress along the stretch is
   * the event model's (\`t0\` moved later by what it did not walk, the end event with it); its place across is \`lat\`.
   */
  seeEachOther(dt: number): void {
    const c = this.h.t.cols, net = this.h.sim.net;
    // gather: walkers and those standing (obstacles too), with their shown position
    this.nearNodes.length = 0;
    // a person is in the list of the node it walks to, up to a street's length away
    const reach = NEAR_R + 150;
    net.nodeIndex.query(this.h.camX - reach, this.h.camZ - reach, this.h.camX + reach, this.h.camZ + reach, (n) => this.nearNodes.push(n));
    let n = 0;
    for (const node of this.nearNodes) {
      for (let p = this.h.head[node]; p >= 0; p = c.next[p]) {
        if (c.bike[p] || c.mode[p] === 4 || (c.mode[p] === 0 && !net.segs.alive[c.seg[p]])) continue;
        if (n >= this.nearP.length) this.growNear();
        const q = this.h.posShown(p);
        if (Math.abs(q[0] - this.h.camX) > NEAR_R || Math.abs(q[2] - this.h.camZ) > NEAR_R) continue;
        this.nearP[n] = p; this.nearX[n] = q[0]; this.nearZ[n] = q[2];
        this.nearHx[n] = Math.sin(q[3]); this.nearHz[n] = Math.cos(q[3]);
        this.nearV[n] = c.mode[p] === 0 || c.mode[p] === 1 ? c.vNow[p] : 0;
        n++;
      }
    }
    this.nearHead.fill(-1);
    for (let i = 0; i < n; i++) {
      const h = this.nearSlot(Math.floor(this.nearX[i] / NEAR_CELL), Math.floor(this.nearZ[i] / NEAR_CELL));
      this.nearNext[i] = this.nearHead[h]; this.nearHead[h] = i;
    }
    const oa = this.othAlong, ol = this.othLat, oo = this.othOn, or = this.othR;
    // the vehicles near, by cell (`setBodies`)
    this.bodyHead.fill(-1);
    for (let b = 0; b < this.bodyN; b++) {
      const h = this.bodySlot(Math.floor(this.bodies[b * 5] / NEAR_CELL), Math.floor(this.bodies[b * 5 + 1] / NEAR_CELL));
      this.bodyNext[b] = this.bodyHead[h]; this.bodyHead[h] = b;
    }
    for (let i = 0; i < n; i++) {
      const p = this.nearP[i], walking = c.mode[p] === 0 || c.mode[p] === 1;
      if (!walking) { c.vNow[p] = 0; c.hold[p] = 0; continue; }
      const xi = this.nearX[i], zi = this.nearZ[i], hx = this.nearHx[i], hz = this.nearHz[i], d = c.lat[p];
      // on the carriageway, crossing: those standing at the far kerb waiting for their own crossing step back for it
      // (roadcraft waits a step back from the kerb, walk.ts:75 KERB_BACK): it does not stop on the zebra for them
      const crossingNow = c.mode[p] === 1 && c.wIdx[p] > 0 && this.h.ways[p * WAYS * 4 + (c.wIdx[p] - 1) * 4 + 3] > 0;
      // the others in its frame (walk.ts:1470-1481): along its heading, and across (+ = right), as stripes see them
      let m = 0;
      const cx = Math.floor(xi / NEAR_CELL), cz = Math.floor(zi / NEAR_CELL), cells = Math.ceil(LOOK / NEAR_CELL);
      for (let gz = cz - cells; gz <= cz + cells; gz++) for (let gx = cx - cells; gx <= cx + cells; gx++) {
        const key = (gx & 0xffff) | ((gz & 0xffff) << 16);
        let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
        while (this.nearHead[h] >= 0 && this.nearKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
        for (let j = this.nearHead[h]; j >= 0; j = this.nearNext[j]) {
          if (j === i) continue;
          if (crossingNow && c.mode[this.nearP[j]] === 2) continue;
          const dx = this.nearX[j] - xi, dz = this.nearZ[j] - zi;
          const along = dx * hx + dz * hz;
          if (along <= 0 || along > LOOK) continue;
          if (m >= oa.length) break;
          // facing it and moving: coming the other way (walk.ts:1477-1478)
          const facing = hx * this.nearHx[j] + hz * this.nearHz[j] < -0.3;
          oa[m] = along; ol[m] = d + (-dx * hz + dz * hx); oo[m] = facing && this.nearV[j] > MOVING ? 1 : 0; or[m] = SHOULDERS - BODY_R;
          m++;
        }
      }
      // the vehicles: kept off as three discs along each body (walk.ts:111-119, 1705-1724)
      const bd = this.bodies;
      for (let gz = cz - 1; gz <= cz + 1; gz++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const key = (gx & 0xffff) | ((gz & 0xffff) << 16);
        let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
        while (this.bodyHead[h] >= 0 && this.bodyKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
        for (let b = this.bodyHead[h]; b >= 0; b = this.bodyNext[b]) {
          const o = b * 5, fx = Math.sin(bd[o + 2]), fz = Math.cos(bd[o + 2]), rad = bd[o + 4], reachB = Math.max(0, bd[o + 3] - rad);
          // inside its body already (it came to them): they walk on out of its way, not held inside it (walk.ts:1710-1713)
          let inside = false;
          for (let q = -1; q <= 1 && !inside; q++) if (Math.hypot(bd[o] + fx * reachB * q - xi, bd[o + 1] + fz * reachB * q - zi) < rad) inside = true;
          if (inside) continue;
          for (let q = -1; q <= 1 && m < oa.length; q++) {
            const rx = bd[o] + fx * reachB * q - xi, rz = bd[o + 1] + fz * reachB * q - zi;
            const along = rx * hx + rz * hz - rad + BODY_R;
            if (along + 2 * rad <= 0 || along > LOOK) continue;
            oa[m] = Math.max(0.01, along); ol[m] = d + (-rx * hz + rz * hx); oo[m] = 0; or[m] = rad;
            m++;
          }
        }
      }
      // free distance ahead in the stripe centred c (walk.ts:1484-1493): someone coming the other way meets it halfway
      const free = (cc: number): number => {
        let gap = LOOK;
        for (let k = 0; k < m; k++) {
          if (Math.abs(ol[k] - cc) >= BODY_R + or[k]) continue;
          const g = oo[k] ? oa[k] / 2 : oa[k];
          if (g < gap) gap = g;
        }
        return gap;
      };
      // the room across: the sidewalk's width on a sidewalk (its body inside it), a crosswalk's half elsewhere
      const [lo, hi] = this.latRoom(p);
      // the stripe (walk.ts:1736-1762): most room ahead, a metre less for each stripe away from where it is, kept to
      // the right (here + is right), a stripe just taken kept a moment
      const right = hi - Math.min(hi - lo, STRIPE * 0.5);
      const lateral = c.hold[p] === 0 && free(d) > 0.05 ? LATERAL_PENALTY : 0;
      const gain = c.hold[p] > HELD_SWITCH ? SWITCH_GAIN / 4 : SWITCH_GAIN;
      // somebody coming the other way in the leftmost stripe: that stripe is theirs (walk.ts:1741-1749, 1507-1509)
      const leftmost = lo + STRIPE, wide = hi - lo > STRIPE;
      let oncomingLeft = false;
      for (let k = 0; k < m && !oncomingLeft; k++) if (oo[k] && ol[k] - SHOULDERS < leftmost && ol[k] + SHOULDERS > lo) oncomingLeft = true;
      const reserve = (cc: number) => (oncomingLeft && wide && cc < leftmost - 1e-6 ? ONCOMING_CONFLICT : 0);
      let aim = Math.max(lo, Math.min(hi, c.latT[p]));
      let best = free(aim) - (right - aim) * 0.15 - Math.abs(aim - d) * lateral + gain - reserve(aim) / 2;
      for (let cc = lo; cc <= hi + 1e-6; cc += STRIPE / 2) {
        const score = free(cc) - (right - cc) * 0.15 - Math.abs(cc - d) * Math.max(lateral, 0.2) - reserve(cc);
        if (score > best) { best = score; aim = cc; }
      }
      if (Math.abs(aim - c.latT[p]) > 1e-6 && (this.h.time - c.aimAt[p] >= AIM_HOLD || free(c.latT[p]) < KEEP || c.hold[p] > HELD_SWITCH)) { c.latT[p] = aim; c.aimAt[p] = this.h.time; }
      // the speed (walk.ts:1816-1840): the room ahead in its stripe over the headway; held too long, through slowly
      const pace = c.speed[p];
      let want = pace;
      const jam = c.hold[p] > (c.mode[p] === 1 ? JAM_AFTER_CROSSING : JAM_AFTER);
      if (jam) want *= JAM_SHARE;
      else want = Math.min(want, Math.max(0, (free(d) - KEEP) / HEADWAY));
      const v0 = c.vNow[p];
      const v = want > v0 ? Math.min(want, v0 + PED_ACCEL * dt) : Math.max(want, v0 - PED_BRAKE * dt);
      c.vNow[p] = v;
      c.hold[p] = v < 0.1 ? c.hold[p] + dt : 0;
      // its stretch: it walked v of its pace (the start moves later by the rest of the step)
      c.t0[p] += dt * (1 - v / pace);
      c.pace[p] = v / pace;
      // across, towards its stripe: with the walk (0.4 of the speed, walk.ts:1349) and, slow, a step aside (walk.ts:1848)
      const aside = c.latT[p] - d;
      if (Math.abs(aside) > 0.02 && free(c.latT[p]) > KEEP) {
        const rate = LATERAL_SHARE * v + SIDESTEP_RATE * Math.max(0, 1 - v / (0.6 * pace));
        c.lat[p] = d + Math.max(-rate * dt, Math.min(rate * dt, aside));
      }
    }
    // two walkers closer than CLOSE (side by side at the end of a queue, one catching another at a corner) move apart
    // across their own ways, half each, at most 1.2 m/s (those standing do not move: the walker takes it all)
    for (let i = 0; i < n; i++) {
      const xi = this.nearX[i], zi = this.nearZ[i];
      const cx = Math.floor(xi / NEAR_CELL), cz = Math.floor(zi / NEAR_CELL);
      for (let gz = cz - 1; gz <= cz + 1; gz++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const key = (gx & 0xffff) | ((gz & 0xffff) << 16);
        let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
        while (this.nearHead[h] >= 0 && this.nearKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
        for (let j = this.nearHead[h]; j >= 0; j = this.nearNext[j]) {
          if (j <= i) continue;
          let dx = this.nearX[j] - xi, dz = this.nearZ[j] - zi;
          const d = Math.hypot(dx, dz);
          if (d >= CLOSE) continue;
          // on one spot: apart along the first one's right
          if (d < 1e-3) { dx = -this.nearHz[i]; dz = this.nearHx[i]; } else { dx /= d; dz /= d; }
          const pi = this.nearP[i], pj = this.nearP[j];
          const wi = c.mode[pi] === 0 || c.mode[pi] === 1, wj = c.mode[pj] === 0 || c.mode[pj] === 1;
          if (!wi && !wj) continue;
          const push = Math.min(CLOSE - d, 1.2 * dt) / (wi && wj ? 2 : 1);
          // i moves along −(dx, dz), j along +(dx, dz), each through its own right (−hz, hx)
          if (wi) this.nudge(pi, -(dx * -this.nearHz[i] + dz * this.nearHx[i]) * push);
          if (wj) this.nudge(pj, (dx * -this.nearHz[j] + dz * this.nearHx[j]) * push);
        }
      }
    }
  }

  /** Moves walker `p` `d` m to its right, within its sidewalk (on a sidewalk) or a metre either way (elsewhere). */
  private nudge(p: number, d: number): void {
    const c = this.h.t.cols;
    let lo = -1, hi = 1;
    if (c.mode[p] === 0) {
      const prof = this.h.sim.net.segs.cols.profile[c.seg[p]], [u] = this.h.sideU(prof, c.side[p]);
      let half = 1.5;
      for (const e of PROFILE_INFO[prof].edges) if (e.strip.kind === 'sidewalk' && u >= e.u0 && u <= e.u1) half = (e.u1 - e.u0) / 2;
      // the track is already this far right of the middle; the step aside keeps the body on the sidewalk
      const k = this.h.trackOff(p, prof, u), room = Math.max(0, half - 0.25);
      lo = -room - k; hi = room - k;
    }
    // (one still out of its room, just in from a crosswalk, is not put back at once: it moves from where it is)
    c.lat[p] = Math.max(Math.min(lo, c.lat[p]), Math.min(Math.max(hi, c.lat[p]), c.lat[p] + d));
    // it keeps that step aside while they are close (easing back to its track only once clear)
    c.latT[p] = c.lat[p];
  }


  /** The room across person \`p\`'s way for its body (+ = right of its track): the sidewalk, or ±0.9 m on a line. */
  latRoom(p: number): [number, number] {
    const c = this.h.t.cols;
    if (c.mode[p] !== 0) return [-0.9, 0.9];
    const prof = this.h.sim.net.segs.cols.profile[c.seg[p]], [u] = this.h.sideU(prof, c.side[p]);
    let half = 1.5;
    for (const e of PROFILE_INFO[prof].edges) if (e.strip.kind === 'sidewalk' && u >= e.u0 && u <= e.u1) half = (e.u1 - e.u0) / 2;
    // the track is already this far right of the middle
    const k = this.h.trackOff(p, prof, u), room = Math.max(0, half - BODY_R);
    return [-room - k, room - k];
  }

  private growNear(): void {
    const m = this.nearP.length * 2;
    const g = <T extends Int32Array | Float32Array>(a: T): T => { const b = new (a.constructor as { new(n: number): T })(m); b.set(a); return b; };
    this.nearP = g(this.nearP); this.nearX = g(this.nearX); this.nearZ = g(this.nearZ);
    this.nearHx = g(this.nearHx); this.nearHz = g(this.nearHz); this.nearV = g(this.nearV); this.nearNext = g(this.nearNext);
  }}
