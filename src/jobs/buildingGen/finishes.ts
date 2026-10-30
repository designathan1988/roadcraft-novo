// Finishes (texture-array layer per vertex): the material table of one building, by style/creator/zone, and the write
// of its high nibble on the mesh vertices. Pure data and a shared 16-byte table filled per call; no generator state.

import { hash2 } from '../../core/rng.ts';
import { Zone } from '../../roads/zones.ts';
import { ArchId } from '../../world/arch.ts';
import type { Design } from '../../world/design.ts';
import { FIN } from '../buildingFinishes.ts';
import type { MeshBuilder } from '../meshBuilder.ts';
import { BMAT } from './materials.ts';

/** Finish per building material for one building (index = BMAT); 0 = the shader's default for that material. */
const finTable = new Uint8Array(16);

/** Wall finish by style, picked from the seed (a hash, not the generator's Rng: the layout stays as it was). */
const WALL_FINISHES: number[][] = [];
WALL_FINISHES[ArchId.Colonial] = [FIN.Plaster, FIN.Plaster, FIN.Stucco];
WALL_FINISHES[ArchId.ArtDeco] = [FIN.Stucco, FIN.Stone, FIN.Plaster];
WALL_FINISHES[ArchId.Modernist] = [FIN.Ceramic, FIN.Ceramic, FIN.Plaster];
WALL_FINISHES[ArchId.Contemporary] = [FIN.Panel, FIN.Concrete, FIN.Plaster, FIN.Plaster];
WALL_FINISHES[ArchId.Brick] = [FIN.Brick];
WALL_FINISHES[ArchId.Tropical] = [FIN.Ceramic, FIN.Plaster, FIN.Plaster];
WALL_FINISHES[ArchId.Glass] = [FIN.Stone, FIN.Concrete];
WALL_FINISHES[ArchId.Industrial] = [FIN.Concrete, FIN.Plaster];
WALL_FINISHES[ArchId.ColonialHouse] = [FIN.Plaster, FIN.Stucco];
WALL_FINISHES[ArchId.Bungalow] = [FIN.Stucco, FIN.Plaster];
WALL_FINISHES[ArchId.ModernHouse] = [FIN.Concrete, FIN.Plaster, FIN.Plaster, FIN.Wood];
WALL_FINISHES[ArchId.Sobrado] = [FIN.Plaster, FIN.Plaster, FIN.Brick];
WALL_FINISHES[ArchId.Civic] = [FIN.Stone, FIN.Plaster];

/** Creator wall finishes (design.ts FINISHES order) → finish id, and the facade grammar each one draws. */
const DESIGN_FINISH = [FIN.Plaster, FIN.Brick, FIN.Glass, FIN.Concrete, FIN.Metal, FIN.Wood, FIN.Stone, FIN.Ceramic, FIN.Stucco, FIN.Panel];
export const DESIGN_ARCH = [ArchId.Colonial, ArchId.Brick, ArchId.Glass, ArchId.Modernist, ArchId.Industrial, ArchId.Tropical, ArchId.ArtDeco, ArchId.Modernist, ArchId.ArtDeco, ArchId.Contemporary];
/** Creator wall finishes whose pitched roof is slate (stone, stucco) or metal sheet (metal, glass, concrete, panel). */
export const DESIGN_SLATE = new Set([6, 8]), DESIGN_METAL_ROOF = new Set([2, 3, 4, 9]);

/** The finish of each material of one building (shared table, filled per call). */
export function finishTable(arch: number, seed: number, fn: number, zone: number, ds: Design | null): Uint8Array {
  finTable.fill(0);
  const h = hash2(seed, arch, 0x51f15e);
  const list = WALL_FINISHES[fn ? ArchId.Civic : arch] ?? WALL_FINISHES[ArchId.Colonial];
  let wall = list[h % list.length];
  if (ds) wall = DESIGN_FINISH[ds.finish] ?? FIN.Plaster;
  if (ds) {
    // a design's roofs follow its wall finish, by the player's choice (no draw): every finish is reachable
    finTable[BMAT.Wall] = finTable[BMAT.Shop] = finTable[BMAT.Curtain] = wall;
    finTable[BMAT.Plain] = wall === FIN.Brick || wall === FIN.Ceramic || wall === FIN.Wood || wall === FIN.Panel || wall === FIN.Glass ? FIN.Plaster : wall;
    const hard = DESIGN_METAL_ROOF.has(ds.finish);
    finTable[BMAT.RoofFlat] = hard ? FIN.Concrete : FIN.Roofing;
    finTable[BMAT.RoofTile] = DESIGN_SLATE.has(ds.finish) ? FIN.Slate : hard ? FIN.Metal : FIN.Tile;
    return finTable;
  }
  finTable[BMAT.Wall] = wall;
  finTable[BMAT.Shop] = wall;
  // trim and parapets follow a plain wall; brick, tile, wood and panel buildings get rendered parapets and cornices
  finTable[BMAT.Plain] = wall === FIN.Brick || wall === FIN.Ceramic || wall === FIN.Wood || wall === FIN.Panel ? FIN.Plaster : wall;
  finTable[BMAT.RoofFlat] = (h >>> 8) % 10 < 3 ? FIN.Concrete : FIN.Roofing;
  finTable[BMAT.RoofTile] = (h >>> 12) % 10 < 1 && zone !== Zone.Industrial ? FIN.Slate : FIN.Tile;
  if (zone === Zone.Industrial && !ds) finTable[BMAT.Metal] = FIN.Metal;
  return finTable;
}

/** Writes the finish (high nibble of the material byte) on the vertices of one building. */
export function applyFinishes(mb: MeshBuilder, v0: number, table: Uint8Array): void {
  const m = mb.mat;
  for (let i = v0; i < mb.v; i++) { const k = m[i]; if (k < 16) m[i] = k | (table[k] << 4); }
}
