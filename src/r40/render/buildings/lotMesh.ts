// Part of the R40 building mesh pipeline (split by responsibility).
import { clearOf, elementPaint, emitElement, flightFeet, looseParts } from './elementMesh.ts';

import { default as earcut } from '../../../vendor/earcut.js';
import { resolveBlocks } from '../../world/buildings/blocks.ts';
import { type LotSurface as LotPlane, lotSurfaces } from '../../world/buildings/lots.ts';
import { POOL_SINK } from '../../world/buildings/pads.ts';
import { localToWorld } from '../../world/buildings/geometry.ts';
import { localFootprint } from '../../world/buildings/footprints.ts';


import { m } from '../../world/units.ts';
import { type Entrance, type GroundAt, type PavedAt } from '../../world/buildings/foundation.ts';

import { FOLLOWS_GROUND, elementRect, followPieces, onGround, partGroups } from '../../world/buildings/elements.ts';
import { isRetainingStone } from '../../world/buildings/cityBuildings.ts';
import { HEIGHT_SPACING, MAP_HALF } from '../../../config.ts';
import { highestGroundUnder } from './lawnGround.ts';
import { type Building, type BuildingElement, type Volume, type LotSurface } from '../../world/buildings/types.ts';
import { LOT_COLOURS } from './massing.ts';
import type { LotGround, LotGroundRecipe } from './chunk.ts';
import { paint, Shell, Emitter, type Paint, type PartSink, type V3 } from './meshCore.ts';


export const LOT_PAINT: Readonly<Record<LotSurface, Paint>> = {
  grass: paint({ finish: 'concrete', colour: LOT_COLOURS.grass }),
  paving: paint({ finish: 'stone', colour: LOT_COLOURS.paving }),
  gravel: paint({ finish: 'concrete', colour: LOT_COLOURS.gravel }),
  sand: paint({ finish: 'plaster', colour: LOT_COLOURS.sand }),
  water: paint({ finish: 'glass', colour: LOT_COLOURS.water }),
  asphalt: paint({ finish: 'concrete', colour: LOT_COLOURS.asphalt }),
  concrete: paint({ finish: 'concrete', colour: LOT_COLOURS.concrete }),
  pavers: paint({ finish: 'brick', colour: LOT_COLOURS.pavers }),
  tiles: paint({ finish: 'ceramic', colour: LOT_COLOURS.tiles }),
};

export const LOT_KERB = paint({ finish: 'stone', colour: 0xb3ada0 });

export const KERB_INSET = m(0.012);

export const POOL_TILE = paint({ finish: 'ceramic', colour: 0x9fd0dc });

export const POOL_FLOOR = paint({ finish: 'plaster', colour: 0x8fd3e6 });

export const POOL_COPING = paint({ finish: 'stone', colour: 0xeeebe2 });

export const POOL_WATER_DROP = m(0.12);

/**
 * The lattice the ground is drawn on, this engine's: height samples every HEIGHT_SPACING from the map's edge
 * (world/heights.ts, read bilinear). DO NOT use 4.0's plate lattice (6.4 m from a plate's centre): the lawn's
 * highest point under a laid part was read off the wrong corners, and parts sank into or floated over the ground.
 */
export const LAWN_LATTICE = { cell: HEIGHT_SPACING, half: MAP_HALF } as const;

