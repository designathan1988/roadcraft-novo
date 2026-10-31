// Buildings that break for real, as Roadcraft 4.0's bomb breaks them (bomb/ANALISE.md): the first blow on a building
// has its ruin made off the page (worker.ts); from then on the ruin stands in for it (the cell layers stop drawing it)
// and every blow frees the fragments within its reach (1.4 + 0.55 × force m), thrown out at 2 + 1.1 × force m/s;
// whatever no longer stands on the ground through standing fragments falls; under 35 % of the fragments above the
// ground floor standing, the whole building comes down. A fragment that lands stays where it lies for good.
// All state is in fixed tables (MAX_RUINS ruins, MAX_FRAGMENTS fragments): a frame steps only the fragments in the air.

import * as THREE from 'three/webgpu';
import type { World } from '../../../world/world.ts';
import { heightAt } from '../../../world/heights.ts';
import { buildingTag } from '../../../jobs/buildingGen.ts';
import { HIDDEN, hiddenU } from '../../../render/inside.ts';
import { Puff } from '../../../render/particles.ts';
import { ATTACH, type RuinData } from './fracture.ts';
import { MAX_FRAGMENTS, MAX_RUINS, POSE_ROWS, RuinDraw } from './ruinMesh.ts';
import type { FromRuinWorker, ToRuinWorker } from './worker.ts';

const SLOT = MAX_FRAGMENTS / MAX_RUINS;
const GRAVITY = 9.8;
/** Share of the fragments above the ground floor left standing below which the rest comes down (4.0 COLLAPSE_BELOW). */
const COLLAPSE_BELOW = 0.35;
/** Above its floor by this much a fragment is above the ground floor (4.0: 0.6 m). */
const GROUND_STOREY = 0.6;
const STANDING = 0, FLYING = 1, LANDED = 2;

/** What happened to a building struck ('none': no room for one more ruin now, the blow is lost). */
export type Struck = 'pending' | 'hit' | 'down' | 'none';
/** Seconds a ruined building stays hidden from the cell layers by its tag: its cell is redrawn without it long before. */
const HIDE_FOR = 6;

interface Ruin {
  id: number;
  /** 0 free, 1 being made, 2 standing in for its building, 3 come down. */
  state: number;
  /** Order of its last use (the oldest free one is reused). */
  used: number;
  n: number;
  floor: number;
  start: Int32Array;
  neighbours: Int32Array;
  /** Blows that came before its fragments: x, y, z, force, direction x, y, z. */
  waiting: number[];
  /** Its attached instances: batch id and rest matrix, listed by fragment (byFrag[start[f]..start[f + 1]). */
  attachId: Int32Array;
  attachRest: Float32Array;
  attachStart: Int32Array;
  attachList: Int32Array;
  job: number;
}

export interface RuinHost {
  world: World;
  /** The building parts' unit models, built once by the props pool (render/props.ts). */
  partModels: Readonly<Record<string, THREE.BufferGeometry>>;
  /** Dust, smoke and fire at a point (Blast.emitAt). */
  emit(x: number, y: number, z: number, kind: number, strength: number, seconds: number): void;
  /** A fire that keeps burning at a point (Blast.burn). */
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  /** A building came down (all its fragments loose): the world change and its undo are the caller's. */
  down(id: number): void;
}

