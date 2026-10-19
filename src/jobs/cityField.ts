// The grain of a generated city (Roadcraft 4.0 world/cityGen/field.ts and streets.ts, ported): a tensor field made of
// grid and radial basis fields, and the streets traced along it as hyperstreamlines, level by level (collectors, then
// local streets), each family keeping its spacing. Pure (no document, no network): the city generator (worker) feeds
// the lines into its own planar graph with the arterials, water and slope rules (`jobs/cityGen.ts`).
// Coordinates are the world's (x, z); 4.0's (x, y) maps to them directly.

import type { Rng } from '../core/rng.ts';

export interface P2 { x: number; z: number }

export type BasisField =
  | { readonly kind: 'grid'; readonly x: number; readonly z: number; readonly radius: number; readonly angle: number; readonly weight: number }
  | { readonly kind: 'radial'; readonly x: number; readonly z: number; readonly radius: number; readonly weight: number };

export interface FieldNoise {
  /** Radians the streets turn at most, and over what distance the turn changes (m). */
  readonly amount: number;
  readonly scale: number;
  readonly seed: number;
}

/** Smooth deterministic value noise in [−1, 1] (Roadcraft terrain.ts valueNoise). */
export function valueNoise(x: number, z: number): number {
  const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(x0, z0), b = hash(x0 + 1, z0), c = hash(x0, z0 + 1), d = hash(x0 + 1, z0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

function hash(x: number, z: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(z | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}

export class TensorField {
  readonly fields: readonly BasisField[];
  readonly noise: FieldNoise;
  constructor(fields: readonly BasisField[], noise: FieldNoise) { this.fields = fields; this.noise = noise; }

  /** The tensor at a point, as (a, b) of [[a, b], [b, −a]]. */
  tensor(x: number, z: number): { a: number; b: number } {
    let a = 0, b = 0;
    for (const f of this.fields) {
      const dx = x - f.x, dz = z - f.z, d2 = dx * dx + dz * dz;
      // Gaussian fall-off: whole inside its radius, gone a radius and a half out
      const w = f.weight * Math.exp(-d2 / (f.radius * f.radius));
      if (w < 1e-6) continue;
      if (f.kind === 'grid') { a += w * Math.cos(2 * f.angle); b += w * Math.sin(2 * f.angle); }
      else {
        if (d2 < 1e-6) continue;
        a += (w * (dz * dz - dx * dx)) / d2;
        b += (w * (-2 * dx * dz)) / d2;
      }
    }
    return { a, b };
  }

  /** The way the major streets run at a point (unit), or null where the field vanishes. */
  major(x: number, z: number): P2 | null {
    const { a, b } = this.tensor(x, z);
    if (a * a + b * b < 1e-8) return null;
    const turn = this.noise.amount * valueNoise(x / this.noise.scale + this.noise.seed * 0.013, z / this.noise.scale - this.noise.seed * 0.007);
    const phi = Math.atan2(b, a) / 2 + turn;
    return { x: Math.cos(phi), z: Math.sin(phi) };
  }

  /** The way the minor streets run: across the major ones. */
  minor(x: number, z: number): P2 | null {
    const d = this.major(x, z);
    return d ? { x: -d.z, z: d.x } : null;
  }
}

export interface StreetLevel {
  /** Spacing of the streets along the major way, and along the minor way (m). */
  readonly dsepMajor: number;
  readonly dsepMinor: number;
  /** A streamline stops this near a street of its own family (a fraction of its spacing). */
  readonly testFraction: number;
  readonly dstep: number;
  readonly dlookahead: number;
  readonly minLength: number;
  readonly maxLength: number;
  readonly seedTries: number;
}

export interface StreetLine { readonly level: number; readonly family: 0 | 1; points: P2[]; closed: boolean }

/** Points of streamlines hashed by cell, for "anything of mine within d of here?". */
class SampleGrid {
  private readonly cells = new Map<number, P2[]>();
  private readonly cell: number;
  constructor(cell: number) { this.cell = cell; }
  private key(i: number, j: number): number { return (i + 32768) * 65536 + (j + 32768); }
  add(p: P2): void {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.z / this.cell));
    const list = this.cells.get(k);
    if (list) list.push(p); else this.cells.set(k, [p]);
  }
  near(p: P2, d: number): boolean {
    const r = Math.ceil(d / this.cell), cx = Math.floor(p.x / this.cell), cz = Math.floor(p.z / this.cell);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const list = this.cells.get(this.key(cx + i, cz + j));
      if (!list) continue;
      for (const q of list) if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < d * d) return true;
    }
    return false;
  }
}

