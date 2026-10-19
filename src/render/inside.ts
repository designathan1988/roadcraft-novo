// See inside: the chosen building is cut a little above the chosen floor (the buildings' material discards what lies
// inside the cut box and above the cut height, uniforms below): the facade, the balconies and the lower floors stay
// as generated, the storeys above vanish, and on the floor's slab appear its rooms: outer walls seen from inside,
// partitions, the lift and stairs in the core, and desks. The storeys, the footprint and the floor height come from
// the generator's own layout of that building (jobs/buildingGen.ts buildingVolumes), not from a guess.
// A few boxes, for one building.

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';
import { buildingTag, buildingVolumes, type Volume } from '../jobs/buildingGen.ts';
import type { World } from '../world/world.ts';

/** Cut: centre and half width/depth (x, z, w/2, d/2), turn (cos, sin) and height (no cut: very high). */
export const cutBoxU = T.uniform(new THREE.Vector4(0, 0, 0, 0));
export const cutRotU = T.uniform(new THREE.Vector2(1, 0));
export const cutYU = T.uniform(1e9);
/** The cut building's tag (jobs/buildingGen.ts buildingTag): only its own vertices are cut. */
export const cutTagU = T.uniform(0);

/** The cut mask for the buildings' material (and its detail layer): false = fragment gone. */
export function cutMask(): ReturnType<typeof T.float> {
  const { positionWorld, abs, attribute } = T;
  const dx = positionWorld.x.sub(cutBoxU.x), dz = positionWorld.z.sub(cutBoxU.y);
  const lx = dx.mul(cutRotU.x).sub(dz.mul(cutRotU.y)), lz = dx.mul(cutRotU.y).add(dz.mul(cutRotU.x));
  const inside = abs(lx).lessThan(cutBoxU.z).and(abs(lz).lessThan(cutBoxU.w));
  // position.w = the building's tag (snorm16)
  const mine = abs(attribute('position', 'vec4').w.mul(32767).sub(cutTagU)).lessThan(0.5);
  return inside.and(mine).and(positionWorld.y.greaterThan(cutYU)).not();
}

/** How high the walls of the shown floor stay (m above its slab): a doll's house cut, so the rooms are seen. */
export const INSIDE_CUT = 1.4;

/** A storey of a building: its slab height, its height and the volume it is in. */
export interface Storey { y: number; h: number; v: Volume }

/**
 * The storeys of a building from its volumes (largest footprint first): every volume's storeys from its base (the
 * ground storey, then the others), merged where two volumes share a level; each storey in the largest volume that has it.
 */
export function storeyLevels(vols: Volume[]): Storey[] {
  const out: Storey[] = [];
  for (const v of vols) {
    for (let y = v.base, k = 0; y < v.y1 - 1; y += k++ === 0 ? v.ground : v.fh) {
      if (y < v.y0 - 0.5 || out.some((s) => Math.abs(s.y - y) < 0.5)) continue;
      out.push({ y, h: Math.min(k === 0 ? v.ground : v.fh, v.y1 - y), v });
    }
  }
  return out.sort((a, b) => a.y - b.y);
}

/** The lot of the building (record): centre, front w, depth d, turn. */
export interface InsideLot { x: number; z: number; w: number; d: number; rot: number }

/** What the inside view shows for one floor: the storey, and the box the building is cut by (centre, half sizes). */
export interface InsidePlan { storey: Storey; floor: number; floors: number; cut: { x: number; z: number; hw: number; hd: number; rot: number; y: number; tag: number } }

/**
 * Floor k (clamped to the storeys) of a building: its storey and the cut. The cut box is every volume's footprint and
 * 4 m round it (eaves, balconies, cornices, marquees); only vertices with the building's `tag` are cut, so the
 * neighbours, the lot's ground and walls and the trees stay whatever the box takes in.
 */
