// Gerador procedural de prédios (worker). Determinístico: lote + zona +
// andares + semente + estilo → sempre o mesmo prédio nesta versão do gerador.
// Casas com telhado e quintal, prédios de apartamento com sacadas, lojas,
// torres de escritório com pódio, galpões. Janelas e interiores ficam no
// shader (interior mapping); aqui só volumes, telhados, sacadas, muros.
// lod 0 = célula perto (tudo); 1 = célula longe (sem peças pequenas);
// 2 = ladrilho (sem platibandas); 3 = placa (só volumes e telhados).

import { Rng, hash2 } from '../core/rng.ts';
import { Zone, zoneDensity } from '../roads/zones.ts';
import { heightAt } from '../world/heights.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { ARCHES, ArchId, Fn, PANE_ROW, chimneyOf, pickArch } from '../world/arch.ts';
import { type BoxColumns, type PackedMesh } from '../shared/contracts/worker.ts';
import { CIVIC_DESIGNS, decodeDesign, hasDesign } from '../world/design.ts';
import { catalogProjects } from '../world/catalog.ts';
import { layLot40, massLot40, setRuinSource, volumes40, type AttachSink, type Lot40, type PartSink } from './building40.ts';
import { planCells, type CellPlan } from './buildingGen/plan.ts';
import { lotFit } from './buildingGen/polygon.ts';
import { type Frame } from './buildingGen/geometry.ts';
import { newOutputs, type GenOutputs, type PartEmit, type Volume } from './buildingGen/outputs.ts';
import { applyFinishes, finishTable } from './buildingGen/finishes.ts';
import { R40_ZONES } from './buildingGen/heights.ts';
import { beginLot, emptyLot, endLot, groundRange, legacyBox, polyWalls } from './buildingGen/lot.ts';
import { block, house } from './buildingGen/plans.ts';
import { chimney, design, tower, warehouse } from './buildingGen/plans2.ts';
import { civic, openLot } from './buildingGen/civic.ts';
import { catalogBuilding } from './buildingGen/catalog.ts';
import type { GenContext } from './buildingGen/context.ts';
export { groundRange } from './buildingGen/lot.ts';
export { hip } from './buildingGen/plans.ts';
export { FRAME_BAR, WIN_REVEAL, WIN_REVEAL_SHADE } from './buildingGen/windows.ts';
export { PART } from './buildingGen/shell.ts';
export { BMAT, Facade } from './buildingGen/materials.ts';
export { finishTable } from './buildingGen/finishes.ts';
export { catalogLevels, wallsHeight, wallsHeightOf } from './buildingGen/heights.ts';
export type { HeightRec } from './buildingGen/heights.ts';
export type { PartEmit, Volume } from './buildingGen/outputs.ts';
/**
 * The main mesh of a pass that does not want it (detail layer, parts): keeps the facade state the detail reads
 * (curFac, curBase, curU) and stores no vertex.
 */
class NoMesh extends MeshBuilder {
  override vert(): number { return 0; }
  override tri(): void {}
  override quad(): void {}
  override box(): void {}
}
const NO_MESH = new NoMesh(false, true);

/**
 * The volumes of building i of the boxes (the boxes of its cell: the cell plan picks facades and landmarks), from the
 * same generator, sorted from the largest footprint. Empty for an empty lot. A few milliseconds: for one building.
 */
export function buildingVolumes(heights: Float32Array, b: BoxColumns, i: number): Volume[] {
  const sink = newOutputs({ layout: [] });
  try { genOne(NO_MESH, heights, b, i, planCells(b), -3, false, sink); } finally { endLot(); }
  return sink.layout!.sort((p, q) => q.hw * q.hd - p.hw * p.hd);
}

/**
 * Building i of the boxes (its cell's: the cell plan picks its facade and landmark from them) at the near level with
 * every part laid in as geometry (jobs/building40.ts whole parts): what its ruin is cut from (jobs/ruin.ts).
 */
export function buildingForRuin(heights: Float32Array, b: BoxColumns, i: number, attach: AttachSink): MeshBuilder {
  const mb = new MeshBuilder(false, true);
  setRuinSource(attach);
  try {
    mb.curTag = buildingTag(b.seed[i], b.x[i], b.z[i]);
    genOne(mb, heights, b, i, planCells(b), 0, false, newOutputs({}));
  } finally { setRuinSource(null); endLot(); }
  return mb;
}

/**
 * The tag of a building's own vertices (15 bits, never 0), in position.w of the mesh: the inside view cuts only the
 * chosen building's vertices, never a neighbour's. The same sum on the page (inside.ts) from the record.
 */
