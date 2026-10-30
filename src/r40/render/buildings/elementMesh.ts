// Lot elements: paths, stairs, fences, flowers, rocks, parking, gates and the lot furniture.
// Part of the R40 building mesh pipeline (split by responsibility).
import { identityMemo } from '../../core/identityMemo.ts';




import { SIDE_NORMAL, bayWidth, closedBlocks, coveredSpans, exposedParts, levelHeight, sideStart } from '../../world/buildings/geometry.ts';
import { edgeFrame, localFootprint } from '../../world/buildings/footprints.ts';
import { COVER_INSET } from './shellParts.ts';
import type { Vec2 } from '../../core/vec2.ts';
import { m } from '../../world/units.ts';
import { type Entrance, type Foundation, type GroundAt, type PavedAt, flightRun, foundationOf } from '../../world/buildings/foundation.ts';
import { paletteOf } from '../../world/buildings/materials.ts';
import { elementRect, onGround, stairSteps, unsupportedElements } from '../../world/buildings/elements.ts';



import { type Building, type BuildingElement, type FaceId, type Volume } from '../../world/buildings/types.ts';


import { paint, Emitter, shaded, PART_INSET, openingOf, PLINTH_GROW, type Paint, type V3 } from './meshCore.ts';


export const ELEMENT_CONCRETE: Paint = paint({ finish: 'concrete', colour: 0xcfcac0 });

export function elementPaint(b: Building, kind: BuildingElement['kind']): Paint {
  switch (kind) {
    case 'canopy': return ELEMENT_CONCRETE;
    case 'wall': return paint(paletteOf(b).wall);
    case 'stair':
    case 'ramp':
    case 'pavement': return PAVING;
    case 'fence': return paint({ finish: 'metal', colour: 0x4b5153 });
    case 'tree': return TRUNK;
    case 'bench': return paint({ finish: 'wood', colour: 0x8a6a45 });
    case 'ac': return paint({ finish: 'metal', colour: 0xd7dade });
    case 'planter': return paint({ finish: 'concrete', colour: 0xb9b3a8 });
    default: return ELEMENT_CONCRETE;
  }
}

export const CLOCK_FACE = paint({ finish: 'plaster', colour: 0xf4f1e8 });

export const CLOCK_INK = paint({ finish: 'metal', colour: 0x23272b });

export function emitClock(e: Emitter, el: BuildingElement, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): void {
  e.box(x0, y0, x1, y1, z0, z1, CLOCK_INK);
  const along = el.facing === 0 || el.facing === 2;
  const a0 = along ? x0 : y0;
  const a1 = along ? x1 : y1;
  // The front plane and the way out of it.
  const front = el.facing === 0 ? y0 : el.facing === 2 ? y1 : el.facing === 1 ? x1 : x0;
  const out = el.facing === 0 || el.facing === 3 ? -1 : 1;
  const size = Math.min(a1 - a0, z1 - z0);
  const ca = (a0 + a1) / 2;
  const cz = (z0 + z1) / 2;
  const layer = (u0: number, u1: number, h0: number, h1: number, d0: number, d1: number, c: Paint): void => {
    const p0 = front + out * d0;
    const p1 = front + out * d1;
    if (along) e.box(u0, Math.min(p0, p1), u1, Math.max(p0, p1), h0, h1, c);
    else e.box(Math.min(p0, p1), u0, Math.max(p0, p1), u1, h0, h1, c);
  };
  const r = size * 0.42;
  layer(ca - r, ca + r, cz - r, cz + r, 0, m(0.04), CLOCK_FACE);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const ua = ca + Math.sin(a) * r * 0.82;
    const uz = cz + Math.cos(a) * r * 0.82;
    const t = size * (k % 3 === 0 ? 0.05 : 0.03);
    layer(ua - t, ua + t, uz - t, uz + t, m(0.04), m(0.07), CLOCK_INK);
  }
  const w = size * 0.03;
  layer(ca - w, ca + w, cz, cz + r * 0.55, m(0.07), m(0.1), CLOCK_INK);
  layer(ca, ca + r * 0.78, cz - w, cz + w, m(0.1), m(0.12), CLOCK_INK);
}

export const looseParts = identityMemo((b: Building): ReadonlySet<number> | null => {
  if (b.lotPlan === undefined || !b.elements?.length) return null;
  const loose = unsupportedElements(b);
  return loose.size ? loose : null;
});

export function emitElement(e: Emitter, el: BuildingElement, floor: number, bottom: number, c: Paint,
  surface?: (lx: number, ly: number) => number): void {
  const was = e.inElement;
  e.inElement = true;
  try {
    layElement(e, el, floor, bottom, c, surface);
  } finally {
    e.inElement = was;
  }
}

