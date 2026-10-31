/// <reference types="node" />
// Buildings: the cell layer's meshes of a city grown in Node (scripts/city.ts) at every level the game asks for
// (render/city.ts createCity/createCityDetail: lod 0 and 1 per 256 m cell, 2 per 1024 m tile, 3 per 2048 m plate,
// -1 the detail layer per cell), the parts the parts pass sends to the props pool (lod -2), and a catalogue of single
// buildings by kind. Writes data/buildings.json, data/building-cells.csv and sheets/building-*.png.
// Usage: node buildings.ts [seed] [--all]   (--all: every cell at L0/L1/detail; default: every tile and plate, and
// the cells of the 3 x 3 tiles round the busiest tile)
import { mkdirSync, writeFileSync } from 'node:fs';
import { growCity } from './city.ts';
import { buildBuildings, buildBuildingParts } from '../../../src/jobs/buildingGen.ts';
import { emptyBoxes, type BoxColumns, type PackedMesh } from '../../../src/shared/contracts/worker.ts';
import { CELL_SIZE, CELLS_PER_TILE, MAP_CELLS, MAP_PLATES, MAP_TILES, PLATE_SIZE, TILE_SIZE } from '../../../src/config.ts';
import { cellId, cellOriginX, tileOriginX } from '../../../src/core/grid.ts';
import { pickArch, ARCHES } from '../../../src/world/arch.ts';
import { Zone } from '../../../src/roads/zones.ts';
import { flatOfPacked, packedBytes, packedKey, stats, pxPerMetre } from './geom.ts';
import { sheet, grid } from './raster.ts';
import props from '../data/props.json' with { type: 'json' };

const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true }); mkdirSync(out + 'sheets', { recursive: true });
const seed = Number(process.argv[2] ?? 20261030), all = process.argv.includes('--all');

const city = growCity(seed, 'classic');
const w = city.w;
console.log(`city seed ${seed}: ${city.buildings} buildings, ${city.segs} segments, grown in ${(city.ms / 1000).toFixed(1)} s`);

const tris = (m: PackedMesh | null) => (m ? m.index.length / 3 : 0);
const verts = (m: PackedMesh | null) => (m ? m.vertexCount : 0);
const bytes = (m: PackedMesh | null) => (m ? packedBytes(m, true, false) : 0);
const timed = <T>(f: () => T): [T, number] => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };

// ---- tiles (L2) and plates (L3): every one
const tileRows: Array<Record<string, number>> = [];
let busiest = 0, busiestN = -1;
for (let tz = 0; tz < MAP_TILES; tz++) for (let tx = 0; tx < MAP_TILES; tx++) {
  const cells: number[] = [];
  for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) cells.push(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j));
  const b = w.gatherBoxes(cells, true);
  if (!b.count) continue;
  const [m, ms] = timed(() => buildBuildings(w.heights, b, tileOriginX(tx), tileOriginX(tz), TILE_SIZE, 2));
  tileRows.push({ tile: tz * MAP_TILES + tx, buildings: b.count, vertices: verts(m), triangles: tris(m), bytes: bytes(m), index32: m && m.index instanceof Uint32Array ? 1 : 0, ms: +ms.toFixed(0) });
  if (b.count > busiestN) { busiestN = b.count; busiest = tz * MAP_TILES + tx; }
}
const plateRows: Array<Record<string, number>> = [];
const per = PLATE_SIZE / TILE_SIZE * CELLS_PER_TILE;
for (let p = 0; p < MAP_PLATES * MAP_PLATES; p++) {
  const px = p % MAP_PLATES, pz = (p / MAP_PLATES) | 0, cells: number[] = [];
  for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) { const ci = px * per + i, cj = pz * per + j; if (ci < MAP_CELLS && cj < MAP_CELLS) cells.push(cellId(ci, cj)); }
  const b = w.gatherBoxes(cells, true);
  if (!b.count) continue;
  const [m, ms] = timed(() => buildBuildings(w.heights, b, cellOriginX(px * per), cellOriginX(pz * per), PLATE_SIZE, 3));
  plateRows.push({ plate: p, buildings: b.count, vertices: verts(m), triangles: tris(m), bytes: bytes(m), index32: m && m.index instanceof Uint32Array ? 1 : 0, ms: +ms.toFixed(0) });
}
console.log(`tiles ${tileRows.length}, plates ${plateRows.length}; busiest tile ${busiest} (${busiestN} buildings)`);

