// Part of the R40 building mesh pipeline (split by responsibility).
import { default as earcut } from '../../../vendor/earcut.js';
import { default as clipping } from '../../../vendor/polygonClipping.js';
import { SIDE_NORMAL, bayWidth, coveredSpans, exposedParts, ridgeAlongX, roofRise, roofHeightAt, roofSlope, sawtoothRun, shedFall, sideLength, volumeHeight } from '../../world/buildings/geometry.ts';
import { asPolygon, edgeFrame, localFootprint, volumeSides } from '../../world/buildings/footprints.ts';
import { Color } from 'three';
import type { Vec2 } from '../../core/vec2.ts';
import { m } from '../../world/units.ts';
import { type Building, type FaceId, type Side, SIDES, type Volume, type RoofDetail, volumeTop } from '../../world/buildings/types.ts';
import { PARASOL_HALF, PARASOL_HIGH, PARASOL_LOW, ROOF_COLOURS, TANK_COLOURS, roofPlantOf, terraceDeck, terraceParasols, terraceSeed } from './roofPlan.ts';
import { type FlagDesign } from '../../world/buildings/flags.ts';
import { paint, Emitter, ROOF_PLANT, shaded, trimColour, PARAPET_H, CORNICE_OUT, flagOf, flagSink, TERRACE, sideFrame, PARAPET_T, ATTIC_H, EAVES, ROOF_THICK, SAW_GLASS, type Paint, type V3, type BayFace } from './meshCore.ts';

export const ALUMINIUM_COPING = paint({ finish: 'metal', colour: 0xb9bcbd });

export function copingOf(trim: Paint): Paint {
  const [r, g, b] = trim.rgb;
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  const strong = hi > 1e-6 && (hi - lo) / hi > 0.45;
  return trim.finish === 'metal' || trim.finish === 'glass' || strong ? ALUMINIUM_COPING : trim;
}

export function emitRoofPlant(e: Emitter, b: Building, v: Volume, z: number, trim: Paint): void {
  if (v.roofDetails?.length) return;
  // Drains in two opposite corners, where the roof's fall takes the water.
  if (v.outline) return;
  // THE FAR LEVEL LEAVES OUT WHAT IS UNDER ITS ERROR (`FLAT_DEPTH`, 0.3 m): the drains and fittings a few centimetres proud, the masts and posts a few thick.
  const far = e.shell.far;
  for (const [dx, dy] of far ? [] : [[m(0.7), m(0.7)], [v.w - m(0.7), v.d - m(0.7)]] as const) {
    const x = v.x + dx;
    const y = v.y + dy;
    e.box(x - m(0.18), y - m(0.18), x + m(0.18), y + m(0.18), z, z + 0.02, DRAIN);
  }
  const items = roofPlantOf(b, v);
  for (const it of items) {
    const cx = (it.x0 + it.x1) / 2, cy = (it.y0 + it.y1) / 2, w = it.x1 - it.x0, d = it.y1 - it.y0;
    switch (it.kind) {
      case 'tank': {
        // The rooftop water tank (caixa d'água): a round fibreglass tank on a plinth, tapering in at the top, its lid.
        const paint = TANK_PAINTS[it.variant % TANK_PAINTS.length]!;
        const r = Math.min(w, d) / 2;
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + m(0.3), ROOF_PLANT);
        e.cylinder(cx, cy, r * 0.84, z + m(0.3), z + it.h - m(0.3), paint);
        e.cylinder(cx, cy, r * 0.94, z + it.h - m(0.3), z + it.h - m(0.05), paint, shaded(paint, 0.82));
        if (!far) e.cylinder(cx, cy, r * 0.4, z + it.h - m(0.05), z + it.h + m(0.05), shaded(paint, 0.75));
        break;
      }
      case 'tankBox':
        // A concrete water tank on a tall block, its lid and a ladder up its side.
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, trim, ROOF_PLANT);
        if (far) break;
        e.box(it.x0 + m(0.3), it.y0 + m(0.3), it.x0 + m(1.1), it.y0 + m(1.1), z + it.h, z + it.h + m(0.12), DRAIN);
        e.box(it.x1 - m(0.05), cy - m(0.25), it.x1 + m(0.05), cy + m(0.25), z, z + it.h + m(0.9), DRAIN);
        break;
      case 'hatch':
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, ROOF_PLANT);
        break;
      case 'condenser':
        e.box(it.x0, it.y0, it.x1, it.y1, z + m(0.15), z + it.h, CONDENSER);
        if (!far) e.box(cx - m(0.28), cy - m(0.28), cx + m(0.28), cy + m(0.28), z + it.h, z + it.h + m(0.02), DRAIN);
        break;
      case 'airHandler': {
        // A rooftop air handler: a long metal casing, its fans on top.
        e.box(it.x0, it.y0, it.x1, it.y1, z + m(0.2), z + it.h, CONDENSER);
        const along = w >= d;
        for (const k of far ? [] : [0.25, 0.75]) {
          const fx = along ? it.x0 + w * k : cx, fy = along ? cy : it.y0 + d * k;
          e.cylinder(fx, fy, Math.min(w, d) * 0.32, z + it.h, z + it.h + m(0.12), DRAIN);
        }
        break;
      }
      case 'solar': {
        // Rows of panels tilted to the sun on their frames, filling the array's ground.
        const rows = Math.max(1, Math.floor(d / m(1.7)));
        for (let r = 0; r < rows; r++) {
          const py = it.y0 + r * (d / rows);
          for (let px = it.x0; px + m(1.05) <= it.x1 + 1e-6; px += m(1.15)) {
            e.box(px, py, px + m(1.05), py + Math.min(m(1.6), d / rows - m(0.1)), z + m(0.25), z + m(0.32), SOLAR, SOLAR);
            if (!far) e.box(px + m(0.45), py + m(1.2), px + m(0.6), py + m(1.35), z, z + m(0.25), DRAIN);
          }
        }
        break;
      }
      case 'mast':
        if (far) break;
        e.box(cx - m(0.04), cy - m(0.04), cx + m(0.04), cy + m(0.04), z, z + it.h, DRAIN);
        e.box(cx - m(0.6), cy - m(0.02), cx + m(0.6), cy + m(0.02), z + it.h - m(0.4), z + it.h - m(0.36), DRAIN);
        if (it.variant % 2 === 1) e.box(cx - m(0.02), cy - m(0.45), cx + m(0.02), cy + m(0.45), z + it.h - m(0.9), z + it.h - m(0.86), DRAIN);
        break;
      case 'dish':
        // Its post thinner than the dish's plate, never in the plate's sides.
        if (!far) e.box(cx - m(0.04), cy - m(0.04), cx + m(0.04), cy + m(0.04), z, z + m(0.7), DRAIN);
        e.box(cx - m(0.4), cy - m(0.05), cx + m(0.4), cy + m(0.05), z + m(0.5), z + it.h, it.variant % 2 ? DRAIN : CONDENSER);
        break;
      case 'skylight':
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, ROOF_PLANT, SKYLIGHT);
        break;
      case 'vent':
        e.cylinder(cx, cy, Math.min(w, d) * 0.4, z, z + it.h - m(0.15), CONDENSER);
        e.cylinder(cx, cy, Math.min(w, d) * 0.5, z + it.h - m(0.15), z + it.h, DRAIN);
        break;
      case 'liftRoom':
        // A lift's machine room, with its door.
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, trim, ROOF_PLANT);
        e.box(cx - m(0.45), it.y0 - m(0.04), cx + m(0.45), it.y0, z + m(0.05), z + m(2.1), DOOR_PAINT);
        break;
      case 'chimney':
        e.cylinder(cx, cy, Math.min(w, d) * 0.45, z, z + it.h, CHIMNEY, DRAIN);
        break;
    }
  }
}

