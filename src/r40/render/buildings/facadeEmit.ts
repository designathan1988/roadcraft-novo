// Part of the R40 building mesh pipeline (split by responsibility).
import { type FacadeBay, bayWidth, baysOn, coveredSpans, exposedParts, sideStart, volumeElevation } from '../../world/buildings/geometry.ts';
import { edgeFrame, volumeSides } from '../../world/buildings/footprints.ts';
import { Color } from 'three/webgpu';
import { GRIME_REACH } from './shellParts.ts';
import { m } from '../../world/units.ts';
import { type Entrance } from '../../world/buildings/foundation.ts';
import { type Finish } from '../../world/buildings/materials.ts';
import { type BayComponent, type Building, type FacadeGeometry, type Relief, type FaceId, type Volume } from '../../world/buildings/types.ts';
import { PORCH_LAMP } from './kit.ts';
import { FACADE_KIND, FACADE_STREAK, STREAK_SILL } from './facadeLevel.ts';
import { facadeProps } from './facadeProps.ts';
import { Emitter, trimColour, sideFrame, ARCADE, UP, ARCADE_FLOOR, openingOf, shaded, PLINTH_RISE, PART_INSET, CHEEK_IN, GOURMET_CHEEK, GOURMET_OUT, CHEEK_FOOT, CHEEK_BURY, PLINTH_GROW, type V3, type BayFace, type Paint, type Opening } from './meshCore.ts';
import { shutterColour, slabColour } from './roofMesh.ts';

export const DOWN: Readonly<V3> = Object.freeze([0, 0, -1] as V3);

export const EITHER_SIDE: readonly number[] = Object.freeze([-1, 1]);

export const PORCH_WASH = { half: m(1.1), up: m(1.3) } as const;

export function emitPorchLight(e: Emitter, f: BayFace, W: number, am: number, w: number, top: number): void {
  const right = am + w / 2 + PORCH_LAMP.gap;
  const left = am - w / 2 - PORCH_LAMP.gap;
  const room = PORCH_LAMP.w / 2 + m(0.05);
  const a = right + room <= W ? right : left - room >= 0 ? left : null;
  if (a === null) return;
  const h = top - m(0.25);
  e.put('lamp', f, a, h, -PORCH_LAMP.d / 2, PORCH_LAMP.w, PORCH_LAMP.h, PORCH_LAMP.d);
  const half = Math.min(PORCH_WASH.half, a, W - a);
  const up = Math.min(PORCH_WASH.up, h + m(0.3));
  // At the lantern's own centre, so it is switched with it (`kit.ts`, the wash plane is drawn back on the wall).
  e.put('wash', f, a, h, -PORCH_LAMP.d / 2, half * 2, up * 2, 1);
}

export const REVEAL_SHADE = 0.68;

export const STREAKED: ReadonlySet<Finish> = new Set<Finish>(['plaster', 'stucco', 'concrete', 'stone']);

export function emitStreak(e: Emitter, f: BayFace, bay: FacadeBay, am: number, w: number, sill: number, wall: Paint): void {
  // A flattened bay's streak is drawn by the far level's shader, from its run's streak (`streakOf`, `facadeLevel.ts`).
  if (e.flat || !STREAKED.has(wall.finish) || sill < m(0.5)) return;
  const h = bayHash(bay);
  if (h % 3 === 0) return;
  const reach = Math.min(sill - m(0.05), m(0.7 + (h % 7) * 0.12));
  const half = w * (0.32 + (h % 5) * 0.03);
  const dark = 1 - (0.07 + 0.12 * e.shell.decay);
  const out = -m(0.012);
  e.shell.face([e.P(f, am - half, sill - reach, out), e.P(f, am + half, sill - reach, out), e.P(f, am + half, sill - m(0.02), out), e.P(f, am - half, sill - m(0.02), out)],
    e.N(f.nx, f.ny), wall, [1, 1, dark, dark]);
}