export class Ruins {
  readonly draw: RuinDraw;
  private host: RuinHost;
  private worker: Worker;
  private ruins: Ruin[] = [];
  private nextJob = 1;
  private clock = 0;
  // one row per fragment slot (global index = slot × SLOT + local)
  private mode = new Uint8Array(MAX_FRAGMENTS);
  private reach = new Float32Array(MAX_FRAGMENTS);
  private low = new Float32Array(MAX_FRAGMENTS);
  private vx = new Float32Array(MAX_FRAGMENTS); private vy = new Float32Array(MAX_FRAGMENTS); private vz = new Float32Array(MAX_FRAGMENTS);
  private wx = new Float32Array(MAX_FRAGMENTS); private wy = new Float32Array(MAX_FRAGMENTS); private wz = new Float32Array(MAX_FRAGMENTS);
  /** Fragments in the air (and those that landed this frame, for their last motion row). */
  private flying = new Int32Array(MAX_FRAGMENTS);
  private nFlying = 0;
  /** When each hidden-building slot (render/inside.ts) is free again (clock seconds; 0 free). */
  private hiddenUntil = new Float64Array(HIDDEN);
  private held = new Uint8Array(SLOT);
  private stack = new Int32Array(SLOT);
  private m = new THREE.Matrix4();
  private r = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(host: RuinHost) {
    this.draw = new RuinDraw(host.partModels);
    this.host = host;
    for (let k = 0; k < MAX_RUINS; k++) this.ruins.push(emptyRuin());
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'ruins' });
    this.worker.postMessage({ type: 'init', heights: host.world.heightsSab } satisfies ToRuinWorker);
    this.worker.onmessage = (e: MessageEvent<FromRuinWorker>) => this.made(e.data);
  }

  /** Whether anything is falling (the frame is drawn and the shadows redrawn while it is). */
  moving(): boolean { return this.nFlying > 0; }

  /**
   * A blow on building `id` at (x, y, z) with `force`, the eye looking along (dx, dy, dz): its ruin is made on the first
   * blow (the blow waits for it), then the blow frees what it reaches. 'down': it came down now.
   */
  strike(id: number, x: number, y: number, z: number, force: number, dx: number, dy: number, dz: number): Struck {
    let k = this.ruins.findIndex((r) => r.id === id && (r.state === 1 || r.state === 2));
    if (k < 0) {
      k = this.claim();
      if (k < 0) return 'none';
      const r = this.ruins[k];
      const w = this.host.world, col = w.buildings.cols;
      const boxes = w.gatherBoxes([col.cell[id]]);
      let index = -1;
      for (let i = 0; i < boxes.count && index < 0; i++) if (boxes.seed[i] === col.seed[id] && boxes.x[i] === col.x[id] && boxes.z[i] === col.z[id]) index = i;
      if (index < 0) return 'pending';
      r.id = id; r.state = 1; r.job = this.nextJob++; r.waiting.length = 0; r.used = this.clock;
      r.floor = heightAt(w.heights, col.x[id], col.z[id]);
      this.worker.postMessage({ type: 'ruin', id: r.job, boxes, index } satisfies ToRuinWorker);
    }
    const r = this.ruins[k];
    // dust where it was struck at once (white and grey, as 4.0's: the particles' steam), while its pieces are being made
    this.host.emit(x, y, z, Puff.Steam, Math.min(15, 3 + force * 0.4), 4);
    if (r.state === 1) { r.waiting.push(x, y, z, force, dx, dy, dz); return 'pending'; }
    return this.blow(k, x, y, z, force, dx, dy, dz) ? 'down' : 'hit';
  }

  /** Every ruin gone (a new city). */
  clear(): void { for (let k = 0; k < MAX_RUINS; k++) this.free(k); }

  /** The ruin of building `id` gone (its collapse undone: the building stands again). */
  forget(id: number): void {
    const k = this.ruins.findIndex((r) => r.id === id && r.state !== 0);
    if (k >= 0) this.free(k);
  }

  /** A slot for a new ruin: a free one, else the oldest that came down, else the oldest standing one. */
  private claim(): number {
    let best = -1;
    for (let pass = 0; pass < 3 && best < 0; pass++) {
      for (let k = 0; k < MAX_RUINS; k++) {
        const s = this.ruins[k].state;
        if ((pass === 0 && s === 0) || (pass === 1 && s === 3) || (pass === 2 && s === 2)) {
          if (best < 0 || this.ruins[k].used < this.ruins[best].used) best = k;
        }
      }
    }
    if (best >= 0) this.free(best);
    return best;
  }

  private free(k: number): void {
    const r = this.ruins[k];
    if (r.state === 0) return;
    if (r.state === 2) this.host.world.setRuined(r.id, false);
    for (let i = 0; i < r.attachId.length; i++) this.draw.removeAttached(r.attachId[i]);
    this.draw.hide(k);
    for (let i = this.nFlying - 1; i >= 0; i--) if (((this.flying[i] / SLOT) | 0) === k) this.flying[i] = this.flying[--this.nFlying];
    this.ruins[k] = emptyRuin();
  }

  /** A ruin made by the worker: it stands in for its building, and the blows that waited are dealt. */
  private made(msg: FromRuinWorker): void {
    const k = this.ruins.findIndex((r) => r.state === 1 && r.job === msg.id);
    if (k < 0) return;
    const r = this.ruins[k], data = msg.ruin;
    const w = this.host.world, col = w.buildings.cols;
    if (!data || !w.buildings.alive[r.id] || data.fragmentCount > SLOT) {
      if (msg.error) console.error(`[ruin] building ${r.id}: ${msg.error}`);
      // never silent: a ruin over the slot was dropped with no record (D28; the worker now cuts coarser to fit)
      if (data && data.fragmentCount > SLOT) console.error(`[ruin] building ${r.id}: ${data.fragmentCount} fragments > ${SLOT}, the ruin is dropped`);
      this.ruins[k] = emptyRuin();
      return;
    }
    r.state = 2; r.n = data.fragmentCount; r.start = data.start; r.neighbours = data.neighbours;
    const base = k * SLOT, P = this.draw.poses, F = data.fragments;
    for (let f = 0; f < r.n; f++) {
      const g = base + f, o = g * POSE_ROWS * 4;
      for (const row of [0, 1, 3]) { P[o + row * 4] = F[f * 5]; P[o + row * 4 + 1] = F[f * 5 + 1]; P[o + row * 4 + 2] = F[f * 5 + 2]; }
      P[o + 8] = P[o + 9] = P[o + 10] = 0; P[o + 11] = 1; P[o + 16] = P[o + 17] = P[o + 18] = 0; P[o + 19] = 1;
      this.reach[g] = F[f * 5 + 3]; this.low[g] = F[f * 5 + 4]; this.mode[g] = STANDING;
      this.draw.touched(g);
    }
    this.attach(r, data);
    this.draw.show(k, data);
    // the building is drawn by its ruin from this frame on: hidden now by its tag (the oldest hiding slot reused), its
    // cell drawn again without it in the meantime
    let h = 0;
    for (let i = 1; i < HIDDEN; i++) if (this.hiddenUntil[i] < this.hiddenUntil[h]) h = i;
    hiddenU.array[h].set(buildingTag(col.seed[r.id], col.x[r.id], col.z[r.id]), col.x[r.id], col.z[r.id], (Math.hypot(col.w[r.id], col.d[r.id]) / 2 + 2) ** 2);
    this.hiddenUntil[h] = this.clock + HIDE_FOR;
    w.setRuined(r.id, true);
    const waiting = r.waiting.splice(0);
    let down = false;
    for (let i = 0; i < waiting.length && !down; i += 7) down = this.blow(k, waiting[i], waiting[i + 1], waiting[i + 2], waiting[i + 3], waiting[i + 4], waiting[i + 5], waiting[i + 6]);
  }

  /** The ruin's parts and furniture as instances, each listed under its fragment. */
  private attach(r: Ruin, data: RuinData): void {
    const A = data.attached, n = A.length / ATTACH;
    r.attachId = new Int32Array(n); r.attachRest = new Float32Array(n * 16);
    const count = new Int32Array(r.n + 1);
    for (let i = 0; i < n; i++) {
      const o = i * ATTACH, kind = data.kinds[A[o]];
      r.attachId[i] = this.draw.addAttached(kind, A[o + 10]);
      // the pose's matrix: T(x, y, z) · turn (cos, sin about y) · S(sx, sy, sz) (jobs/building40.ts)
      const c = A[o + 5], s = A[o + 6], sx = A[o + 7], sy = A[o + 8], sz = A[o + 9];
      this.m.set(c * sx, 0, s * sz, A[o + 2], 0, sy, 0, A[o + 3], -s * sx, 0, c * sz, A[o + 4], 0, 0, 0, 1);
      this.m.toArray(r.attachRest, i * 16);
      this.draw.setAttached(r.attachId[i], this.m);
      count[A[o + 1] + 1]++;
    }
    for (let f = 0; f < r.n; f++) count[f + 1] += count[f];
    r.attachStart = count.slice();
    r.attachList = new Int32Array(n);
    const at = count.slice();
    for (let i = 0; i < n; i++) r.attachList[at[A[i * ATTACH + 1]]++] = i;
  }

  /** One blow on ruin k (4.0 strike): true when it brought the building down. */
  private blow(k: number, x: number, y: number, z: number, force: number, dx: number, dy: number, dz: number): boolean {
    const r = this.ruins[k], base = k * SLOT, P = this.draw.poses;
    r.used = this.clock;
    const cx = (g: number) => P[g * POSE_ROWS * 4 + 4], cy = (g: number) => P[g * POSE_ROWS * 4 + 5], cz = (g: number) => P[g * POSE_ROWS * 4 + 6];
    // the blow lands on the first standing fragment along the line of sight through the point, else the nearest one
    let ix = x, iy = y, iz = z;
    const dl = Math.hypot(dx, dy, dz) || 1, ux = dx / dl, uy = dy / dl, uz = dz / dl;
    const ex = x - ux * 2000, ey = y - uy * 2000, ez = z - uz * 2000;
    let bestT = Infinity, found = -1;
    for (let f = 0; f < r.n; f++) {
      const g = base + f;
      if (this.mode[g] !== STANDING) continue;
      const tx = cx(g) - ex, ty = cy(g) - ey, tz = cz(g) - ez, t = tx * ux + ty * uy + tz * uz;
      if (t <= 0) continue;
      const off = Math.hypot(tx - ux * t, ty - uy * t, tz - uz * t);
      if (off < this.reach[g] * 0.8 + 1.5 && t < bestT) { bestT = t; found = g; }
    }
    if (found < 0) {
      let bd = Infinity;
      for (let f = 0; f < r.n; f++) {
        const g = base + f;
        if (this.mode[g] !== STANDING || cy(g) < r.floor + GROUND_STOREY) continue;
        const d = (cx(g) - x) ** 2 + (cy(g) - y) ** 2 + (cz(g) - z) ** 2;
        if (d < bd) { bd = d; found = g; }
      }
    }
    if (found >= 0) { ix = cx(found); iy = cy(found); iz = cz(found); }
    const reach = 1.4 + 0.55 * force, power = 2 + 1.1 * force;
    let freed = 0;
    for (let f = 0; f < r.n; f++) {
      const g = base + f;
      if (this.mode[g] !== STANDING) continue;
      const d = Math.hypot(cx(g) - ix, cy(g) - iy, cz(g) - iz) - this.reach[g] * 0.5;
      if (d < reach) { this.release(g, ix, iy, iz, power * Math.max(0.3, 1 - d / reach)); freed++; }
    }
    this.host.emit(ix, iy, iz, Puff.Steam, Math.min(15, 6 + force * 0.5), 4);
    this.host.emit(ix, iy, iz, Puff.Sparks, Math.min(15, 4 + force * 0.4), 1.2);
    // its rooms on fire where it was struck
    if (freed) this.host.burn(ix, iy, iz, Math.min(3, 1 + force * 0.08), 20 + force * 0.6);
    // what hangs on nothing now falls: it is not thrown
    this.fallUnsupported(k);
    // counted over what stands above the ground floor (the plinth is never brought down by blows above it)
    let upper = 0, standing = 0;
    for (let f = 0; f < r.n; f++) {
      const g = base + f;
      if (cy(g) <= r.floor + GROUND_STOREY) continue;
      upper++;
      if (this.mode[g] === STANDING) standing++;
    }
    if (upper > 0 && standing < upper * COLLAPSE_BELOW) {
      for (let f = 0; f < r.n; f++) {
        const g = base + f;
        if (this.mode[g] !== STANDING) continue;
        if (cy(g) <= r.floor + GROUND_STOREY) this.mode[g] = LANDED;
        else this.release(g, ix, iy, iz, 0.6);
      }
      const col = this.host.world.buildings.cols, h = Math.max(6, col.h[r.id] || 10);
      this.host.emit(col.x[r.id], r.floor + h * 0.3, col.z[r.id], Puff.Steam, 15, 14);
      this.host.emit(col.x[r.id], r.floor + h * 0.6, col.z[r.id], Puff.Steam, 12, 10);
      this.host.emit(col.x[r.id], r.floor + 1, col.z[r.id], Puff.Smoke, 10, 12);
      r.state = 3;
      this.host.world.setRuined(r.id, false);
      this.host.down(r.id);
      return true;
    }
    return false;
  }

  /** Every standing fragment of ruin k with no path of standing fragments to the ground falls (4.0 unsupported). */
  private fallUnsupported(k: number): void {
    const r = this.ruins[k], base = k * SLOT, held = this.held, stack = this.stack;
    held.fill(0, 0, r.n);
    let top = 0;
    for (let f = 0; f < r.n; f++) {
      if (this.mode[base + f] === STANDING && this.low[base + f] <= r.floor + GROUND_STOREY) { held[f] = 1; stack[top++] = f; }
    }
    while (top > 0) {
      const f = stack[--top];
      for (let j = r.start[f]; j < r.start[f + 1]; j++) {
        const o = r.neighbours[j];
        if (!held[o] && this.mode[base + o] === STANDING) { held[o] = 1; stack[top++] = o; }
      }
    }
    const P = this.draw.poses;
    for (let f = 0; f < r.n; f++) {
      const g = base + f;
      if (this.mode[g] !== STANDING || held[f]) continue;
      const o = g * POSE_ROWS * 4;
      this.release(g, P[o + 4], P[o + 5] + 1, P[o + 6], 0.5);
    }
  }

  /** Fragment g set flying away from (x, y, z) at about `power` m/s (4.0 loosen). */
  private release(g: number, x: number, y: number, z: number, power: number): void {
    const P = this.draw.poses, o = g * POSE_ROWS * 4;
    let ax = P[o + 4] - x, ay = P[o + 5] - y, az = P[o + 6] - z;
    const d = Math.hypot(ax, ay, az) || 1;
    ax /= d; ay /= d; az /= d;
    const k = power * (0.5 + Math.random() * 0.6);
    this.vx[g] = ax * k; this.vy[g] = ay * k + power * 0.25 * Math.random(); this.vz[g] = az * k;
    const spin = 0.4 + power / 10;
    this.wx[g] = (Math.random() - 0.5) * 3 * spin; this.wy[g] = (Math.random() - 0.5) * 3 * spin; this.wz[g] = (Math.random() - 0.5) * 3 * spin;
    this.mode[g] = FLYING;
    this.flying[this.nFlying++] = g;
  }

  /** The fragments in the air: gravity, a bounce on the ground, then at rest where they lie (4.0 update). */
  update(dt: number): void {
    this.clock += dt;
    for (let h = 0; h < HIDDEN; h++) if (this.hiddenUntil[h] > 0 && this.hiddenUntil[h] < this.clock) { this.hiddenUntil[h] = 0; hiddenU.array[h].set(0, 0, 0, -1); }
    if (this.nFlying === 0) return;
    dt = Math.min(0.05, dt);
    const P = this.draw.poses, heights = this.host.world.heights;
    for (let i = this.nFlying - 1; i >= 0; i--) {
      const g = this.flying[i], o = g * POSE_ROWS * 4;
      // last frame's place and turn (the anti-aliasing's motion)
      for (let c = 0; c < 4; c++) { P[o + 12 + c] = P[o + 4 + c]; P[o + 16 + c] = P[o + 8 + c]; }
      this.draw.touched(g);
      if (this.mode[g] === LANDED) { this.flying[i] = this.flying[--this.nFlying]; continue; }
      this.vy[g] -= GRAVITY * dt;
      P[o + 4] += this.vx[g] * dt; P[o + 5] += this.vy[g] * dt; P[o + 6] += this.vz[g] * dt;
      // turned by its spin: q = rotation(w dt) · q
      const wx = this.wx[g], wy = this.wy[g], wz = this.wz[g], wl = Math.hypot(wx, wy, wz), angle = wl * dt;
      if (angle > 1e-6) {
        const h = Math.sin(angle / 2) / wl, ax = wx * h, ay = wy * h, az = wz * h, aw = Math.cos(angle / 2);
        const bx = P[o + 8], by = P[o + 9], bz = P[o + 10], bw = P[o + 11];
        let nx = aw * bx + ax * bw + ay * bz - az * by, ny = aw * by - ax * bz + ay * bw + az * bx;
        let nz = aw * bz + ax * by - ay * bx + az * bw, nw = aw * bw - ax * bx - ay * by - az * bz;
        const l = Math.hypot(nx, ny, nz, nw) || 1;
        nx /= l; ny /= l; nz /= l; nw /= l;
        P[o + 8] = nx; P[o + 9] = ny; P[o + 10] = nz; P[o + 11] = nw;
      }
      // on the ground where it falls (sunk by a third of its size: a heap, not pieces balanced on a corner)
      const rest = heightAt(heights, P[o + 4], P[o + 6]) + this.reach[g] * 0.3;
      if (P[o + 5] <= rest) {
        P[o + 5] = rest;
        if (this.vy[g] < -3) {
          this.vx[g] *= 0.3; this.vz[g] *= 0.3; this.vy[g] = Math.abs(this.vy[g]) * 0.15;
          this.wx[g] *= 0.4; this.wy[g] *= 0.4; this.wz[g] *= 0.4;
          if (this.reach[g] > 1.2 && Math.random() < 0.3) this.host.emit(P[o + 4], rest, P[o + 6], Puff.Steam, 3, 4);
        } else this.mode[g] = LANDED;
      }
      this.moveAttached(g);
    }
    this.draw.upload();
  }

  /** Fragment g's attached instances follow it: T(place) · R(turn) · T(−rest centre) · their rest matrix. */
  private moveAttached(g: number): void {
    const k = (g / SLOT) | 0, f = g - k * SLOT, r = this.ruins[k];
    if (!r.attachStart.length || r.attachStart[f] === r.attachStart[f + 1]) return;
    const P = this.draw.poses, o = g * POSE_ROWS * 4;
    this.q.set(P[o + 8], P[o + 9], P[o + 10], P[o + 11]);
    this.r.compose(this.p.set(P[o + 4], P[o + 5], P[o + 6]), this.q, this.one);
    this.r.multiply(this.m.makeTranslation(-P[o], -P[o + 1], -P[o + 2]));
    for (let j = r.attachStart[f]; j < r.attachStart[f + 1]; j++) {
      const i = r.attachList[j];
      this.m.fromArray(r.attachRest, i * 16).premultiply(this.r);
      this.draw.setAttached(r.attachId[i], this.m);
    }
  }
}

function emptyRuin(): Ruin {
  return {
    id: -1, state: 0, used: 0, n: 0, floor: 0, start: new Int32Array(0), neighbours: new Int32Array(0), waiting: [],
    attachId: new Int32Array(0), attachRest: new Float32Array(0), attachStart: new Int32Array(0), attachList: new Int32Array(0), job: 0,
  };
}