export const TANK_PAINTS: readonly Paint[] = TANK_COLOURS.map((colour) => paint({ finish: 'plaster', colour }));

export const CHIMNEY: Paint = paint({ finish: 'brick', colour: ROOF_COLOURS.chimney });

export const DRAIN: Paint = paint({ finish: 'metal', colour: 0x2d3033 });

export const SOLAR: Paint = paint({ finish: 'glass', colour: ROOF_COLOURS.solar });

export const SKYLIGHT: Paint = paint({ finish: 'glass', colour: ROOF_COLOURS.skylight });

export const DECK: Paint = paint({ finish: 'wood', colour: 0x9a7650 });

export const POT: Paint = paint({ finish: 'ceramic', colour: 0xa8573a });

export const POT_SOIL: Paint = paint({ finish: 'plaster', colour: 0x3a2a1d });

export const PARASOL: Paint = paint({ finish: 'plaster', colour: ROOF_COLOURS.parasol });

export function emitTerrace(e: Emitter, b: Building, v: Volume, z: number, trim: Paint): void {
  const deck = terraceDeck(b, v);
  if (!deck) return;
  const rnd = (k: number): number => terraceSeed(b, v, k);
  // The deck, a part of the terrace.
  const { x0: dx0, x1: dx1, y0: dy0, y1: dy1 } = deck;
  e.box(dx0, dy0, dx1, dy1, z, z + m(0.06), DECK);
  // Terracotta pots along the edges, dark soil in them, at a spacing of its own.
  const potStep = m(1.8 + 1.6 * rnd(5));
  for (let x = v.x + m(0.7); rnd(6) < 0.8 && x < v.x + v.w - m(0.6); x += potStep) {
    for (const y of [v.y + m(0.7), v.y + v.d - m(0.7)]) {
      e.cylinder(x, y, m(0.28), z, z + m(0.5), POT, POT_SOIL, 10);
    }
  }
  // Tables under parasols.
  for (const { x: tx, y: ty } of terraceParasols(b, v)) {
    e.box(tx - m(0.4), ty - m(0.4), tx + m(0.4), ty + m(0.4), z + m(0.7), z + m(0.75), trim);
    // Its pole, a few centimetres thick, under the far level's error (`FLAT_DEPTH`).
    if (!e.shell.far) e.box(tx - m(0.04), ty - m(0.04), tx + m(0.04), ty + m(0.04), z, z + PARASOL_LOW, DRAIN);
    e.box(tx - PARASOL_HALF, ty - PARASOL_HALF, tx + PARASOL_HALF, ty + PARASOL_HALF, z + PARASOL_LOW, z + PARASOL_HIGH, PARASOL);
    for (const s of [-1, 1]) e.box(tx + s * m(0.7) - m(0.2), ty - m(0.2), tx + s * m(0.7) + m(0.2), ty + m(0.2), z, z + m(0.45), trim);
  }
  // Loungers on the far side, a pergola of beams over them.
  const lx = Math.min(v.x + v.w - m(1.5), dx1 + m(1.2));
  if (rnd(8) < 0.6) for (let y = dy0 + m(0.4); y + m(0.7) < dy1; y += m(1.2)) e.box(lx - m(0.9), y, lx + m(0.9), y + m(0.65), z, z + m(0.35), PARASOL);
  // The pergola: posts every 2.4 m on two lines, a beam along each line on the posts
  const span = dy1 - dy0;
  const bays = Math.max(1, Math.round(span / m(2.4)));
  const pergola = rnd(9) < 0.45;
  for (const px of pergola ? [lx - m(1.2), lx + m(1.2)] : []) {
    for (let k = 0; k <= bays && !e.shell.far; k++) {
      const py = dy0 + (span * k) / bays;
      e.box(px - m(0.07), py - m(0.07), px + m(0.07), py + m(0.07), z, z + m(2.4), DECK);
    }
    e.box(px - m(0.06), dy0 - m(0.1), px + m(0.06), dy1 + m(0.1), z + m(2.25), z + m(2.4), DECK);
  }
  if (pergola) for (let y = dy0; y <= dy1; y += m(0.6)) e.box(lx - m(1.45), y - m(0.04), lx + m(1.45), y + m(0.04), z + m(2.4), z + m(2.5), DECK);
  // The caixa d'agua, of one of the colours they come in, on most terraces.
  if (rnd(10) < 0.65) {
    const tank = TANK_PAINTS[Math.floor(rnd(11) * TANK_PAINTS.length)]!;
    const tx = v.x + v.w - m(1.4), ty = v.y + m(1.4);
    e.cylinder(tx, ty, m(0.7), z, z + m(0.95), tank);
    e.cylinder(tx, ty, m(0.78), z + m(0.95), z + m(1.15), tank, shaded(tank, 0.82));
  }
}