export interface FarBay {
  readonly bay: FacadeBay;
  readonly wall: Paint;
  readonly opening: Opening | null;
  readonly ground: number;
  /** Its rain streak (`streakOf`): 0 none, else which drop under the opening its sill is at (`STREAK_SILL`). */
  readonly streak: number;
}

export function streakOf(c: BayComponent, o: Opening | null, wall: Paint): number {
  if (!o || !STREAKED.has(wall.finish)) return 0;
  const code = c === 'window' || c === 'sashWindow' ? 1 : c === 'shutteredWindow' ? 2
    : (c === 'frenchWindow' || c === 'bayWindow' || c === 'ribbon') && o.h0 > m(0.3) ? 1 : 0;
  return code > 0 && o.h0 - STREAK_SILL[code]! >= m(0.5) ? code : 0;
}

export function facadeKind(c: BayComponent): number {
  switch (c) {
    // Dark one bay in four of twenty, a roller shutter part way down in four (`bayHash`).
    case 'window': return FACADE_KIND.window;
    case 'sashWindow': case 'wideWindow': case 'balcony': case 'shopfront': return FACADE_KIND.clear;
    case 'loggia': case 'shutteredWindow': case 'gourmet': return FACADE_KIND.darkQuarter;
    case 'brise': case 'frenchWindow': case 'bayWindow': case 'ribbon': return FACADE_KIND.darkFifth;
    case 'door': case 'doubleDoor': return FACADE_KIND.door;
    case 'loadingDoor': case 'garageDoor': return FACADE_KIND.shutterDoor;
    default: return FACADE_KIND.none;
  }
}

export const sameLength = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

export interface FarRun {
  readonly first: FarBay;
  readonly key: string;
  readonly kind: number;
  bays: number;
  storeys: number;
}

export function emitFacadeRuns(e: Emitter, volumes: ReadonlyMap<number, Volume>, floor: number, list: readonly FarBay[], trim: Paint): void {
  // Bays alike: same block, side, plane, bay and storey size, paint, opening and grime foot.
  const keyOf = (x: FarBay, kind: number): string => {
    const { bay, wall, opening: o } = x;
    const open = o && kind !== FACADE_KIND.none ? `${o.a0.toFixed(4)},${o.a1.toFixed(4)},${o.h0.toFixed(4)},${o.h1.toFixed(4)}` : '-';
    return `${bay.volume}|${bay.side}|${bay.push.toFixed(4)}|${bay.width.toFixed(4)}|${bay.height.toFixed(4)}|${wall.finish}|${wall.rgb.join(',')}|${kind}|${open}|${x.ground.toFixed(4)}`;
  };
  // Along each storey: bays side by side, each the next index, make one run.
  const sorted = [...list].sort((a, b) => a.bay.volume - b.bay.volume || a.bay.side - b.bay.side || a.bay.level - b.bay.level || a.bay.push - b.bay.push || a.bay.start - b.bay.start);
  const rows: FarRun[] = [];
  let last: FarRun | null = null;
  for (const x of sorted) {
    const kind = x.opening ? facadeKind(x.bay.component) + FACADE_STREAK * x.streak : FACADE_KIND.none;
    const at = last ? last.first.bay : null;
    // The key written out only for a bay that starts a run: the next bay is compared field by field, as its key would be.
    if (last && at && alikeBays(last.first, last.kind, x, kind) && at.level === x.bay.level && x.bay.index === at.index + last.bays
      && sameLength(at.start + last.bays * at.width, x.bay.start)) {
      last.bays++;
      continue;
    }
    last = { first: x, key: keyOf(x, kind), kind, bays: 1, storeys: 1 };
    rows.push(last);
  }
  // Up the facade: a run over another alike, the same bays, one storey higher, joins it, but never over the base storey the grime darkens.
  const runs: FarRun[] = [];
  const open = new Map<string, FarRun>();
  rows.sort((a, b) => a.first.bay.level - b.first.bay.level);
  for (const row of rows) {
    const bay = row.first.bay;
    const slot = `${row.key}|${bay.index}|${row.bays}|${bay.start.toFixed(4)}`;
    const below = open.get(slot);
    if (below) {
      const base = below.first.bay;
      const clear = floor + base.z - below.first.ground >= GRIME_REACH;
      if (clear && bay.level === base.level + below.storeys && sameLength(base.z + below.storeys * base.height, bay.z)) {
        below.storeys++;
        continue;
      }
    }
    open.set(slot, row);
    runs.push(row);
  }
  const shell = e.shell;
  const tc = trimColour(trim);
  const ground = shell.ground;
  for (const run of runs) {
    const { bay, wall, opening: o, ground: foot } = run.first;
    const v = volumes.get(bay.volume) as Volume;
    const W = bay.width, H = bay.height;
    const f: BayFace = { ...sideFrame(v, bay.side, bay.start, bay.push), z0: floor + bay.z, W: W * run.bays, H: H * run.storeys };
    const along = e.N(f.tx, f.ty);
    const u0 = bay.index, u1 = bay.index + run.bays, v0 = bay.level, v1 = bay.level + run.storeys;
    shell.ground = foot;
    shell.stamp = {
      kind: run.kind, volume: bay.volume, side: bay.side, tx: along[0], ty: along[1], W, H,
      opening: o && run.kind !== FACADE_KIND.none ? [o.a0 / W, o.a1 / W, o.h0 / H, o.h1 / H] : [0, 0, 0, 0],
      trim: [tc.r, tc.g, tc.b],
      uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
      office: e.building.use === 'commercial' || e.building.use === 'industrial',
    };
    e.rect(f, 0, f.W, 0, f.H, 0, e.N(f.nx, f.ny), wall);
    shell.stamp = null;
  }
  shell.ground = ground;
}

