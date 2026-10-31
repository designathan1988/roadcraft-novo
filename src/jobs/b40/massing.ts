// Buildings made to measure for a lot, writing the b40 SoA body. The rules, values and random order are Roadcraft
// 4.0's (world/buildings/procedural.ts); the structures are not: blocks, storeys, bays and materials go into typed
// columns and the 4.0 record is only built by the temporary adapter.
import type { Xoshiro128 } from '../../core/rng.ts';
import { B40_BAY, B40_CORE, B40_CROWN, B40_ELEMENT, B40_GROUND, B40_KIND, B40_LINES, B40_ROOF, B40_USE } from '../../world/b40Kinds.ts';
import { B40_STYLE, B40_STYLES, type B40Paint } from '../../world/b40Styles.ts';
import { FIN } from '../../shared/finishes.ts';
import { B40Table, type B40Free, type B40Made } from './volumes.ts';
import { baysOf, composeFacades, paintsOf, stoneBaseOf, styleFor } from './facades.ts';
import { elementClash } from './clash.ts';
import { lightness, nudge, paintOf } from './paint.ts';

export interface B40Envelope {
  readonly W: number;
  readonly D: number;
  readonly door?: number;
  readonly backDoor?: boolean;
  readonly character?: number;
  readonly driveSide?: 'left' | 'right';
  readonly neighbours?: readonly number[];
  readonly era?: 0 | 1 | 2;
}

const pickOf = <T>(rng: Xoshiro128, list: readonly T[]): T => list[rng.int(0, list.length - 1)]!;
const between = (rng: Xoshiro128, a: number, b: number): number => a + (b - a) * rng.float();
const half = (x: number): number => Math.round(x * 2) / 2;
const stepsIn = (units: number, step: number): number => Math.round((units / step) * 1e6) / 1e6;

const BRICKS: readonly B40Paint[] = [
  paintOf(FIN.Brick, 0xa4563f), paintOf(FIN.Brick, 0x8c4a35), paintOf(FIN.Brick, 0xb86a4a), paintOf(FIN.Brick, 0x9a6a52),
  paintOf(FIN.Brick, 0xc08060), paintOf(FIN.Brick, 0x7d5444), paintOf(FIN.Brick, 0xb59a80),
];
const HARD: readonly B40Paint[] = [
  paintOf(FIN.Concrete, 0xbcbab3), paintOf(FIN.Stone, 0xcfc7b6), paintOf(FIN.Ceramic, 0xd8d4cc), paintOf(FIN.Concrete, 0xa9aaa5),
  paintOf(FIN.Stone, 0xb9ae98), paintOf(FIN.Ceramic, 0x9e9a92), paintOf(FIN.Stone, 0xd9cdb4),
];
const ROOF_TILES: readonly B40Paint[] = [
  paintOf(FIN.Tile, 0xb5603f), paintOf(FIN.Tile, 0x8f4a35), paintOf(FIN.Slate, 0x55595e), paintOf(FIN.Roofing, 0x6b5a4c),
  paintOf(FIN.Tile, 0x7a3f32), paintOf(FIN.Slate, 0x3f4a52), paintOf(FIN.Tile, 0xa86d4a), paintOf(FIN.Tile, 0xc06a45),
  paintOf(FIN.Tile, 0x9c4f3a), paintOf(FIN.Roofing, 0x9a9a94), paintOf(FIN.Metal, 0x4f6b55), paintOf(FIN.Metal, 0x6e3b32),
  paintOf(FIN.Tile, 0x6b5f57),
];
const CLAY: readonly B40Paint[] = ROOF_TILES.filter((r) => r.finish === FIN.Tile);
const WORKS_ROOFS: readonly number[] = [0x6d7378, 0x8a8f86, 0x5d6870, 0x9a9890, 0x7a4a3a, 0x4f6b55];
const AWNINGS: readonly number[] = [0xb8382e, 0x2f6b4f, 0x2f4f7a, 0xd9a43a, 0x6b3f6b, 0x3d3d3d, 0xc7652f, 0x1f5f6b, 0x8a2f3c, 0x3f7f8f, 0x5c6b2f, 0xd06d8a];

const roofOf = (rng: Xoshiro128, list: readonly B40Paint[]): B40Paint => {
  const r = pickOf(rng, list);
  return paintOf(r.finish, nudge(r.colour, rng, 0.5));
};

function otherSkin(style: number, rng: Xoshiro128, wall: B40Paint): B40Paint {
  for (let k = 0; k < 4; k++) {
    const p = paintsOf(style, rng).wall;
    if (Math.abs(lightness(p.colour) - lightness(wall.colour)) > 0.04 || p.finish !== wall.finish) return p;
  }
  return paintOf(wall.finish, nudge(wall.colour, rng, 3));
}

/** A part hung on the body unless it cuts into a block (4.0 procedural.ts hang). */
function hang(t: B40Table, kind: number, x: number, y: number, w: number, d: number, z: number, h: number, material?: B40Paint, facing = 0): void {
  if (t.elN >= 96) return;
  if (elementClash(t, { kind, x, y, w, d, facing, z, h }) >= 0) return;
  t.el(kind, x, y, facing, { w, d, h, z, material });
}