export function layElement(e: Emitter, el: BuildingElement, floor: number, bottom: number, c: Paint,
  surface?: (lx: number, ly: number) => number): void {
  const [x0, y0, x1, y1] = elementRect(el);
  const zb = onGround(el) ? bottom : floor + el.z;
  const z0 = floor + el.z;
  const z1 = z0 + el.h;
  if (el.kind === 'clock') {
    emitClock(e, el, x0, y0, x1, y1, z0, z1);
    return;
  }
  if (el.kind === 'stair' || el.kind === 'ramp') {
    // The run measured from the foot (the `facing` end) inwards.
    const sub = (u0: number, u1: number): [number, number, number, number] => {
      switch (el.facing) {
        case 0: return [x0, y0 + u0, x1, y0 + u1];
        case 2: return [x0, y1 - u1, x1, y1 - u0];
        case 3: return [x0 + u0, y0, x0 + u1, y1];
        default: return [x1 - u1, y0, x1 - u0, y1];
      }
    };
    if (el.kind === 'stair' && el.angle) {
      // A stair laid along a traced path
      emitTurnedStair(e, el, z0, zb, c);
      return;
    }
    if (el.kind === 'stair') {
      const n = stairSteps(el);
      const tread = el.d / n;
      // A low flight is solid, like steps cast in place.
      if (el.h <= STAIR_SOLID) {
        for (let k = 0; k < n; k++) {
          const [a0, b0, a1, b1] = sub(k * tread, (k + 1) * tread);
          e.box(a0, b0, a1, b1, zb, z0 + ((k + 1) * el.h) / n, c);
        }
        // Three steps up to a door without a rail read as a heap of blocks: a flight taller than a kerb carries its handrail too.
        if (el.h > m(0.5)) emitStairRails(e, el, [x0, y0, x1, y1], z0);
        return;
      }
      emitOpenStair(e, el, [x0, y0, x1, y1], z0, zb, c);
      return;
    }
    // A ramp: its slope, rising from the foot, over two cheeks.
    const foot = sub(0, 0);
    const head = sub(el.d, el.d);
    const [fa0, fb0, fa1, fb1] = foot;
    const [ha0, hb0, ha1, hb1] = head;
    const nf = SIDE_NORMAL[el.facing];
    const slope = el.h / el.d;
    const alongX = el.facing === 1 || el.facing === 3;
    const footPts: [V3, V3] = alongX ? [e.L(fa0, fb0, z0), e.L(fa0, fb1, z0)] : [e.L(fa0, fb0, z0), e.L(fa1, fb0, z0)];
    const headPts: [V3, V3] = alongX ? [e.L(ha0, hb0, z1), e.L(ha0, hb1, z1)] : [e.L(ha0, hb0, z1), e.L(ha1, hb0, z1)];
    e.shell.face([footPts[0], footPts[1], headPts[1], headPts[0]], e.N(nf.x * slope, nf.y * slope, 1), c);
    const cheek = (i: 0 | 1, n: V3): void => {
      const f = footPts[i];
      const h = headPts[i];
      e.shell.face([[f[0], f[1], zb], [h[0], h[1], zb], h, f], n, c);
    };
    const t = alongX ? e.N(0, 1) : e.N(1, 0);
    cheek(0, [-t[0], -t[1], 0]);
    cheek(1, t);
    e.shell.face([[footPts[0][0], footPts[0][1], zb], [footPts[1][0], footPts[1][1], zb], footPts[1], footPts[0]], e.N(nf.x, nf.y), c);
    e.shell.face([[headPts[0][0], headPts[0][1], zb], [headPts[1][0], headPts[1][1], zb], headPts[1], headPts[0]], e.N(-nf.x, -nf.y), c);
    return;
  }
  // Trees, shrubs and hedges are the scenery's plants (`scenery.ts`, `buildGardens`)
  if (el.kind === 'tree' || el.kind === 'shrub' || el.kind === 'hedge') return;
  if (el.kind === 'railing') {
    emitFence(e, el, z0, z1, c, true);
    return;
  }
  if (el.kind === 'flowers') {
    emitFlowers(e, el, z0, zb);
    return;
  }
  if (el.kind === 'rocks') {
    emitRocks(e, el, z0, zb, c);
    return;
  }
  if (el.kind === 'parking') {
    emitParking(e, el, z0, surface);
    return;
  }
  if (el.kind === 'gate' || el.kind === 'bin' || el.kind === 'lamp' || el.kind === 'bollard' || el.kind === 'drain') {
    emitLotPart(e, el, x0, y0, x1, y1, z0, zb, c);
    return;
  }
  if (el.kind === 'awning') {
    // A canvas falling from the wall to its free edge, with a valance.
    const drop = el.h;
    const free = sub2(el, [x0, y0, x1, y1], 0.92, 1);
    const n = SIDE_NORMAL[el.facing];
    e.box(x0, y0, x1, y1, z0 - drop * 0.55, z0 + drop * 0.1, shadeOf(el));
    e.box(free[0], free[1], free[2], free[3], z0 - drop * 0.8, z0 - drop * 0.45, shadeOf(el));
    void n;
    return;
  }
  if (el.kind === 'fence') {
    emitFence(e, el, z0, z1, c);
    return;
  }
  if (el.kind === 'bench') {
    // A seat on two legs and a back, facing the way it faces.
    e.box(x0, y0, x1, y1, z0 + m(0.35), z0 + m(0.45), c);
    const back = sub2(el, [x0, y0, x1, y1], 0, 0.12);
    e.box(back[0], back[1], back[2], back[3], z0 + m(0.45), z0 + m(0.95), c);
    for (const u of [0.15, 0.85]) {
      const leg = sub2(el, [x0, y0, x1, y1], u - 0.06, u + 0.06);
      e.box(leg[0], leg[1], leg[2], leg[3], zb, z0 + m(0.35), shaded(c, 0.85));
    }
    return;
  }
  if (el.kind === 'ac') {
    // A wall unit: the case, and a grille plate on the side it faces
    e.box(x0, y0, x1, y1, z0, z1, c);
    const g = sub2(el, [x0, y0, x1, y1], 0, 0.09);
    const end = m(0.04);
    if (el.facing === 0 || el.facing === 2) e.box(g[0] + end, g[1] - PART_INSET, g[2] - end, g[3], z0 + m(0.1), z1 - m(0.06), RAIL);
    else e.box(g[0] - PART_INSET, g[1] + end, g[2], g[3] - end, z0 + m(0.1), z1 - m(0.06), RAIL);
    return;
  }
  if (el.kind === 'planter') {
    e.box(x0, y0, x1, y1, zb, z1, c);
    const soil = m(0.06);
    e.box(x0 + soil, y0 + soil, x1 - soil, y1 - soil, z1 - m(0.05), z1 + m(0.02), PLANTER_SOIL);
    return;
  }
  if (el.kind === 'canopy') {
    // A cantilevered slab: a fascia down its free edge (the drip) and two steel brackets under it back to the wall.
    e.box(x0, y0, x1, y1, z0, z1, c);
    const n = SIDE_NORMAL[el.facing];
    const lip = m(0.05);
    // The fascia a little proud of the slab's edge and over its top
    const out = PART_INSET;
    const [lx0, ly0, lx1, ly1] = el.facing === 0 ? [x0, y0 - out, x1, y0 + lip] : el.facing === 2 ? [x0, y1 - lip, x1, y1 + out] : el.facing === 3 ? [x0 - out, y0, x0 + lip, y1] : [x1 - lip, y0, x1 + out, y1];
    e.box(lx0 - Math.abs(n.y) * lip, ly0 - Math.abs(n.x) * lip, lx1 + Math.abs(n.y) * lip, ly1 + Math.abs(n.x) * lip, z0 - m(0.12), z1 + out, shaded(c, 0.95));
    const across = el.facing === 0 || el.facing === 2;
    for (const t of [0.15, 0.85]) {
      const bx = across ? x0 + (x1 - x0) * t : (x0 + x1) / 2;
      const by = across ? (y0 + y1) / 2 : y0 + (y1 - y0) * t;
      const half = el.d * 0.35;
      e.box(
        across ? bx - m(0.04) : bx - half,
        across ? by - half : by - m(0.04),
        across ? bx + m(0.04) : bx + half,
        across ? by + half : by + m(0.04),
        z0 - m(0.35),
        z0,
        RAIL,
      );
    }
    return;
  }
  if (el.kind === 'wall' && onGround(el) && el.h <= m(3.2)) {
    // A boundary wall: its body, a darker plinth at the foot where the rain splashes
    const along = x1 - x0 >= y1 - y0;
    const lip = m(0.04);
    const cap = m(0.07);
    // And walls that cross in plan (a sink set against another of the yard's walls, 2026-10-13) each at a course of their own
    const foot = z0 + (along ? m(0.22) : m(0.23)) + m(0.02) * (el.id % 3);
    // Past the ends by `PART_INSET`; the plinth and the coping proud of both faces by `lip`.
    const ex = along ? PART_INSET : 0, ey = along ? 0 : PART_INSET;
    const gx = along ? PART_INSET : lip, gy = along ? lip : PART_INSET;
    e.box(x0 - ex, y0 - ey, x1 + ex, y1 + ey, foot, z1 - cap, c);
    e.box(x0 - gx, y0 - gy, x1 + gx, y1 + gy, zb, foot, shaded(c, 0.78));
    e.box(x0 - gx, y0 - gy, x1 + gx, y1 + gy, z1 - cap, z1, COPING, COPING);
    return;
  }
  if (el.kind === 'pavement') {
    // A paving's sides stand in from its top's edge (`COVER_INSET`): a wall or a gate on that edge keeps the face there.
    e.slab(x0, y0, x1, y1, zb, z1, COVER_INSET, c);
    return;
  }
  e.box(x0, y0, x1, y1, zb, z1, c);
}