// ---- cells: L0, L1, detail (-1) and the parts pass (-2)
const partTris: Record<string, number> = {};
for (const k of props.kit) partTris[k.kind] = k.triangles;
// the pool draws a part's whole type mesh (render/propMeshes.ts buildingPartDefs + SPLIT): its kind's triangles there
const typeTris: Record<string, number> = {};
for (const r of props.rows as Array<{ type: number; variants: number[]; levels: Array<{ triangles: number } | null> }>) {
  for (const [kind, [type, variant]] of Object.entries((await import('../../../src/jobs/parts40.ts')).POOL_PARTS)) {
    if (r.type === type && (r.variants.includes(variant) || r.variants.length === 16)) typeTris[kind] = r.levels[0]?.triangles ?? 0;
  }
}
const btx = busiest % MAP_TILES, btz = (busiest / MAP_TILES) | 0;
const cellList: number[] = [];
for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
  if (!w.cellBuildings[c]) continue;
  const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
  const tx = Math.floor(cx / CELLS_PER_TILE), tz = Math.floor(cz / CELLS_PER_TILE);
  if (all || (Math.abs(tx - btx) <= 1 && Math.abs(tz - btz) <= 1)) cellList.push(c);
}
const cellRows: Array<Record<string, number>> = [];
const partCount: Record<string, number> = {};
let partInstances = 0, partPoolTris = 0;
for (const c of cellList) {
  const b = w.gatherBoxes([c], true), cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
  const [m0, t0] = timed(() => buildBuildings(w.heights, b, cellOriginX(cx), cellOriginX(cz), CELL_SIZE, 0));
  const [m1, t1] = timed(() => buildBuildings(w.heights, b, cellOriginX(cx), cellOriginX(cz), CELL_SIZE, 1));
  const [md, td] = timed(() => buildBuildings(w.heights, b, cellOriginX(cx), cellOriginX(cz), CELL_SIZE, -1));
  let n = 0, pt = 0, generic = 0;
  const [, tp] = timed(() => buildBuildingParts(w.heights, b, () => { generic++; }, undefined, (kind) => { n++; partCount[kind] = (partCount[kind] ?? 0) + 1; pt += typeTris[kind] ?? 0; }));
  partInstances += n; partPoolTris += pt;
  cellRows.push({ cell: c, buildings: b.count, l0v: verts(m0), l0t: tris(m0), l0b: bytes(m0), l1v: verts(m1), l1t: tris(m1), l1b: bytes(m1), dv: verts(md), dt: tris(md), db: bytes(md), parts: n, genericParts: generic, partTris: pt, ms0: +t0.toFixed(0), ms1: +t1.toFixed(0), msd: +td.toFixed(0), msp: +tp.toFixed(0) });
}
console.log(`cells measured ${cellRows.length}`);

// ---- mesh quality on the 6 heaviest L0 cells and their L1 / tile
const heavy = [...cellRows].sort((a, b) => b.l0t - a.l0t).slice(0, 6);
const quality: unknown[] = [];
for (const r of heavy) {
  const c = r.cell, b = w.gatherBoxes([c], true), cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
  for (const lod of [0, 1, -1]) {
    const m = buildBuildings(w.heights, b, cellOriginX(cx), cellOriginX(cz), CELL_SIZE, lod);
    if (!m) continue;
    const s = stats(flatOfPacked(m), packedKey(m));
    quality.push({ cell: c, lod, ...s, scale: m.scale, quantumMm: +(m.scale / 32767 * 1000).toFixed(2) });
  }
}
const tq = (() => {
  const tx = btx, tz = btz, cells: number[] = [];
  for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) cells.push(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j));
  const m = buildBuildings(w.heights, w.gatherBoxes(cells, true), tileOriginX(tx), tileOriginX(tz), TILE_SIZE, 2)!;
  return { tile: busiest, lod: 2, ...stats(flatOfPacked(m), packedKey(m)), scale: m.scale, quantumMm: +(m.scale / 32767 * 1000).toFixed(2) };
})();
quality.push(tq);