function doorAt(t: B40Table, v: number, x: number, kind: number): number {
  const across = baysOf(t, v);
  const bay = Math.max(0, Math.min(across - 1, Math.floor(((x - t.x[v]!) / t.w[v]!) * across)));
  t.setBay(v, 0, 0, bay, kind);
  return t.x[v]! + ((bay + 0.5) * t.w[v]!) / across;
}

function backDoorOn(t: B40Table, v: number): number {
  const across = baysOf(t, v, 2);
  const bay = Math.floor(across / 2);
  t.setBay(v, 0, 2, bay, B40_BAY.Door);
  return t.x[v]! + ((bay + 0.5) * t.w[v]!) / across;
}

/** After the facades: the entrance, the base stone and the projecting columns (4.0 dressBuilding). */
function dressBuilding(t: B40Table, style: number, rng: Xoshiro128, entrance: number, front: number, ground: number, keep: ReadonlySet<number>): void {
  const s = B40_STYLES[style]!;
  const solid: number[] = [];
  for (let v = 0; v < t.n; v++) if (t.open[v]! < 0 && !keep.has(v)) solid.push(v);
  const baseWall = t.wallRef >= 0 ? paintOf(t.matFinish[t.wallRef]!, t.matColour[t.wallRef]!) : undefined;
  if (s.stoneBase) {
    for (const v of solid) {
      if (t.base[v] !== 0 || t.storeys[v]! < 2) continue;
      const wall = t.wallMat[v]! >= 0 ? paintOf(t.matFinish[t.wallMat[v]!]!, t.matColour[t.wallMat[v]!]!) : baseWall;
      if (!wall) continue;
      const stone = stoneBaseOf(wall);
      const ref = t.material(stone);
      for (let side = 0; side < 4; side++) t.setStoreyMaterial(v, 0, side, ref);
    }
  }
  if (!keep.has(front)) {
    const across = baysOf(t, front);
    const bay = Math.max(0, Math.min(across - 1, Math.floor(((entrance - t.x[front]!) / t.w[front]!) * across)));
    const bw = t.w[front]! / across;
    const modern = style === B40_STYLE.Contemporary || style === B40_STYLE.Modernist || style === B40_STYLE.Glass ||
      style === B40_STYLE.Tropical || style === B40_STYLE.ModernHouse;
    if (ground === B40_GROUND.Lobby && modern) {
      const span = Math.min(t.w[front]! - 0.6, bw * (across >= 5 ? 3 : 1) + 1.2);
      const z = Math.min(t.groundHeight - 0.45, 3.6);
      hang(t, B40_ELEMENT.Canopy, t.x[front]! + (bay + 0.5) * bw, t.y[front]! - 1.2, span, 2.4, z, 0.22);
    } else if (ground !== B40_GROUND.Shop && style !== B40_STYLE.Colonial && style !== B40_STYLE.ColonialHouse &&
      t.w[front]! > 6 && rng.float() < 0.45) {
      t.addRelief(front, 0, bay, bay, 0, 0, -1.2);
    } else if (ground !== B40_GROUND.Shop) {
      const z = Math.min(t.groundHeight - 0.35, 3.1);
      hang(t, B40_ELEMENT.Canopy, t.x[front]! + (bay + 0.5) * bw, t.y[front]! - 0.8, Math.min(4, bw + 1), 1.6, z, 0.18);
    }
  }
  if (style === B40_STYLE.Contemporary || style === B40_STYLE.Modernist || style === B40_STYLE.Tropical || style === B40_STYLE.Brick) {
    for (const v of solid) {
      const across = baysOf(t, v), upper = t.storeys[v]!;
      if (t.outlineN[v]! > 0 || upper < 6 || across < 5 || rng.float() < 0.45) continue;
      const mid = Math.floor(across / 2), spread = across >= 9 ? 1 : 0;
      const lo = t.base[v]! === 0 ? 1 : 0;
      for (const side of [0, 2]) t.addRelief(v, side, mid - spread, mid + spread, lo, upper - 1, 0.6);
    }
  }
  if (style === B40_STYLE.ArtDeco || style === B40_STYLE.Colonial) {
    for (const v of solid) {
      const across = baysOf(t, v), upper = t.storeys[v]!;
      if (upper < 4 || across < 5) continue;
      const lo = t.base[v]! === 0 ? 1 : 0;
      t.addRelief(v, 0, 0, 0, lo, upper - 1, 0.5);
      t.addRelief(v, 0, across - 1, across - 1, lo, upper - 1, 0.5);
    }
  }
}

const MIN_PITCH = 5;
const MAX_ROOF_RISE: Partial<Record<number, number>> = {
  [B40_ROOF.Gable]: 3.2, [B40_ROOF.Hip]: 3.2, [B40_ROOF.Shed]: 1.2, [B40_ROOF.Sawtooth]: 2,
};
const PITCH: Partial<Record<number, readonly [number, number]>> = {
  [B40_ROOF.Gable]: [20, 35], [B40_ROOF.Hip]: [20, 32], [B40_ROOF.Shed]: [5, 14], [B40_ROOF.Sawtooth]: [22, 30],
};

