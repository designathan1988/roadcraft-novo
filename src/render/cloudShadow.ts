// Shadows of the clouds on the ground, as Roadcraft 4.0's (`postprocess.ts`): each pixel's world position, from the
// depth, is carried up along the sun to the clouds; the weather's layer and the player's clouds there darken it
// (colour × 1 − strength × (1 − e^(−3 × cover))). Done once per pixel in the final image, not in every material.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';
import { CLOUD_Y, cloudsU, layerCover } from './weather.ts';

const { Fn, Loop, float, vec2, int, ivec2, textureLoad, smoothstep, length, max, step, select, exp, uniform } = T;

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

/**
 * How shadowed a world point is by the clouds (0..1, before the light's strength): `toSun` is the unit vector toward
 * the sun. The weather's layer at CLOUD_Y, and each player cloud as a soft disc at its base.
 */
export function cloudShadowAt(world: Node, toSun: Node): Node {
  // a function node: the loop and its running sum need a shader function to live in
  return cloudShadowFn(world, toSun);
}

const cloudShadowFn = Fn(([world, toSun]: [Node, Node]) => {
  const up = max(toSun.y, float(0.05));
  // the weather's layer (only below it)
  const tl = float(CLOUD_Y).sub(world.y).div(up);
  const layer = layerCover(world.xz.add(toSun.xz.mul(tl))).mul(step(world.y, float(CLOUD_Y)));
  // the player's clouds
  const through = float(0).toVar();
  Loop(MAX_CLOUDS, ({ i }: { i: Node }) => {
    const a = textureLoad(CLOUD_TEX, ivec2(int(i), int(0)));
    const b = textureLoad(CLOUD_TEX, ivec2(int(i), int(1)));
    const t = a.y.sub(world.y).div(up);
    const q = world.xz.add(toSun.xz.mul(t));
    const d = length(q.sub(vec2(a.x, a.z))).div(max(a.w, float(1)).mul(1.25));
    const on = select(float(i).lessThan(cloudCountU), float(1), float(0)).mul(step(world.y, a.y));
    through.addAssign(b.x.mul(smoothstep(1, 0.3, d)).mul(on));
  });
  return float(1).sub(exp(layer.add(through.mul(0.8)).mul(-3)));
});

/** How much of the light the clouds can take by day (overcast already dims the sun: no patches then). */
export function cloudShadowStrength(night: Node): Node {
  return float(0.55).mul(float(1).sub(night.mul(1.5)).clamp(0, 1)).mul(float(1).sub(smoothstep(0.6, 0.95, cloudsU)));
}
