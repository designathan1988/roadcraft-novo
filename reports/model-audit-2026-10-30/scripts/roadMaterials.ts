/// <reference types="node" />
// Road triangles by material (jobs/roadMesh.ts RMAT; the material byte is color.w): how much of every road mesh is the
// zone strip that render/roads.ts:489-492 masks out unless the zone tool is on. Seed 1 city. Writes data/road-materials.json.
import { writeFileSync } from 'node:fs';
import { growCity } from './city.ts';
import { buildRoadMesh, RMAT } from '../../../src/jobs/roadMesh.ts';
import { MAP_CELLS, MAP_TILES, CELLS_PER_TILE } from '../../../src/config.ts';
import { cellId, cellOriginX, tileOriginX } from '../../../src/core/grid.ts';
const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const { w } = growCity(1, 'classic');
const net = w.roads;
const name: Record<number, string> = {}; for (const [k, v] of Object.entries(RMAT)) name[v] = k;
const acc: Record<string, Record<string, number>> = { lod0: {}, lod1: {}, tile: {} };
const count = (m: ReturnType<typeof buildRoadMesh>, into: Record<string, number>) => {
  if (!m) return;
  for (let t = 0; t < m.index.length; t += 3) { const mat = m.color[m.index[t] * 4 + 3] & 15; const k = name[mat] ?? `mat${mat}`; into[k] = (into[k] ?? 0) + 1; }
};
for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
  if (!net.cellCount[c]) continue;
  const s: number[] = [], n: number[] = []; net.cellContents(c, s, n);
  const x = cellOriginX(c % MAP_CELLS), z = cellOriginX((c / MAP_CELLS) | 0);
  count(buildRoadMesh(w.heights, net.gather(s, n), x, z, 512, 0), acc.lod0);
  count(buildRoadMesh(w.heights, net.gather(s, n), x, z, 512, 1), acc.lod1);
}
for (let t = 0; t < MAP_TILES * MAP_TILES; t++) {
  const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0, s: number[] = [], n: number[] = [];
  for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) net.cellContents(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j), s, n);
  if (s.length || n.length) count(buildRoadMesh(w.heights, net.gather(s, n), tileOriginX(tx), tileOriginX(tz), 2048, 1), acc.tile);
}
writeFileSync(out + 'data/road-materials.json', JSON.stringify(acc, null, 1));
console.log(JSON.stringify(acc));