export const COPING: Paint = paint({ finish: 'stone', colour: 0xc9c3b6 });

export const APRON = m(0.9);

export const PATH_WIDTH = m(1.4);

export const PATH_REACH = m(14);

export const LOT_LIFT = m(0.024);

export const PAVING: Paint = paint({ finish: 'stone', colour: 0xbdb5a6 });

export function flightSpan(b: Building, v: Volume, x: Entrance): [number, number] {
  const o = openingOf(x.component, x.width, levelHeight(b, 0)) ?? { a0: x.width * 0.2, a1: x.width * 0.8 };
  const half = (o.a1 - o.a0 + m(0.5)) / 2;
  const middle = x.index * bayWidth(b, v, x.side) + x.width / 2;
  return [middle - half, middle + half];
}

export type PlanRect = readonly [number, number, number, number];

export function flightFeet(b: Building, groundAt: GroundAt, pavedAt: PavedAt | undefined, floor: number, entrances?: readonly Entrance[]): PlanRect[] {
  // The body's own list (`emitChunk`): its doors read off the bays it laid out (`bayLayout`), not worked out again.
  const closed = closedBlocks(b.volumes);
  if (closed.length === 0) return [];
  const built = { ...b, volumes: closed };
  const out: PlanRect[] = [];
  // The body's own (`emitBuilding`, the same floor and ground storey); worked out here only for a signature body, drawn by its own parts.
  for (const x of entrances ?? foundationOf(built, groundAt, undefined, pavedAt, floor).entrances) {
    if (x.steps <= 0 || x.recess > 0) continue;
    const v = closed.find((w) => w.id === x.volume);
    if (!v) continue;
    const [a0, a1] = flightSpan(built, v, x);
    const s = sideStart(v, x.side), n = edgeFrame(v, x.side);
    const xs: number[] = [], ys: number[] = [];
    for (const a of [a0, a1]) {
      for (const d of [x.push, x.push + flightRun(x.steps)]) {
        xs.push(s.x + s.tx * a + n.nx * d);
        ys.push(s.y + s.ty * a + n.ny * d);
      }
    }
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

export function clearOf(piece: BuildingElement, feet: readonly PlanRect[]): BuildingElement[] {
  if (feet.length === 0 || piece.angle) return [piece];
  let left: PlanRect[] = [elementRect(piece)];
  let cut = false;
  for (const [fx0, fy0, fx1, fy1] of feet) {
    const next: PlanRect[] = [];
    for (const r of left) {
      const [x0, y0, x1, y1] = r;
      if (fx0 >= x1 || fx1 <= x0 || fy0 >= y1 || fy1 <= y0) { next.push(r); continue; }
      cut = true;
      // The parts of `r` round the foot: below, above, then left and right between them.
      if (fy0 > y0) next.push([x0, y0, x1, fy0]);
      if (fy1 < y1) next.push([x0, fy1, x1, y1]);
      const my0 = Math.max(y0, fy0), my1 = Math.min(y1, fy1);
      if (fx0 > x0) next.push([x0, my0, fx0, my1]);
      if (fx1 < x1) next.push([fx1, my0, x1, my1]);
    }
    left = next;
  }
  if (!cut) return [piece];
  return left
    .filter(([x0, y0, x1, y1]) => x1 - x0 > m(0.05) && y1 - y0 > m(0.05))
    .map(([x0, y0, x1, y1]) => ({ ...piece, facing: 0, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, d: y1 - y0 }));
}

export function emitLot(e: Emitter, b: Building, f: Foundation, groundAt: GroundAt, pavedAt: PavedAt | undefined): void {
  const paved = (x: number, y: number): boolean => pavedAt !== undefined && Number.isFinite(pavedAt(x, y));
  const up: V3 = [0, 0, 1];
  const strip = (from: Vec2, to: Vec2, width: number, nx: number, ny: number): void => {
    // A strip `width` out from the line from -> to (local), along normal (nx, ny).
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const pieces = Math.max(1, Math.ceil(length / m(2)));
    for (let i = 0; i < pieces; i++) {
      const a = { x: from.x + ((to.x - from.x) * i) / pieces, y: from.y + ((to.y - from.y) * i) / pieces };
      const c = { x: from.x + ((to.x - from.x) * (i + 1)) / pieces, y: from.y + ((to.y - from.y) * (i + 1)) / pieces };
      const quad = [a, c, { x: c.x + nx * width, y: c.y + ny * width }, { x: a.x + nx * width, y: a.y + ny * width }];
      const world = quad.map((p) => e.L(p.x, p.y, 0));
      if (world.some((w) => paved(w[0], w[1]))) continue;
      e.shell.face(world.map((w) => [w[0], w[1], groundAt(w[0], w[1]) + LOT_LIFT] as V3), up, PAVING);
    }
  };
  // The flights standing out of the sides (by block and side): the apron is laid round their feet, not through them.
  const flights = new Map<string, { a0: number; a1: number; run: number }[]>();
  for (const x of f.entrances) {
    if (x.steps <= 0 || x.recess > 0) continue;
    const v = b.volumes.find((w) => w.id === x.volume);
    if (!v) continue;
    const [a0, a1] = flightSpan(b, v, x);
    const key = `${x.volume}:${x.side}`;
    flights.set(key, [...(flights.get(key) ?? []), { a0, a1, run: flightRun(x.steps) }]);
  }
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    const g = PLINTH_GROW;
    // Round the footprint the way it runs
    const ring = localFootprint(v);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length < 1e-6) continue;
      const tx = (q.x - p.x) / length, ty = (q.y - p.y) / length;
      const n = { x: ty, y: -tx };
      // Only along the outside: against another block of the ground the apron lay inside the building.
      const s = sideStart(v, i as FaceId);
      const reversed = s.tx * tx + s.ty * ty < 0;
      const toRing = ([a0, a1]: readonly [number, number]): [number, number] => (reversed ? [length - a1, length - a0] : [a0, a1]);
      const steps = (flights.get(`${v.id}:${i}`) ?? []).map((fl) => ({ span: toRing([fl.a0, fl.a1]), run: fl.run }));
      const covered = [...coveredSpans(b, v, i as FaceId, 0).map(toRing), ...steps.map((fl) => fl.span)]
        .sort((u, w) => u[0] - w[0]);
      for (const [p0, p1] of exposedParts(covered, 0, length)) {
        // Grown past the corner it starts from, to the plinth at the one it ends at.
        const a0 = p0 < 1e-6 ? -(g + APRON) : p0, a1 = p1 > length - 1e-6 ? length + g : p1;
        const from = { x: p.x + tx * a0 + n.x * g, y: p.y + ty * a0 + n.y * g };
        const to = { x: p.x + tx * a1 + n.x * g, y: p.y + ty * a1 + n.y * g };
        strip(from, to, APRON, n.x, n.y);
      }
      // In front of a flight, only past its foot.
      for (const { span: [s0, s1], run } of steps) {
        const out = Math.max(g, run);
        if (out >= g + APRON - 1e-6) continue;
        const from = { x: p.x + tx * s0 + n.x * out, y: p.y + ty * s0 + n.y * out };
        const to = { x: p.x + tx * s1 + n.x * out, y: p.y + ty * s1 + n.y * out };
        strip(from, to, g + APRON - out, n.x, n.y);
      }
    }
  }
  for (const x of f.entrances) {
    if (!pavedAt) break;
    // Where the paving is right there, the entrance already opens onto it.
    let reach = 0;
    for (let d = APRON; d <= PATH_REACH; d += m(0.5)) {
      if (paved(x.x + x.nx * d, x.y + x.ny * d)) {
        reach = d;
        break;
      }
    }
    if (reach <= APRON + m(0.5)) continue;
    const c = Math.cos(b.rotation);
    const s = Math.sin(b.rotation);
    // The entrance's point and normal in the local frame.
    const lx = (x.x - b.x) * c + (x.y - b.y) * s;
    const ly = -(x.x - b.x) * s + (x.y - b.y) * c;
    const nx = x.nx * c + x.ny * s;
    const ny = -x.nx * s + x.ny * c;
    const start = APRON + m(0.1) + flightRun(x.steps);
    const half = PATH_WIDTH / 2;
    strip(
      { x: lx + nx * start - ny * half, y: ly + ny * start + nx * half },
      { x: lx + nx * start + ny * half, y: ly + ny * start - nx * half },
      reach - start,
      nx,
      ny,
    );
  }
}

