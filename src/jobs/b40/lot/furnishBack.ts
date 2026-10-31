// The back zones and the boundary of a furnished lot (4.0 lotPlan.ts): parking, service, courtyard, loading and the
// boundary runs, on the b40 element table.
import type { Xoshiro128 } from '../../../core/rng.ts';
import { B40_BAY, B40_ELEMENT, B40_SURFACE } from '../../../world/b40Kinds.ts';
import { FIN } from '../../../shared/finishes.ts';
import { paintOf } from '../paint.ts';
import { baysOf } from '../facades.ts';
import type { B40Plan, B40Rect } from './plan.ts';
import type { LotBuilder } from './furnish.ts';
import { openRunsAlong, type CoverBox } from './boundaryRuns.ts';
import { BOUNDARY_KINDS } from '../elements.ts';

const STALL = 5, AISLE = 6, DOCK = 3.6;
const PARK_SLOPE = 0.05;
const mat = (finish: number, colour: number) => paintOf(finish, colour);
const PAVERS = mat(FIN.Brick, 0x9a958c);
const STONE_PATH = mat(FIN.Stone, 0xd2cbbd);

export type Strip = { drive: B40Rect | null; walk: B40Rect | null; garden: B40Rect | null };

const loadingDoors = (lot: LotBuilder, back: number): { x: number; y: number }[] => {
  const t = lot.t, out: { x: number; y: number }[] = [];
  for (let v = 0; v < t.n; v++) {
    if (t.open[v]! >= 0 || t.base[v] !== 0 || t.outlineN[v]! > 0 || Math.abs(t.y[v]! + t.d[v]! - back) > 0.6) continue;
    const n = baysOf(t, v, 2), w = t.w[v]! / n;
    for (let i = 0; i < n; i++) {
      const code = t.bay(v, 0, 2, i);
      const fill = code !== 255 ? code : t.fillOf(v, 0);
      if (fill === B40_BAY.LoadingDoor) out.push({ x: t.x[v]! + (i + 0.5) * w, y: t.y[v]! + t.d[v]! });
    }
  }
  return out;
};

