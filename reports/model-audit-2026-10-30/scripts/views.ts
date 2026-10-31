/// <reference types="node" />
// A model of what the five budget views (tools/budget.mjs VIEWS, ?cidade&mapa=10 = seed 1, classic) submit, built
// from the game's own mesh builders in Node: which cell / tile / plate meshes each layer draws (render/cellLayer.ts
// rules: buildings near 1800, L0 to 700, plates past 4200; roads L0 to 600, cells to 1400, tiles to 5500; the detail
// layer to 150 m), the terrain's CDLOD patches (render/terrain.ts select, ranges 128 * 2^l * 5) and the props pool's
// instances per kind and level (render/props.ts bands, radius test) — the main view only, frustum-culled by mesh box.
// It does not model shadow passes, vehicles, people, particles, sky or post: the budget's triangles include those.
// Writes data/views.json and data/layers-seed1.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { growCity } from './city.ts';
import { buildBuildings } from '../../../src/jobs/buildingGen.ts';
import { buildRoadMesh } from '../../../src/jobs/roadMesh.ts';
import { buildProps } from '../../../src/jobs/props.ts';
import { buildPropDefs, buildPropKinds } from '../../../src/render/propMeshes.ts';
import { CELL_SIZE, CELLS_PER_TILE, MAP_CELLS, MAP_HALF, MAP_PLATES, MAP_TILES, PLATE_SIZE, TILE_SIZE } from '../../../src/config.ts';
import { cellId, cellOriginX, tileOriginX } from '../../../src/core/grid.ts';
import { heightAt } from '../../../src/world/heights.ts';
import { PARTS_RANGE } from '../../../src/jobs/parts40.ts';
import type { PackedMesh } from '../../../src/shared/contracts/worker.ts';

const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true });
const seed = Number(process.argv[2] ?? 1);
const city = growCity(seed, 'classic');
const w = city.w;
console.log(`seed ${seed}: ${city.buildings} buildings, ${city.segs} segments (${(city.ms / 1000).toFixed(0)} s)`);

const VIEWS = [
  { name: 'street', yaw: 35, pitch: 18, dist: 90 },
  { name: 'district', yaw: 35, pitch: 50, dist: 420 },
  { name: 'city', yaw: 35, pitch: 45, dist: 2200 },
  { name: 'map', yaw: 0, pitch: 75, dist: 11000 },
];

const tri = (m: PackedMesh | null) => (m ? m.index.length / 3 : 0);
const cache = new Map<string, PackedMesh | null>();
const get = (key: string, make: () => PackedMesh | null) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key)!; };
const cellsOfTile = (t: number) => { const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0, o: number[] = []; for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) o.push(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j)); return o; };
const bCell = (c: number, lod: number) => get(`b${lod}:${c}`, () => { const b = w.gatherBoxes([c], true); return b.count ? buildBuildings(w.heights, b, cellOriginX(c % MAP_CELLS), cellOriginX((c / MAP_CELLS) | 0), CELL_SIZE, lod) : null; });
const bTile = (t: number) => get(`bt:${t}`, () => { const b = w.gatherBoxes(cellsOfTile(t), true); return b.count ? buildBuildings(w.heights, b, tileOriginX(t % MAP_TILES), tileOriginX((t / MAP_TILES) | 0), TILE_SIZE, 2) : null; });
const per = PLATE_SIZE / TILE_SIZE * CELLS_PER_TILE;
const bPlate = (p: number) => get(`bp:${p}`, () => {
  const px = p % MAP_PLATES, pz = (p / MAP_PLATES) | 0, cells: number[] = [];
  for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) { const ci = px * per + i, cj = pz * per + j; if (ci < MAP_CELLS && cj < MAP_CELLS) cells.push(cellId(ci, cj)); }
  const b = w.gatherBoxes(cells, true);
  return b.count ? buildBuildings(w.heights, b, cellOriginX(px * per), cellOriginX(pz * per), PLATE_SIZE, 3) : null;
});
const net = w.roads;
const rCell = (c: number, lod: number) => get(`r${lod}:${c}`, () => {
  if (!net.cellCount[c]) return null;
  const segs: number[] = [], nodes: number[] = []; net.cellContents(c, segs, nodes);
  return buildRoadMesh(w.heights, net.gather(segs, nodes), cellOriginX(c % MAP_CELLS), cellOriginX((c / MAP_CELLS) | 0), 512, lod);
});
const rTile = (t: number) => get(`rt:${t}`, () => {
  const segs: number[] = [], nodes: number[] = [];
  for (const c of cellsOfTile(t)) net.cellContents(c, segs, nodes);
  if (!segs.length && !nodes.length) return null;
  return buildRoadMesh(w.heights, net.gather(segs, nodes), tileOriginX(t % MAP_TILES), tileOriginX((t / MAP_TILES) | 0), 2048, 1);
});