/** Pitch and ridge of a pitched roof; the default `ridgeToStreet` draws its float even for a flat roof (4.0 roofShape). */
function roofShape(t: B40Table, v: number, rng: Xoshiro128, ridgeToStreet = rng.float() < 0.33): void {
  const roof = t.roof[v]!;
  if (roof === B40_ROOF.Flat || roof === B40_ROOF.Terrace) return;
  if (roof === B40_ROOF.Gable || roof === B40_ROOF.Hip) t.ridge[v] = ridgeToStreet ? 1 : 0;
  if (roof === B40_ROOF.Shed && t.fall[v]! < 0 && t.w[v]! < t.d[v]!) t.fall[v] = 1;
  const [lo, hi] = PITCH[roof] ?? [20, 30];
  const run = roof === B40_ROOF.Shed
    ? (((t.fall[v]! < 0 ? 0 : t.fall[v]!) % 2 === 0) ? t.d[v]! : t.w[v]!)
    : roof === B40_ROOF.Sawtooth ? Math.min(6, t.d[v]!) / 2
    : ((t.ridge[v]! >= 0 ? t.ridge[v] === 0 : t.w[v]! >= t.d[v]!) ? t.d[v]! : t.w[v]!) / 2;
  const cap = (Math.atan((MAX_ROOF_RISE[roof] ?? 3) / Math.max(run, 1e-6)) * 180) / Math.PI;
  if (cap < MIN_PITCH * 0.66) { t.roof[v] = B40_ROOF.Flat; t.pitch[v] = NaN; t.ridge[v] = -1; t.fall[v] = -1; return; }
  t.pitch[v] = Math.max(MIN_PITCH, Math.floor(Math.min(between(rng, lo, hi), cap)));
}

function towerShape(rng: Xoshiro128): { x: number; y: number }[] | undefined {
  const r = rng.float();
  if (r < 0.5) return undefined;
  if (r < 0.85) {
    const c = between(rng, 0.14, 0.26);
    return [{ x: c, y: 0 }, { x: 1 - c, y: 0 }, { x: 1, y: c }, { x: 1, y: 1 - c }, { x: 1 - c, y: 1 }, { x: c, y: 1 }, { x: 0, y: 1 - c }, { x: 0, y: c }];
  }
  return Array.from({ length: 16 }, (_, k) => {
    const a = -Math.PI / 2 + (k / 16) * Math.PI * 2;
    return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
  });
}

function houseRoof(rng: Xoshiro128, style: number): number {
  if (style === B40_STYLE.ColonialHouse) return pickOf(rng, [B40_ROOF.Flat, B40_ROOF.Flat, B40_ROOF.Gable, B40_ROOF.Hip]);
  if (style === B40_STYLE.ModernHouse) return pickOf(rng, [B40_ROOF.Flat, B40_ROOF.Flat, B40_ROOF.Flat, B40_ROOF.Shed]);
  if (style === B40_STYLE.Sobrado) return pickOf(rng, [B40_ROOF.Gable, B40_ROOF.Hip, B40_ROOF.Flat]);
  return pickOf(rng, [B40_ROOF.Gable, B40_ROOF.Hip, B40_ROOF.Hip]);
}

/** The body finishes: pitches, roof membrane, facades, entrance, back door and dress (4.0 finish). */
function finish(t: B40Table, fn: string, env: B40Envelope, rng: Xoshiro128, style: number, ground: number, free: B40Free[],
  doorKind: number, doorBlock: number | undefined, keep: ReadonlySet<number>): B40Made {
  t.functionName = fn;
  for (let v = 0; v < t.n; v++) if (Number.isNaN(t.pitch[v])) roofShape(t, v, rng);
  const roofRef = t.roofRef;
  if (roofRef >= 0) {
    const finishId = t.matFinish[roofRef]!;
    if (finishId === FIN.Tile || finishId === FIN.Slate || finishId === FIN.Metal) {
      const membrane = paintOf(FIN.Roofing, nudge(0x74716a, rng, 0.6));
      for (let v = 0; v < t.n; v++) {
        if (t.open[v]! < 0 && (t.roof[v] === B40_ROOF.Flat || t.roof[v] === B40_ROOF.Terrace) && t.roofMat[v]! < 0) t.roofMat[v] = t.material(membrane);
      }
    }
  }
  const composed: number[] = [];
  for (let v = 0; v < t.n; v++) if (!keep.has(v)) composed.push(v);
  composeFacades(t, composed, style, rng, ground);
  const solid: number[] = [];
  for (let v = 0; v < t.n; v++) if (t.open[v]! < 0 && t.base[v] === 0) solid.push(v);
  const front = doorBlock ?? solid.filter((v) => !keep.has(v)).sort((p, q) => t.y[p]! - t.y[q]! || t.w[q]! - t.w[p]!)[0] ?? solid[0]!;
  const want = env.door ?? env.W / 2;
  const entrance = doorAt(t, front, Math.max(t.x[front]!, Math.min(t.x[front]! + t.w[front]!, want)), doorKind);
  const backBlock = [...solid].sort((p, q) => (t.y[q]! + t.d[q]!) - (t.y[p]! + t.d[p]!))[0]!;
  const back = env.backDoor ? backDoorOn(t, backBlock) : undefined;
  dressBuilding(t, style, rng, entrance, front, ground, keep);
  return { body: t, entrance, ...(back !== undefined ? { backDoor: back } : {}), free };
}

