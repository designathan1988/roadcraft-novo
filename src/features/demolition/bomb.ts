// The player's bomb, as Roadcraft 4.0 deals it (actionsWiring.ts explodeAt): the blast tears up what it lands on (a
// crater in the road or the earth), the buildings within its reach come down into rubble, the things standing in the
// street are thrown and gone, the vehicles burn as wrecks, soot is laid round it, and the simulation removes whoever
// was near. The world change is one inverse command (buildings, rubble and the items struck); the effect is drawn by
// the Blast passed in the context. Everything is asked by place (spatial indexes, the pose tiles), never the whole city.

import type { Command } from '../../core/commands.ts';
import type { World } from '../../world/world.ts';
import { heightAt } from '../../world/heights.ts';
import { Item, ItemsCommand } from '../../world/items.ts';
import { RoadJournal } from '../../roads/build.ts';
import { wallsHeightOf } from '../../jobs/buildingGen.ts';
import { bombRadius } from '../../shared/contracts/bomb.ts';
import { plural, t } from '../../shared/i18n/index.ts';
import type { ToSim } from '../../sim/worker.ts';

export interface BombBlast {
  explode(x: number, y: number, z: number, radius: number, ground: 'road' | 'earth' | 'building'): void;
  crater(x: number, y: number, z: number, radius: number, road: boolean): void;
  soot(x: number, y: number, z: number, radius: number): void;
  collapse(x: number, y: number, z: number, w: number, d: number, h: number, rot: number, floors: number, color: number, bx: number, bz: number, radius: number): void;
}

export interface BombParticles {
  burst(x: number, y: number, z: number, kind: number, strength: number, seconds: number): void;
}

/** What is thrown of the things in the street and of the traffic (render/blast/thrown.ts). */
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
  thrown: BombThrow;
  /** The cars, buses and lorries within `r` (Vehicles.vehiclesNear): x, y, z, yaw, model, paint per vehicle. */
  vehiclesNear(x: number, z: number, r: number, out: number[]): number;
  particles: BombParticles;
  sim: { postMessage(msg: ToSim): void };
  hud: { toast(text: string): void };
  ambient: { sfx(kind: 'boom'): void };
  flash: { value: number };
  force: number;
  /** The game's hitKind; the victims' toast is handled by the page on the simulation's answer. */
  setHitKind(kind: 'bomb'): void;
}

/** Wall colours of the interim collapse (a building's own finish is not on its record). */
const WALLS = [0x9a968e, 0x8a4a35, 0xc9b79c, 0xb8b0a2, 0x7d6a5a];

const found: number[] = [];

/** Drops one bomb at (x, z): effect now, buildings/rubble/items as one undoable command, hit message to the workers. */
export function dropBomb(ctx: BombContext, x: number, z: number): void {
  const w = ctx.world, col = w.buildings.cols;
  const r = bombRadius(ctx.force);
  const y = heightAt(w.heights, x, z);
  const doomed: number[] = [];
  let onBuilding = false;
  w.buildingIndex.query(x - r - 40, z - r - 40, x + r + 40, z + r + 40, (id) => {
    if (col.floors[id] === 0) return;
    if (Math.hypot(col.x[id] - x, col.z[id] - z) < r + Math.min(col.w[id], col.d[id]) * 0.3) doomed.push(id);
    // inside its footprint: the blow lands on it (no crater)
    const c = Math.cos(col.rot[id]), s = Math.sin(col.rot[id]), dx = x - col.x[id], dz = z - col.z[id];
    if (Math.abs(dx * c - dz * s) < col.w[id] / 2 && Math.abs(dx * s + dz * c) < col.d[id] / 2) onBuilding = true;
  });
  const ground = onBuilding ? 'building' : w.roads.nearestSeg(x, z, 0.5) ? 'road' : 'earth';
  ctx.blast.explode(x, y, z, r, ground);
  if (ground !== 'building') ctx.blast.crater(x, y, z, r * 0.75, ground === 'road');
  ctx.ambient.sfx('boom');
  ctx.flash.value = 1;
  // the vehicles within reach, as burnt-out wrecks (read before the simulation takes them away)
  found.length = 0;
  const nv = ctx.vehiclesNear(x, z, r, found);
  for (let i = 0; i < nv; i++) {
    const o = i * 6;
    ctx.thrown.vehicle(found[o + 4], found[o], found[o + 1], found[o + 2], found[o + 3], found[o + 5], x, z, r);
  }
  const j = doomed.length ? new RoadJournal(w, 'bomba') : null;
  const items = new ItemsCommand(w.items, 'bomba');
  // the things standing in the street within reach: thrown and gone
  const ic = w.items.t.cols, struck: number[] = [];
  w.items.index.query(x - r, z - r, x + r, z + r, (id) => {
    if (!ctx.thrown.struck(ic.type[id]) || (ic.x0[id] - x) ** 2 + (ic.z0[id] - z) ** 2 > r * r) return;
    struck.push(id);
  });
  for (const id of struck) {
    const ix = ic.x0[id], iz = ic.z0[id];
    ctx.thrown.item(ic.type[id], ix, heightAt(w.heights, ix, iz), iz, x, z, r);
    items.remove(id);
  }
  if (j) {
    for (const id of doomed) {
      const gy = heightAt(w.heights, col.x[id], col.z[id]);
      ctx.blast.collapse(col.x[id], gy, col.z[id], col.w[id], col.d[id], Math.max(3, wallsHeightOf(col, id)), col.rot[id], col.floors[id],
        WALLS[col.seed[id] % WALLS.length], x, z, r);
      const rec = w.buildingRec(id);
      j.removeBuilding(id);
      // rubble: the lot is left empty and full of stones and gravel
      j.addBuilding({ x: rec[1], z: rec[2], w: rec[3], d: rec[4], h: 0, rot: rec[6], color: 0, seed: rec[8], zone: rec[9], floors: 0, style: rec[11], fn: 0 });
      const n = Math.min(40, Math.round(rec[3] * rec[4] / 12));
      for (let k = 0; k < n; k++) {
        const lx = (Math.random() - 0.5) * rec[3] * 0.85, lz = (Math.random() - 0.5) * rec[4] * 0.85, c = Math.cos(rec[6]), s = Math.sin(rec[6]);
        items.add([rec[1] + lx * c + lz * s, rec[2] - lx * s + lz * c, Math.random() * 6, 0, k % 3 === 0 ? Item.Gravel : Item.Stones, 12]);
      }
    }
  }
  if (j || struck.length) ctx.push({ label: 'bomba', apply: () => { j?.apply(); items.apply(); }, invert: () => { items.invert(); j?.invert(); } });
  // soot and ash over the ground round it: streets and lots left dirty (4.0: 6 + one per 3 m of reach, at most 40)
  const blots = Math.min(40, Math.round(6 + r / 3));
  for (let k = 0; k < blots; k++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 1.6;
    const bx = x + Math.cos(a) * d, bz = z + Math.sin(a) * d;
    ctx.blast.soot(bx, heightAt(w.heights, bx, bz), bz, 2 + Math.random() * 4 + r * 0.08);
  }
  ctx.setHitKind('bomb');
  ctx.sim.postMessage({ type: 'hit', x, z, r, one: false } satisfies ToSim);
  ctx.hud.toast(doomed.length ? plural('game.toast.collapsed', doomed.length) : t('game.toast.bombGround'));
}
