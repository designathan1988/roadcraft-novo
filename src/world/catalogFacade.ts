// How the catalog projects' facades (Roadcraft 4.0 bay components and per-face window geometry) are drawn by the
// buildings' shader: each storey band of a face gets a facade id whose row in the window table (arch.ts
// facadeWindowTable) has the project's window width, sill and head for that storey height. The rows come after the
// 117 style × pattern rows, computed in the same order on the page (the shader's table) and in the workers (the ids
// on the vertices). A row's id also picks the trim colour and the 3D frame style (id % ARCH_COUNT): the residue whose
// style trim is nearest the project's trim colour.

import { ARCHES, ARCH_COUNT, PATTERN_COUNT } from './archData.ts';
import { CAT_BAYS, CAT_UNIT, catalogProjects, type CatGeometry, type CatProject } from './catalog.ts';

/** Bay components by name (CAT_BAYS indices). */
export const BAY = Object.fromEntries(CAT_BAYS.map((n, k) => [n, k])) as Record<(typeof CAT_BAYS)[number], number>;
/** Shader kinds (as buildingGen Facade): punched, curtain glass, house, ribbon; the shop bit. */
const K_PUNCHED = 0, K_CURTAIN = 1, K_RIBBON = 3, SHOP_BIT = 4;
/** First id of the catalog rows (after the 13 styles × 9 patterns); the table holds 256 ids (one byte on the vertex). */
export const CAT_ROW0 = 117;

/** What a fill draws: no windows (null), or the shader kind and the window row [side margin, sill, head, bits]. */
export function fillLook(fill: number, g: CatGeometry | null, fh: number, ground: boolean): { kind: number; row: [number, number, number, number] } | null {
  if (fill === BAY.wall || fill === BAY.pillar) return null;
  const ww = g?.windowWidth ?? 0.6, wh = g?.windowHeight ?? 0.6, sill = (g?.sill ?? 2) * CAT_UNIT;
  const q = (v: number) => Math.round(v * 100) / 100;
  const side = (w: number) => q(Math.max(0.02, Math.min(0.45, (1 - w) / 2)));
  const low = q(Math.max(0.02, Math.min(0.7, sill / fh)));
  const high = q(Math.max(low + 0.12, Math.min(0.95, low + wh)));
  if (fill === BAY.shopfront) return ground ? { kind: K_PUNCHED | SHOP_BIT, row: [side(ww), low, high, 0] } : { kind: K_CURTAIN, row: [0.02, 0.24, 0.98, 0] };
  if (fill === BAY.ribbon) return { kind: K_RIBBON, row: [0.02, low, high, 0] };
  // full-height openings: French windows, balconies, loggias, doors as a fill
  if (fill === BAY.frenchWindow || fill === BAY.balcony || fill === BAY.loggia || fill === BAY.gourmet || fill === BAY.door
    || fill === BAY.doubleDoor || fill === BAY.garageDoor || fill === BAY.loadingDoor) return { kind: K_PUNCHED, row: [side(ww), 0.03, q(Math.min(0.9, 0.03 + Math.max(wh, 0.8))), 2] };
  if (fill === BAY.wideWindow || fill === BAY.bayWindow) return { kind: K_PUNCHED, row: [side(Math.min(0.95, ww + 0.25)), low, high, 2] };
  return { kind: K_PUNCHED, row: [side(ww), low, high, (fill === BAY.shutteredWindow ? 1 : 0) | 2] };
}

/** The style residue (0..ARCH_COUNT-1) whose trim is nearest a colour. */
function trimResidue(colour: number): number {
  let best = 0, bd = Infinity;
  ARCHES.forEach((a, k) => {
    const d = (((a.trim >> 16) & 255) - ((colour >> 16) & 255)) ** 2 + (((a.trim >> 8) & 255) - ((colour >> 8) & 255)) ** 2 + ((a.trim & 255) - (colour & 255)) ** 2;
    if (d < bd) { bd = d; best = k; }
  });
  return best;
}

interface RowTable { rows: Array<[number, number, number, number]>; ids: Map<string, number> }
let table: RowTable | null = null;

const keyOf = (row: [number, number, number, number], residue: number) => `${row.join(',')}|${residue}`;

/** Every catalog row, in a fixed order: projects, volumes, faces, the storey fills of each face, both storey heights. */
function buildTable(): RowTable {
  if (CAT_ROW0 !== ARCH_COUNT * PATTERN_COUNT) throw new Error('catalog facade rows: CAT_ROW0 is not the number of style × pattern rows');
  const rows: Array<[number, number, number, number]> = [], ids = new Map<string, number>();
  const used = new Set<number>();
  for (const p of catalogProjects()) {
    const residue = trimResidue(p.trim.colour);
    for (const v of p.volumes) {
      if (v.open >= 0) continue;
      for (let face = 0; face < 4; face++) {
        const fills = new Set<number>();
        for (const s of v.storeys) fills.add(s.sides[face] >= 0 ? s.sides[face] : s.fill);
        for (const fill of fills) for (const [fh, ground] of [[p.groundHeight * CAT_UNIT, true], [p.storeyHeight * CAT_UNIT, false]] as const) {
          const look = fillLook(fill, v.geometry[face], fh, ground);
          if (!look) continue;
          const key = keyOf(look.row, residue);
          if (ids.has(key)) continue;
          // the first free id with this residue (so the id picks the trim), else any free one
          let id = -1;
          for (let k = CAT_ROW0; k < 256 && id < 0; k++) if (!used.has(k) && k % ARCH_COUNT === residue) id = k;
          for (let k = CAT_ROW0; k < 256 && id < 0; k++) if (!used.has(k)) id = k;
          if (id < 0) throw new Error('catalog facade rows: more than fit in a byte');
          used.add(id);
          rows[id - CAT_ROW0] = look.row;
          ids.set(key, id);
        }
      }
    }
  }
  for (let k = 0; k < rows.length; k++) rows[k] ??= [0.3, 0.3, 0.8, 0];
  return { rows, ids };
}

/** The rows after the style × pattern rows, for the window table (index = id − CAT_ROW0). */
export function catalogWindowRows(): Array<[number, number, number, number]> {
  return (table ??= buildTable()).rows;
}

/** The facade id and shader kind of a fill on a face of a project's volume, at a storey height; null = blank wall. */
export function catalogFacade(p: CatProject, fill: number, g: CatGeometry | null, fh: number, ground: boolean): { id: number; kind: number } | null {
  const look = fillLook(fill, g, fh, ground);
  if (!look) return null;
  const t = (table ??= buildTable());
  const id = t.ids.get(keyOf(look.row, trimResidue(p.trim.colour)));
  return { id: id ?? trimResidue(p.trim.colour), kind: look.kind };
}
