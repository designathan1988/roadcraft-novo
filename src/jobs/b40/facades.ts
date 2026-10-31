// The b40 facade grammar: style choice, paints, columns and the composition that writes a bay code into every
// column of every storey. Values and draw order from Roadcraft 4.0 architecture.ts (styleFor/paintsOf/columns
// and composeFacades); the output is the SoA table, never a Facade object with string keys.
import type { Xoshiro128 } from '../../core/rng.ts';
import { B40_BAY, B40_CROWN, B40_GROUND } from '../../world/b40Kinds.ts';
import { B40_ERA_AFFINITY, B40_FOR, B40_STYLES, type B40Paint } from '../../world/b40Styles.ts';
import { paintOf, tint } from './paint.ts';
import type { B40Table } from './volumes.ts';

const stepsIn = (units: number, step: number): number => Math.round((units / step) * 1e6) / 1e6;

/** The style a kind of building is drawn from, by weight; the quarter's era and the street's character weigh in. */
export function styleFor(kind: number, rng: Xoshiro128, character?: number, era?: 0 | 1 | 2): number {
  const list = B40_FOR[kind]!;
  const weighted = list.map(([style, weight]) => [style, weight * (era === undefined ? 1 : B40_ERA_AFFINITY[style]![era]!)] as const);
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  if (character !== undefined && rng.float() < 0.5) {
    let at = ((character * 2654435761) >>> 0) / 4294967296 * total;
    for (const [style, w] of weighted) if ((at -= w) < 0) return style;
  }
  let at = rng.float() * total;
  for (const [style, w] of weighted) if ((at -= w) < 0) return style;
  return weighted[0]![0];
}

/** The wall and trim of a building in a style: the skin's tint, and a trim that reads against it. */
export function paintsOf(style: number, rng: Xoshiro128): { wall: B40Paint; trim: B40Paint } {
  const s = B40_STYLES[style]!;
  const skin = s.skins[rng.int(0, s.skins.length - 1)]!;
  const wall = paintOf(skin.finish, tint(skin.colour, rng));
  const isLight = (c: number): boolean => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255) > 600;
  // A light frame on a light wall disappears: on a pale skin, a dark trim is preferred half the time.
  const trims = isLight(wall.colour) && s.trims.some((t) => !isLight(t.colour)) && rng.float() < 0.5
    ? s.trims.filter((t) => !isLight(t.colour)) : s.trims;
  const trim = trims[rng.int(0, trims.length - 1)]!;
  return { wall, trim: { ...trim } };
}

/** How many columns a face of `length` is shared into on a module (4.0 columnsFor). */
export function columnsFor(length: number, module: number): number {
  const exact = stepsIn(length, module);
  const n = Math.max(1, Math.round(exact));
  if (n % 2 === 1 || n < 2) return n;
  const lo = n - 1, hi = n + 1;
  const best = Math.abs(exact - lo) <= Math.abs(exact - hi) ? lo : hi;
  return Math.abs(exact - best) <= 0.75 ? best : n;
}

/** The component of column `i` of `n`, counted from the ends in (4.0 columnComponent). */
export function columnComponent(rhythm: readonly number[], i: number, n: number): number {
  return rhythm[Math.min(i, n - 1 - i) % rhythm.length]!;
}

/** The length of a volume's side: its outline segment, or the rectangle's side. */
export function sideLength(t: B40Table, v: number, side: number): number {
  const n = t.outlineN[v]!;
  if (n > 0) {
    const at = t.outlineAt[v]!;
    const p = ((side % n) + n) % n, q = (p + 1) % n;
    const dx = (t.outline[at + q * 2]! - t.outline[at + p * 2]!) * t.w[v]!;
    const dy = (t.outline[at + q * 2 + 1]! - t.outline[at + p * 2 + 1]!) * t.d[v]!;
    return Math.hypot(dx, dy);
  }
  return side === 0 || side === 2 ? t.w[v]! : t.d[v]!;
}

/** The columns a face is shared into: the composed geometry, else the 3 m module (4.0 baysOf). */
export function baysOf(t: B40Table, v: number, side = 0): number {
  const composed = t.fgBays[v * 16 + side]!;
  if (composed >= 0) return composed;
  return Math.max(1, Math.round(stepsIn(side === 0 || side === 2 ? t.w[v]! : t.d[v]!, 3)));
}