export const STAIR_SOLID = m(1.2);

export const TREAD = m(0.05);

export const WAIST = m(0.25);

export const HANDRAIL = m(0.95);

export function emitOpenStair(
  e: Emitter,
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  z0: number,
  zb: number,
  c: Paint,
): void {
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  // A point `u` along the run from the foot, `a` across it, at height z.
  const P = (u: number, a: number, z: number): V3 => {
    switch (el.facing) {
      case 0: return e.L(x0 + a, y0 + u, z);
      case 2: return e.L(x0 + a, y1 - u, z);
      case 3: return e.L(x0 + u, y0 + a, z);
      default: return e.L(x1 - u, y0 + a, z);
    }
  };
  const nf = SIDE_NORMAL[el.facing];
  const out = e.N(nf.x, nf.y);
  const across = el.facing === 0 || el.facing === 2 ? e.N(1, 0) : e.N(0, 1);
  const back: V3 = [-across[0], -across[1], 0];
  const w = el.w;
  for (let k = 0; k < n; k++) {
    const top = z0 + (k + 1) * riser;
    const u0 = k * tread;
    const u1 = (k + 1) * tread;
    // The riser (down to the step below, or to the ground for the first) and the tread.
    const below = k === 0 ? zb : z0 + k * riser - TREAD;
    e.shell.face([P(u0, 0, below), P(u0, w, below), P(u0, w, top), P(u0, 0, top)], out, c);
    e.shell.face([P(u0, 0, top), P(u0, w, top), P(u1, w, top), P(u1, 0, top)], [0, 0, 1], c);
    // The step's ends, down to the waist.
    const base = Math.max(zb, z0 + (el.h * u0) / el.d - WAIST);
    e.shell.face([P(u0, 0, base), P(u1, 0, base), P(u1, 0, top), P(u0, 0, top)], back, c);
    e.shell.face([P(u1, w, base), P(u0, w, base), P(u0, w, top), P(u1, w, top)], across, c);
  }
  // The waist: a raking slab under the steps, from the ground up to the top.
  const slope = el.h / el.d;
  const soffit = (u: number): number => Math.max(zb, z0 + slope * u - WAIST);
  e.shell.face([P(0, 0, soffit(0)), P(0, w, soffit(0)), P(el.d, w, soffit(el.d)), P(el.d, 0, soffit(el.d))], e.N(-nf.x * slope, -nf.y * slope, -1), c);
  emitStairRails(e, el, [x0, y0, x1, y1], z0);
}

