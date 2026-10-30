// The player's bomb, as Roadcraft 4.0 deals it (bomb/ANALISE.md): it lands on the first building along the pointer's
// ray (or on the ground: a crater in the road or the earth); the buildings within its reach are struck, the one it
// lands on with the bomb's force and the others less with the distance, and break for real (ruin/ruins.ts: holes
// showing their rooms, then down once too little stands); the things standing in the street are thrown and gone, the
// vehicles burn as wrecks, soot is laid round it, and the simulation removes whoever was near. A building that comes
// down and the items struck are inverse commands; the effect is drawn by the Blast and the Ruins in the context.
// Everything is asked by place (spatial indexes, the pose tiles), never the whole city.

import type { Command } from '../../core/commands.ts';
import type { World } from '../../world/world.ts';
import { heightAt } from '../../world/heights.ts';
import { Item, ItemsCommand } from '../../world/items.ts';
import { RoadJournal } from '../../roads/build.ts';
import { wallsHeightOf } from '../../jobs/buildingGen.ts';
import { bombRadius } from '../../shared/contracts/bomb.ts';
import { t } from '../../shared/i18n/index.ts';
import type { ToSim } from '../../sim/worker.ts';

export interface BombBlast {
  explode(x: number, y: number, z: number, radius: number, ground: 'road' | 'earth' | 'building'): void;
  crater(x: number, y: number, z: number, radius: number, road: boolean): void;
  soot(x: number, y: number, z: number, radius: number): void;
}

/** Buildings that break (ruin/ruins.ts Ruins.strike). */
export interface BombRuins {
  strike(id: number, x: number, y: number, z: number, force: number, dx: number, dy: number, dz: number): 'pending' | 'hit' | 'down' | 'none';
}

/** What is thrown of the things in the street and of the traffic (blast/thrown.ts). */
export interface BombThrow {
  item(type: number, x: number, g: number, z: number, bx: number, bz: number, radius: number): void;
  struck(type: number): boolean;
  vehicle(model: number, x: number, y: number, z: number, yaw: number, paint: number, bx: number, bz: number, radius: number): void;
}

export interface BombContext {
  world: World;
  /** Records a command whose RoadJournal/ItemsCommand live operations were already applied (CommandStack.push). */
  push(cmd: Command): void;
  blast: BombBlast;
  ruins: BombRuins;
  thrown: BombThrow;
  /** Where the pointer's ray starts (the camera). */
  eye: { x: number; y: number; z: number };
  /** The cars, buses and lorries within `r` (Vehicles.vehiclesNear): x, y, z, yaw, model, paint per vehicle. */
  vehiclesNear(x: number, z: number, r: number, out: number[]): number;
  sim: { postMessage(msg: ToSim): void };
  hud: { toast(text: string): void };
  ambient: { sfx(kind: 'boom'): void };
  flash: { value: number };
  force: number;
  /** The game's hitKind; the victims' toast is handled by the page on the simulation's answer. */
  setHitKind(kind: 'bomb'): void;
}

/**
 * The first building the ray from `eye` to the ground point (x, gy, z) goes into, and where it enters its box, or null.
 * Walked in 8 m steps, each step a small query of the building index (never the ray's whole box).
 */
