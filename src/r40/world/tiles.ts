
import { m } from './units.ts';

/** THE WORLD'S TILES: an unbounded grid of 1,024 m squares, the unit the world is generated, kept, loaded and drawn by (CLAUDE.md, "Streaming world") */

/** A tile's side. The tiles' edges lie on multiples of it, so a tile nests in a 2,048 m plate (`bounds.ts`) and holds 16 cells of 256 m. */
export const TILE = m(1_024);

/** Tiles each way from the origin a key can name (2^15): about 33,000 km, far past any map, so a key and an id stay exact doubles. */
const TILE_REACH = 1 << 15;
/** How far from the origin a tile's key reaches, each way: the world's only edge (`bounds.ts` WORLD_HALF keeps a plate inside it). */
export const WORLD_REACH = TILE_REACH * TILE;

/** A tile's column and row. */
export interface TileIJ {
  readonly i: number;
  readonly j: number;
}

/** The tile a point lies in: a point on an edge is the tile's whose low edge it is. */
export const tileIJ = (x: number, y: number): TileIJ => ({ i: Math.floor(x / TILE), j: Math.floor(y / TILE) });

/** A tile's key: its column and row packed in one number (each shifted to be positive, 16 bits each). */
export function tileKey(i: number, j: number): number {
  if (i < -TILE_REACH || i >= TILE_REACH || j < -TILE_REACH || j >= TILE_REACH) throw new Error(`tile ${i},${j} is past the world's reach`);
  return (i + TILE_REACH) * (TILE_REACH * 2) + (j + TILE_REACH);
}

/** The ids a tile hands out: each tile its own range, so a tile is made, kept and loaded alone and two tiles never name one record alike */
export const TILE_IDS = 1 << 20;

/** The first id of a tile's range; the ids under `TILE_IDS` are a map's from before the tiles (kept as they were, never handed out again). */
export const tileIdBase = (key: number): number => (key + 1) * TILE_IDS;

/** The ids a tile counts out one by one (its own records); the upper half of its range is its edge's nodes' (`edgeNodeId`). */
export const TILE_COUNTED = 1 << 19;

/** Steps an edge node's place is told in along its edge: a centimetre (an edge is 102,400 of them, under 2^17). */
const EDGE_STEP = m(0.01);

/** A node on a tile's edge: the same id from both tiles that lay it (each makes it alone, from the seed and the place, `cityGen/wholeMap.ts`)
 *  - a point on a tile edge belongs to the tile whose low edge it is (`tileIJ`); its id is told by which of that tile's two low edges it is on and how far along. Null off any edge. */
export function edgeNodeId(x: number, y: number): number | null {
  const { i, j } = tileIJ(x, y);
  const onX = x === i * TILE, onY = y === j * TILE;
  if (!onX && !onY) return null;
  // The corner counts as the x edge's (offset 0 along it).
  const along = onX ? y - j * TILE : x - i * TILE;
  const step = Math.round(along / EDGE_STEP);
  return tileIdBase(tileKey(i, j)) + TILE_COUNTED + (onX ? 0 : 1 << 17) + step;
}