export function emitStairRails(
  e: Emitter,
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  z0: number,
): void {
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const P = (u: number, a: number, z: number): V3 => {
    switch (el.facing) {
      case 0: return e.L(x0 + a, y0 + u, z);
      case 2: return e.L(x0 + a, y1 - u, z);
      case 3: return e.L(x0 + u, y0 + a, z);
      default: return e.L(x1 - u, y0 + a, z);
    }
  };
  const nf = SIDE_NORMAL[el.facing];
  const slope = el.h / el.d;
  const across = el.facing === 0 || el.facing === 2 ? e.N(1, 0) : e.N(0, 1);
  const back: V3 = [-across[0], -across[1], 0];
  const w = el.w;
  const rail = m(0.05);
  for (const a of [rail, w - rail]) {
    const r0 = z0 + riser + HANDRAIL;
    const r1 = z0 + el.h + HANDRAIL;
    e.shell.face([P(0, a - rail, r0), P(0, a + rail, r0), P(el.d, a + rail, r1), P(el.d, a - rail, r1)], e.N(nf.x * slope, nf.y * slope, 1), RAIL);
    e.shell.face([P(0, a + rail, r0 - rail * 2), P(el.d, a + rail, r1 - rail * 2), P(el.d, a + rail, r1), P(0, a + rail, r0)], across, RAIL);
    e.shell.face([P(el.d, a - rail, r1 - rail * 2), P(0, a - rail, r0 - rail * 2), P(0, a - rail, r0), P(el.d, a - rail, r1)], back, RAIL);
    const every = Math.max(1, Math.round(m(1.2) / tread));
    for (let k = 0; k < n; k += every) postAt(e, P, k * tread + tread / 2, a, z0 + (k + 1) * riser, HANDRAIL);
    postAt(e, P, el.d - tread / 2, a, z0 + el.h, HANDRAIL);
  }
}

export const RAIL: Paint = paint({ finish: 'metal', colour: 0x3a3f42 });

export const PLANTER_SOIL: Paint = paint({ finish: 'wood', colour: 0x3d2f22 });

export const TRUNK: Paint = paint({ finish: 'wood', colour: 0x5a4632 });

export function sub2(
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  u0: number,
  u1: number,
): [number, number, number, number] {
  if (el.facing === 0 || el.facing === 2) {
    const a = y0 + (y1 - y0) * u0;
    const b = y0 + (y1 - y0) * u1;
    return [x0, Math.min(a, b), x1, Math.max(a, b)];
  }
  const a = x0 + (x1 - x0) * u0;
  const b = x0 + (x1 - x0) * u1;
  return [Math.min(a, b), y0, Math.max(a, b), y1];
}