export const CONDENSER: Paint = paint({ finish: 'metal', colour: ROOF_COLOURS.condenser });

export const DOOR_PAINT: Paint = paint({ finish: 'metal', colour: 0x5c6468 });

export function band(e: Emitter, v: Volume, z: number, out: number, height: number, c: Paint, hidden?: (side: FaceId) => [number, number][]): void {
  // A moulding is a PROFILE, not a slab
  const tier = (o: number, z0: number, z1: number, paint: Paint): void => flushBand(e, v, (z0 + z1) / 2, o, z1 - z0, paint, hidden);
  tier(out * 0.45, z - height / 2, z - height * 0.1, shaded(c, 0.94));
  tier(out, z - height * 0.1, z + height / 2, c);
}

export function flushBand(e: Emitter, v: Volume, z: number, out: number, height: number, c: Paint, hidden?: (side: FaceId) => [number, number][]): void {
  const ring = localFootprint(v);
  const z0 = z - height / 2, z1 = z + height / 2;
  // A rectangle's corners closed as the box closed them; a shaped block's as before.
  const grow = v.outline ? 0 : out;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length < 1e-6) continue;
    const tx = (q.x - p.x) / length, ty = (q.y - p.y) / length;
    const nx = ty, ny = -tx;
    const P = (a: number, o: number, h: number): V3 => e.L(p.x + tx * a + nx * o, p.y + ty * a + ny * o, h);
    // Only the stretches no other block covers; grown past a corner only at the side's own ends.
    for (const [s0, s1] of hidden ? exposedParts(hidden(i), 0, length) : [[0, length] as [number, number]]) {
      const a0 = s0 <= 1e-6 ? -grow : s0, a1 = s1 >= length - 1e-6 ? length + grow : s1;
      e.shell.face([P(a0, out, z0), P(a1, out, z0), P(a1, out, z1), P(a0, out, z1)], e.N(nx, ny), c);
      e.shell.face([P(a0, 0, z1), P(s1, 0, z1), P(s1, out, z1), P(a0, out, z1)], [0, 0, 1], c);
    }
  }
}

export function bothCovered(a: readonly [number, number][], b: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a0, a1] of a) for (const [b0, b1] of b) { const s = Math.max(a0, b0), t = Math.min(a1, b1); if (t > s + 1e-6) out.push([s, t]); }
  return out.sort((p, q) => p[0] - q[0]);
}

export const SHUTTER_PAINTS = [new Color().setHex(0x55785c), new Color().setHex(0x557392), new Color().setHex(0x7a5538)];

export const slabColours = new WeakMap<Paint, Color>();

export function slabColour(wall: Paint): Color {
  let c = slabColours.get(wall);
  if (!c) { c = new Color().setRGB(wall.rgb[0] * 0.92, wall.rgb[1] * 0.92, wall.rgb[2] * 0.92); slabColours.set(wall, c); }
  return c;
}

export function shutterColour(wall: Paint, trim: Paint): Color {
  const [r, g, b] = trim.rgb;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma > 0.06 && Math.max(r, g, b) < 0.75) return trimColour(trim);
  const [wr, wg, wb] = wall.rgb;
  return SHUTTER_PAINTS[wb > wr ? 2 : wg > wb ? 1 : 0]!;
}

export function emitCornice(e: Emitter, v: Volume, z: number, trim: Paint): void {
  const crown = v.dress?.crown;
  if (crown === 'none' || crown === 'attic') return;
  // A thin roof slab standing well out: the crown of a modern block.
  if (crown === 'slab') { flushBand(e, v, z + PARAPET_H - m(0.12), m(0.45), m(0.26), trim); return; }
  const deco = crown === 'deco' || (!crown && (v.facadePattern === 'artDeco' || v.facadePattern === 'artDecoCrown'));
  band(e, v, z - m(.2), deco ? m(.55) : CORNICE_OUT, deco ? m(.55) : m(.36), trim);
  if (deco) band(e, v, z - m(1.05), m(.28), m(.32), trim);
}

