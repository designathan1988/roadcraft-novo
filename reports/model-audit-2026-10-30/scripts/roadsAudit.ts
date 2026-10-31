/// <reference types="node" />
// Roads and the terrain seams: every road cell's mesh at lod 0 and 1 (render/roads.ts buildCell, extent 512), every
// tile's (buildTile, lod 1, extent 2048), and the terrain seams of the cells round the busiest road tile
// (render/terrainSeams.ts: lod-0 roads over CELL_SIZE * 2, then jobs/terrainSeams.ts). Seed 1 city (the budget's).
// Writes data/roads.json and sheets/road-*.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { growCity } from './city.ts';
import { buildRoadMesh } from '../../../src/jobs/roadMesh.ts';
import { buildTerrainSeams, SEAM_PAD } from '../../../src/jobs/terrainSeams.ts';
import { CELL_SIZE, CELLS_PER_TILE, HEIGHT_SPACING, MAP_CELLS, MAP_TILES } from '../../../src/config.ts';
import { cellId, cellOriginX, tileOriginX } from '../../../src/core/grid.ts';
import type { PackedMesh } from '../../../src/shared/contracts/worker.ts';
import { flatOfPacked, packedBytes, packedKey, stats } from './geom.ts';
import { sheet } from './raster.ts';