/** A unit way, flipped to go on the way it was going. */
function oriented(d: P2 | null, prev: P2): P2 | null {
  if (!d) return null;
  return d.x * prev.x + d.z * prev.z < 0 ? { x: -d.x, z: -d.z } : d;
}

/**
 * Traces every level (coarsest first): seeds offset by the spacing from the streets already traced, then random
 * seeds until `seedTries` fail in a row; each streamline steps by the midpoint rule and stops at the edge (`inside`)
 * or near a street of its own family. Dangling ends are carried on to the first street within `dlookahead`.
 */
export function traceStreets(field: TensorField, inside: (p: P2) => boolean, bounds: { x0: number; z0: number; x1: number; z1: number },
  levels: readonly StreetLevel[], rng: Rng): StreetLine[] {
  const cell = Math.max(3.2, Math.min(...levels.map((l) => Math.min(l.dsepMajor, l.dsepMinor))) / 2);
  const grids: [SampleGrid, SampleGrid] = [new SampleGrid(cell), new SampleGrid(cell)];
  const lines: StreetLine[] = [];
  const dirOf = (family: 0 | 1, p: P2): P2 | null => (family === 0 ? field.major(p.x, p.z) : field.minor(p.x, p.z));

  const trace = (seed: P2, family: 0 | 1, L: StreetLevel, dtest: number): { points: P2[]; closed: boolean } | null => {
    const start = dirOf(family, seed)!;
    const halves: P2[][] = [];
    let closed = false;
    for (const sign of [1, -1]) {
      const out: P2[] = [];
      let p = seed, prev = { x: start.x * sign, z: start.z * sign }, length = 0;
      for (let it = 0; it < 4000; it++) {
        const d1 = oriented(dirOf(family, p), prev);
        if (!d1) break;
        const d2 = oriented(dirOf(family, { x: p.x + (d1.x * L.dstep) / 2, z: p.z + (d1.z * L.dstep) / 2 }), d1);
        if (!d2) break;
        const next = { x: p.x + d2.x * L.dstep, z: p.z + d2.z * L.dstep };
        if (!inside(next) || grids[family].near(next, dtest)) break;
        length += L.dstep;
        // round on itself (a ring round a radial centre): closed
        if (sign === 1 && length > L.dstep * 12 && Math.hypot(next.x - seed.x, next.z - seed.z) < L.dstep * 1.5) { closed = true; break; }
        out.push(next);
        prev = d2; p = next;
        if (length > L.maxLength / 2) break;
      }
      halves.push(out);
      if (closed) break;
    }
    const points = closed ? [seed, ...halves[0], seed] : [...(halves[1] ?? []).reverse(), seed, ...halves[0]];
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    return total >= L.minLength ? { points, closed } : null;
  };

  for (let level = 0; level < levels.length; level++) {
    const L = levels[level];
    for (const family of [0, 1] as const) {
      const dsep = family === 0 ? L.dsepMajor : L.dsepMinor, dtest = dsep * L.testFraction;
      const queue: P2[] = [];
      let head = 0, fails = 0;
      const offer = (points: readonly P2[]): void => {
        for (let i = 2; i < points.length; i += 4) {
          const p = points[i], q = points[i - 1], dx = p.x - q.x, dz = p.z - q.z, n = Math.hypot(dx, dz) || 1;
          queue.push({ x: p.x - (dz / n) * dsep, z: p.z + (dx / n) * dsep }, { x: p.x + (dz / n) * dsep, z: p.z - (dx / n) * dsep });
        }
      };
      for (const line of lines) if (line.family === family) offer(line.points);
      while (fails < L.seedTries) {
        const fromQueue = head < queue.length;
        const seed = fromQueue ? queue[head++] : { x: rng.range(bounds.x0, bounds.x1), z: rng.range(bounds.z0, bounds.z1) };
        if (!inside(seed) || grids[family].near(seed, dsep * 0.98) || !dirOf(family, seed)) { if (!fromQueue) fails++; continue; }
        const line = trace(seed, family, L, dtest);
        if (!line) { if (!fromQueue) fails++; continue; }
        fails = 0;
        lines.push({ level, family, points: line.points, closed: line.closed });
        for (const p of line.points) grids[family].add(p);
        offer(line.points);
      }
    }
  }
  // dangling ends carried on to the street they would meet
  const stretches = new StretchGrid(80);
  lines.forEach((line) => stretches.addLine(line));
  for (const line of lines) {
    if (line.closed) continue;
    const L = levels[line.level];
    for (const end of [0, 1] as const) {
      const pts = line.points;
      if (pts.length < 2) continue;
      const a = end === 0 ? pts[1] : pts[pts.length - 2], b = end === 0 ? pts[0] : pts[pts.length - 1];
      const dx = b.x - a.x, dz = b.z - a.z, n = Math.hypot(dx, dz) || 1;
      const hit = castTo(stretches, line, b, { x: dx / n, z: dz / n }, L.dlookahead);
      if (!hit) continue;
      if (end === 0) pts.unshift(hit); else pts.push(hit);
      stretches.addStretch(line, end === 0 ? hit : b, end === 0 ? b : hit);
    }
  }
  return lines;
}