export function emitTurnedStair(e: Emitter, el: BuildingElement, z0: number, zb: number, c: Paint): void {
  const a = el.angle ?? 0;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // A point `u` along the run from the foot, `v` across it, at height z.
  const P = (u: number, v: number, z: number): V3 =>
    e.L(el.x + u * ca - v * sa, el.y + u * sa + v * ca, z);
  const hw = el.w / 2;
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const across: V3 = e.N(-sa, ca, 0);
  const back: V3 = e.N(-ca, -sa, 0);
  for (let k = 0; k < n; k++) {
    const u0 = k * tread;
    const u1 = (k + 1) * tread;
    const top = z0 + (k + 1) * riser;
    const base = k === 0 ? zb : z0 + k * riser - m(0.08);
    // The riser, then the tread.
    e.shell.face([P(u0, -hw, base), P(u0, hw, base), P(u0, hw, top), P(u0, -hw, top)], back, c);
    e.shell.face([P(u0, -hw, top), P(u0, hw, top), P(u1, hw, top), P(u1, -hw, top)], e.N(0, 0, 1), c);
    // The two cheeks, down to the flight's underside.
    const under = Math.max(zb, z0 + el.h * (u0 / el.d) - m(0.25));
    e.shell.face([P(u0, -hw, under), P(u1, -hw, under), P(u1, -hw, top), P(u0, -hw, top)], e.N(-across[0], -across[1], 0), c);
    e.shell.face([P(u1, hw, under), P(u0, hw, under), P(u0, hw, top), P(u1, hw, top)], across, c);
  }
  emitRailLine(e, P, el, z0, hw);
}

export function emitRailLine(
  e: Emitter,
  P: (u: number, v: number, z: number) => V3,
  el: BuildingElement,
  z0: number,
  hw: number,
): void {
  if (el.h < m(0.5)) return;
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const rail = m(0.05);
  for (const v of [-hw + rail, hw - rail]) {
    const r0 = z0 + riser + HANDRAIL;
    const r1 = z0 + el.h + HANDRAIL;
    e.shell.face([P(0, v - rail, r0), P(0, v + rail, r0), P(el.d, v + rail, r1), P(el.d, v - rail, r1)], e.N(0, 0, 1), RAIL);
    const every = Math.max(1, Math.round(m(1.2) / tread));
    // Its posts, 5 cm thick, under the far level's error (`FLAT_DEPTH`).
    for (let k = 0; k < n && !e.shell.far; k += every) postAt(e, P, k * tread + tread / 2, v, z0 + (k + 1) * riser, HANDRAIL);
  }
}

export function emitFence(e: Emitter, el: BuildingElement, z0: number, z1: number, c: Paint, light = false): void {
  const half = el.w / 2;
  const at = (u: number, v: number): { x: number; y: number } => {
    const a = el.angle ?? 0;
    const across = el.facing === 0 || el.facing === 2 ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const ux = across.x * Math.cos(a) - across.y * Math.sin(a);
    const uy = across.x * Math.sin(a) + across.y * Math.cos(a);
    const vx = -uy;
    const vy = ux;
    return { x: el.x + ux * u + vx * v, y: el.y + uy * u + vy * v };
  };
  const t = light ? m(0.03) : m(0.06);
  // The rails, boxes a post wide: as two flat ribbons they had no sides to see
  const railTop = z0 + el.h - m(0.07) - RAIL_OFF;
  const railMid = z0 + el.h * 0.45 + RAIL_OFF;
  const a = at(-half, 0), b = at(half, 0);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const r = m(0.02);
  for (const [z, tall] of [[railMid, m(0.06)], [railTop, m(0.07)]] as const) {
    // An instance of the shell's rail, turned along the run (`shellParts.ts`).
    if (e.apart && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) {
      e.shellPart('lotRail', a.x + (ux * len) / 2, a.y + (uy * len) / 2, z, z + tall, len, 2 * r, Math.atan2(uy, ux), c);
      continue;
    }
    const q = (u: number, v: number, h: number): V3 => e.L(a.x + ux * u - uy * v, a.y + uy * u + ux * v, h);
    e.shell.face([q(0, -r, z), q(len, -r, z), q(len, -r, z + tall), q(0, -r, z + tall)], e.N(uy, -ux), c);
    e.shell.face([q(len, r, z), q(0, r, z), q(0, r, z + tall), q(len, r, z + tall)], e.N(-uy, ux), c);
    e.shell.face([q(0, -r, z + tall), q(len, -r, z + tall), q(len, r, z + tall), q(0, r, z + tall)], [0, 0, 1], c);
    e.shell.face([q(0, r, z), q(len, r, z), q(len, -r, z), q(0, -r, z)], [0, 0, -1], c);
  }
  // Posts every couple of metres on a fence, closer together on a railing, at both ends
  const spacing = light ? m(0.45) : m(2);
  // A fence's posts, 12 cm thick two metres apart, under the far level's error (`FLAT_DEPTH`); a railing's close ones read together and stay.
  const posts = light || !e.shell.far ? Math.max(2, Math.round(el.w / spacing) + 1) : 0;
  const reach = Math.max(0, half - t - PART_INSET);
  for (let k = 0; k < posts; k++) {
    const u = -reach + (2 * reach * k) / (posts - 1);
    const p = at(u, 0);
    e.box(p.x - t, p.y - t, p.x + t, p.y + t, z0, z1 + m(0.05), c);
  }
}

export const RAIL_OFF = m(0.005);

export const FLOWER_KERB: Paint = paint({ finish: 'stone', colour: 0xa9a196 });