export function backParking(lot: LotBuilder, by0: number, by1: number, W: number, D: number, back: B40Plan['back'], drives: B40Rect[], rng: Xoshiro128): void {
  const fall = lot.split && lot.hill?.backFall !== undefined
    ? Math.max(-PARK_SLOPE, Math.min(PARK_SLOPE, lot.hill.backFall / Math.max(1, by1 - by0))) * (by1 - by0) : 0;
  if (Math.abs(fall) >= 0.1) lot.sloped({ x0: 0, y0: by0, x1: W, y1: by1 }, B40_SURFACE.Asphalt, 0, fall);
  else lot.lay({ x0: 0, y0: by0, x1: W, y1: by1 }, B40_SURFACE.Asphalt);
  const mouth = drives[0];
  const rowY = [by1 - STALL / 2 - 0.15];
  if (back.rows === 2) rowY.push(by0 + STALL / 2);
  for (const [k, y] of rowY.entries()) {
    const facing = (k === 0 ? 2 : 0) as 0 | 1 | 2 | 3;
    const skips: [number, number][] = [];
    if (mouth && k === 1) skips.push([mouth.x0 - 0.2, mouth.x1 + 0.2]);
    if (lot.backDoor !== null && k === 1) skips.push([lot.backDoor - 0.9, lot.backDoor + 0.9]);
    let x = 0.4;
    const end = W - 0.4;
    const runs: [number, number][] = [];
    for (const [a, b] of skips.sort((p, q) => p[0] - q[0])) { if (a > x) runs.push([x, a]); x = Math.max(x, b); }
    if (end > x) runs.push([x, end]);
    for (const [a, b] of runs) {
      const n = Math.floor((b - a) / 2.5);
      if (n < 1) {
        if (b - a >= 1.2) { lot.place(B40_ELEMENT.Planter, (a + b) / 2, y, 0, Math.min(2, b - a - 0.2), 1.2, 0.5); lot.place(B40_ELEMENT.Shrub, (a + b) / 2, y, 0, 1, 1, 0.9); }
        continue;
      }
      const used = n * 2.5, x0 = a + (b - a - used) / 2;
      lot.place(B40_ELEMENT.Parking, x0 + used / 2, y, facing, used, STALL, 0.12);
      if (b - a - used >= 1.4) lot.place(B40_ELEMENT.Planter, b - (b - a - used) / 2, y, 0, Math.min(1.6, b - a - used - 0.2), 1.6, 0.5);
    }
  }
  if (lot.backDoor !== null) lot.walk({ x0: lot.backDoor - 0.7, y0: by0, x1: lot.backDoor + 0.7, y1: by0 + (back.rows === 2 ? STALL : 1.2) }, PAVERS);
  const aisleY = back.rows === 2 ? by0 + STALL + AISLE / 2 : by0 + AISLE / 2;
  lot.place(B40_ELEMENT.Drain, W / 2, aisleY, 0, 0.5, 0.5, 0.1);
  for (const px of [0.6, W - 0.6]) lot.place(B40_ELEMENT.Lamp, px, aisleY, 0, 0.3, 0.3, 5);
  if (back.rows === 1) {
    const spots: [number, number][] = [[1.2, by0 + 0.8], [W - 1.4, by0 + 0.8], [W / 2, by0 + 0.6]];
    const props: ((x: number, y: number) => void)[] = [
      (x, y) => { lot.place(B40_ELEMENT.Bin, x, y, 0, 2.2, 1.4, 1.3, undefined, mat(FIN.Metal, 0x2f5a3c)); },
      (x, y) => { for (let k = -1; k <= 1; k++) lot.place(B40_ELEMENT.Railing, x + k * 0.6, y, 0, 0.05, 0.8, 0.8, undefined, mat(FIN.Metal, 0x9aa0a4)); },
      (x, y) => { lot.place(B40_ELEMENT.Wall, x, y, 0, 0.8, 0.4, 1.6, undefined, mat(FIN.Metal, 0x8a9094)); },
      (x, y) => { lot.place(B40_ELEMENT.Slab, x, y, 0, 1.2, 1.0, 0.14, 0, mat(FIN.Wood, 0x9c7a50)); lot.place(B40_ELEMENT.Slab, x, y, 0, 1.2, 1.0, 0.14, 0.14, mat(FIN.Wood, 0x8b6c45)); },
      (x, y) => { for (const k of [-1, 1]) lot.place(B40_ELEMENT.Pillar, x + k * 0.9, y, 0, 0.08, 0.08, 2.3, undefined, mat(FIN.Metal, 0x4a4e52)); lot.place(B40_ELEMENT.Slab, x, y, 0, 2.2, 1.4, 0.06, 2.3, mat(FIN.Metal, 0x6a7074)); lot.place(B40_ELEMENT.Bench, x, y, 0, 1.4, 0.45, 0.45); },
    ];
    for (const [x, y] of spots) if (rng.float() < 0.7 && !lot.occupied(x, y, 1)) props[rng.int(0, props.length - 1)]!(x, y);
  }
}