interface Stretch { readonly line: StreetLine; readonly a: P2; readonly b: P2 }

/** The streets' stretches by cell, kept as ends are carried on. */
class StretchGrid {
  private readonly cells = new Map<number, Stretch[]>();
  private readonly cell: number;
  constructor(cell: number) { this.cell = cell; }
  private key(i: number, j: number): number { return (i + 32768) * 65536 + (j + 32768); }
  addLine(line: StreetLine): void { for (let i = 1; i < line.points.length; i++) this.addStretch(line, line.points[i - 1], line.points[i]); }
  addStretch(line: StreetLine, a: P2, b: P2): void {
    const s = { line, a, b };
    for (let i = Math.floor(Math.min(a.x, b.x) / this.cell); i <= Math.floor(Math.max(a.x, b.x) / this.cell); i++) {
      for (let j = Math.floor(Math.min(a.z, b.z) / this.cell); j <= Math.floor(Math.max(a.z, b.z) / this.cell); j++) {
        const list = this.cells.get(this.key(i, j));
        if (list) list.push(s); else this.cells.set(this.key(i, j), [s]);
      }
    }
  }
  near(x0: number, z0: number, x1: number, z1: number): Stretch[] {
    const found = new Set<Stretch>();
    for (let i = Math.floor(x0 / this.cell); i <= Math.floor(x1 / this.cell); i++) {
      for (let j = Math.floor(z0 / this.cell); j <= Math.floor(z1 / this.cell); j++) for (const s of this.cells.get(this.key(i, j)) ?? []) found.add(s);
    }
    return [...found];
  }
}

/** The first street a ray from `p` along `dir` meets within `reach` (not its own stretches near `p`). */
function castTo(stretches: StretchGrid, own: StreetLine, p: P2, dir: P2, reach: number): P2 | null {
  let best: P2 | null = null, bestT = reach;
  const ex = p.x + dir.x * reach, ez = p.z + dir.z * reach;
  for (const { line, a, b } of stretches.near(Math.min(p.x, ex), Math.min(p.z, ez), Math.max(p.x, ex), Math.max(p.z, ez))) {
    if (line === own && (Math.hypot(a.x - p.x, a.z - p.z) < reach * 1.5 || Math.hypot(b.x - p.x, b.z - p.z) < reach * 1.5)) continue;
    const rx = ex - p.x, rz = ez - p.z, sx = b.x - a.x, sz = b.z - a.z, den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a.x - p.x) * sz - (a.z - p.z) * sx) / den, u = ((a.x - p.x) * rz - (a.z - p.z) * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t * reach > 1e-3 && t * reach < bestT) { bestT = t * reach; best = { x: p.x + dir.x * t * reach, z: p.z + dir.z * t * reach }; }
  }
  return best;
}

// ------------------------------------------------------------------ styles (Roadcraft 4.0 cityGen/plan.ts)

export type CityStyle = 'classic' | 'grid' | 'organic' | 'radial' | 'mixed' | 'blocks';
export const CITY_STYLES: readonly CityStyle[] = ['classic', 'grid', 'organic', 'radial', 'mixed', 'blocks'];

/**
 * The field of one district of radius R centred at (cx, cz) in a style (4.0's recipes, scaled to the district): grid —
 * one grain and two local grids; organic — a weak grain, seven local grids and a strong noise; radial — the streets
 * go round and out from the centre; mixed — a grain, a radial core and three local grids. Null for 'blocks' and
 * 'classic' (no field).
 */
