// Pool worker: receives jobs, returns transferred buffers.

import { setCustomProfiles } from '../roads/profiles.ts';
import { NO_WATER, WATER_TILE_RES } from '../world/ground.ts';
import type { FromWorker, JobKind, JobPayloads, JobResults, ToWorker } from './protocol.ts';
import { boxTransfer, lotTransfer, meshTransfer, propTransfer } from './protocol.ts';
import { generateTerrainTile } from './terrainGen.ts';
import { conformTileToGrid, debugTileRoads } from './debugCity.ts';
import { buildBuildings } from './buildingGen.ts';
import { buildRoadMesh } from './roadMesh.ts';
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
  terrainGen: (p) => [{ tile: p.tile, ...generateTerrainTile(H(), p.tile, p.seed) }, []],
  debugTile: (p) => {
    const mm = conformTileToGrid(H(), p.tile, p.seed);
    const roads = debugTileRoads(p.tile, p.seed);
    return [{ tile: p.tile, roadNodes: roads.nodes, roadSegs: roads.segs, ...mm },
      [roads.nodes.buffer as ArrayBuffer, roads.segs.buffer as ArrayBuffer]];
  },
  buildingMesh: (p) => {
    const mesh = buildBuildings(H(), p.boxes, p.originX, p.originZ, p.extent, p.lod);
    return [{ mesh }, mesh ? meshTransfer(mesh) : []];
  },
  roadMesh: (p) => {
    const mesh = buildRoadMesh(H(), p.graph, p.originX, p.originZ, p.extent, p.lod);
    return [{ mesh }, mesh ? meshTransfer(mesh) : []];
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
    const props = buildProps(H(), p.graph, p.boxes, p.cell, p.items, { ground: ground ?? undefined, water: water ?? undefined, biome: p.biome });
    return [{ cell: p.cell, props }, propTransfer(props)];
  },
  cityGen: (p) => {
    const r = generateCity(p.seed);
    return [r, [r.nodes.buffer as ArrayBuffer, r.segs.buffer as ArrayBuffer, r.centers.buffer as ArrayBuffer]];
  },
  conform: (p) => [{ tile: p.tile, ...conformTile(H(), p.tile, p.segs) }, []],
  saveTile: async (p) => {
    // tile ground and water read straight from shared memory
    const gl = WATER_TILE_RES * WATER_TILE_RES, wl = gl;
    const g = ground ? ground.slice(p.tile * gl, (p.tile + 1) * gl) : undefined;
    const w = water ? water.slice(p.tile * wl, (p.tile + 1) * wl) : undefined;
    return [{ tile: p.tile, bytes: await storage.saveTile(p.slot, p.tile, p.heights, p.boxes, p.roads, g, w) }, []];
  },
  saveMeta: async (p) => [{ bytes: await storage.saveMeta(p.slot, p.meta) }, []],
  loadTile: async (p) => {
    const t = await storage.loadTile(p.slot, p.tile);
    if (!t) return [{ tile: p.tile, found: false, min: 0, max: 0, boxes: null, roads: null }, []];
    const mm = storage.unpackTileHeights(H(), p.tile, t.heights);
    let hasWater = false;
    if (t.ground && ground && t.ground.length === WATER_TILE_RES * WATER_TILE_RES) ground.set(t.ground, p.tile * t.ground.length);
    if (t.water && water && t.water.length === WATER_TILE_RES * WATER_TILE_RES) {
      water.set(t.water, p.tile * t.water.length);
      for (let i = 0; i < t.water.length && !hasWater; i++) if (t.water[i] !== NO_WATER) hasWater = true;
    }
    return [{ tile: p.tile, found: true, ...mm, boxes: t.boxes, roads: t.roads, hasWater },
      [...boxTransfer(t.boxes), t.roads.nodes.buffer as ArrayBuffer, t.roads.segs.buffer as ArrayBuffer, ...(t.roads.items ? [t.roads.items.buffer as ArrayBuffer] : [])]];
  },
  loadMeta: async (p) => {
    const meta = await storage.loadMeta(p.slot);
    return [{ meta }, meta ? [meta.buffer as ArrayBuffer] : []];
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
