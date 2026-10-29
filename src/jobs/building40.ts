// A lot's building through the whole Roadcraft 4.0 path, in the worker: the lot planned (world/growth/lotPlan.ts
// planLot), the building made to measure for it (world/buildings/procedural.ts madeToMeasure), the lot furnished
// (furnishLot: walls, gates, paths, pool, plants), then emitted (render/buildings/buildingMesh.ts emitChunk) and laid
// into this engine's mesh: the shell's faces with their paint and finish (the finishes texture array), and the parts
// (glass, frames, sills, doors, shutters, railings, AC units, the lot's boxes...) laid out of their models
// (kit.ts partGeometries) at their poses. The Building lives only here, while it is emitted.
import { Rng } from '../r40/core/rng.ts';
import { madeToMeasure } from '../r40/world/buildings/procedural.ts';
import { furnishLot, lotKind, planLot } from '../r40/world/growth/lotPlan.ts';
import { emitChunk, letGoEmitted } from '../r40/render/buildings/buildingMesh.ts';
import { PLATE_DETAIL, TILE_DETAIL, emitMassing } from '../r40/render/buildings/massing.ts';
import { partGeometries, type PartKind } from '../r40/render/buildings/kit.ts';
import { COLOURED_PARTS, COLOUR_RANGE, PAINT_UNIT, NORMAL_UNIT } from '../r40/render/buildings/cellArrays.ts';
import { POSE_FLOATS } from '../r40/render/buildings/partPose.ts';
import { LOOK_FLOATS } from '../r40/render/buildings/shellParts.ts';
import { FINISHES, roofMaterial, wallMaterial } from '../r40/world/buildings/materials.ts';
import type { Building } from '../r40/world/buildings/types.ts';
import type { BufferGeometry } from 'three';
import { FIN } from './buildingFinishes.ts';
import { levelElevation, levelHeight } from '../r40/world/buildings/geometry.ts';
import { MeshBuilder } from './meshBuilder.ts';

/** Building materials as the generator writes them (jobs/buildingGen.ts BMAT). */
const MAT = { Wall: 0, Plain: 4, Metal: 5, Grass: 7, WinGlass: 10 } as const;

/** A 4.0 finish name -> this engine's finish id (high nibble of the material byte). */
const FIN_OF: Record<string, number> = {
  plaster: FIN.Plaster, stucco: FIN.Stucco, ceramic: FIN.Ceramic, brick: FIN.Brick, stone: FIN.Stone, concrete: FIN.Concrete,
  wood: FIN.Wood, metal: FIN.Metal, glass: FIN.Glass, tile: FIN.Tile, slate: FIN.Slate, panel: FIN.Panel, roofing: FIN.Roofing,
};

/** The 4.0 kit's colour and finish of each part kind (kit.ts createBuildingKit): the base its instance colour tints. */
const PART_LOOK: Partial<Record<PartKind, [number, string, number]>> = {
  frame: [0xffffff, 'metal', MAT.Plain], concrete: [0xcfc9bd, 'concrete', MAT.Plain], door: [0x6b4a33, 'wood', MAT.Plain],
  shutter: [0x9aa1a4, 'metal', MAT.Plain], railing: [0xffffff, 'metal', MAT.Metal], roofRailing: [0x33373a, 'metal', MAT.Metal],
  awning: [0xffffff, 'plaster', MAT.Plain], column: [0xcfc9bd, 'concrete', MAT.Plain], water: [0x58c4dd, '', MAT.Plain],
  lamp: [0xf1ebdd, '', MAT.Plain], fin: [0xffffff, '', MAT.Plain], brise: [0xffffff, 'concrete', MAT.Plain],
  louvre: [0xffffff, 'wood', MAT.Plain], glassRail: [0xa9c4c4, 'glass', MAT.Plain],
};
/**
 * The parts drawn with the shell, in the cell's mesh (4.0 layerCells.ts:41 COARSE_PARTS): the panes and pool water; the
 * rest (the lot's walls, kerbs and pavings among them) go to the props pool as instances (jobs/parts40.ts), drawn by
 * their size on the screen as the 4.0 draws them.
 */
export const COARSE_PARTS = new Set<string>(['glass', 'glassDark', 'water']);
/** Parts not laid: the porch lamp's light on the wall (a decal of the night). */
const SKIPPED = new Set<string>(['wash']);

let models: Record<PartKind, BufferGeometry> | null = null;