export function backService(lot: LotBuilder, by0: number, by1: number, W: number, env: B40Rect): void {
  lot.lay({ x0: 0, y0: by0, x1: W, y1: by1 }, B40_SURFACE.Concrete);
  const bd = lot.backDoor ?? (env.x0 + env.x1) / 2;
  lot.place(B40_ELEMENT.Bin, Math.min(W - 1.2, bd + 2.2), by0 + 0.6, 0, 1.4, 0.7, 1.1);
  lot.place(B40_ELEMENT.Bin, Math.min(W - 1.4, bd + 4), by0 + 0.9, 0, 2.2, 1.4, 1.3, undefined, mat(FIN.Metal, 0x2f5a3c));
  for (let k = 0; k < 3; k++) lot.place(B40_ELEMENT.Rocks, Math.min(W - 0.6, bd + 2.6 + k * 0.5), by0 + 1.6, 0, 0.5, 0.45, 0.4, undefined, mat(FIN.Plaster, 0x1c1d1f));
  lot.place(B40_ELEMENT.Slab, Math.max(0.8, bd - 3), by0 + 1, 0, 1.2, 1.0, 0.14, 0, mat(FIN.Wood, 0x9c7a50));
  lot.place(B40_ELEMENT.Slab, Math.max(0.8, bd - 3), by0 + 1, 0, 0.6, 0.6, 0.45, 0.14, mat(FIN.Wood, 0x7f6040));
  lot.place(B40_ELEMENT.Drain, bd, by0 + (by1 - by0) / 2, 0, 0.5, 0.5, 0.1);
  lot.place(B40_ELEMENT.Lamp, Math.max(0.6, bd - 1.6), by0 + 0.4, 0, 0.3, 0.3, 3.2);
  if (W >= 8 && by1 - by0 >= 4) {
    const gx = 1.2, gy = by1 - 1;
    lot.place(B40_ELEMENT.Fence, gx, gy, 0, 1.6, 0.9, 1.4, undefined, mat(FIN.Metal, 0x7a8084));
    for (let k = 0; k < 3; k++) lot.place(B40_ELEMENT.Pillar, gx - 0.5 + k * 0.5, gy, 0, 0.32, 0.32, 0.9, undefined, mat(FIN.Metal, 0x3a6fb0));
    for (let k = 0; k < 4; k++) lot.place(B40_ELEMENT.Slab, Math.min(W - 2.6, bd + 1.2) + (k % 2) * 0.45, by1 - 2.2, 0, 0.42, 0.32, 0.28, Math.floor(k / 2) * 0.28, mat(FIN.Plaster, k % 2 ? 0xc9a227 : 0xb23b2e));
  }
  for (let px = env.x0 + 1; px < env.x1 - 1 && px < bd - 2.5; px += 2.4) lot.place(B40_ELEMENT.Ac, px, by0 + 0.2, 2, 0.8, 0.35, 0.6, 2.6);
  if (by1 - by0 >= 5 && W >= 8) lot.place(B40_ELEMENT.Planter, 1, by1 - 1, 0, 1, 1, 0.6);
}

export function backCourtyard(lot: LotBuilder, by0: number, by1: number, W: number, env: B40Rect, walks: B40Rect[]): void {
  const play = by1 - by0 >= 8 && W >= 12 ? { x0: W - 5, y0: by1 - 4.5, x1: W - 1, y1: by1 - 0.5 } : null;
  lot.fillAround({ x0: 0, y0: by0, x1: W, y1: by1 }, play ? [play] : [], B40_SURFACE.Grass);
  if (play) { lot.lay(play, B40_SURFACE.Sand); lot.place(B40_ELEMENT.Bench, play.x0 - 0.6, (play.y0 + play.y1) / 2, 1, 1.4, 0.45, 0.45); lot.taken.push(play); }
  const cx = (env.x0 + env.x1) / 2;
  if (lot.backDoor !== null) lot.walk({ x0: lot.backDoor - 0.7, y0: by0, x1: lot.backDoor + 0.7, y1: by0 + 2 }, PAVERS);
  lot.walk({ x0: cx - 3, y0: by0 + 2, x1: cx + 3, y1: Math.min(by1 - 0.5, by0 + 6) }, STONE_PATH);
  lot.place(B40_ELEMENT.Bench, cx - 1.5, by0 + 4, 0, 1.6, 0.5, 0.45);
  lot.place(B40_ELEMENT.Bench, cx + 1.5, by0 + 4, 0, 1.6, 0.5, 0.45);
  for (const w of walks) lot.walk({ x0: w.x0, y0: by0, x1: w.x1, y1: by0 + 2 }, PAVERS);
  for (const px of [2.6, W - 2.6]) if (!lot.occupied(px, by1 - 2.8, 1.4)) lot.place(B40_ELEMENT.Tree, px, by1 - 2.8, 0, 3, 3, 5);
  lot.place(B40_ELEMENT.Bin, 1.2, by0 + 0.6, 0, 1.4, 0.7, 1.1);
}