function house(t: B40Table, rng: Xoshiro128, env: B40Envelope): B40Made {
  const { W, D } = env;
  const style = styleFor(B40_KIND.House, rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  const roofMat = roofOf(rng, style === B40_STYLE.ModernHouse ? ROOF_TILES : CLAY);
  t.palette = rng.int(0, 7); t.heights(between(rng, 2.8, 3.3), between(rng, 2.8, 3.1)); t.look(paints.wall, roofMat, paints.trim);
  const storeys = style === B40_STYLE.Sobrado ? 2 : rng.float() < 0.5 ? 2 : 1;
  const roof = houseRoof(rng, style);
  const w = half(W), d = half(D);
  const forms: string[] = ['wing', 'veranda'];
  if (W >= 10) forms.push('ell', 'twin');
  if (W >= 11 && env.driveSide) forms.push('garage');
  if (W >= 12 && D <= 14 && style === B40_STYLE.Bungalow) forms.push('bungalow', 'bungalow');
  const form = pickOf(rng, forms);
  const free: B40Free[] = [];
  const keep = new Set<number>();
  let doorBlock: number | undefined;
  switch (form) {
    case 'ell': {
      const wingW = half(Math.min(w * 0.45, between(rng, 3.5, 5)));
      const step = half(Math.min(d * 0.35, between(rng, 2, 3.5)));
      const left = rng.float() < 0.5;
      const mainD = half(Math.min(d - step, between(rng, 7.5, 10)));
      t.block({ x: 0, y: step, w, d: mainD, storeys, roof, fill: B40_BAY.Window });
      t.block({ x: left ? 0 : w - wingW, y: 0, w: wingW, d: step + half(mainD * 0.6), storeys: rng.float() < 0.6 ? storeys : 1, roof: roof === B40_ROOF.Flat ? B40_ROOF.Flat : B40_ROOF.Gable, fill: B40_BAY.Window });
      free.push(left ? { x0: wingW, y0: 0, x1: w, y1: step } : { x0: 0, y0: 0, x1: w - wingW, y1: step });
      doorBlock = 0;
      roofShape(t, 0, rng, false);
      roofShape(t, 1, rng, true);
      break;
    }
    case 'veranda': {
      const deep = half(between(rng, 1.8, 2.6));
      const mainD = half(Math.min(d - deep, between(rng, 8, 11)));
      t.block({ x: 0, y: deep, w, d: mainD, storeys, roof, fill: B40_BAY.Window });
      if (d - deep - mainD >= 2.5 && rng.float() < 0.6) {
        const ww = half(Math.max(Math.min(w, 4), w * between(rng, 0.4, 0.6)));
        t.block({ x: rng.float() < 0.5 ? 0 : w - ww, y: deep + mainD, w: ww, d: half(d - deep - mainD), storeys: 1, roof: B40_ROOF.Flat, fill: B40_BAY.Window });
      }
      roofShape(t, 0, rng);
      const vx0 = 0.3, vx1 = w - 0.3;
      const span = rng.float() < 0.5 ? [vx0, vx1] : [vx0, Math.max(3.5, w * 0.6)];
      const vw = span[1]! - span[0]!, cx = (span[0]! + span[1]!) / 2;
      hang(t, B40_ELEMENT.Pavement, cx, deep / 2, vw, deep, 0, 0.15, paintOf(FIN.Ceramic, nudge(0xb5654a, rng)));
      hang(t, B40_ELEMENT.Slab, cx, deep / 2 - 0.05, vw + 0.3, deep - 0.1, t.groundHeight - 0.2, 0.16, paints.trim);
      const posts = Math.max(2, Math.round(stepsIn(vw, 2.6)) + 1);
      for (let k = 0; k < posts; k++) {
        hang(t, B40_ELEMENT.Pillar, span[0]! + 0.15 + ((vw - 0.3) * k) / (posts - 1), 0.2, 0.2, 0.2, 0, t.groundHeight - 0.2, paints.trim);
      }
      break;
    }
    case 'garage': {
      const gw = half(between(rng, 3, 3.6));
      const onLeft = env.driveSide === 'left';
      const mainD = half(Math.min(d, between(rng, 8, 10.5)));
      const back = half(between(rng, 0.5, 2));
      t.block({ x: onLeft ? gw : 0, y: 0, w: w - gw, d: mainD, storeys, roof, fill: B40_BAY.Window });
      t.block({ x: onLeft ? 0 : w - gw, y: back, w: gw, d: half(Math.min(d - back, 6)), storeys: 1, roof: rng.float() < 0.5 ? B40_ROOF.Flat : B40_ROOF.Shed, fill: B40_BAY.Wall, ground: B40_BAY.Wall });
      doorBlock = 0;
      roofShape(t, 0, rng);
      const g = 1;
      t.setBay(g, 0, 0, 0, B40_BAY.GarageDoor);
      t.dressLines[g] = B40_LINES.None;
      t.dressCrown[g] = B40_STYLES[style]!.crown === B40_CROWN.Cornice ? B40_CROWN.None : B40_STYLES[style]!.crown;
      keep.add(g);
      break;
    }
    case 'twin': {
      const split = half(w * between(rng, 0.42, 0.58));
      const setback = half(between(rng, 0.8, 2));
      const tallLeft = rng.float() < 0.5;
      const mainD = half(Math.min(d - setback, between(rng, 8, 10)));
      t.block({ x: 0, y: tallLeft ? 0 : setback, w: split, d: mainD, storeys: tallLeft ? 2 : 1, roof, fill: B40_BAY.Window });
      t.block({ x: split, y: tallLeft ? setback : 0, w: w - split, d: mainD, storeys: tallLeft ? 1 : 2, roof: houseRoof(rng, style), fill: B40_BAY.Window });
      roofShape(t, 0, rng);
      roofShape(t, 1, rng);
      t.wallMat[1] = t.material(otherSkin(style, rng, paints.wall));
      break;
    }
    case 'bungalow': {
      const mainD = half(Math.min(d, between(rng, 7.5, 10)));
      t.block({ x: 0, y: 0, w, d: mainD, storeys: 1, roof: B40_ROOF.Hip, fill: B40_BAY.Window });
      roofShape(t, 0, rng, false);
      t.pitch[0] = Math.round(between(rng, 20, 28));
      break;
    }
    default: {
      const mainD = half(Math.min(d, between(rng, 7.5, 10)));
      t.block({ x: 0, y: 0, w, d: mainD, storeys, roof, fill: B40_BAY.Window });
      if (d - mainD >= 2) {
        const ww = half(Math.max(Math.min(w, 4), w * between(rng, 0.45, 0.7)));
        const left = rng.float() < 0.5;
        t.block({ x: left ? 0 : w - ww, y: mainD, w: ww, d: half(d - mainD), storeys: 1, roof: pickOf(rng, [B40_ROOF.Flat, B40_ROOF.Shed, roof]), fill: B40_BAY.Window });
        if (w - ww >= 2) free.push(left ? { x0: ww, y0: mainD, x1: w, y1: d } : { x0: 0, y0: mainD, x1: w - ww, y1: d });
      }
      roofShape(t, 0, rng);
      break;
    }
  }
  const doorKind = rng.float() < 0.3 ? B40_BAY.DoubleDoor : B40_BAY.Door;
  return finish(t, 'house', env, rng, style, B40_GROUND.House, free, doorKind, doorBlock, keep);
}

function setbacks(t: B40Table, rng: Xoshiro128, x: number, y: number, w: number, d: number, base: number, floors: number,
  spec: { roof: number; shape?: readonly { x: number; y: number }[] }): void {
  let left = floors, at = base, bx = x, by = y, bw = w, bd = d;
  const scale = between(rng, 0.75, 0.9);
  for (let step = 0; left > 0; step++) {
    const part = left > 6 && step < 3 ? Math.max(3, Math.round(left * pickOf(rng, [0.4, 0.6]))) : left;
    t.block({ x: bx, y: by, w: bw, d: bd, base: at, storeys: part, ...(spec.shape ? { shape: spec.shape } : {}), roof: part === left ? spec.roof : B40_ROOF.Terrace });
    at += part; left -= part;
    const nw = half(Math.max(8, bw * scale)), nd = half(Math.max(8, bd * scale));
    bx += half((bw - nw) / 2); by += half((bd - nd) / 2); bw = nw; bd = nd;
  }
}

function flats(t: B40Table, rng: Xoshiro128, env: B40Envelope, high: boolean): B40Made {
  const { W, D } = env;
  const fn = high ? 'residentialTower' : 'apartments';
  const style = styleFor(high ? B40_KIND.Tower : B40_KIND.Flats, rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  t.palette = rng.int(0, 7); t.heights(between(rng, 3.8, 4.5), between(rng, 2.9, 3.1)); t.look(paints.wall, roofOf(rng, CLAY), paints.trim);
  const near = env.neighbours?.length ? Math.max(...env.neighbours) : null;
  const cap = near !== null && !high ? Math.max(3, near + 3) : Infinity;
  const floors = high ? (rng.float() < 0.125 ? rng.int(30, 44) : rng.int(8, 24)) : Math.min(cap, rng.int(3, 7));
  const ground = rng.float() < 0.25 ? B40_GROUND.Shop : B40_GROUND.Lobby;
  const roof = !high && (style === B40_STYLE.Colonial || style === B40_STYLE.Brick) && rng.float() < 0.4 ? B40_ROOF.Hip
    : rng.float() < 0.3 ? B40_ROOF.Terrace : B40_ROOF.Flat;
  const w = half(W), d = half(D);
  const free: B40Free[] = [];
  const barD = half(Math.min(d, between(rng, 12, 15)));
  let form = '';
  if (high) {
    const podium = rng.int(1, 2);
    const inset = half(between(rng, 0.5, 1.2));
    const tw = Math.max(8, w - 2 * inset), td = Math.max(8, Math.min(d - 2 * inset, 22));
    const pd = Math.min(d, td + 2 * inset);
    t.block({ x: 0, y: 0, w, d: pd, storeys: podium, roof: B40_ROOF.Terrace });
    if (d - pd >= 2) free.push({ x0: 0, y0: pd, x1: w, y1: d });
    const forms = ['box', 'setback', 'crown', 'crown'];
    if (tw >= 14) forms.push('ell');
    if (tw >= 26) forms.push('twin', 'twin');
    const kind = pickOf(rng, forms);
    const shape = kind === 'ell' ? undefined : towerShape(rng);
    form = `tower:${kind}`;
    switch (kind) {
      case 'setback': setbacks(t, rng, inset, inset, tw, td, podium, floors, { ...(shape ? { shape } : {}), roof: B40_ROOF.Flat }); break;
      case 'ell': {
        const legW = half(Math.max(8, tw * between(rng, 0.38, 0.5)));
        const left = rng.float() < 0.5;
        t.block({ x: inset, y: inset, w: tw, d: half(Math.max(8, td * 0.5)), base: podium, storeys: floors, roof: B40_ROOF.Flat });
        t.block({ x: left ? inset : inset + tw - legW, y: inset + half(Math.max(8, td * 0.5)), w: legW, d: half(Math.max(4, td * 0.5)), base: podium, storeys: Math.max(4, floors - rng.int(0, 4)), roof: B40_ROOF.Flat });
        break;
      }
      case 'twin': {
        const gap = half(between(rng, 3, 5));
        const each = half((tw - gap) / 2);
        const other = Math.max(6, floors + pickOf(rng, [-5, -3, 3, 5]));
        t.block({ x: inset, y: inset, w: each, d: td, base: podium, storeys: floors, ...(shape ? { shape } : {}), roof: B40_ROOF.Flat });
        t.block({ x: inset + each + gap, y: inset, w: each, d: td, base: podium, storeys: other, ...(shape ? { shape } : {}), roof: B40_ROOF.Flat });
        break;
      }
      case 'crown': {
        const top = rng.int(1, 3);
        t.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: floors - top, ...(shape ? { shape } : {}), roof: B40_ROOF.Terrace });
        const cin = half(between(rng, 1.5, 3));
        t.block({ x: inset + cin, y: inset + cin, w: Math.max(6, tw - 2 * cin), d: Math.max(6, td - 2 * cin), base: podium + floors - top, storeys: top, roof: B40_ROOF.Flat, ...(shape ? { shape } : {}) });
        break;
      }
      default: t.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: floors, ...(shape ? { shape } : {}), roof: B40_ROOF.Flat });
    }
  } else if (d - barD >= 6 && w >= 20 && rng.float() < 0.5) {
    form = 'flats:u';
    const ww = half(between(rng, 6, Math.min(9, w / 3)));
    const wingFloors = Math.max(2, floors - rng.int(0, 2));
    t.block({ x: 0, y: 0, w, d: barD, storeys: floors, roof });
    t.block({ x: 0, y: barD, w: ww, d: d - barD, storeys: wingFloors, roof });
    t.block({ x: w - ww, y: barD, w: ww, d: d - barD, storeys: wingFloors, roof });
    free.push({ x0: ww, y0: barD, x1: w - ww, y1: d });
  } else if (d - barD >= 6 && w >= 14 && rng.float() < 0.7) {
    form = 'flats:l';
    const ww = half(between(rng, 7, Math.min(11, w / 2)));
    const left = rng.float() < 0.5;
    t.block({ x: 0, y: 0, w, d: barD, storeys: floors, roof });
    t.block({ x: left ? 0 : w - ww, y: barD, w: ww, d: d - barD, storeys: rng.float() < 0.25 ? Math.max(2, Math.round(floors * 0.7)) : floors, roof });
    free.push(left ? { x0: ww, y0: barD, x1: w, y1: d } : { x0: 0, y0: barD, x1: w - ww, y1: d });
  } else if (w >= 16 && rng.float() < 0.4) {
    form = 'flats:pair';
    const split = half(w * between(rng, 0.4, 0.6));
    const back = half(between(rng, 1, 2.5));
    t.block({ x: 0, y: 0, w: split, d, storeys: floors, roof });
    t.block({ x: split, y: back, w: w - split, d: d - back, storeys: Math.max(2, floors + pickOf(rng, [-2, -1, 1, 2])), roof });
  } else {
    form = 'flats:bar';
    const lower = floors >= 5 && rng.float() < 0.5 ? floors - rng.int(1, 2) : floors;
    t.block({ x: 0, y: 0, w, d, storeys: lower, roof: lower < floors ? B40_ROOF.Terrace : roof });
    if (lower < floors && d >= 9) t.block({ x: 0, y: 2, w, d: d - 2, base: lower, storeys: floors - lower, roof });
  }
  t.core(B40_CORE.StairLift, half(w / 2 - 1.5), half(Math.min(d, 10) / 2 - 1.5), floors + (high ? 2 : 0));
  if (form === 'flats:pair' && rng.float() < 0.6) t.wallMat[1] = t.material(otherSkin(style, rng, paints.wall));
  for (let v = 0; v < t.n; v++) roofShape(t, v, rng);
  return finish(t, fn, env, rng, style, ground, free, B40_BAY.DoubleDoor, undefined, new Set());
}

