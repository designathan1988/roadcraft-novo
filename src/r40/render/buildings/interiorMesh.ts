// Part of the R40 building mesh pipeline (split by responsibility).
import { default as earcut } from '../../../vendor/earcut.js';
import { levelElevation, levelHeight, liftAt, volumeElevation } from '../../world/buildings/geometry.ts';
import { FURNITURE_KINDS, FURNITURE_SIZE, type Furniture, type FurnitureKind, interiorAt, levelFlights } from '../../world/buildings/interior.ts';
import { floorKind } from './roomBehind.ts';
import { localFootprint } from '../../world/buildings/footprints.ts';
import { m } from '../../world/units.ts';
import { type Building, volumeTop } from '../../world/buildings/types.ts';
import type { PartBatch } from './chunk.ts';
import { paint, Emitter, furnitureRows, Shell, type V3, type FurnitureSink, type PartSink } from './meshCore.ts';

export const FLOOR_FINISH = paint({ finish: 'stone', colour: 0xb9b2a5 });

export const WOOD_FLOOR = paint({ finish: 'wood', colour: 0xa27548 });

export const PORCELAIN_FLOOR = paint({ finish: 'stone', colour: 0xd9d3c7 });

export const SHAFT = paint({ finish: 'concrete', colour: 0xb9b6ae });

export const CAB = paint({ finish: 'metal', colour: 0x9aa3a8 });

export const STEP = paint({ finish: 'stone', colour: 0xc9c2b3 });

export function emitInterior(e: Emitter, b: Building, floor: number, cut: number): void {
  // The cut floor's height where a point of the plan is: each block's own, on a split level (`Volume.lift`).
  const zAt = (x: number, y: number): number => floor + liftAt(b, cut, x, y) + levelElevation(b, cut);
  // Homes and hotels have wooden floors; everywhere else, stone (the windows show the same, `roomBehind.ts`).
  const kind = floorKind(b, cut);
  const floorLook = kind === 1 ? FLOOR_FINISH : kind === 2 ? PORCELAIN_FLOOR : WOOD_FLOOR;
  for (const v of b.volumes) {
    if (v.mode === 'void' || v.mode === 'intersect' || v.open) continue;
    if (!(v.base <= cut && volumeTop(v) > cut)) continue;
    const z = floor + volumeElevation(b, v, cut);
    const flat = localFootprint(v).flatMap((p) => [p.x, p.y]);
    const triangles = earcut(flat);
    for (let i = 0; i < triangles.length; i += 3) {
      const p = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!].map((k) => e.L(flat[2 * k]!, flat[2 * k + 1]!, z + 0.04));
      e.shell.face(p as [V3, V3, V3], [0, 0, 1], floorLook);
    }
  }
  const u = b.module;
  const wall = m(0.2);
  for (const core of b.cores) {
    if (core.from > cut || core.to < cut) continue;
    const w = core.kind === 'stair' ? u * 2 : u;
    const x0 = core.x, y0 = core.y, x1 = core.x + w, y1 = core.y + u;
    const lift = liftAt(b, cut, x0 + w / 2, y0 + u / 2);
    const z = floor + lift + levelElevation(b, cut);
    const top = floor + lift + levelElevation(b, cut + 1) - m(0.3);
    const z0 = floor + lift + levelElevation(b, core.from);
    // The shaft: four walls, the front one with a doorway at this floor.
    e.box(x0, y1 - wall, x1, y1, z0, top, SHAFT);
    e.box(x0, y0, x0 + wall, y1, z0, top, SHAFT);
    e.box(x1 - wall, y0, x1, y1, z0, top, SHAFT);
    const door = Math.min(w * 0.5, m(1.2));
    const mid = (x0 + x1) / 2;
    e.box(x0, y0, mid - door / 2, y0 + wall, z0, top, SHAFT);
    e.box(mid + door / 2, y0, x1, y0 + wall, z0, top, SHAFT);
    e.box(mid - door / 2, y0, mid + door / 2, y0 + wall, z + m(2.2), top, SHAFT);
    if (core.kind === 'lift' || core.kind === 'stairLift') {
      // The car, standing at this floor.
      e.box(x0 + wall + m(0.1), y0 + wall + m(0.1), x1 - wall - m(0.1), y1 - wall - m(0.1), z + 0.05, z + m(2.3), CAB);
    }
    if (core.kind === 'stair' || core.kind === 'stairLift') {
      // A flight rising along the back of the shaft, and the landing.
      const steps = 12;
      const run = (x1 - x0 - 2 * wall) / steps;
      const rise = levelHeight(b, cut) / steps;
      for (let k = 0; k < steps; k++) {
        const sx = x0 + wall + k * run;
        e.box(sx, y0 + (y1 - y0) / 2, sx + run, y1 - wall, z, z + rise * (k + 1), STEP);
      }
    }
  }
  // The flights between blocks at floors of their own (a split level, `levelFlights`)
  for (const f of levelFlights(b, cut)) {
    const run = Math.hypot(f.top.x - f.foot.x, f.top.y - f.foot.y);
    const ux = (f.top.x - f.foot.x) / run, uy = (f.top.y - f.foot.y) / run;
    const tread = run / f.risers, rise = (f.z1 - f.z0) / f.risers, half = f.width / 2;
    for (let k = 0; k < f.risers; k++) {
      const a = { x: f.foot.x + ux * tread * k, y: f.foot.y + uy * tread * k };
      const c = { x: f.foot.x + ux * tread * (k + 1), y: f.foot.y + uy * tread * (k + 1) };
      const x0 = Math.min(a.x, c.x) - Math.abs(uy) * half, x1 = Math.max(a.x, c.x) + Math.abs(uy) * half;
      const y0 = Math.min(a.y, c.y) - Math.abs(ux) * half, y1 = Math.max(a.y, c.y) + Math.abs(ux) * half;
      e.box(x0, y0, x1, y1, floor + f.z0, floor + f.z0 + rise * (k + 1), STEP);
    }
  }
  // The rooms: their walls, with doorways, and what is in them.
  const inside = interiorAt(b, cut);
  const wallRise = Math.min(levelHeight(b, cut) - m(0.4), m(2.7));
  // Walls across the camera's line of sight come down to a skirting, as in The Sims
  const view = b.cutView;
  const viewLocal = view ? { x: view.x * Math.cos(b.rotation) + view.y * Math.sin(b.rotation), y: -view.x * Math.sin(b.rotation) + view.y * Math.cos(b.rotation) } : null;
  for (const p of inside.partitions) {
    const t = m(0.06);
    const len = Math.hypot(p.x1 - p.x0, p.y1 - p.y0) || 1;
    // The wall's normal against the view: near 1 means it faces the camera.
    const facing = viewLocal ? Math.abs((-(p.y1 - p.y0) / len) * viewLocal.x + ((p.x1 - p.x0) / len) * viewLocal.y) : 0;
    const z = zAt((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2);
    const top = facing > 0.6 ? z + m(0.9) : z + wallRise;
    e.box(Math.min(p.x0, p.x1) - t, Math.min(p.y0, p.y1) - t, Math.max(p.x0, p.x1) + t, Math.max(p.y0, p.y1) + t, z, top, PARTITION);
  }
  // A ceiling light hangs from the ceiling; everything else stands on the floor.
  for (const f of inside.furniture) {
    const z = zAt(f.x, f.y);
    placeFurniture(e, f, f.kind === 'ceilingLamp' ? z + levelHeight(b, cut) - m(0.06) - f.h : z);
  }
}