export function emitRoofDetails(e: Emitter, b: Building, v: Volume, floor: number): void {
  const base = floor + volumeHeight(b, v);
  const metal = paint({ finish: 'metal', colour: 0x677b79 });
  const panel = paint({ finish: 'glass', colour: 0x153e4c });
  const glazing = paint({ finish: 'glass', colour: 0x6098a6 });
  const masonry = paint({ finish: 'brick', colour: 0x876755 });
  const concrete = paint({ finish: 'concrete', colour: 0xaaa99d });
  for (const detail of v.roofDetails ?? []) {
    const z = base + roofHeightAt(b, v, detail);
    if (detail.kind === 'solar' || detail.kind === 'skylight') {
      const c = Math.cos(detail.rotation), s = Math.sin(detail.rotation);
      const point = (x: number, y: number, lift: number): V3 => {
        const px = detail.x + x * c - y * s, py = detail.y + x * s + y * c;
        return e.L(px, py, base + roofHeightAt(b, v, { x: px, y: py }) + lift);
      };
      const quad = (grow: number, lift: number): V3[] => [
        point(-detail.w / 2 - grow, -detail.d / 2 - grow, lift),
        point(detail.w / 2 + grow, -detail.d / 2 - grow, lift),
        point(detail.w / 2 + grow, detail.d / 2 + grow, lift),
        point(-detail.w / 2 - grow, detail.d / 2 + grow, lift),
      ];
      e.shell.face(quad(0.15, 0.18), [0, 0, 1], metal);
      e.shell.face(quad(0, 0.24), [0, 0, 1], detail.kind === 'solar' ? panel : glazing);
      continue;
    }
    if (detail.kind === 'vent') {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - 0.2, z + m(1), metal);
    } else if (detail.kind === 'spire') {
      const height = detail.h ?? m(11.7);
      const radius = Math.min(detail.w, detail.d) * 0.47;
      const baseStone = paint({ finish: 'plaster', colour: 0xd1ccbe });
      e.box(detail.x - radius, detail.y - radius, detail.x + radius, detail.y + radius, z - m(0.15), z + m(0.75), baseStone);
      const rings = [
        { z: z + m(0.75), r: radius * .78 },
        { z: z + height * .28, r: radius * .48 },
        { z: z + height * .84, r: radius * .12 },
        { z: z + height, r: Math.max(m(0.025), radius * .025) },
      ];
      for (let band = 0; band < rings.length - 1; band++) {
        const lo = rings[band]!, hi = rings[band + 1]!;
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4, c = (i + 1) * Math.PI / 4;
          const point = (angle: number, r: number, h: number): V3 =>
            e.L(detail.x + Math.cos(angle) * r, detail.y + Math.sin(angle) * r, h);
          e.shell.face([point(a, lo.r, lo.z), point(c, lo.r, lo.z), point(c, hi.r, hi.z), point(a, hi.r, hi.z)],
            e.N(Math.cos((a + c) / 2), Math.sin((a + c) / 2)), band === 0 ? baseStone : metal);
        }
      }
      const design = flagOf(detail);
      if (design) emitFlag(e, detail.x, detail.y, z + height * .98, design, m(2.2), m(1.25));
    } else if (detail.kind === 'lantern') {
      emitLantern(e, detail, z);
    } else if (detail.kind === 'chimney') {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - 0.2, z + m(2.1), masonry);
      e.box(detail.x - detail.w / 2 - .1, detail.y - detail.d / 2 - .1,
        detail.x + detail.w / 2 + .1, detail.y + detail.d / 2 + .1, z + m(2.1), z + m(2.25), concrete);
    } else {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - .1, z + m(1.6), metal);
    }
  }
}

export function emitFlag(e: Emitter, x: number, y: number, flagTop: number, design: FlagDesign, width: number, height: number): void {
  if (!flagSink) return;
  const [wx, wy, wz] = e.L(x, y, flagTop);
  flagSink.push({ x: wx, y: wz, z: -wy, width, height, design });
}

export function emitLantern(e: Emitter, detail: RoofDetail, z: number): void {
  const h = detail.h ?? m(19.4);
  const k = h / m(19.4);
  const span = Math.min(detail.w, detail.d);
  const stone = paint({ finish: 'stone', colour: 0xc9c6bd });
  const render = paint({ finish: 'plaster', colour: 0xe4e1d8 });
  const glass = paint({ finish: 'glass', colour: 0x7fa8b8 });
  const frame = paint({ finish: 'plaster', colour: 0xf0eee8 });
  const dome = paint({ finish: 'metal', colour: 0xcbb99a });
  const mast = paint({ finish: 'metal', colour: 0x8e9396 });
  const red = paint({ finish: 'plaster', colour: 0xe0301e });
  const N = 24;
  const at = (ang: number, rr: number, zz: number): V3 => e.L(detail.x + Math.cos(ang) * rr, detail.y + Math.sin(ang) * rr, zz);
  /** A ring of `n` faces between radii and heights (n = 8: octagon, 24: a cylinder). */
  const ring = (n: number, z0: number, z1: number, r0: number, r1: number, c: Paint, turn = 0): void => {
    for (let i = 0; i < n; i++) {
      const p0 = turn + (i * 2 * Math.PI) / n, p1 = turn + ((i + 1) * 2 * Math.PI) / n;
      e.shell.face([at(p0, r0, z0), at(p1, r0, z0), at(p1, r1, z1), at(p0, r1, z1)], e.N(Math.cos((p0 + p1) / 2), Math.sin((p0 + p1) / 2)), c);
    }
  };
  const disc = (n: number, zz: number, rr: number, c: Paint, turn = 0): void => {
    const pts: V3[] = [];
    for (let i = 0; i < n; i++) pts.push(at(turn + (i * 2 * Math.PI) / n, rr, zz));
    e.shell.face(pts, [0, 0, 1], c);
  };
  // The octagonal base, 1.0 m.
  const rBase = span / 2;
  const z1 = z + m(1.03) * k;
  ring(8, z - m(0.05), z1, rBase, rBase, stone, Math.PI / 8);
  disc(8, z1, rBase, stone, Math.PI / 8);
  // The glazed cylinder, 3.7 m across, 7.5 m tall: glass, then the grid in front of it
  const rCyl = rBase * (3.69 / 4.02);
  const z2 = z1 + m(7.47) * k;
  ring(N, z1, z2, rCyl, rCyl, glass);
  // The model's grid: a band at every 1.5 m, a mullion every 15 degrees.
  const floors = 5;
  for (let f = 0; f <= floors; f++) {
    const zz = z1 + ((z2 - z1) * f) / floors;
    ring(N, Math.max(z1, zz - m(0.07)), Math.min(z2, zz + m(0.07)), rCyl + m(0.04), rCyl + m(0.04), frame);
  }
  for (let i = 0; i < 24; i++) {
    const ang = (i * 2 * Math.PI) / 24;
    const cx = detail.x + Math.cos(ang) * (rCyl + m(0.02)), cy = detail.y + Math.sin(ang) * (rCyl + m(0.02)), s = m(0.035);
    e.box(cx - s, cy - s, cx + s, cy + s, z1, z2, frame);
  }
  ring(N, z2 - m(0.05), z2 + m(0.25), rCyl + m(0.12), rCyl + m(0.12), render);
  disc(N, z2 + m(0.25), rCyl + m(0.12), render);
  // The hemispherical dome, 1.1 m.
  const zDome = z2 + m(0.25);
  const hDome = m(1.1) * k;
  const steps = 6;
  for (let s = 0; s < steps; s++) {
    const a0 = (s / steps) * Math.PI / 2, a1 = ((s + 1) / steps) * Math.PI / 2;
    ring(N, zDome + Math.sin(a0) * hDome, zDome + Math.sin(a1) * hDome, rCyl * Math.cos(a0), Math.max(m(0.16), rCyl * Math.cos(a1)), dome);
  }
  // The mast, 0.3 m, to the top; the aviation light under its tip.
  const top = z + h;
  ring(8, zDome + hDome - m(0.05), top, m(0.15), m(0.1), mast);
  e.box(detail.x - m(0.2), detail.y - m(0.2), detail.x + m(0.2), detail.y + m(0.2), top - m(0.45), top - m(0.1), red);
  // The flag: 6.6 x 4.3 m on the model's 19.4 m lighthouse.
  const design = flagOf(detail);
  if (design) emitFlag(e, detail.x, detail.y, top - m(0.5), design, h * 0.34, h * 0.34 * 0.65);
}