function firstBuildingOnRay(w: World, eye: { x: number; y: number; z: number }, x: number, gy: number, z: number): { id: number; x: number; y: number; z: number } | null {
  const col = w.buildings.cols;
  const dx = x - eye.x, dy = gy - eye.y, dz = z - eye.z, len = Math.hypot(dx, dz);
  let best: { id: number; x: number; y: number; z: number } | null = null, bestT = Infinity;
  const seen = new Set<number>();
  const lo = [0, 0, 0], ld = [0, 0, 0], half = [0, 0, 0];
  for (let s = 0; s <= len + 8 && !best; s += 8) {
    const k = len > 0 ? Math.min(1, s / len) : 1, px = eye.x + dx * k, pz = eye.z + dz * k;
    w.buildingIndex.query(px - 10, pz - 10, px + 10, pz + 10, (id) => {
      if (seen.has(id) || col.floors[id] === 0) return;
      seen.add(id);
      // the ray into the building's box (its footprint turned, from its ground to its walls' top): slab test
      const c = Math.cos(col.rot[id]), sn = Math.sin(col.rot[id]);
      const ox = eye.x - col.x[id], oz = eye.z - col.z[id];
      lo[0] = ox * c - oz * sn; lo[1] = eye.y - heightAt(w.heights, col.x[id], col.z[id]); lo[2] = ox * sn + oz * c;
      ld[0] = dx * c - dz * sn; ld[1] = dy; ld[2] = dx * sn + dz * c;
      half[0] = col.w[id] / 2; half[1] = Math.max(3, wallsHeightOf(col, id)); half[2] = col.d[id] / 2;
      let t0 = 0, t1 = 1;
      for (let a = 0; a < 3 && t0 <= t1; a++) {
        const min = a === 1 ? 0 : -half[a], max = half[a];
        if (Math.abs(ld[a]) < 1e-9) { if (lo[a] < min || lo[a] > max) t1 = -1; continue; }
        let ta = (min - lo[a]) / ld[a], tb = (max - lo[a]) / ld[a];
        if (ta > tb) { const q = ta; ta = tb; tb = q; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (t0 <= t1 && t0 < bestT) { bestT = t0; best = { id, x: eye.x + dx * t0, y: eye.y + dy * t0, z: eye.z + dz * t0 }; }
    });
  }
  return best;
}

/** How far (x, z) is from building id's footprint (0 inside) and its nearest point: [distance, x, z]. */
function toFootprint(w: World, id: number, x: number, z: number): [number, number, number] {
  const col = w.buildings.cols, c = Math.cos(col.rot[id]), s = Math.sin(col.rot[id]);
  const ox = x - col.x[id], oz = z - col.z[id];
  const lx = ox * c - oz * s, lz = ox * s + oz * c;
  const cx = Math.max(-col.w[id] / 2, Math.min(col.w[id] / 2, lx)), cz = Math.max(-col.d[id] / 2, Math.min(col.d[id] / 2, lz));
  return [Math.hypot(lx - cx, lz - cz), col.x[id] + cx * c + cz * s, col.z[id] - cx * s + cz * c];
}

/**
 * A building brought down by its blows leaves the world as one undoable command (its lot left empty with stones and
 * gravel: what the save keeps of the rubble). Undone, the building stands again and `forget` takes its ruin away.
 */
export function buildingDown(w: World, id: number, push: (cmd: Command) => void, forget: (id: number) => void): void {
  if (!w.buildings.alive[id]) return;
  const j = new RoadJournal(w, 'bomba');
  const items = new ItemsCommand(w.items, 'entulho');
  const rec = w.buildingRec(id);
  j.removeBuilding(id);
  j.addBuilding({ x: rec[1], z: rec[2], w: rec[3], d: rec[4], h: 0, rot: rec[6], color: 0, seed: rec[8], zone: rec[9], floors: 0, style: rec[11], fn: 0 });
  const n = Math.min(40, Math.round(rec[3] * rec[4] / 12));
  for (let k = 0; k < n; k++) {
    const lx = (Math.random() - 0.5) * rec[3] * 0.85, lz = (Math.random() - 0.5) * rec[4] * 0.85, c = Math.cos(rec[6]), s = Math.sin(rec[6]);
    items.add([rec[1] + lx * c + lz * s, rec[2] - lx * s + lz * c, Math.random() * 6, 0, k % 3 === 0 ? Item.Gravel : Item.Stones, 12]);
  }
  push({ label: 'bomba', apply: () => { j.apply(); items.apply(); }, invert: () => { items.invert(); j.invert(); forget(id); } });
}

const found: number[] = [];

/** Drops one bomb at the ground point (x, z) under the pointer (on the ray from ctx.eye). */
export function dropBomb(ctx: BombContext, x: number, z: number): void {
  const w = ctx.world, col = w.buildings.cols;
  const r = bombRadius(ctx.force);
  const gy = heightAt(w.heights, x, z);
  // where it lands: on the first building along the pointer's ray, or on the ground
  const on = firstBuildingOnRay(w, ctx.eye, x, gy, z);
  const bx = on ? on.x : x, by = on ? on.y : gy, bz = on ? on.z : z;
  const ground = on ? 'building' : w.roads.nearestSeg(bx, bz, 0.5) ? 'road' : 'earth';
  ctx.blast.explode(bx, by, bz, r, ground);
  if (ground !== 'building') ctx.blast.crater(bx, by, bz, r * 0.75, ground === 'road');
  ctx.ambient.sfx('boom');
  ctx.flash.value = 1;
  // the buildings within reach: the one it landed on with the bomb's force, the others at their nearest point with
  // less, and only when close or strong enough (4.0 explodeAt)
  const dx = x - ctx.eye.x, dy = gy - ctx.eye.y, dz = z - ctx.eye.z;
  let down = 0, hit = 0;
  const near: number[] = [];
  w.buildingIndex.query(bx - r - 40, bz - r - 40, bx + r + 40, bz + r + 40, (id) => { if (col.floors[id] > 0) near.push(id); });
  for (const id of near) {
    let res: 'pending' | 'hit' | 'down' | 'none';
    if (on && id === on.id) res = ctx.ruins.strike(id, bx, by, bz, ctx.force, dx, dy, dz);
    else {
      const [d, px, pz] = toFootprint(w, id, bx, bz);
      if (d > r) continue;
      const force = Math.max(1, ctx.force * (1 - d / r) * 1.2);
      if (!(d < r * 0.75 || force >= 4)) continue;
      const py = Math.max(by, heightAt(w.heights, px, pz) + 1.5);
      res = ctx.ruins.strike(id, px, py, pz, force, px - bx, 0, pz - bz);
    }
    if (res === 'down') down++; else if (res !== 'none') hit++;
  }
  // the vehicles within reach, as burnt-out wrecks (read before the simulation takes them away)
  found.length = 0;
  const nv = ctx.vehiclesNear(bx, bz, r, found);
  for (let i = 0; i < nv; i++) {
    const o = i * 6;
    ctx.thrown.vehicle(found[o + 4], found[o], found[o + 1], found[o + 2], found[o + 3], found[o + 5], bx, bz, r);
  }
  // the things standing in the street within reach: thrown and gone
  const items = new ItemsCommand(w.items, 'bomba');
  const ic = w.items.t.cols, struck: number[] = [];
  w.items.index.query(bx - r, bz - r, bx + r, bz + r, (id) => {
    if (!ctx.thrown.struck(ic.type[id]) || (ic.x0[id] - bx) ** 2 + (ic.z0[id] - bz) ** 2 > r * r) return;
    struck.push(id);
  });
  for (const id of struck) {
    const ix = ic.x0[id], iz = ic.z0[id];
    ctx.thrown.item(ic.type[id], ix, heightAt(w.heights, ix, iz), iz, bx, bz, r);
    items.remove(id);
  }
  if (struck.length) ctx.push({ label: 'bomba', apply: () => items.apply(), invert: () => items.invert() });
  // soot and ash over the ground round it: streets and lots left dirty (4.0: 6 + one per 3 m of reach, at most 40)
  const blots = Math.min(40, Math.round(6 + r / 3));
  for (let k = 0; k < blots; k++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 1.6;
    const sx = bx + Math.cos(a) * d, sz = bz + Math.sin(a) * d;
    ctx.blast.soot(sx, heightAt(w.heights, sx, sz), sz, 2 + Math.random() * 4 + r * 0.08);
  }
  ctx.setHitKind('bomb');
  ctx.sim.postMessage({ type: 'hit', x: bx, z: bz, r, one: false } satisfies ToSim);
  ctx.hud.toast(down ? t('game.toast.bombDown') : hit ? t('game.toast.bombHit') : t('game.toast.bombGround'));
}