function shop(t: B40Table, rng: Xoshiro128, env: B40Envelope, density: 'low' | 'medium'): B40Made {
  const { W, D } = env;
  const fn = pickOf(rng, density === 'low'
    ? ['shop', 'bakery', 'pharmacy', 'snackBar', 'bar', 'shop', 'restaurant', 'supermarket']
    : ['shop', 'restaurant', 'bank', 'hotel', 'gym', 'office', 'pharmacy', 'supermarket']);
  const style = styleFor(B40_KIND.Shop, rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  t.palette = rng.int(0, 7); t.heights(between(rng, 4, 4.6), 3.1); t.look(paints.wall, roofOf(rng, CLAY), paints.trim);
  const near = env.neighbours?.length ? Math.max(...env.neighbours) : null;
  const storeys = density === 'low' ? rng.int(1, 3) : Math.min(near !== null ? Math.max(2, near + 3) : 6, rng.int(2, 6));
  const roof = storeys === 1 && style === B40_STYLE.Colonial && rng.float() < 0.4 ? pickOf(rng, [B40_ROOF.Gable, B40_ROOF.Hip])
    : rng.float() < 0.2 ? B40_ROOF.Terrace : B40_ROOF.Flat;
  const w = half(W), d = half(D);
  const mainD = d > 16 ? half(between(rng, 12, Math.min(16, d - 3))) : d;
  let form = 'shop:block';
  const keep = new Set<number>();
  if (w >= 14 && storeys >= 2 && rng.float() < 0.35) {
    form = 'shop:pair';
    const split = half(w * between(rng, 0.4, 0.6));
    t.block({ x: 0, y: 0, w: split, d: mainD, storeys, roof });
    t.block({ x: split, y: 0, w: w - split, d: mainD, storeys: Math.max(1, storeys + pickOf(rng, [-1, 1])), roof });
  } else t.block({ x: 0, y: 0, w, d: mainD, storeys, roof });
  if (d - mainD >= 2) t.block({ x: 0, y: mainD, w, d: d - mainD, storeys: 1, roof: B40_ROOF.Flat, fill: B40_BAY.Wall, ground: B40_BAY.Wall });
  if (d - mainD >= 2) {
    const store = t.n - 1;
    t.dressLines[store] = B40_LINES.None; t.dressCrown[store] = B40_CROWN.None;
    keep.add(store);
  }
  if (form === 'shop:pair') t.wallMat[1] = t.material(otherSkin(style, rng, paints.wall));
  for (let v = 0; v < t.n; v++) roofShape(t, v, rng);
  const doorKind = rng.float() < 0.5 ? B40_BAY.DoubleDoor : B40_BAY.Door;
  const made = finish(t, fn, env, rng, style, B40_GROUND.Shop, [], doorKind, undefined, keep);
  if (storeys > 1 && w >= 7) {
    const main = 0;
    const across = baysOf(t, main);
    const end = rng.float() < 0.5 ? 0 : across - 1;
    const existing = t.bay(main, 0, 0, end);
    if (existing !== B40_BAY.DoubleDoor && existing !== B40_BAY.Door) t.setBay(main, 0, 0, end, B40_BAY.Door);
  }
  if ((style === B40_STYLE.Colonial || style === B40_STYLE.Brick) && rng.float() < 0.3) {
    hang(t, B40_ELEMENT.Awning, w / 2, -0.6, Math.max(2, w - 1), between(rng, 1, 1.6), 3, 0.12, paintOf(FIN.Metal, pickOf(rng, AWNINGS)));
  }
  return made;
}

function office(t: B40Table, rng: Xoshiro128, env: B40Envelope): B40Made {
  const { W, D } = env;
  const style = styleFor(B40_KIND.Office, rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  t.palette = rng.int(0, 7); t.heights(between(rng, 4.5, 5.5), between(rng, 3.4, 3.9));
  t.look(paints.wall, paintOf(FIN.Concrete, 0x8a8a86), paints.trim);
  const floors = rng.int(8, 24);
  const w = half(W), d = half(D);
  const free: B40Free[] = [];
  if (rng.float() < 0.6 && w >= 14 && d >= 14) {
    const podium = rng.int(1, 3);
    const inset = half(between(rng, 0.5, 1.2));
    const tw = w - 2 * inset, td = Math.max(8, Math.min(d - 2 * inset, 24));
    const pd = Math.min(d, td + 2 * inset);
    t.block({ x: 0, y: 0, w, d: pd, storeys: podium, roof: B40_ROOF.Terrace });
    if (d - pd >= 2) free.push({ x0: 0, y0: pd, x1: w, y1: d });
    const shaft = floors - podium;
    const pickForm = style === B40_STYLE.ArtDeco ? 'setback' : pickOf(rng, tw >= 26 ? ['setback', 'podium', 'twin', 'crown'] : ['setback', 'podium', 'crown']);
    if (pickForm === 'setback') setbacks(t, rng, inset, inset, tw, td, podium, shaft, { roof: B40_ROOF.Flat });
    else if (pickForm === 'twin') {
      const gap = half(between(rng, 3, 5)), each = half((tw - gap) / 2);
      t.block({ x: inset, y: inset, w: each, d: td, base: podium, storeys: shaft, roof: B40_ROOF.Flat });
      t.block({ x: inset + each + gap, y: inset, w: each, d: td, base: podium, storeys: Math.max(4, shaft + pickOf(rng, [-6, -3, 4])), roof: B40_ROOF.Flat });
    } else if (pickForm === 'crown') {
      const top = rng.int(2, 3), cin = half(between(rng, 1, 2.5));
      t.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: shaft - top, roof: B40_ROOF.Terrace });
      t.block({ x: inset + cin, y: inset + cin, w: Math.max(6, tw - 2 * cin), d: Math.max(6, td - 2 * cin), base: podium + shaft - top, storeys: top, roof: B40_ROOF.Flat });
    } else t.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: shaft, roof: B40_ROOF.Flat });
  } else {
    t.block({ x: 0, y: 0, w, d, storeys: floors, roof: B40_ROOF.Flat });
  }
  t.core(B40_CORE.StairLift, half(w / 2 - 1.5), half(Math.min(d, 12) / 2 - 1.5), floors);
  return finish(t, 'office', env, rng, style, B40_GROUND.Lobby, free, B40_BAY.DoubleDoor, undefined, new Set());
}