export function emitLots(b: Building, lots: readonly Volume[], withParts: boolean, groundAt: GroundAt, shell: Shell,
  parts: PartSink, buildingFloor?: number, pavedAt?: PavedAt,
  onLot?: (el: BuildingElement) => boolean, entrances?: readonly Entrance[]): LotGround | undefined {
  if (lots.length === 0) return lotGroundOf(b, [], buildingFloor, false);
  const e = new Emitter(b, shell, parts);
  const at = (lx: number, ly: number): number => {
    const w = e.L(lx, ly, 0);
    return groundAt(w[0], w[1]);
  };
  let floor = -Infinity;
  for (const v of lots) {
    for (const p of localFootprint(v)) floor = Math.max(floor, at(p.x, p.y));
    floor = Math.max(floor, at(v.x + v.w / 2, v.y + v.d / 2));
  }
  // A building's own yard - its car park, its garden - meets its ground floor at the back and the street at the front
  const level = buildingFloor !== undefined ? buildingFloor : floor + m(0.12);
  const surfaces = lotSurfaces(b, level, pavedAt);
  // Where the doors' flights stand: a path laid to a door stops at the foot of its steps.
  const feet = buildingFloor !== undefined ? flightFeet(b, groundAt, pavedAt, buildingFloor, entrances) : [];
  let low = Infinity;
  for (const v of lots) for (const p of localFootprint(v)) low = Math.min(low, at(p.x, p.y));
  const heightOf = new Map<Volume, (lx: number, ly: number) => number>();
  for (const s of surfaces) {
    heightOf.set(s.volume, (lx, ly) => {
      const w = e.L(lx, ly, 0);
      return s.heightAt(w[0], w[1]);
    });
  }
  for (const v of lots) {
    const height = heightOf.get(v) ?? (() => level);
    // A lawn is the terrain itself, graded to the lot (`pads.ts`), and drawn with the terrain's grass: no plate, no kerb.
    if ((v.open ?? 'grass') === 'grass') continue;
    const water = v.open === 'water';
    // A pool: its floor down at the bottom, the water itself a separate glossy surface just under the coping (`water` part).
    const look = water ? POOL_FLOOR : LOT_PAINT[v.open ?? 'grass'] ?? LOT_KERB;
    const sink = water ? POOL_SINK : 0;
    if (water) {
      const cx = v.x + v.w / 2, cy = v.y + v.d / 2;
      const rim = height(cx, cy);
      const centre = e.L(cx, cy, 0);
      e.parts.water.add(centre[0], centre[1], rim - POOL_WATER_DROP - m(0.01), b.rotation, v.w, m(0.02), v.d);
      // The coping: a white stone band round the rim.
      const band = m(0.3), lift = m(0.04);
      const ring = [
        [v.x - band, v.y - band, v.x + v.w + band, v.y],
        [v.x - band, v.y + v.d, v.x + v.w + band, v.y + v.d + band],
        [v.x - band, v.y, v.x, v.y + v.d],
        [v.x + v.w, v.y, v.x + v.w + band, v.y + v.d],
      ] as const;
      for (const [qx0, qy0, qx1, qy1] of ring) {
        shell.face([e.L(qx0, qy0, rim + lift), e.L(qx1, qy0, rim + lift), e.L(qx1, qy1, rim + lift), e.L(qx0, qy1, rim + lift)], [0, 0, 1], POOL_COPING);
      }
    }
    if (v.outline) {
      // A shaped lot is laid level, at the height of its middle.
      const z = height(v.x + v.w / 2, v.y + v.d / 2) - sink;
      const ring = localFootprint(v);
      const flat = ring.flatMap((p) => [p.x, p.y]);
      const triangles = earcut(flat);
      for (let i = 0; i < triangles.length; i += 3) {
        const p = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!].map((k) => e.L(flat[2 * k]!, flat[2 * k + 1]!, z));
        shell.face(p as [V3, V3, V3], [0, 0, 1], look);
      }
    } else {
      // A grid fine enough to follow the street's fall.
      const nx = Math.max(1, Math.ceil(v.w / m(3))), ny = Math.max(1, Math.ceil(v.d / m(3)));
      const P = (i: number, j: number): V3 => {
        const lx = v.x + (v.w * i) / nx, ly = v.y + (v.d * j) / ny;
        return e.L(lx, ly, height(lx, ly) - sink);
      };
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          shell.face([P(i, j), P(i + 1, j), P(i + 1, j + 1)], [0, 0, 1], look);
          shell.face([P(i, j), P(i + 1, j + 1), P(i, j + 1)], [0, 0, 1], look);
        }
      }
    }
    // The kerb round it, down to the ground, so no edge stands in the air.
    const ring = localFootprint(v);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const nx = (q.y - p.y) / len;
      const ny = -(q.x - p.x) / len;
      const tx = (q.x - p.x) / len, ty = (q.y - p.y) / len;
      const steps = Math.max(1, Math.ceil(len / m(3)));
      for (let k = 0; k < steps; k++) {
        const ax = p.x + ((q.x - p.x) * k) / steps, ay = p.y + ((q.y - p.y) * k) / steps;
        const bx = p.x + ((q.x - p.x) * (k + 1)) / steps, by = p.y + ((q.y - p.y) * (k + 1)) / steps;
        const za = height(ax, ay), zb = height(bx, by);
        const foot = Math.min(Math.min(za, zb) - m(0.3), Math.min(at(ax, ay), at(bx, by)) - m(0.15));
        if (sink > 0) {
          // A pool's or a pond's side, tiled, from the water up to the rim.
          shell.face([e.L(ax, ay, za), e.L(bx, by, zb), e.L(bx, by, zb - sink), e.L(ax, ay, za - sink)], e.N(-nx, -ny), POOL_TILE);
        } else {
          // Set in under the plate's edge (`KERB_INSET`), and cut short at the corners by as much
          const sa = k === 0 ? KERB_INSET : 0, sb = k === steps - 1 ? KERB_INSET : 0;
          const kax = ax - nx * KERB_INSET + tx * sa, kay = ay - ny * KERB_INSET + ty * sa;
          const kbx = bx - nx * KERB_INSET - tx * sb, kby = by - ny * KERB_INSET - ty * sb;
          shell.face([e.L(kax, kay, foot), e.L(kbx, kby, foot), e.L(kbx, kby, zb), e.L(kax, kay, za)], e.N(nx, ny), LOT_KERB);
        }
      }
    }
  }
  const loose = looseParts(b);
  // DO NOT take the first lot that holds it.
  const hostAt = (x: number, y: number): Volume | undefined => {
    let lawn: Volume | undefined;
    for (const v of lots) {
      if (x < v.x || x > v.x + v.w || y < v.y || y > v.y + v.d) continue;
      if ((v.open ?? 'grass') !== 'grass') return v;
      lawn ??= v;
    }
    return lawn;
  };
  const onLawn = (x: number, y: number): boolean => {
    const host = hostAt(x, y);
    return !host || ((host.open ?? 'grass') === 'grass' && host.terrace === undefined);
  };
  const groups = partGroups(b);
  const earthworks = new Set<number>();
  for (const el of b.elements ?? []) {
    const g = groups.get(el.id);
    if (g !== undefined && (el.kind === 'stair' || el.kind === 'ramp' || isRetainingStone(el.material))) earthworks.add(g);
  }
  const seats = new Map<number, { base: number; lowest: number }>();
  {
    const lowest = new Map<number, number>();
    // Only what stands on the land is seated on it
    const standing = new Set<number>();
    for (const el of b.elements ?? []) {
      const g = groups.get(el.id);
      if (g === undefined) continue;
      lowest.set(g, Math.min(lowest.get(g) ?? Infinity, el.z));
      if (onGround(el)) standing.add(g);
    }
    for (const el of b.elements ?? []) {
      const g = groups.get(el.id);
      if (g === undefined || !standing.has(g) || earthworks.has(g) || el.z > lowest.get(g)! + m(0.05)) continue;
      const [x0, y0, x1, y1] = elementRect(el);
      const points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]] as const;
      const lawn = points.filter(([px, py]) => onLawn(px, py));
      if (lawn.length === 0) continue;
      // All on the lawn: the highest the drawn ground rises anywhere under it, ridges of the terrain's triangles included
      const ground = lawn.length === points.length
        ? highestGroundUnder(points.slice(0, 4).map(([px, py]) => { const w = e.L(px, py, 0); return [w[0], w[1]] as const; }), groundAt, LAWN_LATTICE)
        : Math.max(...lawn.map(([px, py]) => at(px, py)));
      const seat = seats.get(g);
      if (!seat) seats.set(g, { base: ground, lowest: lowest.get(g)! });
      else seat.base = Math.max(seat.base, ground);
    }
  }
  for (const el of b.elements ?? []) {
    if ((!withParts && !onLot?.(el)) || loose?.has(el.id)) continue;
    const look = el.material ? paint(el.material) : elementPaint(b, el.kind);
    const group = groups.get(el.id);
    const seat = group === undefined ? undefined : seats.get(group);
    if (seat && onLawn(el.x, el.y)) {
      // Its height within the object kept; its lowest parts at the seat.
      const placed = { ...el, z: el.z - seat.lowest };
      for (const piece of placed.kind === 'pavement' ? clearOf(placed, feet) : [placed]) {
        emitElement(e, piece, seat.base, Math.min(low, seat.base) - m(0.3), look);
      }
      continue;
    }
    // A run on the land in steps, each on the lot's surface under it, or on the ground where no lot is laid
    for (const piece of followPieces(el).flatMap((p) => (p.kind === 'pavement' ? clearOf(p, feet) : [p]))) {
      const host = hostAt(piece.x, piece.y);
      // On a lawn the ground is the terrain as drawn (`pads.ts`), not the lot's plane
      const height = host && (host.open ?? 'grass') !== 'grass' ? heightOf.get(host) : undefined;
      // A part raised or lowered with a paving at a level of its own
      const base = height && host && !FOLLOWS_GROUND.has(piece.kind) ? host.ramp ?? host.terrace ?? 0 : 0;
      const z = height ? height(piece.x, piece.y) - base : FOLLOWS_GROUND.has(piece.kind) ? at(piece.x, piece.y) : level;
      emitElement(e, piece, z, Math.min(low, z) - m(0.3), look, height);
    }
  }
  return lotGroundOf(b, surfaces, level, true);
}

