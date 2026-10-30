// The player's bomb: flash, fire and smoke, the buildings in the radius collapse into rubble (one inverse command),
// and the simulation removes whoever was near. The effect is rendered by the Blast/Particles passed in the context;
// this module owns the world change and the undo command, not the game object.

import type { Command } from '../../core/commands.ts';
import type { World } from '../../world/world.ts';
import { heightAt } from '../../world/heights.ts';
import { Item, ItemsCommand } from '../../world/items.ts';
import { RoadJournal } from '../../roads/build.ts';
import { lot40OfBox, wallsHeightOf } from '../../jobs/buildingGen.ts';
import { bombRadius } from '../../shared/contracts/bomb.ts';
import { plural, t } from '../../shared/i18n/index.ts';
import { SHAPE_STRIDE, emptyBoxes, type BoxColumns } from '../../shared/contracts/worker.ts';
import { wreckInput } from '../../render/wreckData.ts';
import type { FractureInput } from '../../render/fracture.ts';
import type { ToSim } from '../../sim/worker.ts';

export interface BombBlast {
  boom(x: number, y: number, z: number, r: number): void;
  collapse(x: number, y: number, z: number, w: number, d: number, h: number, rot: number, floors?: number): void;
  wreck(input: FractureInput, floor: number, x: number, y: number, z: number, force: number): void;
}

export interface BombParticles {
  burst(x: number, y: number, z: number, kind: number, strength: number, seconds: number): void;
}

/** One building record as the one-row columns the 4.0 generator takes. */
function oneBuilding(w: World, id: number): BoxColumns {
  const c = w.buildings.cols, b = emptyBoxes(1);
  b.x[0] = c.x[id]; b.z[0] = c.z[id]; b.w[0] = c.w[id]; b.d[0] = c.d[id]; b.h[0] = c.h[id];
  b.rot[0] = c.rot[id]; b.color[0] = c.color[id]; b.seed[0] = c.seed[id]; b.zone[0] = c.zone[id];
  b.floors[0] = c.floors[id]; b.style[0] = c.style[id]; b.fn[0] = c.fn[id];
  b.shapeN[0] = c.shapeN[id]; b.built[0] = c.built[id]; b.decay[0] = c.decay[id];
  if (c.shapeN[id]) b.shape.set(w.lotShape.subarray(id * SHAPE_STRIDE, (id + 1) * SHAPE_STRIDE), 0);
  return b;
}

export interface BombContext {
  world: World;
  /** Records a command whose RoadJournal/ItemsCommand live operations were already applied (CommandStack.push). */
  push(cmd: Command): void;
  blast: BombBlast;
  particles: BombParticles;
  sim: { postMessage(msg: ToSim): void };
  hud: { toast(text: string): void };
  ambient: { sfx(kind: 'boom'): void };
  flash: { value: number };
  force: number;
  /** The game's hitKind; the victims' toast is handled by the page on the simulation's answer. */
  setHitKind(kind: 'bomb'): void;
}

/** Drops one bomb at (x, z): effect now, buildings/rubble as one undoable command, hit message to the workers. */
export function dropBomb(ctx: BombContext, x: number, z: number): void {
  const w = ctx.world, col = w.buildings.cols;
  const r = bombRadius(ctx.force);
  const y = heightAt(w.heights, x, z);
  ctx.blast.boom(x, y, z, r);
  ctx.ambient.sfx('boom');
  ctx.particles.burst(x, y + 1, z, 2, 8, 12);
  ctx.particles.burst(x, y + 2, z, 0, 10, 40);
  ctx.particles.burst(x, y + 0.5, z, 6, 10, 3);
  ctx.particles.burst(x, y + 0.5, z, 4, 12, 15);
  ctx.flash.value = 1;
  const doomed: number[] = [];
  w.buildingIndex.query(x - r - 40, z - r - 40, x + r + 40, z + r + 40, (id) => {
    if (col.floors[id] === 0) return;
    if (Math.hypot(col.x[id] - x, col.z[id] - z) < r + Math.min(col.w[id], col.d[id]) * 0.3) doomed.push(id);
  });
  if (doomed.length) {
    const j = new RoadJournal(w, 'bomba');
    const rubble = new ItemsCommand(w.items, 'entulho');
    let detailed = 0;
    for (const id of doomed) {
      const gy = heightAt(w.heights, col.x[id], col.z[id]);
      let input: FractureInput | null = null;
      if (detailed < 6) {
        try { input = wreckInput(lot40OfBox(w.heights, oneBuilding(w, id), 0)); detailed++; } catch (error) { console.error('wreck:', error); }
      }
      if (input) ctx.blast.wreck(input, gy, col.x[id], gy + 1, col.z[id], ctx.force);
      else ctx.blast.collapse(col.x[id], gy, col.z[id], col.w[id], col.d[id],
        Math.max(3, wallsHeightOf(col, id)), col.rot[id], col.floors[id]);
      ctx.particles.burst(col.x[id], gy + 1, col.z[id], 4, 14, 10);
      const rec = w.buildingRec(id);
      j.removeBuilding(id);
      // rubble: the lot is left empty and full of stones and gravel
      j.addBuilding({ x: rec[1], z: rec[2], w: rec[3], d: rec[4], h: 0, rot: rec[6], color: 0, seed: rec[8], zone: rec[9], floors: 0, style: rec[11], fn: 0 });
      const n = Math.min(40, Math.round(rec[3] * rec[4] / 12));
      for (let k = 0; k < n; k++) {
        const lx = (Math.random() - 0.5) * rec[3] * 0.85, lz = (Math.random() - 0.5) * rec[4] * 0.85, c = Math.cos(rec[6]), s = Math.sin(rec[6]);
        rubble.add([rec[1] + lx * c + lz * s, rec[2] - lx * s + lz * c, Math.random() * 6, 0, k % 3 === 0 ? Item.Gravel : Item.Stones, 12]);
      }
    }
    ctx.push({ label: 'bomba', apply: () => { j.apply(); rubble.apply(); }, invert: () => { rubble.invert(); j.invert(); } });
  }
  ctx.setHitKind('bomb');
  ctx.sim.postMessage({ type: 'hit', x, z, r, one: false } satisfies ToSim);
  ctx.hud.toast(doomed.length ? plural('game.toast.collapsed', doomed.length) : t('game.toast.bombGround'));
}