function works(t: B40Table, rng: Xoshiro128, env: B40Envelope, density: 'low' | 'medium' | 'high'): B40Made {
  const { W, D } = env;
  const fn = density === 'low' ? 'warehouse' : rng.float() < 0.5 ? 'factory' : 'warehouse';
  const style = B40_STYLE.Industrial;
  const paints = paintsOf(style, rng);
  const hallH = density === 'high' ? between(rng, 8, 10) : density === 'medium' ? between(rng, 7, 9) : between(rng, 6, 7.5);
  t.palette = rng.int(0, 7); t.heights(hallH, 3.4); t.look(paints.wall, paintOf(FIN.Panel, pickOf(rng, WORKS_ROOFS)), paints.trim);
  const w = half(W), d = half(D);
  const roof = pickOf(rng, [B40_ROOF.Sawtooth, B40_ROOF.Shed, B40_ROOF.Flat, B40_ROOF.Gable, B40_ROOF.Sawtooth]);
  const free: B40Free[] = [];
  const annex = d >= 20 && w >= 12;
  const aw = annex ? half(Math.min(w - 4, between(rng, 6, 9))) : 0;
  const ad = annex ? half(between(rng, 5, 7)) : 0;
  const left = rng.float() < 0.5;
  t.block({ x: 0, y: ad, w, d: d - ad, storeys: 1, ground: B40_BAY.Wall, fill: B40_BAY.Ribbon, roof, pattern: 3 /* industrial */ });
  if (annex) {
    t.block({ x: left ? 0 : w - aw, y: 0, w: aw, d: ad, storeys: rng.int(1, 2), ground: B40_BAY.Ribbon, fill: B40_BAY.Ribbon, roof: B40_ROOF.Flat,
      wall: pickOf(rng, [...HARD, ...BRICKS]) });
    free.push(left ? { x0: aw, y0: 0, x1: w, y1: ad } : { x0: 0, y0: 0, x1: w - aw, y1: ad });
  }
  roofShape(t, 0, rng, false);
  const hall = 0;
  const across = baysOf(t, hall, 2);
  for (let i = 0; i < across; i += 2) t.setBay(hall, 0, 2, i, B40_BAY.LoadingDoor);
  t.dressLines[hall] = B40_LINES.None; t.dressCrown[hall] = B40_CROWN.Attic;
  const keep = new Set<number>([hall]);
  if (annex) {
    const officeBlock = 1;
    t.dressLines[officeBlock] = B40_LINES.Slab; t.dressCrown[officeBlock] = B40_CROWN.Slab;
    keep.add(officeBlock);
  }
  return finish(t, fn, { ...env, door: annex ? (left ? aw / 2 : w - aw / 2) : env.door ?? w / 2 }, rng, style, B40_GROUND.Works, free, B40_BAY.Door, undefined, keep);
}

/** A building for a lot of `W` x `D` metres, for a zone's use and density (4.0 madeToMeasure). */
export function madeToMeasure(t: B40Table, use: 'residential' | 'commercial' | 'industrial', density: 'low' | 'medium' | 'high', env: B40Envelope, rng: Xoshiro128): B40Made {
  t.clear();
  t.use = use === 'residential' ? B40_USE.Residential : use === 'commercial' ? B40_USE.Commercial : B40_USE.Industrial;
  if (use === 'residential') return density === 'low' ? house(t, rng, env) : flats(t, rng, env, density === 'high');
  if (use === 'commercial') return density === 'high' ? office(t, rng, env) : shop(t, rng, env, density);
  return works(t, rng, env, density);
}