export const sameFixed = (a: number, b: number): boolean => a === b || a.toFixed(4) === b.toFixed(4);

export function alikeBays(p: FarBay, pk: number, q: FarBay, qk: number): boolean {
  const a = p.bay, b = q.bay;
  if (a.volume !== b.volume || a.side !== b.side || pk !== qk || p.wall.finish !== q.wall.finish) return false;
  if (!sameFixed(a.push, b.push) || !sameFixed(a.width, b.width) || !sameFixed(a.height, b.height) || !sameFixed(p.ground, q.ground)) return false;
  const pr = p.wall.rgb, qr = q.wall.rgb;
  if (pr.length !== qr.length) return false;
  // Written out alike: the same number, or both NaN.
  for (let i = 0; i < pr.length; i++) { const u = pr[i]!, w = qr[i]!; if (u !== w && (u === u || w === w)) return false; }
  const po = p.opening && pk !== FACADE_KIND.none ? p.opening : null, qo = q.opening && qk !== FACADE_KIND.none ? q.opening : null;
  if (!po || !qo) return po === qo;
  return sameFixed(po.a0, qo.a0) && sameFixed(po.a1, qo.a1) && sameFixed(po.h0, qo.h0) && sameFixed(po.h1, qo.h1);
}

export function bayHash(bay: FacadeBay): number {
  let h = Math.imul(bay.volume + 1, 0x27d4eb2d) ^ Math.imul(bay.level + 7, 0x165667b1) ^ Math.imul(bay.side + 3, 0x3c6ef372) ^ Math.imul(bay.index + 11, 0x85ebca6b);
  h ^= Math.imul(Math.round(bay.x * 7), 0x2c1b3c6d) ^ Math.imul(Math.round(bay.y * 7), 0x297a2d39);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

export function canopyAt(head: number, H: number, half: number, over: number): number {
  return Math.min(head + over, H - m(0.42) - half);
}

export function emitBay(
  e: Emitter,
  f: BayFace,
  bay: FacadeBay,
  wall: Paint,
  trim: Paint,
  awning: Color,
  /** What the bays either side of it hold, along the same storey (none past the side's ends). */
  left: BayComponent | undefined,
  right: BayComponent | undefined,
  /** An entrance whose flight is set into the building: the opening becomes a porch this deep. */
  recess = 0,
  geometry?: FacadeGeometry,
): void {
  const out = e.N(f.nx, f.ny);
  const along = e.N(f.tx, f.ty);
  const back: V3 = [-along[0], -along[1], 0];
  const { W, H } = f;

  if (bay.component === 'pillar') {
    // An arcade: the wall steps back, a column stands on the facade line.
    e.rect(f, 0, W, 0, H, ARCADE, out, wall);
    e.strip(f, 0, W, H, 0, ARCADE, DOWN, trim);
    e.strip(f, 0, W, 0.02, 0, ARCADE, UP, ARCADE_FLOOR);
    if (left !== 'pillar') e.jamb(f, 0, 0, H, 0, ARCADE, along, wall);
    if (right !== 'pillar') e.jamb(f, W, 0, H, 0, ARCADE, back, wall);
    const d = m(0.55);
    e.put('column', f, W / 2, H / 2, m(0.35), d, H, d);
    return;
  }

  const tc = trimColour(trim);
  const found = openingOf(bay.component, W, H, geometry);
  if (!found) {
    if (!e.flat) e.rect(f, 0, W, 0, H, 0, out, wall);
    return;
  }
  // A porch runs down to the floor and back to the door; its floor is the top of the flight, so it has no sill of its own.
  const o = recess > 0 ? { ...found, h0: 0, depth: recess } : found;
  // The wall around the hole, then the four reveals into it (a flattened bay's wall is its run's, `emitFacadeRuns`).
  if (!e.flat) {
    e.rect(f, 0, o.a0, 0, H, 0, out, wall);
    e.rect(f, o.a1, W, 0, H, 0, out, wall);
    e.rect(f, o.a0, o.a1, 0, o.h0, 0, out, wall);
    e.rect(f, o.a0, o.a1, o.h1, H, 0, out, wall);
    // The reveals are in the wall's shadow
    const reveal = shaded(recess > 0 ? wall : trim, REVEAL_SHADE);
    e.jamb(f, o.a0, o.h0, o.h1, 0, o.depth, along, reveal);
    e.jamb(f, o.a1, o.h0, o.h1, 0, o.depth, back, reveal);
    // A sill; at the floor, a threshold as high as the plinth's ledge
    if (recess <= 0) e.strip(f, o.a0, o.a1, o.h0 > 1e-6 ? o.h0 : PLINTH_RISE, 0, o.depth, UP, shaded(trim, 0.92));
    e.strip(f, o.a0, o.a1, o.h1, 0, o.depth, DOWN, shaded(reveal, 0.8));
  }

  const w = o.a1 - o.a0;
  const h = o.h1 - o.h0;
  const am = (o.a0 + o.a1) / 2;
  const hm = (o.h0 + o.h1) / 2;
  switch (bay.component) {
    case 'window':
    case 'sashWindow': {
      // No two rows alike: some rooms darker, some with the roller shutter part way down - picked from the bay, so stable.
      const pick = bay.component === 'sashWindow' ? 13 : bayHash(bay) % 20;
      e.put(pick < 5 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      // The shutter a little inside the frame's edges: as wide as it, its sides lay in the frame's own and fought it for depth.
      if (pick >= 9 && pick < 13) {
        const down = h * (0.25 + (pick - 9) * 0.15) - PART_INSET;
        e.put('shutter', f, am, o.h1 - PART_INSET - down / 2, o.depth - m(0.05), w - 2 * PART_INSET, down, m(0.04));
      }
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      // The sill: out past the wall, with a drip.
      e.put('concrete', f, am, o.h0 - m(0.03), (o.depth - m(0.07)) / 2, w + m(0.14), m(0.06), o.depth + m(0.07));
      emitStreak(e, f, bay, am, w, o.h0 - m(0.06), wall);
      break;
    }
    case 'wideWindow':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      break;
    case 'balcony':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      e.put('concrete', f, W / 2, -m(0.09), -m(0.65), W - m(0.3), m(0.18), m(1.3));
      e.put('railing', f, W / 2, 0, 0, W - m(0.3), m(1.05), m(1.3), tc);
      break;
    case 'door':
      e.put('door', f, am, hm, o.depth + m(0.03), w, h, m(0.06));
      if (bay.level === 0) {
        // A canopy over the door: a slab with a fascia at its edge (a drip), and two brackets under it into the wall.
        const cz = canopyAt(o.h1, H, m(0.06), m(0.3));
        e.put('concrete', f, am, cz, -m(0.45), w + m(0.7), m(0.12), m(0.9));
        e.put('concrete', f, am, cz - m(0.04), -m(0.88), w + m(0.7), m(0.2), m(0.05));
        // The brackets up to the slab's soffit, not into it
        for (const side of EITHER_SIDE) e.put('frame', f, am + side * (w / 2 + m(0.2)), cz - m(0.06) - m(0.15), -m(0.25), m(0.06), m(0.3), m(0.5), tc);
        emitPorchLight(e, f, W, am, w, o.h1);
      }
      break;
    case 'shopfront':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      e.put('awning', f, W / 2, o.h1 + m(0.45), 0, W - m(0.2), m(0.75), m(1.3), awning);
      break;
    case 'loadingDoor':
    case 'garageDoor':
      e.put('shutter', f, am, hm, o.depth, w, h, m(0.1));
      break;
    case 'doubleDoor': {
      // Two leaves up to door height, and a fanlight over them in a tall opening; a canopy over the whole on the ground floor.
      const leafTop = Math.min(h, m(2.5));
      const leafMid = o.h0 + leafTop / 2;
      for (const side of EITHER_SIDE) {
        const cx = am + side * (w / 4);
        e.put('door', f, cx, leafMid, o.depth + m(0.03), w / 2 - m(0.04), leafTop, m(0.06));
        e.put('glassDark', f, cx, leafMid + leafTop * 0.12, o.depth - m(0.01), w / 2 - m(0.5), leafTop * 0.5, m(0.02));
      }
      if (h > leafTop + m(0.4)) {
        const fan = h - leafTop - m(0.12);
        e.put('glass', f, am, o.h0 + leafTop + m(0.12) + fan / 2, o.depth, w, fan, 1);
        e.put('frame', f, am, o.h0 + leafTop + m(0.12) + fan / 2, o.depth - m(0.03), w, fan, m(0.05), tc);
        e.put('frame', f, am, o.h0 + leafTop + m(0.06), o.depth - m(0.03), w, m(0.12), m(0.08), tc);
      }
      if (bay.level === 0) {
        const cz = canopyAt(o.h1, H, m(0.07), m(0.3));
        e.put('concrete', f, am, cz, -m(0.55), w + m(1), m(0.14), m(1.1));
        e.put('concrete', f, am, cz - m(0.05), -m(1.08), w + m(1), m(0.24), m(0.05));
        emitPorchLight(e, f, W, am, w, o.h1);
      }
      break;
    }
    case 'loggia': {
      // The glazed wall at the back of the loggia, and a glass parapet on the facade line.
      e.put(bayHash(bay) % 4 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth - m(0.02), w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.05), w, h, m(0.06), tc);
      e.put('glassRail', f, am, o.h0, -m(0.02), w, m(1.05), 1);
      e.put('fin', f, am, o.h0 + m(1.06), -m(0.02), w, m(0.05), m(0.06), tc);
      break;
    }
    case 'brise': {
      e.put(bayHash(bay) % 5 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      // Vertical fins the storey's height, standing out of the wall: the brise-soleil of the Brazilian modern block
      const fd = m(0.6);
      e.put('brise', f, W / 2, H / 2, -fd / 2, W, H, fd, tc);
      break;
    }
    case 'shutteredWindow': {
      e.put(bayHash(bay) % 4 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      // A moulded surround in the trim, then the louvred leaves folded back on the wall either side, in the shutter paint
      const band = m(0.14);
      e.put('fin', f, am, o.h1 + band / 2, -m(0.03), w + band * 2, band, m(0.06), tc);
      for (const side of EITHER_SIDE) e.put('fin', f, am + side * (w / 2 + band / 2), hm, -m(0.03), band, h, m(0.06), tc);
      if (o.a0 >= w / 2 + band) for (const side of EITHER_SIDE) e.put('louvre', f, am + side * (w * 0.75 + band), hm, -m(0.05), w / 2, h, m(0.04), shutterColour(wall, trim));
      e.put('concrete', f, am, o.h0 - m(0.04), (o.depth - m(0.1)) / 2, w + band * 2 + m(0.1), m(0.08), o.depth + m(0.1));
      emitStreak(e, f, bay, am, w, o.h0 - m(0.08), wall);
      break;
    }
    case 'gourmet': {
      // Sliding glass the bay's width, and the deep balcony: its slab, a glass parapet along its front edge.
      e.put(bayHash(bay) % 4 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      const slab = slabColour(wall);
      // Where the run of balconies ends, the side wall that carries the slabs storey on storey and closes the balcony
      const closedLeft = left !== 'gourmet', closedRight = right !== 'gourmet';
      const r0 = closedLeft ? CHEEK_IN + GOURMET_CHEEK / 2 : 0, r1 = closedRight ? W - CHEEK_IN - GOURMET_CHEEK / 2 : W;
      e.put('fin', f, W / 2, -m(0.12), -GOURMET_OUT / 2, W, m(0.24), GOURMET_OUT, slab);
      // The slab's edge beam, a drip under its front: the slab reads as a floor of the building carried out, not a tray.
      e.put('fin', f, W / 2, -m(0.2), -GOURMET_OUT + m(0.06), W, m(0.18), m(0.16), slab);
      e.put('glassRail', f, (r0 + r1) / 2, 0, -GOURMET_OUT + m(0.04), r1 - r0, m(1.05), 1);
      // The rail's metal cap along the top of the glass, in the frames' colour.
      e.put('fin', f, (r0 + r1) / 2, m(1.06), -GOURMET_OUT + m(0.04), r1 - r0, m(0.05), m(0.06), tc);
      for (const [u, closed] of [[CHEEK_IN + GOURMET_CHEEK / 2, closedLeft], [W - CHEEK_IN - GOURMET_CHEEK / 2, closedRight]] as const) {
        // A storey high from under the slab, so the cheeks of the storeys stack into one wall
        if (closed) e.put('fin', f, u, H / 2 - CHEEK_FOOT, (CHEEK_BURY - GOURMET_OUT - m(0.05)) / 2, GOURMET_CHEEK, H, GOURMET_OUT + m(0.05) + CHEEK_BURY, slab);
      }
      if (!closedRight) e.put('frame', f, W, m(0.55), -GOURMET_OUT / 2 - m(0.1), m(0.06), m(1.1), GOURMET_OUT - m(0.2), tc);
      break;
    }
    case 'frenchWindow':
    case 'bayWindow':
    case 'ribbon': {
      e.put(bayHash(bay) % 5 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      // A transom across a tall pane, and a sill under the raised ones.
      if (h > m(2.2)) e.put('frame', f, am, o.h0 + h * 0.72, o.depth - m(0.03), w, m(0.08), m(0.07), tc);
      if (o.h0 > m(0.3)) {
        e.put('concrete', f, am, o.h0 - m(0.03), (o.depth - m(0.07)) / 2, w + m(0.14), m(0.06), o.depth + m(0.07));
        emitStreak(e, f, bay, am, w, o.h0 - m(0.06), wall);
      }
      break;
    }
    default:
      break;
  }
  // What hangs on the bay and stands on its balcony (`facadeProps.ts`), its own by the bay.
  const b = e.building;
  for (const p of facadeProps(bay.component, bay.level, b.use, b.decay ?? 0, bayHash(bay), W, o)) {
    e.put(p.kind, f, p.a, p.h, -p.out, p.sx, p.sy, p.sz, e.propColour.setHex(p.colour), p.turn);
  }
}

export function emitPlinth(
  e: Emitter,
  b: Building,
  v: Volume,
  bottom: number,
  floor: number,
  c: Paint,
  notches: ReadonlyMap<FaceId, readonly { a0: number; a1: number; recess: number }[]>,
): void {
  const g = PLINTH_GROW;
  // Only along the outside: where another block of the ground stands against a side, the plinth
  const coveredOf = (side: FaceId, base: number): [number, number][] =>
    coveredSpans(b, v, side, 0).map(([a0, a1]) => [base + a0, base + a1] as [number, number]);
  if (v.outline) {
    for (const side of volumeSides(v)) {
      const f = edgeFrame(v, side);
      const covered = coveredOf(side, 0);
      const at = (a: number, depth: number, z: number): V3 => e.L(f.x + f.tx * a - f.nx * depth, f.y + f.ty * a - f.ny * depth, z);
      const n = e.N(f.nx, f.ny);
      const t = e.N(f.tx, f.ty);
      const cuts = [...(notches.get(side) ?? [])].sort((a, b) => a.a0 - b.a0);
      let from = 0;
      const wallTo = (to: number): void => {
        if (to - from < 1e-4) return;
        for (const [p0, p1] of exposedParts(covered, from, to)) {
          e.shell.face([at(p0, -g, bottom), at(p1, -g, bottom), at(p1, -g, floor), at(p0, -g, floor)], n, c);
          e.shell.face([at(p0, -g, floor), at(p1, -g, floor), at(p1, g, floor), at(p0, g, floor)], [0, 0, 1], c);
        }
      };
      for (const cut of cuts) {
        wallTo(cut.a0);
        const depth = g + cut.recess;
        e.shell.face([at(cut.a0, -g, bottom), at(cut.a0, depth, bottom), at(cut.a0, depth, floor), at(cut.a0, -g, floor)], t, c);
        e.shell.face([at(cut.a1, depth, bottom), at(cut.a1, -g, bottom), at(cut.a1, -g, floor), at(cut.a1, depth, floor)], [-t[0], -t[1], 0], c);
        from = cut.a1;
      }
      wallTo(f.length);
    }
    return;
  }
  const x0 = v.x - g;
  const y0 = v.y - g;
  const x1 = v.x + v.w + g;
  const y1 = v.y + v.d + g;
  for (const side of volumeSides(v)) {
    // The side as a line in the plan: where it runs along its axis and where it stands across it.
    const alongX = side === 0 || side === 2;
    const lo = alongX ? x0 : y0;
    const hi = alongX ? x1 : y1;
    const at = side === 0 ? y0 : side === 1 ? x1 : side === 2 ? y1 : x0;
    const inward = side === 0 || side === 3 ? 1 : -1;
    const point = (a: number, depth: number, z: number): V3 =>
      alongX ? e.L(a, at + inward * depth, z) : e.L(at + inward * depth, a, z);
    const edge = edgeFrame(v, side);
    const n = { x: edge.nx, y: edge.ny };
    const out = e.N(n.x, n.y);
    const cuts = [...(notches.get(side) ?? [])].sort((p, q) => p.a0 - q.a0);
    // A side runs along its axis from the block's corner (`sideStart`).
    const covered = coveredOf(side, alongX ? v.x : v.y);
    let from = lo;
    const wallTo = (to: number): void => {
      if (to - from < 1e-4) return;
      for (const [p0, p1] of exposedParts(covered, from, to)) {
        e.shell.face([point(p0, 0, bottom), point(p1, 0, bottom), point(p1, 0, floor), point(p0, 0, floor)], out, c);
        e.shell.face([point(p0, 0, floor), point(p1, 0, floor), point(p1, g, floor), point(p0, g, floor)], [0, 0, 1], c);
      }
    };
    for (const cut of cuts) {
      wallTo(cut.a0);
      // The notch's cheeks, facing into it; the flight fills its floor and back.
      const depth = g + cut.recess;
      const t = alongX ? e.N(1, 0) : e.N(0, 1);
      e.shell.face([point(cut.a0, 0, bottom), point(cut.a0, depth, bottom), point(cut.a0, depth, floor), point(cut.a0, 0, floor)], t, c);
      e.shell.face([point(cut.a1, depth, bottom), point(cut.a1, 0, bottom), point(cut.a1, 0, floor), point(cut.a1, depth, floor)], [-t[0], -t[1], 0], c);
      from = cut.a1;
    }
    wallTo(hi);
  }
}

export function emitRecessedFlight(
  e: Emitter,
  face: BayFace,
  a0: number,
  a1: number,
  entrance: Entrance,
  floor: number,
  bottom: number,
  riser: number,
  c: Paint,
): void {
  const n = e.N(face.nx, face.ny);
  const start = -PLINTH_GROW;
  if (entrance.threshold > PLINTH_GROW) {
    // The slab over the verge, from the paving to the foot of the flight.
    const top = entrance.ground - floor;
    const out = -entrance.threshold;
    const t = e.N(face.tx, face.ty);
    e.rect(face, a0, a1, bottom - floor, top, out, n, c);
    e.shell.face([e.P(face, a0, top, out), e.P(face, a1, top, out), e.P(face, a1, top, start), e.P(face, a0, top, start)], [0, 0, 1], c);
    e.shell.face([e.P(face, a1, bottom - floor, out), e.P(face, a1, bottom - floor, start), e.P(face, a1, top, start), e.P(face, a1, top, out)], t, c);
    e.shell.face([e.P(face, a0, bottom - floor, start), e.P(face, a0, bottom - floor, out), e.P(face, a0, top, out), e.P(face, a0, top, start)], [-t[0], -t[1], 0], c);
  }
  const tread = (entrance.recess - start) / (entrance.steps + 1);
  for (let k = 0; k < entrance.steps; k++) {
    const top = entrance.ground + (k + 1) * riser - floor;
    const d0 = start + k * tread;
    // Each block runs to the door, so only its riser and its tread show.
    e.rect(face, a0, a1, bottom - floor, top, d0, n, c);
    e.shell.face([e.P(face, a0, top, d0), e.P(face, a1, top, d0), e.P(face, a1, top, entrance.recess), e.P(face, a0, top, entrance.recess)], [0, 0, 1], c);
  }
}

export function emitRelief(e: Emitter, b: Building, v: Volume, r: Relief, floor: number, wall: Paint, trim: Paint): void {
  const count = baysOn(b, v, r.side);
  const top = v.storeys.length - 1;
  if (r.depth === 0 || r.bay0 > count - 1 || r.storey0 > top) return;
  const w = bayWidth(b, v, r.side);
  const a0 = Math.max(0, r.bay0) * w;
  const a1 = (Math.min(count - 1, r.bay1) + 1) * w;
  const z0 = floor + volumeElevation(b, v, v.base + Math.max(0, r.storey0));
  const z1 = floor + volumeElevation(b, v, v.base + Math.min(top, r.storey1) + 1);
  const s = sideStart(v, r.side);
  const f = edgeFrame(v, r.side);
  const n = { x: f.nx, y: f.ny };
  const d = r.depth;
  const P = (a: number, z: number, out: number): V3 => e.L(s.x + s.tx * a + n.x * out, s.y + s.ty * a + n.y * out, z);
  const t = e.N(s.tx, s.ty);
  const into: V3 = [-t[0], -t[1], 0];
  const out = d > 0;
  // Cheeks: facing away from the region on a projection, into it on a recess.
  e.shell.face([P(a0, z0, 0), P(a0, z0, d), P(a0, z1, d), P(a0, z1, 0)], out ? into : t, wall);
  e.shell.face([P(a1, z0, d), P(a1, z0, 0), P(a1, z1, 0), P(a1, z1, d)], out ? t : into, wall);
  e.shell.face([P(a0, z1, 0), P(a1, z1, 0), P(a1, z1, d), P(a0, z1, d)], [0, 0, out ? 1 : -1], trim);
  e.shell.face([P(a0, z0, 0), P(a1, z0, 0), P(a1, z0, d), P(a0, z0, d)], [0, 0, out ? -1 : 1], trim);
}