/** An IEEE half float's bits -> its number. */
function half(h: number): number {
  const e = (h >> 10) & 31, f = h & 1023, sg = h & 0x8000 ? -1 : 1;
  return sg * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15));
}

/** Linear 0..1 -> an sRGB byte. */
function srgbByte(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}
const hexOf = (r: number, g: number, b: number): number => (srgbByte(r) << 16) | (srgbByte(g) << 8) | srgbByte(b);
const linear = (hex: number, k: number): number => { const c = ((hex >> k) & 255) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

/** Octahedral normal (two snorm16) unfolded (4.0 finishes.ts shellUnfold). */
function unfold(u: number, v: number, out: number[]): void {
  let x = Math.max(-1, u / NORMAL_UNIT), y = Math.max(-1, v / NORMAL_UNIT);
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) { const nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1), ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1); x = nx; y = ny; }
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
}

export interface Lot40 {
  /** The lot's centre and size in this engine's world (x, z), its turn (local x along the front, +z to the road). */
  cx: number; cz: number; W: number; D: number; rot: number;
  use: 'residential' | 'commercial' | 'industrial';
  density: 'low' | 'medium' | 'high';
  seed: number;
  /** The ground's height at a world (x, z). */
  groundAt: (x: number, z: number) => number;
}

/** What one lot laid: shell vertices, part instances, its lot ground and its solid volumes' footprints. */
export interface Laid40 {
  shell: number; parts: number;
  ground?: (x: number, z: number) => number;
  /** [centre x, centre z, half width, half depth, turn] in engine world coordinates. */
  footprints?: Array<[number, number, number, number, number]>;
}

/** Where a part goes as a pool instance: its kind, place, turn, scale per axis and colour (sRGB hex). */
export type PartSink = (kind: string, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, rgb: number) => void;

/**
 * Lays one lot's 4.0 building: its faces and the COARSE_PARTS into `shell`, the other parts to `pool` as instances;
 * either may be null to leave it out. `paneRow`: the facade window row the panes are drawn with (a whole-pane row: the
 * room behind, blinds, night).
 */