export function placeFurniture(e: Emitter, f: Furniture, floorZ: number): void {
  const [w, d, h] = FURNITURE_SIZE[f.kind];
  const p = e.L(f.x, f.y, floorZ + 0.05);
  const front = e.N(Math.sin(f.angle), -Math.cos(f.angle));
  furnitureRows(e.furniture, f.kind).add(p[0], p[1], p[2], Math.atan2(front[0], -front[1]), f.w / w, f.h / h, f.d / d);
}

export const PARTITION = paint({ finish: 'plaster', colour: 0xece6da });

export function interiorFurniture(b: Building, floor: number): Partial<Record<FurnitureKind, PartBatch>> {
  const placed: FurnitureSink = {};
  const e = new Emitter(b, new Shell(), {} as PartSink, placed);
  let top = 0;
  for (const v of b.volumes) if (!v.open && v.mode !== 'void') top = Math.max(top, volumeTop(v));
  for (let level = 0; level < top; level++) {
    for (const f of interiorAt(b, level).furniture) {
      // Each piece on its own block's floor (a split level, `Volume.lift`).
      const z = floor + liftAt(b, level, f.x, f.y) + levelElevation(b, level);
      placeFurniture(e, f, f.kind === 'ceilingLamp' ? z + levelHeight(b, level) - m(0.06) - f.h : z);
    }
    // Enough to fill the air when it breaks; a tower's every chair cost a second.
    if (Object.values(placed).reduce((n, l) => n + (l?.count ?? 0), 0) > 140) break;
  }
  const out: Partial<Record<FurnitureKind, PartBatch>> = {};
  for (const kind of FURNITURE_KINDS) {
    const rows = placed[kind];
    if (!rows?.count) continue;
    out[kind] = rows.batch();
  }
  return out;
}