// ---- one building per kind (zone, floors band, function, architecture): every level on its own
const col = w.buildings.cols;
const kinds = new Map<string, number>();
for (let id = 0; id < w.buildings.end; id++) {
  if (!w.buildings.alive[id] || !col.floors[id]) continue;
  const f = col.floors[id], band = f <= 2 ? '1-2' : f <= 5 ? '3-5' : f <= 10 ? '6-10' : f <= 20 ? '11-20' : '21+';
  const arch = pickArch(col.zone[id], f, col.x[id], col.z[id], col.style[id]);
  const zname = Object.entries(Zone).find(([, v]) => v === col.zone[id])?.[0] ?? `zone${col.zone[id]}`;
  const k = `${zname} ${band}fl ${col.fn[id] ? 'fn' + col.fn[id] + ' ' : ''}${ARCHES[arch]?.name ?? 'arch' + arch}`;
  if (!kinds.has(k)) kinds.set(k, id);
}
const kindCount = new Map<string, number>();
for (let id = 0; id < w.buildings.end; id++) {
  if (!w.buildings.alive[id] || !col.floors[id]) continue;
  const f = col.floors[id], band = f <= 2 ? '1-2' : f <= 5 ? '3-5' : f <= 10 ? '6-10' : f <= 20 ? '11-20' : '21+';
  const arch = pickArch(col.zone[id], f, col.x[id], col.z[id], col.style[id]);
  const zname = Object.entries(Zone).find(([, v]) => v === col.zone[id])?.[0] ?? `zone${col.zone[id]}`;
  const k = `${zname} ${band}fl ${col.fn[id] ? 'fn' + col.fn[id] + ' ' : ''}${ARCHES[arch]?.name ?? 'arch' + arch}`;
  kindCount.set(k, (kindCount.get(k) ?? 0) + 1);
}
function single(id: number): BoxColumns {
  const b = emptyBoxes(1);
  b.x[0] = col.x[id]; b.z[0] = col.z[id]; b.w[0] = col.w[id]; b.d[0] = col.d[id]; b.h[0] = col.h[id]; b.rot[0] = col.rot[id];
  b.color[0] = col.color[id]; b.seed[0] = col.seed[id]; b.zone[0] = col.zone[id]; b.floors[0] = col.floors[id]; b.style[0] = col.style[id];
  b.fn[0] = col.fn[id]; b.shapeN[0] = col.shapeN[id]; b.built[0] = col.built[id]; b.decay[0] = col.decay[id]; b.count = 1;
  if (col.shapeN[id]) b.shape.set(w.lotShape.subarray(id * 32, (id + 1) * 32));
  return b;
}
const catalogue: unknown[] = [];
const thumbs: Parameters<typeof grid>[2] = [];
for (const [k, id] of [...kinds].sort((a, b) => (kindCount.get(b[0])! - kindCount.get(a[0])!))) {
  const b = single(id), x0 = col.x[id] - 128, z0 = col.z[id] - 128;
  const lv = [0, 1, 2, 3, -1].map((lod) => buildBuildings(w.heights, b, x0, z0, lod === 2 ? TILE_SIZE : lod === 3 ? PLATE_SIZE : CELL_SIZE, lod));
  let parts = 0, ptris = 0;
  const pk: Record<string, number> = {};
  buildBuildingParts(w.heights, b, () => {}, undefined, (kind) => { parts++; ptris += typeTris[kind] ?? 0; pk[kind] = (pk[kind] ?? 0) + 1; });
  const m0 = lv[0];
  const s0 = m0 ? stats(flatOfPacked(m0), packedKey(m0)) : null;
  const footprint = col.w[id] * col.d[id];
  catalogue.push({
    kind: k, count: kindCount.get(k), id, floors: col.floors[id], w: +col.w[id].toFixed(1), d: +col.d[id].toFixed(1),
    L0: tris(lv[0]), L1: tris(lv[1]), L2: tris(lv[2]), L3: tris(lv[3]), detail: tris(lv[4]), L0v: verts(lv[0]), L1v: verts(lv[1]), L2v: verts(lv[2]), L3v: verts(lv[3]),
    parts, partTris: ptris, partKinds: pk, footprint: +footprint.toFixed(0),
    weldable0: s0?.weldable ?? 0, tiny0: s0?.tiny ?? 0, degenerate0: s0?.degenerate ?? 0, duplicate0: s0?.duplicate ?? 0, height: s0 ? +(s0.bbox[4] - s0.bbox[1]).toFixed(1) : 0,
  });
  if (m0 && thumbs.length < 36) thumbs.push({ name: k, caption: `L0 ${tris(lv[0])} L1 ${tris(lv[1])} L2 ${tris(lv[2])} L3 ${tris(lv[3])} +${parts} PARTS`, f: flatOfPacked(m0) });
}
// sheets: the most common kinds, each level side by side for the top 4
grid(out + 'sheets/building-kinds-L0.png', 'BUILDINGS BY KIND, LEVEL 0 SHELL (CELL MESH), MOST COMMON FIRST', thumbs, 6, 220);
const top = (catalogue as Array<{ kind: string; id: number }>).slice(0, 6);
for (const t of top) {
  const b = single(t.id), x0 = col.x[t.id] - 128, z0 = col.z[t.id] - 128, slug = t.kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const items = [0, 1, 2, 3, -1].map((lod) => ({ lod, m: buildBuildings(w.heights, b, x0, z0, lod === 2 ? TILE_SIZE : lod === 3 ? PLATE_SIZE : CELL_SIZE, lod) }))
    .filter((x) => x.m).map((x) => ({ name: x.lod === -1 ? 'DETAIL LAYER' : `L${x.lod}`, caption: `${tris(x.m)} TRIANGLES ${verts(x.m)} VERTICES`, f: flatOfPacked(x.m!), wire: true }));
  grid(out + `sheets/building-levels-${slug}.png`, `${t.kind}: LEVELS (WIREFRAME)`, items, 5, 260);
}
// a whole busy cell at L0 and L1, and the busiest tile at L2
const bc = heavy[0].cell, bb = w.gatherBoxes([bc], true), bx = bc % MAP_CELLS, bz = (bc / MAP_CELLS) | 0;
for (const lod of [0, 1]) {
  const m = buildBuildings(w.heights, bb, cellOriginX(bx), cellOriginX(bz), CELL_SIZE, lod)!;
  sheet(out + `sheets/building-cell-${bc}-L${lod}.png`, `Cell ${bc} buildings, level ${lod} (one draw call)`, [`${bb.count} buildings, ${tris(m).toLocaleString('en-US')} triangles, ${verts(m).toLocaleString('en-US')} vertices, ${(bytes(m) / 1e6).toFixed(2)} MB (24 B/vertex + index)`, `drawn ${lod === 0 ? 'up to 700 m' : '700-1800 m'}; ${(tris(m) / bb.count).toFixed(0)} triangles per building`], flatOfPacked(m), { yaw: 0.7, pitch: 0.75 });
}