export function buildingTag(seed: number, x: number, z: number): number {
  return (hash2(seed, Math.round(x * 8), Math.round(z * 8)) & 0x7ffe) | 1;
}

/** Runs draw() with no building tag on mb and on the detail layer (lot ground, walls, gates, trees). */

/** Lajes: manta clara, cimento, piche, cinza escuro, telhado verde. */

export function buildBuildings(heights: Float32Array, b: BoxColumns, originX: number, originZ: number, extent: number, lod: number, legacy = false, out?: GenOutputs): PackedMesh | null {
  const mb = new MeshBuilder(false, true);
  const sink = out ?? newOutputs({ detail: lod === -1 ? mb : null });
  const plan = planCells(b);
  for (let i = 0; i < b.count; i++) {
    mb.curTag = buildingTag(b.seed[i], b.x[i], b.z[i]);
    genOne(mb, heights, b, i, plan, lod, legacy, sink);
    mb.curTag = 0;
  }
  return mb.pack(originX, originZ, extent);
}

/** The generic generator's entry point for its regression tests: the production R/C/M path is the 4.0 one. */
export function buildBuildingsLegacy(heights: Float32Array, b: BoxColumns, originX: number, originZ: number, extent: number, lod: number): PackedMesh | null {
  return buildBuildings(heights, b, originX, originZ, extent, lod, true);
}

/** The lot as the 4.0 path takes it (jobs/building40.ts): one description, the same building at every level. */
function lot40Of(b: BoxColumns, i: number, fit: { cx: number; cz: number; W: number; D: number }, zone: number, floors: number, heights: Float32Array): Lot40 {
  const dens = zoneDensity(zone);
  const use = zone === Zone.Commercial || zone === Zone.ComLow || zone === Zone.ComHigh || zone === Zone.Mixed ? 'commercial' : 'residential';
  const density = dens === 0 || (use === 'residential' && floors <= 2) ? 'low' : dens === 2 || (use === 'commercial' && floors >= 8) ? 'high' : 'medium';
  return { cx: fit.cx, cz: fit.cz, W: fit.W, D: fit.D, rot: b.rot[i], use, density, seed: b.seed[i] || i + 1, groundAt: (x: number, z: number) => heightAt(heights, x, z) };
}