const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true }); mkdirSync(out + 'sheets', { recursive: true });
const city = growCity(Number(process.argv[2] ?? 1), 'classic');
const w = city.w, net = w.roads;
const tris = (m: PackedMesh | null) => (m ? m.index.length / 3 : 0);
const rb = (m: PackedMesh | null) => (m ? packedBytes(m, false, true) : 0);
const cellRows: Array<Record<string, number>> = [];
const ms = { l0: 0, l1: 0, tile: 0, seam: 0 };
for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
  if (!net.cellCount[c]) continue;
  const segs: number[] = [], nodes: number[] = []; net.cellContents(c, segs, nodes);
  const g = net.gather(segs, nodes), x = cellOriginX(c % MAP_CELLS), z = cellOriginX((c / MAP_CELLS) | 0);
  let t = performance.now(); const m0 = buildRoadMesh(w.heights, g, x, z, 512, 0); ms.l0 += performance.now() - t;
  t = performance.now(); const m1 = buildRoadMesh(w.heights, net.gather(segs, nodes), x, z, 512, 1); ms.l1 += performance.now() - t;
  cellRows.push({ cell: c, segs: segs.length, nodes: nodes.length, l0v: m0?.vertexCount ?? 0, l0t: tris(m0), l0b: rb(m0), l1v: m1?.vertexCount ?? 0, l1t: tris(m1), l1b: rb(m1) });
}
const tileRows: Array<Record<string, number>> = [];
for (let t = 0; t < MAP_TILES * MAP_TILES; t++) {
  const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0, segs: number[] = [], nodes: number[] = [];
  for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) net.cellContents(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j), segs, nodes);
  if (!segs.length && !nodes.length) continue;
  const t0 = performance.now();
  const m = buildRoadMesh(w.heights, net.gather(segs, nodes), tileOriginX(tx), tileOriginX(tz), 2048, 1);
  ms.tile += performance.now() - t0;
  tileRows.push({ tile: t, segs: segs.length, v: m?.vertexCount ?? 0, t: tris(m), b: rb(m), index32: m && m.index instanceof Uint32Array ? 1 : 0, quantumMm: m ? +(m.scale / 32767 * 1000).toFixed(1) : 0 });
}
// seams: the 25 cells with the most road triangles
const REACH = SEAM_PAD * HEIGHT_SPACING + 80;
const seamRows: Array<Record<string, number>> = [];
for (const r of [...cellRows].sort((a, b) => b.l0t - a.l0t).slice(0, 25)) {
  const c = r.cell, x = cellOriginX(c % MAP_CELLS), z = cellOriginX((c / MAP_CELLS) | 0), segs: number[] = [], nodes: number[] = [];
  net.segIndex.query(x - REACH, z - REACH, x + CELL_SIZE + REACH, z + CELL_SIZE + REACH, (s: number) => { segs.push(s); });
  net.nodeIndex.query(x - REACH, z - REACH, x + CELL_SIZE + REACH, z + CELL_SIZE + REACH, (n: number) => { nodes.push(n); });
  const t0 = performance.now();
  const road = buildRoadMesh(w.heights, net.gather(segs, nodes), x, z, CELL_SIZE * 2, 0);
  const s = buildTerrainSeams(w.heights, road, x, z);
  ms.seam += performance.now() - t0;
  let holes = 0; for (const h of s.holes) holes += h;
  seamRows.push({ cell: c, roadTrisInput: tris(road), seamV: s.mesh?.vertexCount ?? 0, seamT: tris(s.mesh), seamB: s.mesh ? packedBytes(s.mesh, false, false) : 0, holes4m: holes });
}
// quality and sheets on the heaviest cell and tile
const hc = [...cellRows].sort((a, b) => b.l0t - a.l0t)[0];
const segs: number[] = [], nodes: number[] = []; net.cellContents(hc.cell, segs, nodes);
const hx = cellOriginX(hc.cell % MAP_CELLS), hz = cellOriginX((hc.cell / MAP_CELLS) | 0);
const quality: unknown[] = [];
for (const lod of [0, 1]) {
  const m = buildRoadMesh(w.heights, net.gather(segs, nodes), hx, hz, 512, lod)!;
  const s = stats(flatOfPacked(m), packedKey(m));
  quality.push({ cell: hc.cell, lod, ...s, quantumMm: +(m.scale / 32767 * 1000).toFixed(1) });
  sheet(out + `sheets/road-cell-${hc.cell}-L${lod}.png`, `Road cell ${hc.cell}, level ${lod} (${lod === 0 ? 'to 600 m' : '600-1400 m'}), one draw`, [`${s.triangles.toLocaleString('en-US')} triangles, ${s.vertices.toLocaleString('en-US')} vertices, 32 B/vertex (pos 8, normal 4, colour 4, road f32x4 16)`, `${segs.length} segments, ${nodes.length} nodes; tiny triangles ${s.tiny}, degenerate ${s.degenerate}, median edge ${s.medianEdge.toFixed(2)} m`], flatOfPacked(m), { yaw: 0.5, pitch: 1.0 });
}
const ht = [...tileRows].sort((a, b) => b.t - a.t)[0];
{
  const tx = ht.tile % MAP_TILES, tz = (ht.tile / MAP_TILES) | 0, s2: number[] = [], n2: number[] = [];
  for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) net.cellContents(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j), s2, n2);
  const m = buildRoadMesh(w.heights, net.gather(s2, n2), tileOriginX(tx), tileOriginX(tz), 2048, 1)!;
  const s = stats(flatOfPacked(m), packedKey(m));
  quality.push({ tile: ht.tile, lod: 1, ...s, quantumMm: +(m.scale / 32767 * 1000).toFixed(1) });
  sheet(out + `sheets/road-tile-${ht.tile}.png`, `Road tile ${ht.tile} (1024 m, lod 1, drawn 1400-5500 m)`, [`${s.triangles.toLocaleString('en-US')} triangles, ${s.vertices.toLocaleString('en-US')} vertices, ${(rb(m) / 1e6).toFixed(1)} MB; ${s2.length} segments`, `median edge ${s.medianEdge.toFixed(2)} m; at 1400 m one pixel is ${(1 / (1080 / (2 * 1400 * Math.tan(Math.PI / 8)))).toFixed(2)} m`], flatOfPacked(m), { yaw: 0.3, pitch: 1.2 });
}
const sum = (rows: Array<Record<string, number>>, k: string) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const summary = {
  cells: cellRows.length, l0t: sum(cellRows, 'l0t'), l0v: sum(cellRows, 'l0v'), l0b: sum(cellRows, 'l0b'), l1t: sum(cellRows, 'l1t'), l1v: sum(cellRows, 'l1v'), l1b: sum(cellRows, 'l1b'),
  maxL0t: Math.max(...cellRows.map((r) => r.l0t)), tiles: tileRows.length, tileT: sum(tileRows, 't'), tileV: sum(tileRows, 'v'), tileB: sum(tileRows, 'b'), maxTileT: Math.max(...tileRows.map((r) => r.t)), tileIndex32: sum(tileRows, 'index32'),
  seamCells: seamRows.length, seamT: sum(seamRows, 'seamT'), seamV: sum(seamRows, 'seamV'), ms,
};
writeFileSync(out + 'data/roads.json', JSON.stringify({ summary, quality, seams: seamRows, tiles: tileRows, cells: cellRows }, null, 1));
console.log(JSON.stringify(summary)); console.log(JSON.stringify(quality));