export function backLoading(lot: LotBuilder, by0: number, by1: number, W: number, D: number, env: B40Rect): void {
  lot.lay({ x0: 0, y0: by0, x1: W, y1: by1 }, B40_SURFACE.Concrete);
  const dockDepth = Math.min(12, by1 - by0 - 0.5);
  const doors = loadingDoors(lot, by0).map((d) => ({ x: d.x + W / 2, y: d.y })).sort((p, q) => p.x - q.x);
  let last = -Infinity;
  for (const door of doors) {
    const x = Math.max(0.3 + DOCK / 2, Math.min(W - 0.3 - DOCK / 2, door.x)), y = door.y;
    if (Math.abs(x - door.x) > 0.6 || x - last < DOCK + 0.5) continue;
    const y0 = Math.max(by0, y), depth = Math.min(dockDepth, by1 - y0 - 0.5);
    if (!lot.place(B40_ELEMENT.Parking, x, y0 + depth / 2, 0, DOCK, depth, 0.12)) continue;
    lot.place(B40_ELEMENT.Bollard, x - DOCK / 2 - 0.25, by0 + 0.5, 0, 0.25, 0.25, 1);
    last = x;
  }
  if (last === -Infinity) for (let px = env.x0 + 0.5; px + DOCK <= env.x1 - 0.3; px += 4.5) {
    lot.place(B40_ELEMENT.Parking, px + DOCK / 2, by0 + 6, 0, DOCK, dockDepth, 0.12);
    lot.place(B40_ELEMENT.Bollard, px - 0.25, by0 + 0.5, 0, 0.25, 0.25, 1);
  }
  for (const px of [0.6, W - 0.6]) lot.place(B40_ELEMENT.Lamp, px, (by0 + by1) / 2, 0, 0.3, 0.3, 6);
  lot.place(B40_ELEMENT.Drain, W / 2, by0 + (by1 - by0) * 0.6, 0, 0.6, 0.6, 0.1);
}

