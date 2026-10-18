// Demolir qualquer coisa: o que estiver sob o cursor (item ou muro, prédio, via) ou tudo dentro
// de um retângulo arrastado. Consultas só pelo índice espacial da área; um comando só (desfazer).

import type { Command } from '../core/commands.ts';
import { RoadJournal } from '../roads/build.ts';
import { ItemsCommand, MAX_RUN } from '../world/items.ts';
import { lotAt } from '../world/lotEdit.ts';
import type { World } from '../world/world.ts';

export type Target = { kind: 'item'; id: number } | { kind: 'building'; id: number } | { kind: 'seg'; id: number } | null;

/** O que um clique em (x, z) demoliria: item ou muro bem perto, senão o prédio, senão a via. */
export function targetAt(world: World, x: number, z: number): Target {
  const it = world.items.nearest(x, z, 2.5);
  if (it >= 0) return { kind: 'item', id: it };
  const b = lotAt(world, x, z);
  if (b >= 0) return { kind: 'building', id: b };
  const s = world.roads.nearestSeg(x, z, 14);
  if (s) return { kind: 'seg', id: s[0] };
  return null;
}

/** Junta um diário de vias/prédios e um de itens num comando só. */
function both(label: string, j: RoadJournal, items: ItemsCommand | null): Command {
  if (!items) return j;
  return { label, apply: () => { j.apply(); items.apply(); }, invert: () => { items.invert(); j.invert(); } };
}

/** Demole o alvo (já aplicado; o comando volta para registrar). */
export function demolishTarget(world: World, t: NonNullable<Target>): { cmd: Command; charge: number } {
  if (t.kind === 'item') {
    const c = new ItemsCommand(world.items, 'remover item');
    c.remove(t.id);
    return { cmd: c, charge: 0 };
  }
  const j = new RoadJournal(world, t.kind === 'building' ? 'demolir prédio' : 'demolir via');
  if (t.kind === 'building') j.removeBuilding(t.id);
  else removeSegAndOrphans(world, j, t.id);
  j.settle();
  return { cmd: j, charge: j.charge };
}

function removeSegAndOrphans(world: World, j: RoadJournal, s: number): void {
  const net = world.roads;
  const rec = j.removeSeg(s);
  for (const n of [rec.a, rec.b]) if (net.nodes.alive[n] && net.nodes.cols.deg[n] === 0) j.removeNode(n);
}

/** Tudo dentro do retângulo (x0, z0)–(x1, z1): vias pelo meio do trecho, prédios pelo centro, itens pela ponta. */
export function demolishBox(world: World, x0: number, z0: number, x1: number, z1: number): { cmd: Command; count: number; charge: number } | null {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), az = Math.min(z0, z1), bz = Math.max(z0, z1);
  const inside = (x: number, z: number) => x >= ax && x <= bx && z >= az && z <= bz;
  const net = world.roads, sc = net.segs.cols, col = world.buildings.cols;
  const segs: number[] = [], blds: number[] = [], its: number[] = [];
  net.forSegsNear(ax, az, bx, bz, (s) => { if (inside(sc.mx[s], sc.mz[s])) segs.push(s); });
  world.buildingIndex.query(ax, az, bx, bz, (id) => { if (inside(col.x[id], col.z[id])) blds.push(id); });
  const ic = world.items.t.cols;
  world.items.index.query(ax - MAX_RUN, az - MAX_RUN, bx + MAX_RUN, bz + MAX_RUN, (i) => { if (inside(ic.x0[i], ic.z0[i])) its.push(i); });
  if (!segs.length && !blds.length && !its.length) return null;
  const j = new RoadJournal(world, 'demolir área');
  for (const id of blds) j.removeBuilding(id);
  for (const s of segs) if (net.segs.alive[s]) removeSegAndOrphans(world, j, s);
  j.settle();
  let items: ItemsCommand | null = null;
  if (its.length) { items = new ItemsCommand(world.items, 'demolir área'); for (const i of its) items.remove(i); }
  return { cmd: both('demolir área', j, items), count: segs.length + blds.length + its.length, charge: j.charge };
}