/** One building of the boxes (the cell plan already made) into mb, at level lod. */
function genOne(mb: MeshBuilder, heights: Float32Array, b: BoxColumns, i: number, plan: CellPlan, lod: number, legacy: boolean, out: GenOutputs): void {
  const rot = b.rot[i];
  const zone = b.zone[i];
  if (lod < 0 && (b.floors[i] === 0 || zone === 0)) return;
  if (zone === 0) { legacyBox(mb, heights, b, i, { cx: b.x[i], cz: b.z[i], c: Math.cos(rot), s: Math.sin(rot), base: 0, out }); return; }
  // the building goes in the lot's rectangle, or in the largest one inside a polygon lot (yard and walls follow it)
  const fit = lotFit(b, i);
  const f: Frame = { cx: fit.cx, cz: fit.cz, c: Math.cos(rot), s: Math.sin(rot), base: 0, out };
  beginLot(fit.poly);
  if (b.floors[i] === 0) { emptyLot(mb, heights, fit.W, fit.D, f); endLot(); return; }
  const r = new Rng((b.seed[i] ^ (b.style[i] * 2654435761)) >>> 0);
  const W = fit.W, D = fit.D;
  const rows = lod <= 1 ? lotParking(b, i) : [];
  for (let k = 0; k < rows.length; k += 2) { rows[k] -= fit.ox; rows[k + 1] -= fit.oz; }
  const [lo, hi] = groundRange(heights, f, W, D);
  f.base = lo - 0.4;
  mb.curBase = f.base;
  out.footI = i; out.footGround = hi;
  const floors = Math.max(1, b.floors[i]);
  const arch = pickArch(zone, floors, b.x[i], b.z[i], b.style[i]);
  const g: GenContext = { mb, heights, f, W, D, floors, arch, a: ARCHES[arch], r, hi, lod, seed: b.seed[i], zone, rows, pattern: plan.pattern[i], side: plan.side[i] };
  if (lod < 0) {
    // one pass, the outputs this job asks for: the parts (lod -2, part -> out.part) or the detail layer (lod -1,
    // prism -> windowDetail into the real mesh); the main geometry goes to a builder that keeps nothing
    NO_MESH.curBase = f.base;
    if (lod === -1) out.detail = mb;
    g.mb = NO_MESH; g.lod = 0;
  }
  mb.lod = g.lod; NO_MESH.lod = g.lod;
  if (out.detail) out.detail.lod = g.lod;
  const v0 = mb.v;
  const ds = hasDesign(b.color[i]) ? decodeDesign(b.color[i], b.h[i]) : null;
  const cat = ds?.catalog ? ds.catalog : plan.landmark[i];
  const proj = cat ? catalogProjects()[cat - 1] : undefined;
  if (proj) catalogBuilding(g, proj, ds ? ds.wall : -1);
  else if (ds) design(g, ds);
  else if (b.fn[i] === Fn.Cemetery || b.fn[i] === Fn.Playground) openLot(g, b.fn[i]);
  else if (CIVIC_DESIGNS[b.fn[i]]) { const [ds, minF] = CIVIC_DESIGNS[b.fn[i]]; design({ ...g, floors: Math.max(minF, Math.min(floors, minF * 2)) }, ds); }
  else if (b.fn[i]) civic(g, b.fn[i]);
  else if (zone === Zone.Industrial) {
    warehouse(g.mb, heights, f, W, D, floors, arch, r, hi, g.lod);
    const ch = chimneyOf(b.seed[i], W, D, floors);
    if (ch) chimney(g.mb, f, ch[0], ch[1], f.base, hi + ch[2], g.lod);
  }
  else if (!legacy && lod === 1 && R40_ZONES.has(zone) && !b.shapeN[i]) {
    // the same 4.0 building at 4.0's facade level (L1): its walls, openings and roofs, without the small parts
    layLot40(lot40Of(b, i, fit, zone, floors, heights), mb, null, PANE_ROW, true);
  }
  else if (!legacy && lod >= 2 && R40_ZONES.has(zone) && !b.shapeN[i]) {
    // the same 4.0 building from afar (jobs/building40.ts massLot40): never another building than the near one
    massLot40(lot40Of(b, i, fit, zone, floors, heights), mb, lod, arch);
  }
  else if (!legacy && lod <= 0 && R40_ZONES.has(zone) && !b.shapeN[i]) {
    // the Roadcraft 4.0 building (jobs/building40.ts), near: its shell in the cell's mesh (level 0), its parts to the
    // props pool (the parts pass, level -2, when the props job asks for them); nothing in the detail layer (level -1);
    // the old body is still made, into nothing, for the footprint the yard's props avoid. The -3 layout pass takes the
    // 4.0's own volumes, so the inside view, the camera and the collapse read the building actually drawn.
    const lot40 = lot40Of(b, i, fit, zone, floors, heights);
    if (lod === -3) { if (out.layout) for (const v of volumes40(lot40)) out.layout.push(v as Volume); return; }
    if (lod === 0) layLot40(lot40, mb, null, PANE_ROW);
    else if (lod === -2) {
      // With the 4.0 sink the parts come from layLot40; without one this pass has to fall back to the generic parts,
      // or a caller that does not ask for the 4.0 pool silently loses every part.
      const keep = out.part;
      if (parts40Out) {
        const laid = layLot40(lot40, null, parts40Out, PANE_ROW);
        out.part = null;
        if (grounds40Out) grounds40Out[i] = laid.ground;
        if (out.foot && laid.footprints) for (const [cx, cz, hw, hd, turn] of laid.footprints) out.foot[i].push(cx, cz, hw, hd, turn);
      }
      try { if (arch >= ArchId.ColonialHouse && arch <= ArchId.Sobrado) house(g); else if (zone === Zone.Commercial && floors >= 8) tower(g); else block(g); }
      finally { out.part = keep; }
    }
  }
  else if (arch >= ArchId.ColonialHouse && arch <= ArchId.Sobrado) house(g);
  else if (zone === Zone.Commercial && floors >= 8) tower(g);
  else block(g);
  polyWalls(g.mb, heights, f);
  endLot();
  applyFinishes(mb, v0, finishTable(arch, b.seed[i], b.fn[i], zone, ds));
}

/**
 * Peças repetidas dos prédios (ar-condicionado, vasos, varais, antenas, exaustores, caixas d'água) para o pool de
 * props: o mesmo gerador, no modo peças, com o mesmo sorteio da malha. Roda no job de peças da célula.
 */
