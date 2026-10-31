// Pool worker: receives jobs, returns transferred buffers.

import { setCustomProfiles } from '../roads/profiles.ts';
import { CELL_SIZE, HEIGHT_TILE_RES } from '../config.ts';
import { NO_WATER, WATER_TILE_RES } from '../world/ground.ts';
import type { FromWorker, JobKind, JobPayloads, JobResults, ToWorker } from '../shared/contracts/worker.ts';
import { boxTransfer, lotTransfer, meshTransfer, propTransfer } from '../shared/contracts/worker.ts';
import { generateTerrainTile } from './terrainGen.ts';
import { conformTileToGrid, debugTileRoads } from './debugCity.ts';
import { buildBuildings } from './buildingGen.ts';
import { newOutputs } from './buildingGen/outputs.ts';
import { buildRoadMesh } from './roadMesh.ts';
import { buildTerrainSeams } from './terrainSeams.ts';
import { coarsen, paintRoadTile } from './roadPaint.ts';
import { buildLots } from './lots.ts';
import { buildProps } from './props.ts';
import { generateCity } from './cityGen.ts';
import { conformTile } from './conform.ts';
import * as storage from './storage.ts';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let heights: Float32Array | null = null;
let ground: Uint32Array | null = null;
let water: Float32Array | null = null;

type Handler<K extends JobKind> = (p: JobPayloads[K]) => Promise<[JobResults[K], Transferable[]]> | [JobResults[K], Transferable[]];

const H = (): Float32Array => {
  if (!heights) throw new Error('worker not initialized');
  return heights;
};

const handlers: { [K in JobKind]: Handler<K> } = {
  terrainGen: (p) => [{ tile: p.tile, ...generateTerrainTile(H(), p.tile, p.seed, water ?? undefined) }, []],
  debugTile: (p) => {
    const mm = conformTileToGrid(H(), p.tile, p.seed);
    const roads = debugTileRoads(p.tile, p.seed);
    return [{ tile: p.tile, roadNodes: roads.nodes, roadSegs: roads.segs, ...mm },
      [roads.nodes.buffer as ArrayBuffer, roads.segs.buffer as ArrayBuffer]];
  },
  buildingMesh: (p) => {
    // with the mesh, the height each building's walls were built to (the page keeps it: no generating there)
    const top = new Float32Array(p.boxes.count);
    const mesh = buildBuildings(H(), p.boxes, p.originX, p.originZ, p.extent, p.lod, false, newOutputs({ tops: top }));
    return [{ mesh, built: { id: p.boxes.id, top } }, [...(mesh ? meshTransfer(mesh) : []), top.buffer as ArrayBuffer, p.boxes.id.buffer as ArrayBuffer]];
  },
  roadMesh: (p) => {
    const mesh = buildRoadMesh(H(), p.graph, p.originX, p.originZ, p.extent, p.lod);
    return [{ mesh }, mesh ? meshTransfer(mesh) : []];
  },
  terrainSeams: (p) => {
    // the roads' own lod 0 surfaces round the cell, packed as the road layer packs a cell's (render/roads.ts: same
    // origin and extent, so the same quantised edge), then the cut
    const road = buildRoadMesh(H(), p.graph, p.originX, p.originZ, CELL_SIZE * 2, 0);
    const r = buildTerrainSeams(H(), road, p.originX, p.originZ);
    return [r, [...(r.mesh ? meshTransfer(r.mesh) : []), r.holes.buffer as ArrayBuffer]];
  },
  roadPaint: (p) => {
    const texels = paintRoadTile(H(), p.graph, p.tile);
    const coarse = coarsen(texels);
    return [{ tile: p.tile, texels, coarse }, [texels.buffer as ArrayBuffer, coarse.buffer as ArrayBuffer]];
  },
  lots: (p) => {
    const lots = buildLots(H(), p.graph, p.cell, water ?? undefined);
    return [{ cell: p.cell, lots }, lotTransfer(lots)];
  },
  props: (p) => {
    const props = buildProps(H(), p.graph, p.boxes, p.cell, p.items, { ground: ground ?? undefined, water: water ?? undefined, biome: p.biome, parts40: p.parts40 });
    return [{ cell: p.cell, props }, propTransfer(props)];
  },
  cityGen: (p) => {
    const r = generateCity(p.seed, p.medium);
    return [r, [r.nodes.buffer as ArrayBuffer, r.segs.buffer as ArrayBuffer, r.centers.buffer as ArrayBuffer]];
  },
  conform: (p) => [{ tile: p.tile, ...conformTile(H(), p.tile, p.segs) }, []],
  packTile: async (p) => {
    // the ground and water the page copied with the rest of the snapshot (read here only if it sent none)
    const gl = WATER_TILE_RES * WATER_TILE_RES, wl = gl;
    const g = p.ground ?? (ground ? ground.slice(p.tile * gl, (p.tile + 1) * gl) : undefined);
    const w = p.water ?? (water ? water.slice(p.tile * wl, (p.tile + 1) * wl) : undefined);
    const data = await storage.compress(storage.encodeTile(p.tile, p.heights, p.boxes, p.roads, g, w));
    return [{ tile: p.tile, data, hash: await storage.sha256(data) }, [data.buffer as ArrayBuffer]];
  },
  unpackTile: async (p) => {
    const hash = await storage.sha256(p.data);
    // a file that cannot be used is reported (the page decides what to do), and nothing of it is written
    const refuse = (reason: string): [JobResults['unpackTile'], Transferable[]] => [{ tile: p.tile, ok: false, reason, hash, min: 0, max: 0, boxes: null, roads: null }, []];
    if (p.hash && hash !== p.hash) return refuse('its contents do not match the save (damaged)');
    let t: ReturnType<typeof storage.decodeTile>;
    try { t = storage.decodeTile(await storage.decompress(p.data)); } catch (err) { return refuse(`it cannot be decoded (${err instanceof Error ? err.message : String(err)})`); }
    if (t.tile !== p.tile) return refuse(`it holds tile ${t.tile}`);
    if (t.heights.length !== HEIGHT_TILE_RES * HEIGHT_TILE_RES) return refuse(`it holds ${t.heights.length} heights`);
    const mm = storage.unpackTileHeights(H(), p.tile, t.heights);
    let hasWater = false;
    if (t.ground && ground && t.ground.length === WATER_TILE_RES * WATER_TILE_RES) ground.set(t.ground, p.tile * t.ground.length);
    if (t.water && water && t.water.length === WATER_TILE_RES * WATER_TILE_RES) {
      water.set(t.water, p.tile * t.water.length);
      for (let i = 0; i < t.water.length && !hasWater; i++) if (t.water[i] !== NO_WATER) hasWater = true;
    }
    return [{ tile: p.tile, ok: true, hash, ...mm, boxes: t.boxes, roads: t.roads, hasWater },
      [...boxTransfer(t.boxes), t.roads.nodes.buffer as ArrayBuffer, t.roads.segs.buffer as ArrayBuffer, ...(t.roads.items ? [t.roads.items.buffer as ArrayBuffer] : [])]];
  },
};

scope.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    heights = new Float32Array(msg.shared.heights);
    ground = new Uint32Array(msg.shared.ground);
    water = new Float32Array(msg.shared.water);
    return;
  }
  if (msg.type === 'profiles') { setCustomProfiles(msg.list); return; }
  try {
    const h = handlers[msg.kind] as Handler<JobKind>;
    const [result, transfer] = await h(msg.payload as never);
    scope.postMessage({ type: 'done', id: msg.id, result }, transfer);
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