export function districtField(style: CityStyle, cx: number, cz: number, R: number, rng: Rng, seed: number): TensorField | null {
  const fields: BasisField[] = [];
  const base = rng.range(0, Math.PI);
  const grid = (x: number, z: number, radius: number, angle: number, weight = 1) => { fields.push({ kind: 'grid', x, z, radius, angle, weight }); };
  const radial = (x: number, z: number, radius: number, weight = 1) => { fields.push({ kind: 'radial', x, z, radius, weight }); };
  let noise: FieldNoise = { amount: 0.06, scale: 500, seed };
  switch (style) {
    case 'grid':
      grid(cx, cz, R * 4, base, 0.6);
      for (let i = 0; i < 2; i++) { const a = rng.range(0, Math.PI * 2); grid(cx + Math.cos(a) * R * 0.55, cz + Math.sin(a) * R * 0.55, R * 0.42, base + rng.range(0.25, 0.7)); }
      break;
    case 'organic':
      grid(cx, cz, R * 4, base, 0.25);
      for (let i = 0; i < 7; i++) { const a = rng.range(0, Math.PI * 2), d = R * Math.sqrt(rng.next()) * 0.85; grid(cx + Math.cos(a) * d, cz + Math.sin(a) * d, R * rng.range(0.22, 0.38), base + rng.range(-0.9, 0.9)); }
      noise = { amount: 0.32, scale: 260, seed };
      break;
    case 'radial':
      grid(cx, cz, R * 4, base, 0.3);
      radial(cx, cz, R * 0.55, 1.2);
      noise = { amount: 0.1, scale: 400, seed };
      break;
    case 'mixed':
      grid(cx, cz, R * 4, base, 0.45);
      radial(cx, cz, R * 0.32, 1.1);
      for (let i = 0; i < 3; i++) { const a = rng.range(0, Math.PI * 2), d = R * rng.range(0.45, 0.75); grid(cx + Math.cos(a) * d, cz + Math.sin(a) * d, R * 0.35, base + rng.range(-0.6, 0.6)); }
      noise = { amount: 0.14, scale: 380, seed };
      break;
    default:
      return null;
  }
  return new TensorField(fields, noise);
}

/** Collector and local street levels (4.0's spacings in metres; its avenue level is this engine's arterial skeleton). */
export function districtLevels(R: number): StreetLevel[] {
  return [
    { dsepMajor: 160, dsepMinor: 200, testFraction: 0.5, dstep: 7, dlookahead: 120, minLength: 110, maxLength: R * 1.6, seedTries: 80 },
    { dsepMajor: 68, dsepMinor: 112, testFraction: 0.55, dstep: 6, dlookahead: 70, minLength: 60, maxLength: 520, seedTries: 160 },
  ];
}

/** Blocks style (4.0): a straight grid of 120 × 72 m blocks, an avenue line every 4 blocks; lines as [level, points]. */
export function blockLines(cx: number, cz: number, R: number): Array<{ level: number; points: P2[] }> {
  const along = 120, across = 72, AVENUE_EVERY = 4;
  const nx = Math.max(2, Math.floor((R * 1.7) / along)), nz = Math.max(2, Math.floor((R * 1.7) / across));
  const x0 = cx - (nx * along) / 2, z0 = cz - (nz * across) / 2;
  const levelOf = (k: number, n: number) => (k === 0 || k === n || k % AVENUE_EVERY === 0 ? 0 : 1);
  const out: Array<{ level: number; points: P2[] }> = [];
  for (let j = 0; j <= nz; j++) {
    const pts: P2[] = [];
    for (let i = 0; i <= nx * 4; i++) pts.push({ x: x0 + (i * along) / 4, z: z0 + j * across });
    out.push({ level: levelOf(j, nz), points: pts });
  }
  for (let i = 0; i <= nx; i++) {
    const pts: P2[] = [];
    for (let j = 0; j <= nz * 2; j++) pts.push({ x: x0 + i * along, z: z0 + (j * across) / 2 });
    out.push({ level: levelOf(i, nx), points: pts });
  }
  return out;
}

/**
 * A traced line made fit for the street graph (4.0 planarize): Douglas-Peucker to `tol` metres, then no two points
 * nearer than `spacing` (the ends kept).
 */
export function simplifyLine(points: readonly P2[], tol: number, spacing: number): P2[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = points[i], b = points[j], ex = b.x - a.x, ez = b.z - a.z, l = Math.hypot(ex, ez) || 1;
    let far = -1, best = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((points[k].x - a.x) * ez - (points[k].z - a.z) * ex) / l;
      if (d > best) { best = d; far = k; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([i, far], [far, j]); }
  }
  const kept = points.filter((_, k) => keep[k]);
  const out: P2[] = [kept[0]];
  for (let k = 1; k < kept.length - 1; k++) {
    const last = out[out.length - 1];
    if (Math.hypot(kept[k].x - last.x, kept[k].z - last.z) >= spacing) out.push(kept[k]);
  }
  const end = kept[kept.length - 1];
  if (out.length > 1 && Math.hypot(end.x - out[out.length - 1].x, end.z - out[out.length - 1].z) < spacing) out.pop();
  out.push(end);
  return out;
}