export function insidePlan(vols: Volume[], lot: InsideLot, k: number, tag: number): InsidePlan | null {
  const levels = storeyLevels(vols);
  if (!levels.length) return null;
  const floor = Math.max(0, Math.min(levels.length - 1, k));
  const c = Math.cos(lot.rot), s = Math.sin(lot.rot);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const v of vols) {
    // the volume's centre in the lot frame (x along the front, z towards it)
    const dx = v.cx - lot.x, dz = v.cz - lot.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
    x0 = Math.min(x0, lx - v.hw); x1 = Math.max(x1, lx + v.hw); z0 = Math.min(z0, lz - v.hd); z1 = Math.max(z1, lz + v.hd);
  }
  x0 -= 4; x1 += 4; z0 -= 4; z1 += 4;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const storey = levels[floor];
  return {
    storey, floor, floors: levels.length,
    cut: { x: lot.x + mx * c + mz * s, z: lot.z - mx * s + mz * c, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: lot.rot, y: storey.y + INSIDE_CUT, tag },
  };
}

/**
 * Floor k of building `id` of the world, laid out by the generator with its cell's plan (null: an empty lot, a building
 * that is gone, or one with no storeys).
 */
export function insidePlanOf(world: World, id: number, k: number): InsidePlan | null {
  const col = world.buildings.cols;
  if (id < 0 || !world.buildings.alive[id] || col.floors[id] === 0) return null;
  const boxes = world.gatherBoxes([col.cell[id]]);
  for (let i = 0; i < boxes.count; i++) {
    if (boxes.seed[i] !== col.seed[id] || boxes.x[i] !== col.x[id] || boxes.z[i] !== col.z[id]) continue;
    return insidePlan(buildingVolumes(world.heights, boxes, i), { x: col.x[id], z: col.z[id], w: col.w[id], d: col.d[id], rot: col.rot[id] }, k, buildingTag(col.seed[id], col.x[id], col.z[id]));
  }
  return null;
}

export class InsideView {
  readonly group = new THREE.Group();
  private mats = {
    slab: new THREE.MeshStandardNodeMaterial({ color: 0xbdb5a6, roughness: 0.9 }),
    wall: new THREE.MeshStandardNodeMaterial({ color: 0xf0ece4, roughness: 0.95 }),
    core: new THREE.MeshStandardNodeMaterial({ color: 0x8f949a, roughness: 0.6 }),
    stair: new THREE.MeshStandardNodeMaterial({ color: 0xc9c2b4, roughness: 0.8 }),
    wood: new THREE.MeshStandardNodeMaterial({ color: 0x8a6a4a, roughness: 0.7 }),
  };
  private box = new THREE.BoxGeometry(1, 1, 1);
  /** The plan shown (null = off), the building it is of and that building's record when it was laid out. */
  plan: InsidePlan | null = null;
  id = -1;
  private rec = new Float64Array(10);

  constructor() { this.group.visible = false; }

  private add(mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): void {
    const m = new THREE.Mesh(this.box, mat);
    m.position.set(x, y + h / 2, z);
    m.scale.set(w, h, d);
    this.group.add(m);
  }