export function emitPolygonRoof(
  e: Emitter, b: Building, v: Volume, floor: number,
  wallOf: (side: FaceId) => Paint, trim: Paint, roofColour: Paint,
): void {
  const z = floor + volumeHeight(b, v);
  const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
  const slope = roofSlope(v);
  type Patch = { ring: Vec2[]; height: (p: Vec2) => number };
  const rect = (a: number, c: number, d: number, f: number): Vec2[] =>
    [{ x: a, y: c }, { x: d, y: c }, { x: d, y: f }, { x: a, y: f }];
  let patches: Patch[] = [];
  if (v.roof === 'flat' || v.roof === 'terrace') {
    patches = [{ ring: rect(x0, y0, x1, y1), height: () => 0 }];
  } else if (v.roof === 'gable') {
    if (ridgeAlongX(v)) {
      const mid = (y0 + y1) / 2;
      patches = [
        { ring: rect(x0, y0, x1, mid), height: (p) => (p.y - y0) * slope },
        { ring: rect(x0, mid, x1, y1), height: (p) => (y1 - p.y) * slope },
      ];
    } else {
      const mid = (x0 + x1) / 2;
      patches = [
        { ring: rect(x0, y0, mid, y1), height: (p) => (p.x - x0) * slope },
        { ring: rect(mid, y0, x1, y1), height: (p) => (x1 - p.x) * slope },
      ];
    }
  } else if (v.roof === 'hip') {
    const alongX = v.w >= v.d;
    const long = alongX ? v.w : v.d, short = alongX ? v.d : v.w;
    const h = short / 2;
    const P = (u: number, a: number): Vec2 => alongX ? { x: x0 + u, y: y0 + a } : { x: x0 + a, y: y0 + u };
    const polygon = (pairs: readonly (readonly [number, number])[]): Vec2[] => pairs.map(([u, a]) => P(u, a));
    const U = (p: Vec2): number => alongX ? p.x - x0 : p.y - y0;
    const A = (p: Vec2): number => alongX ? p.y - y0 : p.x - x0;
    patches = [
      { ring: polygon([[0, 0], [h, h], [0, short]]), height: (p) => U(p) * slope },
      { ring: polygon([[long, 0], [long, short], [long - h, h]]), height: (p) => (long - U(p)) * slope },
      { ring: polygon([[0, 0], [long, 0], [long - h, h], [h, h]]), height: (p) => A(p) * slope },
      { ring: polygon([[h, h], [long - h, h], [long, short], [0, short]]), height: (p) => (short - A(p)) * slope },
    ];
  } else if (v.roof === 'shed') {
    const fall = shedFall(v);
    patches = [{ ring: rect(x0, y0, x1, y1), height: (p) =>
      (fall === 0 ? p.y - y0 : fall === 2 ? y1 - p.y : fall === 1 ? x1 - p.x : p.x - x0) * slope }];
  } else {
    const run = sawtoothRun(b, v);
    for (let from = y0; from < y1 - 1e-6; from += run) {
      const to = Math.min(y1, from + run), middle = (from + to) / 2;
      patches.push({ ring: rect(x0, from, x1, middle), height: (p) => (p.y - from) * slope });
      patches.push({ ring: rect(x0, middle, x1, to), height: (p) => (to - p.y) * slope });
    }
  }
  const footprint = asPolygon(localFootprint(v));
  const heightAt = (p: Vec2): number => roofHeightAt(b, v, p);
  const roofPaint = v.roof === 'terrace' ? TERRACE : roofColour;
  for (const patch of patches) {
    const pieces = clipping.intersection(footprint, asPolygon(patch.ring));
    for (const piece of pieces) {
      const ring = piece[0];
      if (!ring || ring.length < 4) continue;
      const flat = ring.slice(0, -1).flat();
      const triangles = earcut(flat);
      for (let i = 0; i < triangles.length; i += 3) {
        const plan = [triangles[i], triangles[i + 1], triangles[i + 2]].map((index) =>
          ({ x: flat[2 * index!]!, y: flat[2 * index! + 1]! }));
        const a = plan[0]!, c = plan[1]!, d = plan[2]!;
        const az = patch.height(a), cz = patch.height(c), dz = patch.height(d);
        const ux = c.x - a.x, uy = c.y - a.y, uz = cz - az;
        const vx = d.x - a.x, vy = d.y - a.y, vz = dz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const length = Math.hypot(nx, ny, nz) || 1;
        e.shell.face([e.L(a.x, a.y, z + az), e.L(c.x, c.y, z + cz), e.L(d.x, d.y, z + dz)],
          e.N(nx / length, ny / length, nz / length), roofPaint);
      }
    }
  }
  // The eaves close under pitched surfaces. Short segments follow every break.
  for (const side of volumeSides(v)) {
    const frame = edgeFrame(v, side);
    const divisions = Math.max(1, Math.ceil(frame.length / b.module));
    for (let i = 0; i < divisions; i++) {
      const a0 = i * frame.length / divisions, a1 = (i + 1) * frame.length / divisions;
      const p0 = { x: frame.x + frame.tx * a0, y: frame.y + frame.ty * a0 };
      const p1 = { x: frame.x + frame.tx * a1, y: frame.y + frame.ty * a1 };
      const h0 = Math.max(0, heightAt(p0)), h1 = Math.max(0, heightAt(p1));
      if (h0 + h1 > 1e-4) e.shell.face([e.L(p0.x, p0.y, z), e.L(p1.x, p1.y, z), e.L(p1.x, p1.y, z + h1), e.L(p0.x, p0.y, z + h0)], e.N(frame.nx, frame.ny), wallOf(side));
    }
    // A low continuous coping makes the plan legible at game zoom.
    const f: BayFace = { ...sideFrame(v, side, 0), z0: z, W: frame.length, H: PARAPET_H };
    if (v.roof === 'flat' || v.roof === 'terrace') {
      if (v.roof === 'terrace') e.put('roofRailing', f, frame.length / 2, 0, m(.12), frame.length, m(1), 1);
      else {
        // A wall with two faces and a top, as the square blocks' parapets (\`emitRoof\`)
        const out = e.N(f.nx, f.ny);
        e.rect(f, 0, frame.length, 0, PARAPET_H, 0, out, wallOf(side));
        e.rect(f, 0, frame.length, 0, PARAPET_H, PARAPET_T, [-out[0], -out[1], 0], shaded(roofColour, 0.9));
        e.strip(f, 0, frame.length, PARAPET_H, -m(0.05), PARAPET_T + m(0.05), [0, 0, 1], copingOf(trim));
      }
    }
  }
  if (v.roof === 'flat' || v.roof === 'terrace') emitCornice(e, v, z, trim);
  if (v.roof === 'flat') emitRoofPlant(e, b, v, z, trim);
}