// props: kinds and their triangles per level
const kinds = buildPropKinds(buildPropDefs());
const kTris = kinds.kinds.map((k) => k.lods.map((g) => (g ? g.attributes.position.count / 3 : 0)));
const propCells = new Map<number, ReturnType<typeof buildProps>>();
const propsOf = (c: number, parts: boolean) => {
  const key = c * 2 + (parts ? 1 : 0);
  if (!propCells.has(key)) {
    const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0), segs: number[] = [];
    net.forSegsNear(x0 - 40, z0 - 40, x0 + 296, z0 + 296, (s) => segs.push(s));
    propCells.set(key, buildProps(w.heights, net.gather(segs, []), w.gatherBoxes([c], true), c, w.items.gather(c, MAP_CELLS), { ground: w.ground32, water: w.water, biome: w.biome, parts40: parts }));
  }
  return propCells.get(key)!;
};

const box = new THREE.Box3(), sphere = new THREE.Sphere(), frustum = new THREE.Frustum();
const results: unknown[] = [];
for (const v of VIEWS) {
  const t0 = performance.now();
  const ty = heightAt(w.heights, 0, 0), yaw = v.yaw * Math.PI / 180, pitch = v.pitch * Math.PI / 180;
  const eye = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * v.dist, ty + Math.sin(pitch) * v.dist, Math.cos(yaw) * Math.cos(pitch) * v.dist);
  const cam = new THREE.PerspectiveCamera(45, 1920 / 1080, 0.2, 60000);
  cam.position.copy(eye); cam.lookAt(0, ty, 0); cam.updateMatrixWorld();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const hdist = (x: number, z: number, s: number) => Math.hypot(Math.max(x - eye.x, 0, eye.x - x - s), Math.max(z - eye.z, 0, eye.z - z - s));
  const d3 = (x: number, z: number, s: number) => { const h = hdist(x, z, s); return Math.hypot(h, Math.max(0, eye.y - ty - 60)); };
  const inView = (x: number, z: number, s: number, y0 = -100, y1 = 700) => { box.min.set(x - 40, y0, z - 40); box.max.set(x + s + 40, y1, z + s + 40); return frustum.intersectsBox(box); };
  const L: Record<string, { draws: number; tris: number }> = {};
  const add = (k: string, m: PackedMesh | null) => { if (!m) return; (L[k] ??= { draws: 0, tris: 0 }); L[k].draws++; L[k].tris += tri(m); };
  // buildings (render/city.ts: near 1800, detail 700, plate 4200); distances by eye height like the layer (eyeHeight)
  for (let p = 0; p < MAP_PLATES * MAP_PLATES; p++) {
    const px = p % MAP_PLATES, pz = (p / MAP_PLATES) | 0, x0 = -MAP_HALF + px * PLATE_SIZE, z0 = -MAP_HALF + pz * PLATE_SIZE;
    if (!inView(x0, z0, PLATE_SIZE)) continue;
    if (d3(x0, z0, PLATE_SIZE) > 4200) { add('buildings L3 plate', bPlate(p)); continue; }
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const tx = px * 2 + i, tz = pz * 2 + j; if (tx >= MAP_TILES || tz >= MAP_TILES) continue;
      const t = tz * MAP_TILES + tx, ox = tileOriginX(tx), oz = tileOriginX(tz);
      if (!inView(ox, oz, TILE_SIZE)) continue;
      if (d3(ox, oz, TILE_SIZE) > 1800) { add('buildings L2 tile', bTile(t)); continue; }
      for (const c of cellsOfTile(t)) {
        const cx = cellOriginX(c % MAP_CELLS), cz = cellOriginX((c / MAP_CELLS) | 0);
        if (!w.cellBuildings[c] || !inView(cx, cz, CELL_SIZE)) continue;
        const d = d3(cx, cz, CELL_SIZE);
        add(d < 700 ? 'buildings L0 cell' : 'buildings L1 cell', bCell(c, d < 700 ? 0 : 1));
        if (d < 150) add('building detail L-1 cell', bCell(c, -1));
      }
    }
  }
  // roads (render/roads.ts: near 1400, detail 600, far 5500; no plates)
  for (let t = 0; t < MAP_TILES * MAP_TILES; t++) {
    const ox = tileOriginX(t % MAP_TILES), oz = tileOriginX((t / MAP_TILES) | 0);
    if (!inView(ox, oz, TILE_SIZE) || hdist(ox, oz, TILE_SIZE) > 5500) continue;
    if (hdist(ox, oz, TILE_SIZE) > 1400) { add('roads tile (lod 1)', rTile(t)); continue; }
    for (const c of cellsOfTile(t)) {
      const cx = cellOriginX(c % MAP_CELLS), cz = cellOriginX((c / MAP_CELLS) | 0);
      if (!inView(cx, cz, CELL_SIZE)) continue;
      const d = hdist(cx, cz, CELL_SIZE);
      add(d < 600 ? 'roads L0 cell' : 'roads L1 cell', rCell(c, d < 600 ? 0 : 1));
    }
  }
  // terrain CDLOD (render/terrain.ts select): 32 x 32 patch = 2048 triangles each
  let patches = 0;
  const ranges = Array.from({ length: 6 }, (_, l) => 128 * (1 << l) * 5);
  const bounds = (x: number, z: number, s: number) => { box.min.set(x, -50, z); box.max.set(Math.min(x + s, MAP_HALF), 450, Math.min(z + s, MAP_HALF)); return box; };
  const sel = (x: number, z: number, s: number, l: number): boolean => {
    if (x >= MAP_HALF || z >= MAP_HALF) return true;
    const b = bounds(x, z, s), d = b.distanceToPoint(eye);
    if (d > ranges[l]) return false;
    if (!frustum.intersectsBox(b)) return true;
    if (l === 0 || d > ranges[l - 1]) { patches++; return true; }
    const h = s / 2;
    for (let k = 0; k < 4; k++) { const cx = x + (k & 1 ? h : 0), cz = z + (k & 2 ? h : 0); if (!sel(cx, cz, h, l - 1) && frustum.intersectsBox(bounds(cx, cz, h))) patches++; }
    return true;
  };
  for (let rz = 0; rz < MAP_PLATES; rz++) for (let rx = 0; rx < MAP_PLATES; rx++) { const x = rx * PLATE_SIZE - MAP_HALF, z = rz * PLATE_SIZE - MAP_HALF; if (!sel(x, z, PLATE_SIZE, 4) && frustum.intersectsBox(bounds(x, z, PLATE_SIZE))) patches++; }
  L['terrain patches'] = { draws: 1, tris: patches * 2048 };
  const eyeAbove = eye.y - ty;
  if (eyeAbove < 140) L['grass tufts'] = { draws: 1, tris: 160 * 160 * 7 };
  // props: resident within reach (3600) + 256; parts within PARTS_RANGE; per instance its kind's level by distance
  const kindLevelTris = new Float64Array(kinds.kinds.length * 3);
  const kindLevelN = new Uint32Array(kinds.kinds.length * 3);
  let propCellsN = 0, instances = 0;
  for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
    const cx = cellOriginX(c % MAP_CELLS), cz = cellOriginX((c / MAP_CELLS) | 0), d = hdist(cx, cz, CELL_SIZE);
    if (d > 3600 + 256 || !inView(cx, cz, CELL_SIZE)) continue;
    const p = propsOf(c, d < PARTS_RANGE);
    propCellsN++; instances += p.count;
    for (let i = 0; i < p.count; i++) {
      const type = p.extra[i] & 31; if (type >= 31) continue;
      const pw = p.data[i * 4 + 3], variant = (pw >>> 12) & 15, k = kinds.kindOf[type * 16 + variant], kind = kinds.kinds[k];
      const x = p.data[i * 4], y = p.data[i * 4 + 1], z = p.data[i * 4 + 2];
      const dd = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
      let lvl = -1;
      for (let l = 0; l < 3; l++) if (kind.lods[l] && kind.dist[l] > 0 && dd < kind.dist[l] && (l === 0 || dd >= kind.dist[l - 1])) { lvl = l; break; }
      if (lvl < 0) continue;
      sphere.center.set(x, y, z); sphere.radius = Math.max(1, kind.radius * 2);
      if (!frustum.intersectsSphere(sphere)) continue;
      kindLevelN[k * 3 + lvl]++; kindLevelTris[k * 3 + lvl] += kTris[k][lvl];
    }
  }
  const byType: Record<string, { instances: number; tris: number; draws: number }> = {};
  for (let k = 0; k < kinds.kinds.length; k++) for (let l = 0; l < 3; l++) {
    if (!kindLevelN[k * 3 + l]) continue;
    const name = `props ${kinds.kinds[k].type >= 24 ? 'building parts' : 'street/vegetation'}`;
    (byType[name] ??= { instances: 0, tris: 0, draws: 0 });
    byType[name].instances += kindLevelN[k * 3 + l]; byType[name].tris += kindLevelTris[k * 3 + l]; byType[name].draws++;
  }
  for (const [k, s] of Object.entries(byType)) L[k] = { draws: s.draws, tris: s.tris };
  const topKinds = [...Array(kinds.kinds.length * 3).keys()].filter((i) => kindLevelN[i]).sort((a, b) => kindLevelTris[b] - kindLevelTris[a]).slice(0, 15)
    .map((i) => ({ kind: Math.floor(i / 3), type: kinds.kinds[Math.floor(i / 3)].type, level: i % 3, instances: kindLevelN[i], tris: kindLevelTris[i], trisEach: kTris[Math.floor(i / 3)][i % 3] }));
  const total = Object.values(L).reduce((s, x) => ({ draws: s.draws + x.draws, tris: s.tris + x.tris }), { draws: 0, tris: 0 });
  results.push({ view: v.name, eye: eye.toArray().map((x) => +x.toFixed(1)), layers: L, total, propCells: propCellsN, propInstancesResidentInView: instances, topKinds, s: +((performance.now() - t0) / 1000).toFixed(1) });
  console.log(v.name, JSON.stringify(total), JSON.stringify(L));
}
writeFileSync(out + 'data/views.json', JSON.stringify({ seed, buildings: city.buildings, segments: city.segs, views: results }, null, 1));
