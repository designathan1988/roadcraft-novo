// The cell plan: facade patterns, catalog landmarks and the free sides of a corner lot. Pure functions of the
// building boxes, shared by every LOD of a cell and by the props job.
import { hash2 } from '../../core/rng.ts';
import { cellId, cellOriginX, cellX } from '../../core/grid.ts';
import { CELL_SIZE } from '../../config.ts';
import { ArchId, Pattern, pickArch } from '../../world/arch.ts';
import { Zone } from '../../roads/zones.ts';
import { CIVIC_CATALOG, hasDesign } from '../../world/design.ts';
import { CAT_UNIT, catalogProjects, type CatProject } from '../../world/catalog.ts';
import type { BoxColumns } from '../../shared/contracts/worker.ts';

/** Landmark towers: the catalog projects that are not civic (index into catalogProjects()). */
let towerCatalog: number[] | null = null;
const TOWER_CATALOG = (): number[] => towerCatalog ??= catalogProjects().map((_, k) => k).filter((k) => !CIVIC_CATALOG.has(catalogProjects()[k].name));
/** Share of commercial towers drawn as a catalog landmark (%). */
const LANDMARK_SHARE = 22;
/** Radius in which a landmark is never repeated (m); the cell colouring keeps it across cell borders. */
const LANDMARK_GAP = 250;
/** Radius of the neighbours a facade pattern is compared with (m). */
const SIGNATURE_RADIUS = 90;

export interface CellPlan { pattern: Uint8Array; landmark: Uint8Array; /** Free side (corner): 1 = -x, 2 = +x. */ side: Uint8Array }

/**
 * Per cell, in a fixed order (seed, then x): each building takes the facade pattern whose signature (style,
 * pattern, height) is least like the buildings already placed within 90 m, and ~22 % of the commercial towers
 * become a catalog landmark. Only buildings of the same cell are read, so a cell, its tile and its plate (L0..L3)
 * and the props job all reach the same plan; neighbouring cells use disjoint quarters of the landmark list
 * (2 x 2 colouring), so the same landmark is never closer than one cell (256 m) across a border.
 */
export function planCells(b: BoxColumns): CellPlan {
  const n = b.count;
  const pattern = new Uint8Array(n), landmark = new Uint8Array(n), arch = new Uint8Array(n), side = new Uint8Array(n);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (b.floors[i] === 0 || b.zone[i] === 0) continue;
    const key = cellId(cellX(b.x[i]), cellX(b.z[i]));
    let list = groups.get(key);
    if (!list) groups.set(key, list = []);
    list.push(i);
  }
  for (const list of groups.values()) {
    list.sort((p, q) => (b.seed[p] - b.seed[q]) || (b.x[p] - b.x[q]));
    const done: number[] = [];
    for (const i of list) {
      const floors = Math.max(1, b.floors[i]), zone = b.zone[i];
      arch[i] = pickArch(zone, floors, b.x[i], b.z[i], b.style[i]);
      const house = arch[i] >= ArchId.ColonialHouse && arch[i] <= ArchId.Sobrado;
      if (b.fn[i] || hasDesign(b.color[i]) || zone === Zone.Industrial || house) { done.push(i); continue; }
      const tower = zone === Zone.Commercial && floors >= 8;
      if (tower && hash2(b.seed[i], 0x1a4d) % 100 < LANDMARK_SHARE) {
        const colour = (cellX(b.x[i]) & 1) | ((cellX(b.z[i]) & 1) << 1);
        const cands = TOWER_CATALOG().filter((_, j) => j % 4 === colour);
        const start = hash2(b.seed[i], 0x77) % cands.length;
        for (let t = 0; t < cands.length && !landmark[i]; t++) {
          const k = cands[(start + t) % cands.length], ext = catalogExtent(catalogProjects()[k]);
          if (Math.min(b.w[i] / ((ext.x1 - ext.x0) * CAT_UNIT), b.d[i] / (ext.y1 * CAT_UNIT)) < 0.6) continue;
          const near = done.some((j) => landmark[j] === k + 1 && Math.hypot(b.x[j] - b.x[i], b.z[j] - b.z[i]) < LANDMARK_GAP);
          if (!near) landmark[i] = k + 1;
        }
        if (landmark[i]) { done.push(i); continue; }
      }
      const cands: number[] = tower ? [Pattern.Office, Pattern.Observation, Pattern.ArtDecoCrown, Pattern.ArtDeco]
        : zone === Zone.Commercial || zone === Zone.Mixed ? [Pattern.Storefront, Pattern.Arcade, Pattern.ArtDeco, Pattern.Office, Pattern.Gallery]
          : [Pattern.Residential, Pattern.Gallery, Pattern.ArtDeco, Pattern.Office];
      let best = cands[0], bestScore = Infinity;
      for (let c = 0; c < cands.length; c++) {
        let score = (hash2(b.seed[i], c, 0x51) & 255) / 4096; // tie-break
        for (const j of done) {
          if (Math.hypot(b.x[j] - b.x[i], b.z[j] - b.z[i]) > SIGNATURE_RADIUS) continue;
          score += (arch[j] === arch[i] ? 1 : 0) + (pattern[j] === cands[c] ? 2 : 0) + (Math.abs(b.floors[j] - floors) < 3 ? 0.5 : 0);
        }
        if (score < bestScore) { bestScore = score; best = cands[c]; }
      }
      pattern[i] = best;
      side[i] = freeSides(b, i, list);
      done.push(i);
    }
  }
  return { pattern, landmark, side };
}

/** The plan of a project: x from x0 to x1 and y from 0 (the front) to y1, project units, over volumes and elements. */
export function catalogExtent(p: CatProject): { x0: number; x1: number; y1: number } {
  let x0 = Infinity, x1 = -Infinity, y1 = 0;
  for (const v of p.volumes) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x + v.w); y1 = Math.max(y1, v.y + v.d); }
  return { x0, x1, y1 };
}

/**
 * Sides of a lot with no neighbour (a corner): only trusted 40 m or more inside the cell (the neighbours across the
 * border are not read), so a cell border never makes a false corner.
 */
function freeSides(b: BoxColumns, i: number, list: number[]): number {
  const c = Math.cos(b.rot[i]), s = Math.sin(b.rot[i]), W = b.w[i], D = b.d[i];
  const ox = cellOriginX(cellX(b.x[i])), oz = cellOriginX(cellX(b.z[i]));
  let out = 0;
  for (const sx of [-1, 1]) {
    // the point 30 m out on that side, in the world
    const px = b.x[i] + sx * (W / 2 + 30) * c, pz = b.z[i] - sx * (W / 2 + 30) * s;
    if (px - ox < 40 || ox + CELL_SIZE - px < 40 || pz - oz < 40 || oz + CELL_SIZE - pz < 40) continue;
    let taken = false;
    for (const j of list) {
      if (j === i) continue;
      const dx = b.x[j] - b.x[i], dz = b.z[j] - b.z[i];
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.sign(lx) === sx && Math.abs(lx) < W / 2 + Math.max(b.w[j], b.d[j]) / 2 + 6 && Math.abs(lz) < D / 2 + 4) { taken = true; break; }
    }
    if (!taken) out |= sx < 0 ? 1 : 2;
  }
  return out;
}