export function emitRoof(
  e: Emitter,
  b: Building,
  v: Volume,
  floor: number,
  wallOf: (side: FaceId) => Paint,
  trim: Paint,
  roofColour: Paint,
): void {
  if (v.outline) { emitPolygonRoof(e, b, v, floor, wallOf, trim, roofColour); return; }
  const top = volumeTop(v);
  const z = floor + volumeHeight(b, v);
  const x0 = v.x;
  const y0 = v.y;
  const x1 = v.x + v.w;
  const y1 = v.y + v.d;
  const sh = e.shell;
  const up: V3 = [0, 0, 1];

  if (v.roof === 'flat' || v.roof === 'terrace') {
    const terrace = v.roof === 'terrace';
    sh.face([e.L(x0, y0, z), e.L(x1, y0, z), e.L(x1, y1, z), e.L(x0, y1, z)], up, terrace ? TERRACE : roofColour);
    // A terrace with a block standing on it (a setback, a tower's podium) is left plain
    const built = b.volumes.some((o) => o !== v && !o.open && o.base === top);
    if (!terrace) emitRoofPlant(e, b, v, z, trim);
    else if (!built) emitTerrace(e, b, v, z, trim);
    // Its top stays just under the roof: a face shared with the roof cap z-fights into stripes.
    emitCornice(e, v, z, trim);
    // An edge bay gets a parapet (or a railing, on a terrace) only where the roof really ends
    for (const side of volumeSides(v)) {
      // Only where the roof really ends: not against a neighbour as tall or taller.
      const spans = [...coveredSpans(b, v, side, top - 1), ...coveredSpans(b, v, side, top)].sort((p, q) => p[0] - q[0]);
      const step = bayWidth(b, v, side);
      for (const [p0, p1] of exposedParts(spans, 0, sideLength(v, side))) {
        // In bay-sized pieces, so a railing keeps its baluster spacing.
        const pieces = Math.max(1, Math.round((p1 - p0) / step));
        const W = (p1 - p0) / pieces;
        for (let k = 0; k < pieces; k++) {
          const ph = v.dress?.crown === 'attic' ? ATTIC_H : PARAPET_H;
          const face: BayFace = { ...sideFrame(v, side, p0 + k * W), z0: z, W, H: ph };
          if (terrace) {
            e.put('roofRailing', face, W / 2, 0, m(0.12), W, m(1.0), 1);
          } else {
            const out = e.N(face.nx, face.ny);
            e.rect(face, 0, W, 0, ph, 0, out, wallOf(side));
            // Its inner face is the roof's membrane carried up the parapet
            e.rect(face, 0, W, 0, ph, PARAPET_T, [-out[0], -out[1], 0], shaded(roofColour, 0.9));
            // The coping: proud of both faces, so the rain drips clear of them.
            const coping = copingOf(trim);
            e.strip(face, 0, W, ph, -m(0.05), PARAPET_T + m(0.05), up, coping);
            e.rect(face, 0, W, ph - m(0.06), ph, -m(0.05), out, shaded(coping, 0.9));
          }
        }
      }
    }
    return;
  }

  const rise = roofRise(b, v);
  const slope = roofSlope(v);
  if (v.roof === 'gable' || v.roof === 'hip') {
    const alongX = ridgeAlongX(v);
    // Work in a frame whose "long" axis runs along the ridge.
    const span = alongX ? y1 - y0 : x1 - x0;
    const eave = z - EAVES * slope;
    const ridge = z + rise;
    const hip = v.roof === 'hip' ? Math.min(span / 2, (alongX ? x1 - x0 : y1 - y0) / 2) : 0;
    const Lp = (along: number, across: number, height: number): V3 =>
      alongX ? e.L(along, across, height) : e.L(across, along, height);
    const a0 = alongX ? x0 : y0;
    const a1 = alongX ? x1 : y1;
    const c0 = alongX ? y0 : x0;
    const c1 = alongX ? y1 : x1;
    const cm = (c0 + c1) / 2;
    const nNear = alongX ? e.N(0, -slope, 1) : e.N(-slope, 0, 1);
    const nFar = alongX ? e.N(0, slope, 1) : e.N(slope, 0, 1);
    const o = EAVES;
    const r0 = a0 + hip;
    const r1 = a1 - hip;
    // The two long slopes.
    sh.face([Lp(a0 - o, c0 - o, eave), Lp(a1 + o, c0 - o, eave), Lp(r1, cm, ridge), Lp(r0, cm, ridge)], nNear, roofColour);
    sh.face([Lp(a1 + o, c1 + o, eave), Lp(a0 - o, c1 + o, eave), Lp(r0, cm, ridge), Lp(r1, cm, ridge)], nFar, roofColour);
    const endLow = alongX ? e.N(-slope, 0, 1) : e.N(0, -slope, 1);
    const endHigh = alongX ? e.N(slope, 0, 1) : e.N(0, slope, 1);
    // The roof has a body, not a sheet of paper (the player's order of 2026-10-05)
    const T = ROOF_THICK;
    const fascia = shaded(trim, 0.92);
    const soffit = shaded(trim, 0.7);
    const outC0 = alongX ? e.N(0, -1) : e.N(-1, 0);
    const outC1 = alongX ? e.N(0, 1) : e.N(1, 0);
    const outA0 = alongX ? e.N(-1, 0) : e.N(0, -1);
    const outA1 = alongX ? e.N(1, 0) : e.N(0, 1);
    const down: V3 = [0, 0, -1];
    sh.face([Lp(a0 - o, c0 - o, eave - T), Lp(a1 + o, c0 - o, eave - T), Lp(a1 + o, c0 - o, eave), Lp(a0 - o, c0 - o, eave)], outC0, fascia);
    sh.face([Lp(a1 + o, c1 + o, eave - T), Lp(a0 - o, c1 + o, eave - T), Lp(a0 - o, c1 + o, eave), Lp(a1 + o, c1 + o, eave)], outC1, fascia);
    sh.face([Lp(a0 - o, c0 - o, eave - T), Lp(a1 + o, c0 - o, eave - T), Lp(a1, c0, z - T), Lp(a0, c0, z - T)], down, soffit);
    sh.face([Lp(a1 + o, c1 + o, eave - T), Lp(a0 - o, c1 + o, eave - T), Lp(a0, c1, z - T), Lp(a1, c1, z - T)], down, soffit);
    // The ridge cap: a rounded row of tiles, two narrow slopes over the ridge.
    if (r1 > r0) {
      const w = m(0.14), lift = m(0.07);
      sh.face([Lp(r0, cm - w, ridge - w * slope + m(0.01)), Lp(r1, cm - w, ridge - w * slope + m(0.01)), Lp(r1, cm, ridge + lift), Lp(r0, cm, ridge + lift)], nNear, shaded(roofColour, 0.85));
      sh.face([Lp(r1, cm + w, ridge - w * slope + m(0.01)), Lp(r0, cm + w, ridge - w * slope + m(0.01)), Lp(r0, cm, ridge + lift), Lp(r1, cm, ridge + lift)], nFar, shaded(roofColour, 0.85));
    }
    if (v.roof === 'hip') {
      sh.face([Lp(a0 - o, c1 + o, eave), Lp(a0 - o, c0 - o, eave), Lp(r0, cm, ridge)], endLow, roofColour);
      sh.face([Lp(a1 + o, c0 - o, eave), Lp(a1 + o, c1 + o, eave), Lp(r1, cm, ridge)], endHigh, roofColour);
      sh.face([Lp(a0 - o, c1 + o, eave - T), Lp(a0 - o, c0 - o, eave - T), Lp(a0 - o, c0 - o, eave), Lp(a0 - o, c1 + o, eave)], outA0, fascia);
      sh.face([Lp(a1 + o, c0 - o, eave - T), Lp(a1 + o, c1 + o, eave - T), Lp(a1 + o, c1 + o, eave), Lp(a1 + o, c0 - o, eave)], outA1, fascia);
      sh.face([Lp(a0 - o, c1 + o, eave - T), Lp(a0 - o, c0 - o, eave - T), Lp(a0, c0, z - T), Lp(a0, c1, z - T)], down, soffit);
      sh.face([Lp(a1 + o, c0 - o, eave - T), Lp(a1 + o, c1 + o, eave - T), Lp(a1, c1, z - T), Lp(a1, c0, z - T)], down, soffit);
    } else {
      // Barge boards: the slab's edge up each rake, and its underside over the gable.
      for (const [a, out] of [[a0 - o, outA0], [a1 + o, outA1]] as const) {
        sh.face([Lp(a, c0 - o, eave - T), Lp(a, cm, ridge - T), Lp(a, cm, ridge), Lp(a, c0 - o, eave)], out, fascia);
        sh.face([Lp(a, cm, ridge - T), Lp(a, c1 + o, eave - T), Lp(a, c1 + o, eave), Lp(a, cm, ridge)], out, fascia);
      }
      for (const [aOut, aIn] of [[a0 - o, a0], [a1 + o, a1]] as const) {
        sh.face([Lp(aOut, c0 - o, eave - T), Lp(aIn, c0 - o, eave - T), Lp(aIn, cm, ridge - T), Lp(aOut, cm, ridge - T)], down, soffit);
        sh.face([Lp(aOut, cm, ridge - T), Lp(aIn, cm, ridge - T), Lp(aIn, c1 + o, eave - T), Lp(aOut, c1 + o, eave - T)], down, soffit);
      }
      // Gable ends: wall-coloured triangles.
      const w0 = alongX ? e.N(-1, 0) : e.N(0, -1);
      const w1 = alongX ? e.N(1, 0) : e.N(0, 1);
      sh.face([Lp(a0, c0, z), Lp(a0, c1, z), Lp(a0, cm, ridge)], w0, wallOf(alongX ? 3 : 0));
      sh.face([Lp(a1, c1, z), Lp(a1, c0, z), Lp(a1, cm, ridge)], w1, wallOf(alongX ? 1 : 2));
    }
    return;
  }

  if (v.roof === 'shed') {
    // One slope, low along the side it falls towards and high along the opposite one.
    const fall = shedFall(v);
    const lowAlongX = fall === 0 || fall === 2;
    const eaveLength = lowAlongX ? x1 - x0 : y1 - y0;
    const run = lowAlongX ? y1 - y0 : x1 - x0;
    const Q = (a: number, t: number, height: number): V3 => {
      switch (fall) {
        case 0: return e.L(x0 + a * (x1 - x0), y0 + t * (y1 - y0), height);
        case 2: return e.L(x0 + a * (x1 - x0), y1 - t * (y1 - y0), height);
        case 3: return e.L(x0 + t * (x1 - x0), y0 + a * (y1 - y0), height);
        default: return e.L(x1 - t * (x1 - x0), y0 + a * (y1 - y0), height);
      }
    };
    const high = z + run * slope;
    const oa = EAVES / eaveLength;
    const ot = EAVES / run;
    const nf = SIDE_NORMAL[fall];
    sh.face(
      [Q(-oa, -ot, z - EAVES * slope), Q(1 + oa, -ot, z - EAVES * slope), Q(1 + oa, 1 + ot, high + EAVES * slope), Q(-oa, 1 + ot, high + EAVES * slope)],
      e.N(nf.x * slope, nf.y * slope, 1),
      roofColour,
    );
    // The slab's body: a fascia on all four edges and the soffit under the overhang, so the roof has a thickness
    {
      const T = ROOF_THICK;
      const lo = z - EAVES * slope, hi = high + EAVES * slope;
      const fasc = shaded(trim, 0.92), soff = shaded(trim, 0.7);
      const pts = [Q(-oa, -ot, lo), Q(1 + oa, -ot, lo), Q(1 + oa, 1 + ot, hi), Q(-oa, 1 + ot, hi)];
      for (let k = 0; k < 4; k++) {
        const p0 = pts[k]!, p1 = pts[(k + 1) % 4]!;
        const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
        const len = Math.hypot(ex, ey) || 1;
        // Outward for the corner order (counter-clockwise in plan or not, the face winding is measured).
        const cx = (pts[0]![0] + pts[2]![0]) / 2, cy = (pts[0]![1] + pts[2]![1]) / 2;
        let nx = ey / len, ny = -ex / len;
        if ((p0[0] - cx) * nx + (p0[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
        sh.face([[p0[0], p0[1], p0[2] - T], [p1[0], p1[1], p1[2] - T], p1, p0], [nx, ny, 0], fasc);
      }
      sh.face([Q(-oa, -ot, lo - T), Q(1 + oa, -ot, lo - T), Q(1 + oa, 1 + ot, hi - T), Q(-oa, 1 + ot, hi - T)], [0, 0, -1], soff);
    }
    // The two end walls, rising with the slope, and the tall wall at the back.
    const back = ((fall + 2) % 4) as Side;
    const ends = SIDES.filter((x) => x !== fall && x !== back);
    for (const end of ends) {
      const a = (lowAlongX ? end === 3 : end === 0) ? 0 : 1;
      const n = SIDE_NORMAL[end];
      sh.face([Q(a, 0, z), Q(a, 1, z), Q(a, 1, high)], e.N(n.x, n.y), wallOf(end));
    }
    const nb = SIDE_NORMAL[back];
    sh.face([Q(0, 1, z), Q(1, 1, z), Q(1, 1, high), Q(0, 1, high)], e.N(nb.x, nb.y), wallOf(back));
    return;
  }

  // Sawtooth: teeth of up to two cells, glazed on their steep face.
  const tooth = sawtoothRun(b, v);
  const toothRise = tooth * 0.5 * slope;
  const glass = SAW_GLASS;
  for (let t0 = y0; t0 < y1 - 1e-6; t0 += tooth) {
    const t1 = Math.min(y1, t0 + tooth);
    const h = toothRise * ((t1 - t0) / tooth);
    sh.face([e.L(x0, t0, z), e.L(x1, t0, z), e.L(x1, t1, z + h), e.L(x0, t1, z + h)], e.N(0, -1, 2), roofColour);
    sh.face([e.L(x1, t1, z), e.L(x0, t1, z), e.L(x0, t1, z + h), e.L(x1, t1, z + h)], e.N(0, 1), glass);
    sh.face([e.L(x0, t0, z), e.L(x0, t1, z), e.L(x0, t1, z + h)], e.N(-1, 0), wallOf(3));
    sh.face([e.L(x1, t1, z), e.L(x1, t0, z), e.L(x1, t1, z + h)], e.N(1, 0), wallOf(1));
  }
}