export function emitFlowers(e: Emitter, el: BuildingElement, z0: number, bottom: number): void {
  const kerb = m(0.12);
  e.box(el.x - el.w / 2, el.y - el.d / 2, el.x + el.w / 2, el.y + el.d / 2, bottom, z0 + m(0.16), FLOWER_KERB);
  e.box(el.x - el.w / 2 + kerb, el.y - el.d / 2 + kerb, el.x + el.w / 2 - kerb, el.y + el.d / 2 - kerb, z0 + m(0.1), z0 + m(0.2), PLANTER_SOIL);
  // The flowers themselves are the scenery's (`buildGardens`).
}

export function emitRocks(e: Emitter, el: BuildingElement, z0: number, bottom: number, c: Paint): void {
  const count = 3;
  for (let k = 0; k < count; k++) {
    const h = Math.abs(Math.round(Math.sin(el.id * 3.7 + k * 12.3) * 9127.13));
    const rx = ((h % 100) / 100 - 0.5) * (el.w - m(0.4));
    const ry = (((h >> 3) % 100) / 100 - 0.5) * (el.d - m(0.4));
    const r = m(0.22) + ((h >> 7) % 5) * m(0.05);
    const top = z0 + el.h * (0.5 + ((h >> 5) % 4) * 0.12);
    const t = z0 + (el.h - (top - z0)) * 0.3;
    const p = (dx: number, dy: number, dz: number): V3 => e.L(el.x + rx + dx, el.y + ry + dy, dz);
    const base: V3[] = [p(-r, -r, bottom), p(r, -r, bottom), p(r, r, bottom), p(-r, r, bottom)];
    const apex: V3[] = [p(-r * 0.4, -r * 0.35, top), p(r * 0.45, -r * 0.3, top), p(r * 0.35, r * 0.4, top), p(-r * 0.45, r * 0.35, top)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const q = (i + 0.5) * 0.25 * Math.PI * 2;
      e.shell.face([base[i] as V3, base[j] as V3, apex[j] as V3, apex[i] as V3], e.N(Math.cos(q), Math.sin(q), 0.3), c);
    }
    e.shell.face([apex[0] as V3, apex[1] as V3, apex[2] as V3, apex[3] as V3], e.N(0, 0, 1), c);
    void t;
  }
}

export function emitParking(e: Emitter, el: BuildingElement, z0: number, surface?: (lx: number, ly: number) => number): void {
  // Laid on the lot, following its fall
  const lift = (lx: number, ly: number, dz: number): V3 => e.L(lx, ly, (surface ? surface(lx, ly) : z0) + dz);
  const quad = (x0: number, y0: number, x1: number, y1: number, dz: number, look: Paint): void => {
    e.shell.face([lift(x0, y0, dz), lift(x1, y0, dz), lift(x1, y1, dz), lift(x0, y1, dz)], [0, 0, 1], look);
  };
  const ax = el.x - el.w / 2, ay = el.y - el.d / 2;
  const n = Math.max(1, Math.ceil(Math.max(el.w, el.d) / m(3)));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      quad(ax + (el.w * i) / n, ay + (el.d * j) / n, ax + (el.w * (i + 1)) / n, ay + (el.d * (j + 1)) / n, m(0.03), PARKING_ASPHALT);
    }
  }
  const stalls = Math.max(1, Math.floor(el.w / m(2.5)));
  const line = m(0.1);
  const along = el.facing === 0 || el.facing === 2;
  for (let k = 0; k <= stalls; k++) {
    const u = -el.w / 2 + (el.w * k) / stalls;
    if (along) quad(el.x + u - line / 2, ay, el.x + u + line / 2, ay + el.d * 0.72, m(0.05), PARKING_LINE);
    else quad(ax, el.y + u - line / 2, ax + el.w * 0.72, el.y + u + line / 2, m(0.05), PARKING_LINE);
  }
}

export const PARKING_ASPHALT: Paint = paint({ finish: 'concrete', colour: 0x4a4d4f });

export const GATE_PAINT: Paint = paint({ finish: 'metal', colour: 0x2f3437 });

export const CAR_GATE_OPEN = m(2.2);

export const GATE_POST = m(0.17);

export const BIN_BODY: Paint = paint({ finish: 'metal', colour: 0x3d5a43 });

export const BIN_LID: Paint = paint({ finish: 'metal', colour: 0x2b3a2e });

export const LAMP_POST: Paint = paint({ finish: 'metal', colour: 0x40464a });

export const GATE_LANTERN = { w: m(0.16), h: m(0.24) } as const;

export const BOLLARD_BAND: Paint = paint({ finish: 'plaster', colour: 0xe8e2cf });

export const DRAIN_GRATE: Paint = paint({ finish: 'metal', colour: 0x26292b });

