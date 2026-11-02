// Shadows of the clouds on the ground, as Roadcraft 4.0's (`postprocess.ts` with `cloudShadowStamp.ts`): the
// shadow factor is BAKED into a map of the whole ground (a cell every ~40 m on the 10 km map) and the final image
// samples it bilinearly by world position - the same formula the old per-pixel path evaluated, two million times a
// screen. The clouds take seconds to cross a cell, so a few rows are baked each frame (the whole map in BAKE_FRAMES
// frames, a tenth of a second), and with no cloud in the sky none are; the factor on a pixel far above the ground reads
// the ground's cell (4.0's own map is a ground plane: the parallax inside a cloud's softness was the accepted look).

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';
import { MAP_HALF, MAP_SIZE } from '../config.ts';
import { CLOUD_Y, cloudsU, layerCover } from './weather.ts';

const { Fn, If, Loop, storage, uniform, instanceIndex, uint, int, float, vec2, vec3, ivec2, textureLoad, smoothstep, length, max, step, select, exp, fract, floor, clamp, min } = T;

/** The player's clouds (render/cloudPuffs.ts): at most this many. */
export const MAX_CLOUDS = 24;
/** Two rows per cloud: (x, base height, z, size) and (density, -, -, -). Shared by the puffs and their shadows. */
export const CLOUD_DATA = new Float32Array(MAX_CLOUDS * 2 * 4);
export const CLOUD_TEX = (() => {
  const t = new THREE.DataTexture(CLOUD_DATA, MAX_CLOUDS, 2, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
/** How many of the player's clouds there are. */
export const cloudCountU = uniform(0);

/** The map's resolution: a cell every MAP_SIZE/RES metres (40 m on the 10 km map, under a cloud's softness). */
export const CLOUD_MAP_RES = 256;
const CLOUD_MAP = new THREE.StorageBufferAttribute(CLOUD_MAP_RES * CLOUD_MAP_RES, 1);
const mapStore = storage(CLOUD_MAP, 'float', CLOUD_MAP_RES * CLOUD_MAP_RES);
const mapSunU = uniform(new THREE.Vector3(0, 1, 0));
/** Frames a whole bake is spread over, and the rows each one takes. */
const BAKE_FRAMES = 8;
const BAKE_ROWS = CLOUD_MAP_RES / BAKE_FRAMES;
/** The first row of this frame's slice. */
const rowU = uniform(0, 'uint');

/** The factor a world ground point reads: the weather's layer and each player cloud along the sun - the exact
 *  formula the per-pixel path evaluated, now per map cell. */
const mapCell = Fn(() => {
  const i = instanceIndex.add(rowU.mul(uint(CLOUD_MAP_RES)));
  If(i.lessThan(uint(CLOUD_MAP_RES * CLOUD_MAP_RES)), () => {
    const gx = i.mod(uint(CLOUD_MAP_RES)), gy = i.div(uint(CLOUD_MAP_RES));
    const world = vec3(gx.div(float(CLOUD_MAP_RES)).sub(0.5).mul(float(MAP_SIZE)), float(0), gy.div(float(CLOUD_MAP_RES)).sub(0.5).mul(float(MAP_SIZE)));
    const toSun = mapSunU;
    const up = max(toSun.y, float(0.05));
    const layer = float(0).toVar();
    If(cloudsU.greaterThan(0), () => {
      const tl = float(CLOUD_Y).sub(world.y).div(up);
      layer.assign(layerCover(world.xz.add(toSun.xz.mul(tl))).mul(step(world.y, float(CLOUD_Y))));
    });
    const through = float(0).toVar();
    If(cloudCountU.greaterThan(0), () => {
      Loop(MAX_CLOUDS, ({ i: k }: { i: Node }) => {
        const a = textureLoad(CLOUD_TEX, ivec2(int(k), int(0)));
        const b = textureLoad(CLOUD_TEX, ivec2(int(k), int(1)));
        const t = a.y.sub(world.y).div(up);
        const q = world.xz.add(toSun.xz.mul(t));
        const d = length(q.sub(vec2(a.x, a.z))).div(max(a.w, float(1)).mul(1.25));
        const on = select(float(k).lessThan(cloudCountU), float(1), float(0)).mul(step(world.y, a.y));
        through.addAssign(b.x.mul(smoothstep(1, 0.3, d)).mul(on));
      });
    });
    mapStore.element(i).assign(float(1).sub(exp(layer.add(through.mul(0.8)).mul(-3))));
  });
})().compute(BAKE_ROWS * CLOUD_MAP_RES, [64]);

/** The sky was empty for a whole bake: the map holds zeros and stays as it is while the sky stays empty. */
let bakedEmpty = false;
let bakeRow = 0;
let emptyRows = 0;

/** One slice of the bake (post's frame end: the clouds drift and the sun moves). The count is in invocations. */
export function buildCloudMap(renderer: THREE.WebGPURenderer, sun: THREE.Vector3): void {
  const empty = (cloudsU.value as number) <= 0 && (cloudCountU.value as number) <= 0;
  if (empty && bakedEmpty) return;
  (mapSunU.value as THREE.Vector3).copy(sun);
  rowU.value = bakeRow;
  renderer.compute(mapCell);
  bakeRow = (bakeRow + BAKE_ROWS) % CLOUD_MAP_RES;
  emptyRows = empty ? emptyRows + BAKE_ROWS : 0;
  bakedEmpty = emptyRows >= CLOUD_MAP_RES;
}

/** Bilinear read of the baked factor at a world ground position. */
function mapAt(worldXZ: Node): Node {
  const b = worldXZ.add(float(MAP_HALF)).div(float(MAP_SIZE)).mul(float(CLOUD_MAP_RES)).sub(0.5);
  const fx = clamp(b.x, float(0), float(CLOUD_MAP_RES - 1.001));
  const fy = clamp(b.y, float(0), float(CLOUD_MAP_RES - 1.001));
  const x0 = uint(floor(fx)), y0 = uint(floor(fy));
  const tx = fract(fx), ty = fract(fy);
  const x1 = min(x0.add(1), uint(CLOUD_MAP_RES - 1)), y1 = min(y0.add(1), uint(CLOUD_MAP_RES - 1));
  const a = mapStore.element(y0.mul(uint(CLOUD_MAP_RES)).add(x0));
  const c = mapStore.element(y0.mul(uint(CLOUD_MAP_RES)).add(x1));
  const d2 = mapStore.element(y1.mul(uint(CLOUD_MAP_RES)).add(x0));
  const e = mapStore.element(y1.mul(uint(CLOUD_MAP_RES)).add(x1));
  const top = a.mul(float(1).sub(tx)).add(c.mul(tx));
  const bottom = d2.mul(float(1).sub(tx)).add(e.mul(tx));
  return top.mul(float(1).sub(ty)).add(bottom.mul(ty));
}

/**
 * How shadowed a world point is by the clouds (0..1, before the light's strength): the baked map's factor at the
 * point's ground cell (4.0's map is a ground plane too - the accepted look). `toSun` is kept for the signature.
 */
export function cloudShadowAt(world: Node, toSun: Node): Node {
  void toSun;
  return mapAt(world.xz);
}

/** How much of the light the clouds can take by day (overcast already dims the sun: no patches then). */
export function cloudShadowStrength(night: Node): Node {
  return float(0.55).mul(float(1).sub(night.mul(1.5)).clamp(0, 1)).mul(float(1).sub(smoothstep(0.6, 0.95, cloudsU)));
}