export function lotGroundAgain(b: Building, recipe: LotGroundRecipe, pavedAt?: PavedAt): LotGround | undefined {
  const resolved = resolveBlocks(b);
  const surfaces = recipe.lots && recipe.level !== undefined ? lotSurfaces(resolved, recipe.level, pavedAt) : [];
  return lotGroundOf(resolved, surfaces, recipe.level, recipe.lots);
}

export function lotGroundOf(b: Building, surfaces: readonly LotPlane[], level: number | undefined, lots: boolean): LotGround | undefined {
  const bays = (b.elements ?? []).filter((el) => el.kind === 'parking').map((el) => {
    const [x0, y0, x1, y1] = elementRect(el);
    return [localToWorld(b, x0, y0), localToWorld(b, x1, y0), localToWorld(b, x1, y1), localToWorld(b, x0, y1)];
  });
  if (surfaces.length === 0 && bays.length === 0) return undefined;
  // The box of every lot and bay: a point outside it is off them all, found without a ring test each
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of [...surfaces.map((s) => s.ring), ...bays]) {
    for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  }
  return {
    recipe: { level, lots },
    heightAt(x, y) {
      if (x < x0 || x > x1 || y < y0 || y > y1) return NaN;
      for (const s of surfaces) if (insideRing(s.ring, x, y)) return s.heightAt(x, y);
      if (level !== undefined) for (const ring of bays) if (insideRing(ring, x, y)) return level;
      return NaN;
    },
  };
}

export function insideRing(ring: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, c = ring[j]!;
    if ((a.y > y) !== (c.y > y) && x < ((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