export function emitLotPart(e: Emitter, el: BuildingElement, x0: number, y0: number, x1: number, y1: number,
  z0: number, zb: number, c: Paint): void {
  const z1 = z0 + el.h;
  const alongX = el.facing === 0 || el.facing === 2;
  // A box spanning `u0..u1` along the part and `v0..v1` across it (fractions), at heights h0..h1.
  const part = (u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, look: Paint): void => {
    if (alongX) e.box(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * v0, x0 + (x1 - x0) * u1, y0 + (y1 - y0) * v1, h0, h1, look);
    else e.box(x0 + (x1 - x0) * v0, y0 + (y1 - y0) * u0, x0 + (x1 - x0) * v1, y0 + (y1 - y0) * u1, h0, h1, look);
  };
  const length = alongX ? x1 - x0 : y1 - y0;
  switch (el.kind) {
    case 'gate': {
      const look = el.material ? c : GATE_PAINT;
      // A gate's pillars stand proud of the wall either side of it
      const post = Math.min(0.2, GATE_POST / length);
      part(0, post, -0.4, 1.4, zb, z1 + m(0.1), look);
      part(1 - post, 1, -0.4, 1.4, zb, z1 + m(0.1), look);
      if (el.w < CAR_GATE_OPEN) {
        // A person's gate: a lantern on each post's cap, lit after dark.
        for (const u of [post / 2, 1 - post / 2]) {
          const v = 0.5;
          const lx = alongX ? x0 + (x1 - x0) * u : x0 + (x1 - x0) * v;
          const ly = alongX ? y0 + (y1 - y0) * v : y0 + (y1 - y0) * u;
          e.putAt('lamp', lx, ly, z1 + m(0.1) + GATE_LANTERN.h / 2, GATE_LANTERN.w, GATE_LANTERN.h, GATE_LANTERN.w);
        }
      }
      if (el.w >= CAR_GATE_OPEN) {
        // A car's gate: its two leaves swung open into the lot on their hinges at the posts, so the cars that use it
        const depth = el.d || m(0.12);
        const leaf = ((1 - 2 * post) * length) / 2 / depth;
        const inward = el.facing === 0 || el.facing === 3 ? 1 : -1;
        const v0 = inward > 0 ? 1 : -leaf, v1 = inward > 0 ? 1 + leaf : 0;
        const thin = m(0.05) / length;
        for (const u of [post, 1 - post - thin]) {
          part(u, u + thin, v0, v1, z0 + m(0.08), z0 + m(0.16), look);
          part(u, u + thin, v0, v1, z1 - m(0.1), z1, look);
          const bars = Math.max(2, Math.round((leaf * depth) / m(0.14)));
          for (let k = 0; k <= bars; k++) {
            const v = v0 + ((v1 - v0) * k) / bars;
            const bw = m(0.035) / depth;
            part(u, u + thin, v - bw / 2, v + bw / 2, z0 + m(0.08), z1, look);
          }
        }
        return;
      }
      {
        // A person's gate: its one leaf, hung on one post like a door, stands swung open into the lot
        const depth = el.d || m(0.12);
        const leaf = ((1 - 2 * post) * length) / depth;
        const inward = el.facing === 0 || el.facing === 3 ? 1 : -1;
        const v0 = inward > 0 ? 1 : -leaf, v1 = inward > 0 ? 1 + leaf : 0;
        const thin = m(0.05) / length;
        const u = post;
        part(u, u + thin, v0, v1, z0 + m(0.08), z0 + m(0.16), look);
        part(u, u + thin, v0, v1, z1 - m(0.1), z1, look);
        const bars = Math.max(2, Math.round((leaf * depth) / m(0.14)));
        for (let k = 0; k <= bars; k++) {
          const v = v0 + ((v1 - v0) * k) / bars;
          const bw = m(0.035) / depth;
          part(u, u + thin, v - bw / 2, v + bw / 2, z0 + m(0.08), z1, look);
        }
      }
      return;
    }
    case 'bin': {
      for (const [u0, u1] of [[0.02, 0.48], [0.52, 0.98]] as const) {
        part(u0, u1, 0.05, 0.95, zb, z1 - m(0.06), BIN_BODY);
        part(u0 - 0.01, u1 + 0.01, 0, 1, z1 - m(0.06), z1, BIN_LID);
      }
      return;
    }
    case 'lamp': {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = m(0.06);
      e.box(cx - r, cy - r, cx + r, cy + r, zb, z1, LAMP_POST);
      e.box(cx - m(0.22), cy - m(0.22), cx + m(0.22), cy + m(0.22), z1, z1 + m(0.12), LAMP_POST);
      // The glass under the head: a lamp, lit after dark (`kit.ts`), not a pale box.
      e.putAt('lamp', cx, cy, z1 - m(0.04), m(0.36), m(0.08), m(0.36));
      return;
    }
    case 'bollard': {
      e.box(x0, y0, x1, y1, zb, z1, c === ELEMENT_CONCRETE ? LAMP_POST : c);
      if (!e.shell.far) e.box(x0 - m(0.01), y0 - m(0.01), x1 + m(0.01), y1 + m(0.01), z1 - m(0.25), z1 - m(0.15), BOLLARD_BAND);
      return;
    }
    default: {
      // The drain: a frame and its slots, a hair over the paving (under the far level's error, `FLAT_DEPTH`).
      if (e.shell.far) return;
      e.box(x0, y0, x1, y1, z0, z0 + m(0.02), DRAIN_GRATE);
      for (let k = 1; k < 5; k++) part(k / 5 - 0.03, k / 5 + 0.03, 0.1, 0.9, z0 + m(0.02), z0 + m(0.025), LAMP_POST);
    }
  }
}

export const PARKING_LINE: Paint = paint({ finish: 'plaster', colour: 0xe9e6dc });

export function shadeOf(el: BuildingElement): Paint {
  return el.material ? paint(el.material) : paint({ finish: 'plaster', colour: 0xc85a4a });
}

export function postAt(e: Emitter, P: (u: number, a: number, z: number) => V3, u: number, a: number, z: number, h: number): void {
  const r = m(0.025);
  const corners: V3[] = [P(u - r, a - r, 0), P(u + r, a - r, 0), P(u + r, a + r, 0), P(u - r, a + r, 0)];
  for (let i = 0; i < 4; i++) {
    const p = corners[i] as V3;
    const q = corners[(i + 1) % 4] as V3;
    const mid: V3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 0];
    const centre: V3 = [(corners[0]![0] + corners[2]![0]) / 2, (corners[0]![1] + corners[2]![1]) / 2, 0];
    e.shell.face([[p[0], p[1], z], [q[0], q[1], z], [q[0], q[1], z + h], [p[0], p[1], z + h]], [mid[0] - centre[0], mid[1] - centre[1], 0], RAIL);
  }
}
