// Demolish anything: what is under the cursor (item or wall, building, road) or everything inside
// a dragged rectangle. Queries only through the area's spatial index; a single command (undo).

import type { Command } from '../../core/commands.ts';
import { RoadJournal } from '../../roads/build.ts';
import { Item, ItemsCommand, MAX_RUN } from '../../world/items.ts';
import { signRuleCommand } from '../../roads/signRule.ts';
import { lotAt } from '../../world/lotEdit.ts';
import type { World } from '../../world/world.ts';

export type Target = { kind: 'item'; id: number } | { kind: 'building'; id: number } | { kind: 'seg'; id: number } | null;

/** What a click at (x, z) would demolish: an item or wall very near, else the building, else the road. */
export function targetAt(world: World, x: number, z: number): Target {
  const it = world.items.nearest(x, z, 2.5);
  if (it >= 0) return { kind: 'item', id: it };
  const b = lotAt(world, x, z);
  if (b >= 0) return { kind: 'building', id: b };
  const s = world.roads.nearestSeg(x, z, 14);
  if (s) return { kind: 'seg', id: s[0] };
  return null;
}

/**
 * Removes items (already applied). A Stop or Give-way sign is a rule (`roads/signRule.ts`): taking it away gives its
 * junction arm back to the automatic choice, in the same command.
 */
function removeItems(world: World, label: string, ids: number[]): Command {
  const items = new ItemsCommand(world.items, label);
  const rules: Command[] = [];
  const c = world.items.t.cols;
  for (const id of ids) {
    if (!world.items.t.alive[id]) continue;
    if (c.type[id] === Item.Sign) {
      const r = signRuleCommand(world, c.x0[id], c.z0[id], c.variant[id], false);
      if (typeof r !== 'string') { r.apply(); rules.push(r); }
    }
    items.remove(id);
  }
  if (!rules.length) return items;
  return {
    label,
    apply: () => { items.apply(); for (const r of rules) r.apply(); },
    invert: () => { for (let i = rules.length - 1; i >= 0; i--) rules[i].invert(); items.invert(); },
  };
}

/** Joins a roads/buildings journal and an items one into a single command. */
function both(label: string, j: RoadJournal, items: Command | null): Command {
  if (!items) return j;
  return { label, apply: () => { j.apply(); items.apply(); }, invert: () => { items.invert(); j.invert(); } };
}

/** Demolishes the target (already applied; the command comes back to be recorded). */
export function demolishTarget(world: World, t: NonNullable<Target>): { cmd: Command; charge: number } {
  if (t.kind === 'item') return { cmd: removeItems(world, 'remover item', [t.id]), charge: 0 };
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

/** Everything inside the rectangle (x0, z0)–(x1, z1): roads by the segment's middle, buildings by the centre, items by their start. */
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
  const items = its.length ? removeItems(world, 'demolir área', its) : null;
  return { cmd: both('demolir área', j, items), count: segs.length + blds.length + its.length, charge: j.charge };
}