export function boundary(lot: LotBuilder, W: number, D: number, F: number, Bk: number, env: B40Rect, left: B40Plan['left'], right: B40Plan['right'],
  L: Strip, R: Strip, walks: B40Rect[], drives: B40Rect[], rng: Xoshiro128): void {
  const plan = lot.plan;
  const inset = 0.1;
  const frontAt = (kind: number): number => (kind === B40_ELEMENT.Hedge ? 0.7 : kind === B40_ELEMENT.Fence || kind === B40_ELEMENT.Gate ? 0.12 : 0.2) / 2 + 0.04;
  let b: { front: number | null; frontH: number; frontBase: number; sides: number; sidesH: number };
  switch (plan.kind) {
    case 'house': {
      const style = rng.int(0, 2);
      b = style === 0 ? { front: B40_ELEMENT.Fence, frontH: 1.1, frontBase: 0.6, sides: B40_ELEMENT.Wall, sidesH: 2 }
        : style === 1 ? { front: B40_ELEMENT.Hedge, frontH: 1.1, frontBase: 0, sides: B40_ELEMENT.Wall, sidesH: 1.9 }
        : { front: B40_ELEMENT.Wall, frontH: 1.4, frontBase: 0, sides: B40_ELEMENT.Wall, sidesH: 2 };
      break;
    }
    case 'flats':
    case 'tower': b = { front: B40_ELEMENT.Fence, frontH: 1.6, frontBase: 0.45, sides: B40_ELEMENT.Wall, sidesH: 2.2 }; break;
    case 'industry': b = { front: B40_ELEMENT.Fence, frontH: 2.4, frontBase: 0, sides: B40_ELEMENT.Fence, sidesH: 2.4 }; break;
    case 'shop': b = { front: B40_ELEMENT.Railing, frontH: 1, frontBase: 0, sides: B40_ELEMENT.Wall, sidesH: 2.2 }; break;
    default: b = { front: B40_ELEMENT.Fence, frontH: 1.4, frontBase: 0.45, sides: B40_ELEMENT.Wall, sidesH: 2.2 };
  }
  const frontGaps: [number, number][] = [];
  const gates: { x: number; w: number }[] = [];
  const peopleGate = plan.kind === 'shop' || plan.kind === 'office' ? 2 : plan.kind === 'house' ? 1.2 : 1.6;
  if (F > 0) gates.push({ x: lot.door, w: peopleGate });
  if (plan.front.use === 'apron') gates.push({ x: lot.door > W / 2 ? Math.max(3.4, lot.door - 4.6) : Math.min(W - 3.4, lot.door + 4.6), w: 6 });
  for (const r of drives) gates.push({ x: (r.x0 + r.x1) / 2, w: r.x1 - r.x0 - 0.4 });
  if (plan.front.use === 'carpad') gates.push({ x: lot.door > W / 2 ? 1.8 : W - 1.8, w: 2.8 });
  for (const w of walks) if (F === 0) gates.push({ x: (w.x0 + w.x1) / 2, w: w.x1 - w.x0 - 0.2 });
  for (const g of gates) {
    if (lot.place(B40_ELEMENT.Gate, g.x, frontAt(B40_ELEMENT.Gate), 0, g.w, 0.12, plan.kind === 'industry' ? 2.2 : g.w > 2 ? 1.8 : 1.4)) frontGaps.push([g.x, g.w + 0.1]);
  }
  const builtFront = F === 0 ? [env.x0 - 0.05, env.x1 + 0.05] as const : null;
  const frontRun = (x0: number, x1: number): void => {
    if (b.front !== null && F > 0) {
      if (b.frontBase > 0) lot.runAcross(B40_ELEMENT.Wall, frontAt(B40_ELEMENT.Wall), x0, x1, b.frontBase, frontGaps);
      lot.runAcross(b.front, b.frontBase > 0 ? frontAt(B40_ELEMENT.Wall) : frontAt(b.front), x0, x1, b.frontH, frontGaps, b.frontBase);
    } else if (F === 0 || b.front === null) {
      for (const s of [L, R]) for (const r of [s.drive, s.walk, s.garden]) {
        if (!r || r.x1 < x0 || r.x0 > x1) continue;
        if (F === 0 && s.garden) lot.runAcross(B40_ELEMENT.Wall, frontAt(B40_ELEMENT.Wall), r.x0, r.x1, 1.6);
      }
    }
  };
  if (builtFront) { frontRun(0, builtFront[0]); frontRun(builtFront[1], W); } else frontRun(0, W);

  const sideHalf = (b.sides === B40_ELEMENT.Hedge ? 0.7 : b.sides === B40_ELEMENT.Fence ? 0.12 : 0.2) / 2;
  const streetSide = (x: number, y0: number, y1: number): void => {
    const kind = b.front ?? B40_ELEMENT.Wall;
    const at = (k: number): number => (x < W / 2 ? frontAt(k) : W - frontAt(k));
    const onBase = b.front !== null && b.frontBase > 0;
    if (onBase) lot.runAlong(B40_ELEMENT.Wall, at(B40_ELEMENT.Wall), y0, y1, b.frontBase);
    lot.runAlong(kind, onBase ? at(B40_ELEMENT.Wall) : at(kind), y0, y1, b.front ? b.frontH : 1.6, b.front ? b.frontBase : 0);
  };
  const isCorner = (x: number): boolean => plan.corner !== undefined && (plan.corner === 'left') === (x < W / 2);
  for (const [s, x] of [[left, sideHalf], [right, W - sideHalf]] as const) {
    const lowFront = plan.kind === 'house' || plan.kind === 'flats' ? Math.min(b.sidesH, 1.3) : b.sidesH;
    if (isCorner(x)) {
      if (s.use === 'attached') { if (F > 0) streetSide(x, inset, F); if (D - Bk > 0) streetSide(x, Bk, D - inset); }
      else streetSide(x, inset, D - inset);
    } else if (s.use === 'attached') {
      if (F > 0) lot.runAlong(b.sides, x, inset, F, lowFront);
      if (D - Bk > 0) lot.runAlong(b.sides, x, Bk, D - inset, b.sidesH);
    } else {
      if (F > 0) lot.runAlong(b.sides, x, inset, F, lowFront);
      lot.runAlong(b.sides, x, Math.max(F, inset), D - inset, b.sidesH);
    }
  }
  if (D - Bk > 0) lot.runAcross(b.sides, D - sideHalf, sideHalf, W - sideHalf, b.sidesH);

  const covers = (): CoverBox[] => {
    const boxes: CoverBox[] = [];
    for (let i = 0; i < lot.t.elN; i++) {
      const kind = lot.t.elKind[i]!;
      if (!BOUNDARY_KINDS(kind)) continue;
      const across = lot.t.elFacing[i] === 1 || lot.t.elFacing[i] === 3;
      boxes.push({ kind: 'centre', cx: lot.t.elX[i]! + W / 2, cy: lot.t.elY[i]!, hw: (across ? lot.t.elD[i]! : lot.t.elW[i]!) / 2 + 0.3, hd: (across ? lot.t.elW[i]! : lot.t.elD[i]!) / 2 + 0.3 });
    }
    for (let v = 0; v < lot.t.n; v++) {
      if (lot.t.open[v]! >= 0 || lot.t.base[v] !== 0) continue;
      const x0 = lot.t.x[v]! + W / 2, y0 = lot.t.y[v]!;
      boxes.push({ kind: 'span', x0: x0 - 0.45, x1: x0 + lot.t.w[v]! + 0.45, y0: y0 - 0.45, y1: y0 + lot.t.d[v]! + 0.45 });
    }
    return boxes;
  };
  const openRuns = (len: number, along: 'x' | 'y', fixed: number): [number, number][] => openRunsAlong(len, along, fixed, covers());
  const frontKind = b.front ?? B40_ELEMENT.Wall;
  for (const [a, c] of openRuns(W, 'x', 0.15)) {
    if (b.front !== null && b.frontBase > 0) lot.runAcross(B40_ELEMENT.Wall, frontAt(B40_ELEMENT.Wall), a, c, b.frontBase);
    lot.runAcross(frontKind, b.front !== null && b.frontBase > 0 ? frontAt(B40_ELEMENT.Wall) : frontAt(frontKind), a, c,
      b.front ? b.frontH : 1.6, [], b.front ? b.frontBase : 0);
  }
  for (const [a, c] of openRuns(W, 'x', D - 0.15)) lot.runAcross(b.sides, D - sideHalf, a, c, b.sidesH);
  const lowFront = plan.kind === 'house' || plan.kind === 'flats' ? Math.min(b.sidesH, 1.3) : b.sidesH;
  for (const x of [0.15, W - 0.15]) {
    for (const [a, c] of openRuns(D, 'y', x)) {
      const at = x < W / 2 ? sideHalf : W - sideHalf;
      if (isCorner(x)) { streetSide(at, Math.max(a, inset), Math.min(c, D - inset)); continue; }
      if (a < F) lot.runAlong(b.sides, at, Math.max(a, inset), Math.min(c, F), lowFront);
      if (c > F) lot.runAlong(b.sides, at, Math.max(a, F), Math.min(c, D - inset), b.sidesH);
    }
  }
}