/** The stone of a style's base: the skin's tone, a harder finish, a shade darker (4.0 stoneBaseOf). */
export function stoneBaseOf(wall: B40Paint): B40Paint {
  const k = 0.86;
  const ch = (s: number): number => Math.round(((wall.colour >> s) & 255) * k);
  return paintOf(4 /* FIN.Stone */, (ch(16) << 16) | (ch(8) << 8) | ch(0));
}

/**
 * Composes the facades of `volumes` in `style`: the dress, the column counts and geometry, and each storey's fill
 * and per-bay rhythm. `ground` is what the ground floor carries (shop, lobby, house, works). The draw order is
 * 4.0's: the rhythm, then the opening width and height, then nothing else.
 */
export function composeFacades(t: B40Table, volumes: readonly number[], style: number, rng: Xoshiro128, ground: number): void {
  const s = B40_STYLES[style]!;
  const rhythm = s.rhythms[rng.int(0, s.rhythms.length - 1)]!;
  const windowWidth = s.opening.width[0] + (s.opening.width[1] - s.opening.width[0]) * rng.float();
  const windowHeight = s.opening.height[0] + (s.opening.height[1] - s.opening.height[0]) * rng.float();
  const sill = s.opening.sill;
  const tallest = Math.max(0, ...volumes.filter((v) => t.open[v]! < 0).map((v) => t.base[v]! + t.storeys[v]!));
  const counts = new Uint8Array(16);

  for (const v of volumes) {
    if (t.open[v]! >= 0) continue;
    // A block with another standing on it carries no crown of its own.
    let carries = false;
    for (const o of volumes) {
      if (o === v || t.open[o]! >= 0) continue;
      if (t.base[o]! === t.base[v]! + t.storeys[v]! &&
        t.x[o]! < t.x[v]! + t.w[v]! && t.x[o]! + t.w[o]! > t.x[v]! &&
        t.y[o]! < t.y[v]! + t.d[v]! && t.y[o]! + t.d[o]! > t.y[v]!) { carries = true; break; }
    }
    t.dressLines[v] = s.lines;
    t.dressCrown[v] = carries ? B40_CROWN.None : s.crown;

    const faces = t.outlineN[v]! > 0 ? t.outlineN[v]! : 4;
    const piers = s.piers;
    for (let side = 0; side < faces; side++) {
      const n = columnsFor(sideLength(t, v, side), s.module);
      counts[side] = n;
      const low = t.storeys[v]! < 3;
      t.setFacadeGeometry(v, side, n, windowWidth, windowHeight, sill,
        piers && !low ? piers.width : NaN, piers && !low ? piers.depth : NaN, piers && !low ? piers.every : -1);
    }

    const top = t.base[v]! + t.storeys[v]! - 1;
    for (let k = 0; k < t.storeys[v]!; k++) {
      const level = t.base[v]! + k;
      const crownFloor = s.top !== null && tallest >= 4 && level === tallest - 1 && level === top && level > 0;
      let fill: number;
      let rhythmBays = false;
      if (level === 0) {
        fill = ground === B40_GROUND.Shop ? B40_BAY.Shopfront : ground === B40_GROUND.Works ? B40_BAY.Wall : s.groundFill;
      } else if (crownFloor) {
        fill = s.top!;
      } else {
        fill = s.sideFill;
        rhythmBays = true;
      }
      if (rhythmBays) {
        for (let side = 0; side < faces; side++) {
          // The street and the back of a block; on a shaped plan, its long faces only.
          if (t.outlineN[v]! > 0 ? counts[side]! < 3 : side === 1 || side === 3) continue;
          for (let i = 0; i < counts[side]!; i++) {
            const c = columnComponent(rhythm, i, counts[side]!);
            if (c !== fill) t.setBay(v, k, side, i, c);
          }
        }
      }
      // A component that needs a floor under it is not drawn at the ground.
      if (level === 0 && (fill === B40_BAY.Gourmet || fill === B40_BAY.Loggia || fill === B40_BAY.Balcony)) fill = B40_BAY.WideWindow;
      t.setFill(v, k, fill);
    }
  }
}