export type LotGround40 = (x: number, z: number) => number;
export function buildBuildingParts(heights: Float32Array, b: BoxColumns, emit: PartEmit, foot?: number[][], parts40?: PartSink, legacy = false): Array<LotGround40 | undefined> {
  const grounds40 = new Array<LotGround40 | undefined>(b.count);
  const outerGrounds = grounds40Out;
  grounds40Out = grounds40;
  const sink = newOutputs({ part: emit, foot: foot ?? null });
  parts40Out = parts40 ?? null;
  try { buildBuildings(heights, b, 0, 0, 256, -2, legacy, sink); } finally { parts40Out = null; grounds40Out = outerGrounds; }
  return grounds40;
}

/** The generic parts pass for its regression tests; production R/C/M parts go through the 4.0 sink. */
export function buildBuildingPartsLegacy(heights: Float32Array, b: BoxColumns, emit: PartEmit, foot?: number[][], parts40?: PartSink): Array<LotGround40 | undefined> {
  return buildBuildingParts(heights, b, emit, foot, parts40, true);
}
/** Per-lot lot-ground functions of the parts pass in progress, for the 4.0 lots the sink took. */
let grounds40Out: Array<LotGround40 | undefined> | null = null;
/** Where the parts pass sends the 4.0 buildings' parts (pool instances), when the props job asks for them. */
let parts40Out: PartSink | null = null;

/** Whether (x, z) is within `margin` of one of the footprints (captureFoot) of a building. */
export function inFootprints(rects: number[], x: number, z: number, margin: number): boolean {
  for (let k = 0; k + 4 < rects.length; k += 5) {
    const c = Math.cos(rects[k + 4]), s = Math.sin(rects[k + 4]), dx = x - rects[k], dz = z - rects[k + 1];
    if (Math.abs(dx * c - dz * s) <= rects[k + 2] + margin && Math.abs(dx * s + dz * c) <= rects[k + 3] + margin) return true;
  }
  return false;
}

/**
 * Estacionamento do lote (prédio baixo de loja ou de apartamentos): fileiras de vagas de 2,5 × 5 m nos fundos e
 * nas laterais livres. Cada fileira = [ax, az, bx, bz] (linha do meio, local); a vaga se estende 2,5 m para cada lado
 * na perpendicular. A mesma conta no gerador (piso e faixas) e nas peças (carros), sem guardar nada.
 */
export function lotParking(b: BoxColumns, i: number): number[] {
  const zone = b.zone[i], floors = Math.max(1, b.floors[i]);
  if (b.floors[i] === 0 || zone === 0 || zone === Zone.Industrial || b.fn[i] || hasDesign(b.color[i])) return [];
  const arch = pickArch(zone, floors, b.x[i], b.z[i], b.style[i]);
  if (arch >= ArchId.ColonialHouse && arch <= ArchId.Sobrado) return [];
  if (zone === Zone.Commercial && floors >= 8) return [];
  // in the lot frame: the rows are laid in the building's rectangle (lotFit) and moved by its centre
  const fit = lotFit(b, i), W = fit.W, D = fit.D, shop = zone === Zone.Commercial || zone === Zone.Mixed;
  const bw = Math.max(8, Math.min(W - (shop ? 0.6 : 3), 40)), bd = Math.max(8, Math.min(D - (shop ? 4 : 7), D > 42 ? 50 : 26));
  const out: number[] = [];
  const xL = -W / 2 + 0.8, xR = W / 2 - 0.8;
  // fundos: entre a divisa e o fundo do prédio (o mais recuado que o sorteio deixa)
  const back = D / 2 - (shop ? 0.4 : 4.5) - bd - 0.8, front = -D / 2 + 0.6;
  if (xR - xL >= 7.5) {
    if (back - front >= 16) out.push(xL, front + 2.5, xR, front + 2.5, xL, back - 2.5, xR, back - 2.5);
    else if (back - front >= 5.6) out.push(xL, front + 2.6, xR, front + 2.6);
  }
  // laterais: faixa entre a parede do prédio e a divisa
  const side = (W - bw) / 2 - 1.2;
  if (side >= 5.4 && D >= 12) {
    const z0 = Math.max(front, back + 0.8) + 0.4, z1 = D / 2 - 1.5;
    if (z1 - z0 >= 7.5) out.push(-W / 2 + 0.7 + 2.5, z0, -W / 2 + 0.7 + 2.5, z1, W / 2 - 0.7 - 2.5, z0, W / 2 - 0.7 - 2.5, z1);
  }
  for (let k = 0; k < out.length; k += 2) { out[k] += fit.ox; out[k + 1] += fit.oz; }
  return out;
}



/** A hip roof (houses): the 4.0's (pitchedRoof); `trim` gives the fascia and the soffit. */