/** The lot's 4.0 building (the Building record of 4.0, its lot furnished), the same for every level drawn of it. */
function building40(lot: Lot40): Building {
  const rng = new Rng(lot.seed >>> 0);
  const plan = planLot(lotKind(lot.use, lot.density), lot.W, lot.D, rng);
  const env = plan.building;
  const made = madeToMeasure(lot.use, lot.density, { W: env.x1 - env.x0, D: env.y1 - env.y0, backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading', character: lot.seed & 0xffff, era: (lot.seed >>> 16) % 3 as 0 | 1 | 2 }, rng);
  const body = made.body;
  // the plan's frame (x from the lot's left, y from the front) -> the lot's (x from its middle)
  const dx = env.x0 - lot.W / 2, dy = env.y0;
  for (const v of body.volumes) { v.x += dx; v.y += dy; }
  for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
  for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
  furnishLot(body, plan, made, rng);
  // the 4.0 lot frame: origin at the front's middle, +y away from the street, the map's y = -world z
  const c = Math.cos(lot.rot), s = Math.sin(lot.rot);
  const fx = lot.cx + (lot.D / 2) * s, fz = lot.cz + (lot.D / 2) * c;
  return { ...body, id: (lot.seed & 0x7fffffff) || 1, x: fx, y: -fz, rotation: lot.rot } as Building;
}

/** The 4.0 building's volumes as the engine's layout shape: world rects with their storey ranges, grounded at the
 *  highest ground under the closed volumes (the ground storey is never under the ground at a corner). */
export interface Volume40 { cx: number; cz: number; hw: number; hd: number; rot: number; y0: number; y1: number; base: number; ground: number; fh: number }
export function volumes40(lot: Lot40): Volume40[] {
  const b = building40(lot);
  const cb = Math.cos(b.rotation), sb = Math.sin(b.rotation);
  let g0 = -Infinity;
  for (const v of b.volumes) {
    if (v.open) continue;
    for (const [ux, uy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const lx = v.x + ux * v.w, ly = v.y + uy * v.d;
      g0 = Math.max(g0, lot.groundAt(b.x + lx * cb - ly * sb, -(b.y + lx * sb + ly * cb)));
    }
  }
  if (g0 === -Infinity) g0 = lot.groundAt(b.x, -b.y);
  const out: Volume40[] = [];
  for (const v of b.volumes) {
    if (v.open) continue;
    let top = 0;
    for (let k = 0; k < v.storeys.length; k++) top += levelHeight(b, v.base + k);
    const base = g0 + levelElevation(b, v.base);
    out.push({ cx: b.x + v.x * cb - v.y * sb, cz: -(b.y + v.x * sb + v.y * cb), hw: v.w / 2, hd: v.d / 2, rot: lot.rot,
      y0: base, y1: base + top, base, ground: levelHeight(b, v.base), fh: levelHeight(b, v.base + 1) });
  }
  return out;
}

export function layLot40(lot: Lot40, shell: MeshBuilder | null, pool: PartSink | null, paneRow: number, far = false): Laid40 {
  const b = building40(lot);
  // far: 4.0's facade level (L1: the openings drawn by the shader, no small parts), the near level otherwise
  const chunk = emitChunk(b, (x, y) => lot.groundAt(x, -y), undefined, (x, y) => lot.groundAt(x, -y), undefined, far);
  letGoEmitted(b);
  let laidShell = 0, laidParts = 0;
  const n = [0, 0, 0];
  if (shell) {
    for (const [finish, part] of Object.entries(chunk.shells)) {
      if (!part) continue;
      const fin = FIN_OF[finish] ?? 0;
      const mat = (finish === 'glass' ? MAT.Plain : MAT.Plain) | (fin << 4);
      const base = shell.v;
      const P = part.position, N = part.normal, C = part.paint, I = part.index;
      const k = COLOUR_RANGE / PAINT_UNIT;
      shell.curFac[3] = 0;
      for (let i = 0; i < P.length / 3; i++) {
        unfold(N[i * 2], N[i * 2 + 1], n);
        shell.vert(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], n[0], n[1], n[2], hexOf(C[i * 4] * k, C[i * 4 + 1] * k, C[i * 4 + 2] * k), mat);
      }
      for (let t = 0; t < I.length; t += 3) {
        const a = base + I[t], bb = base + I[t + 1], cc = base + I[t + 2];
        unfold(N[I[t] * 2], N[I[t] * 2 + 1], n);
        shell.tri(a, bb, cc, n[0], n[1], n[2]);
      }
      laidShell += P.length / 3;
    }
  }
  // the far level's runs of bays with openings (4.0 chunk.ts RunChunk): walls whose windows the shader draws from their
  // grid (u in bays, v in storeys, whole at the runs' corners) and their bay width and storey height (half floats)
  if (shell && chunk.runs) {
    for (const [finish, part] of Object.entries(chunk.runs)) {
      if (!part) continue;
      const fin = FIN_OF[finish] ?? 0;
      const base = shell.v;
      const P = part.position, N = part.normal, C = part.paint, I = part.index, F = part.facade, G = part.grid;
      const k = COLOUR_RANGE / PAINT_UNIT;
      for (let i = 0; i < P.length / 3; i++) {
        unfold(N[i * 2], N[i * 2 + 1], n);
        const bay = half(F[i * 2]), storey = half(F[i * 2 + 1]);
        shell.curFac[0] = paneRow; shell.curFac[1] = lot.seed & 255;
        shell.curFac[2] = Math.max(0, Math.min(31, Math.round((storey - 2.5) * 10))) << 3;
        shell.curFac[3] = Math.min(127, Math.max(1, Math.round(bay * 10))) * 2;
        shell.curU = G[i * 4];
        shell.curBase = P[i * 3 + 1] - G[i * 4 + 1] * storey;
        shell.vert(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], n[0], n[1], n[2], hexOf(C[i * 4] * k, C[i * 4 + 1] * k, C[i * 4 + 2] * k), MAT.Wall | (fin << 4));
      }
      for (let t = 0; t < I.length; t += 3) {
        unfold(N[I[t] * 2], N[I[t] * 2 + 1], n);
        shell.tri(base + I[t], base + I[t + 1], base + I[t + 2], n[0], n[1], n[2]);
      }
      laidShell += P.length / 3;
    }
    shell.curFac[3] = 0; shell.curU = 0;
  }
  if (pool) {
    for (const [kind, batch] of Object.entries(chunk.parts) as Array<[PartKind, typeof chunk.parts[PartKind]]>) {
      if (!batch || batch.count === 0 || SKIPPED.has(kind) || COARSE_PARTS.has(kind)) continue;
      const coloured = COLOURED_PARTS.has(kind) && batch.colours;
      for (let i = 0; i < batch.count; i++) {
        const o = i * POSE_FLOATS, Q = batch.poses;
        const rgb = coloured ? hexOf(batch.colours![i * 3], batch.colours![i * 3 + 1], batch.colours![i * 3 + 2]) : 0xffffff;
        pool(kind, Q[o], Q[o + 1], Q[o + 2], Math.atan2(Q[o + 4], Q[o + 3]), Q[o + 5], Q[o + 6], Q[o + 7], rgb);
        laidParts++;
      }
    }
  }
  for (const parts of [shell]) {
    if (!parts) continue;
    models ??= partGeometries();
    for (const [kind, batch] of Object.entries(chunk.parts) as Array<[PartKind, typeof chunk.parts[PartKind]]>) {
      if (!batch || batch.count === 0 || SKIPPED.has(kind) || !COARSE_PARTS.has(kind)) continue;
      const g = models[kind];
      if (!g) continue;
      const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv'), vc = g.getAttribute('color');
      const idx = g.getIndex();
      const glass = kind === 'glass' || kind === 'glassDark';
      const look = PART_LOOK[kind];
      const coloured = COLOURED_PARTS.has(kind) && batch.colours;
      for (let i = 0; i < batch.count; i++) {
        const o = i * POSE_FLOATS, Q = batch.poses;
        const px = Q[o], py = Q[o + 1], pz = Q[o + 2], pc = Q[o + 3], ps = Q[o + 4], sx = Q[o + 5], sy = Q[o + 6], sz = Q[o + 7];
        // the instance's colour (linear) and finish
        let r = look ? linear(look[0], 16) : 1, gg = look ? linear(look[0], 8) : 1, bl = look ? linear(look[0], 0) : 1;
        if (coloured) { r = batch.colours![i * 3]; gg = batch.colours![i * 3 + 1]; bl = batch.colours![i * 3 + 2]; }
        let fin = look && look[1] ? FIN_OF[look[1]] : 0;
        if (batch.looks && kind.startsWith('lot')) fin = FIN_OF[FINISHES[batch.looks[i * LOOK_FLOATS]] ?? ''] ?? 0;
        const mat = glass ? MAT.WinGlass : ((look ? look[2] : MAT.Plain) | (fin << 4));
        if (glass) {
          // a pane: the window row that fills it, its width as the column, the room behind it drawn by the shader
          parts.curFac[0] = paneRow; parts.curFac[1] = (lot.seed + i * 7) & 255;
          parts.curFac[2] = 0; parts.curFac[3] = Math.min(127, Math.max(1, Math.round(Math.abs(sx) * 10))) * 2;
        } else parts.curFac[3] = 0;
        const base = parts.v;
        for (let v = 0; v < pos.count; v++) {
          const lx = pos.getX(v) * sx, ly = pos.getY(v) * sy, lz = pos.getZ(v) * sz;
          // T * Ry * S (partPose.ts poseMatrixInto)
          const X = px + pc * lx + ps * lz, Y = py + ly, Z = pz - ps * lx + pc * lz;
          let nx2 = nor ? nor.getX(v) / sx : 0, ny2 = nor ? nor.getY(v) / sy : 1, nz2 = nor ? nor.getZ(v) / sz : 0;
          const nl = Math.hypot(nx2, ny2, nz2) || 1; nx2 /= nl; ny2 /= nl; nz2 /= nl;
          const NX = pc * nx2 + ps * nz2, NZ = -ps * nx2 + pc * nz2;
          let cr = r, cg = gg, cb = bl;
          if (vc) { cr *= vc.getX(v); cg *= vc.getY(v); cb *= vc.getZ(v); }
          if (glass) {
            // u across the pane in its columns (0..1), h up it in the shader's 2.5 m storey: bottom 0, top 2.5
            const t = uv ? uv.getY(v) : ly / sy + 0.5;
            parts.curU = uv ? uv.getX(v) : lx / sx + 0.5;
            parts.curBase = Y - t * 2.5;
          }
          parts.vert(X, Y, Z, NX, ny2, NZ, glass ? 0x2b3034 : hexOf(cr, cg, cb), mat);
        }
        const tri = (a: number, b2: number, c2: number) => {
          const A = base + a, B = base + b2, Cc = base + c2;
          const ax = parts.nrm[A * 3] + parts.nrm[B * 3] + parts.nrm[Cc * 3], ay = parts.nrm[A * 3 + 1] + parts.nrm[B * 3 + 1] + parts.nrm[Cc * 3 + 1], az = parts.nrm[A * 3 + 2] + parts.nrm[B * 3 + 2] + parts.nrm[Cc * 3 + 2];
          parts.tri(A, B, Cc, ax, ay, az);
        };
        if (idx) for (let t = 0; t < idx.count; t += 3) tri(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
        else for (let t = 0; t < pos.count; t += 3) tri(t, t + 1, t + 2);
        parts.curU = 0;
        laidParts++;
      }
    }
    parts.curFac[3] = 0;
  }
  // The 4.0 lot ground (world x/z; NaN off it). The 4.0 skips its own greenery (buildingMesh.ts:2454-2455), so
  // the old generator's yard plants remain the owner and must stand on this ground, not on the old plan's.
  const lg = chunk.lotGround;
  // The solid volumes in engine world coordinates, for the yard props to keep off the building itself.
  const c = Math.cos(lot.rot), s = Math.sin(lot.rot);
  const fx = lot.cx + (lot.D / 2) * s, fz = lot.cz + (lot.D / 2) * c;
  const footprints = b.volumes.filter((v) => !v.open).map((v) => {
    const lx = v.x + v.w / 2, ly = v.y + v.d / 2;
    return [fx + lx * c - ly * s, fz - lx * s - ly * c, v.w / 2, v.d / 2, lot.rot] as [number, number, number, number, number];
  });
  return { shell: laidShell, parts: laidParts, ground: lg ? (x, z) => lg.heightAt(x, -z) : undefined, footprints };
}

/**
 * The same 4.0 building from afar (4.0 render/buildings/massing.ts emitMassing): its blocks as they stand, coloured as
 * the near one, the windows drawn by the shader from each wall's bays and storeys. `level`: 1 the cell's far level,
 * 2 a tile's, 3 a plate's (each leaves out what 4.0's leaves out: massing.ts CELL/TILE/PLATE_DETAIL). `style` is the
 * window table row (world/arch.ts) the shader draws the openings with.
 */
export function massLot40(lot: Lot40, mb: MeshBuilder, level: number, style: number): number {
  const b = building40(lot);
  const detail = level >= 3 ? PLATE_DETAIL : TILE_DETAIL;
  const m = emitMassing(b, (x, y) => lot.groundAt(x, -y), undefined, (x, y) => lot.groundAt(x, -y), false, undefined, detail);
  if (!m) return 0;
  const P = m.position, N = m.normal, C = m.colour, F = m.facade, G = m.glazing, I = m.index;
  // the walls' and the roofs' finish of the near building (brick, plaster, stone, tile...): the far one keeps its texture
  const v0 = b.volumes.find((v) => !v.open) ?? b.volumes[0];
  const wallFin = v0 ? FIN_OF[wallMaterial(b, v0, 0).finish] ?? 0 : 0;
  const roofFin = v0 ? FIN_OF[roofMaterial(b, v0).finish] ?? 0 : 0;
  const base = mb.v, seed = lot.seed & 255;
  for (let i = 0; i < P.length / 3; i++) {
    const bay = F[i * 4 + 1], storey = F[i * 4 + 2], z0 = F[i * 4 + 3], share = G[i * 2];
    const wall = bay > 0 && Math.abs(N[i * 3 + 1]) < 0.5;
    if (wall) {
      const curtain = share >= 0.95;
      mb.curFac[0] = style; mb.curFac[1] = seed;
      mb.curFac[2] = (curtain ? 1 : 0) | (Math.max(0, Math.min(31, Math.round((storey - 2.5) * 10))) << 3);
      mb.curFac[3] = Math.min(127, Math.max(1, Math.round(bay * 10))) * 2;
      mb.curU = F[i * 4] / bay;
      mb.curBase = z0;
    } else { mb.curFac[3] = 0; mb.curU = 0; }
    const mat = wall ? MAT.Wall | (wallFin << 4) : MAT.Plain | (roofFin << 4);
    mb.vert(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2], hexOf(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]), mat);
  }
  for (let t = 0; t < I.length; t += 3) {
    const A = I[t], B2 = I[t + 1], Cc = I[t + 2];
    mb.tri(base + A, base + B2, base + Cc, N[A * 3], N[A * 3 + 1], N[A * 3 + 2]);
  }
  mb.curFac[3] = 0; mb.curU = 0;
  letGoEmitted(b);
  return P.length / 3;
}