  /** Shows a floor (insidePlan): the building cut above it, its rooms on the slab, in its storey's volume. */
  show(p: InsidePlan): void {
    for (const c of [...this.group.children]) this.group.remove(c);
    this.plan = p;
    const { cut, storey } = p, v = storey.v, y = storey.y;
    cutBoxU.value.set(cut.x, cut.z, cut.hw, cut.hd);
    cutRotU.value.set(Math.cos(cut.rot), Math.sin(cut.rot));
    cutYU.value = cut.y;
    cutTagU.value = cut.tag;
    this.group.position.set(v.cx, 0, v.cz);
    this.group.rotation.y = v.rot;
    // inside the facade: walls 25 cm thick, as high as the cut (they meet the cut facade)
    const W = Math.max(3, v.hw * 2 - 0.3), D = Math.max(3, v.hd * 2 - 0.3), H = Math.min(INSIDE_CUT, storey.h - 0.2), t = 0.25;
    this.add(this.mats.slab, 0, y - 0.25, 0, W, 0.25, D);
    this.add(this.mats.wall, 0, y, D / 2 - t / 2, W, H, t);
    this.add(this.mats.wall, 0, y, -D / 2 + t / 2, W, H, t);
    this.add(this.mats.wall, W / 2 - t / 2, y, 0, t, H, D);
    this.add(this.mats.wall, -W / 2 + t / 2, y, 0, t, H, D);
    // partitions every ~6 m across, a corridor wall along
    const nx = Math.max(1, Math.round(W / 6)), nz = Math.max(1, Math.round(D / 7));
    for (let i = 1; i < nx; i++) if (Math.abs(-W / 2 + (i * W) / nx) > 3) this.add(this.mats.wall, -W / 2 + (i * W) / nx, y, 0, 0.12, H, D * 0.42);
    for (let j = 1; j < nz; j++) this.add(this.mats.wall, -W / 4, y, -D / 2 + (j * D) / nz, W * 0.35, H, 0.12);
    // circulation: lift and stairs in the core (a small building has just the stairs)
    if (W > 8 && D > 8) this.add(this.mats.core, 1.4, y, 0, 2.2, H, 2.4);
    for (let s = 0; s < 8; s++) this.add(this.mats.stair, -1.2, y + s * (H / 8), -1.2 + s * 0.28, 1.6, H / 8, 0.3);
    // a few desks in the rooms
    for (let i = 0; i < nx; i++) {
      const cx = -W / 2 + ((i + 0.5) * W) / nx;
      if (Math.abs(cx) < 3) continue;
      this.add(this.mats.wood, cx, y, D / 4, 1.6, 0.75, 0.8);
      this.add(this.mats.wood, cx, y, -D / 4, 1.6, 0.75, 0.8);
    }
    this.group.visible = true;
  }

  /** Floor k of building id (insidePlanOf); false (and hidden) when it has none. */
  showBuilding(world: World, id: number, k: number): boolean {
    const p = insidePlanOf(world, id, k);
    if (!p) { this.hide(); return false; }
    this.id = id;
    this.readRec(world, id, this.rec);
    this.show(p);
    return true;
  }

  /**
   * Each frame while on: the building demolished, its id taken by another building, or a new city: hide; the same
   * building edited (floors, design, style): lay the floor out again. Reads one record.
   */
  follow(world: World): void {
    if (!this.on || !this.plan) return;
    const id = this.id, r = this.rec, col = world.buildings.cols;
    if (!world.buildings.alive[id] || col.seed[id] !== r[0] || col.x[id] !== r[1] || col.z[id] !== r[2]) { this.hide(); return; }
    if (col.floors[id] !== r[3] || col.color[id] !== r[4] || col.h[id] !== r[5] || col.style[id] !== r[6] || col.fn[id] !== r[7] || col.w[id] !== r[8] || col.d[id] !== r[9]) this.showBuilding(world, id, this.plan.floor);
  }

  private readRec(world: World, id: number, r: Float64Array): void {
    const col = world.buildings.cols;
    r[0] = col.seed[id]; r[1] = col.x[id]; r[2] = col.z[id]; r[3] = col.floors[id]; r[4] = col.color[id];
    r[5] = col.h[id]; r[6] = col.style[id]; r[7] = col.fn[id]; r[8] = col.w[id]; r[9] = col.d[id];
  }

  /** Compiles the materials at load (drawn far below, cut off). */
  warm(): void {
    const v: Volume = { cx: 0, cz: 0, hw: 10, hd: 10, rot: 0, y0: -1000, y1: -990, base: -1000, ground: 3, fh: 3 };
    this.show({ storey: { y: -1000, h: 3, v }, floor: 0, floors: 1, cut: { x: 0, z: 0, hw: 0, hd: 0, rot: 0, y: 1e9, tag: 0 } });
  }

  hide(): void {
    this.group.visible = false;
    this.plan = null;
    this.id = -1;
    cutYU.value = 1e9;
  }

  get on(): boolean { return this.group.visible; }
}