const sum = (rows: Array<Record<string, number>>, k: string) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const summary = {
  seed, buildings: city.buildings, segments: city.segs, growS: +(city.ms / 1000).toFixed(1), busiestTile: busiest, cellsMeasured: cellRows.length, all,
  tiles: { count: tileRows.length, triangles: sum(tileRows, 'triangles'), vertices: sum(tileRows, 'vertices'), bytes: sum(tileRows, 'bytes'), maxTriangles: Math.max(...tileRows.map((r) => r.triangles)), index32: sum(tileRows, 'index32') },
  plates: { count: plateRows.length, triangles: sum(plateRows, 'triangles'), vertices: sum(plateRows, 'vertices'), bytes: sum(plateRows, 'bytes'), maxTriangles: Math.max(...plateRows.map((r) => r.triangles)), index32: sum(plateRows, 'index32') },
  cells: {
    buildings: sum(cellRows, 'buildings'), l0t: sum(cellRows, 'l0t'), l1t: sum(cellRows, 'l1t'), dt: sum(cellRows, 'dt'), l0b: sum(cellRows, 'l0b'), l1b: sum(cellRows, 'l1b'), db: sum(cellRows, 'db'),
    l0v: sum(cellRows, 'l0v'), l1v: sum(cellRows, 'l1v'), dv: sum(cellRows, 'dv'), maxL0t: Math.max(...cellRows.map((r) => r.l0t)), parts: partInstances, partPoolTris,
    msL0: sum(cellRows, 'ms0'), msL1: sum(cellRows, 'ms1'), msDetail: sum(cellRows, 'msd'), msParts: sum(cellRows, 'msp'),
  },
  partCount, typeTris, quality, pxPerMetre: { 700: pxPerMetre(700), 1800: pxPerMetre(1800), 4200: pxPerMetre(4200) },
};
writeFileSync(out + 'data/buildings.json', JSON.stringify({ summary, tiles: tileRows, plates: plateRows, catalogue }, null, 1));
writeFileSync(out + 'data/building-cells.csv', Object.keys(cellRows[0]).join(',') + '\n' + cellRows.map((r) => Object.values(r).join(',')).join('\n') + '\n');
console.log(JSON.stringify(summary.cells), JSON.stringify(summary.tiles), JSON.stringify(summary.plates));
