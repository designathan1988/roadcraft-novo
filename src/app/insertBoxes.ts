// The buildings a tile's save holds, put back into the world (opening a map).

import { SHAPE_SCALE, SHAPE_STRIDE, type BoxColumns } from '../shared/contracts/worker.ts';
import type { World } from '../world/world.ts';

export function insertBoxes(world: World, b: BoxColumns): void {
  for (let i = 0; i < b.count; i++) {
    world.addBuilding({
      x: b.x[i], z: b.z[i], w: b.w[i], d: b.d[i], h: b.h[i], rot: b.rot[i], color: b.color[i], seed: b.seed[i], zone: b.zone[i],
      floors: b.floors[i], style: b.style[i], fn: b.fn[i], built: b.built[i],
      shape: b.shapeN[i] ? Array.from(b.shape.subarray(i * SHAPE_STRIDE, i * SHAPE_STRIDE + b.shapeN[i] * 2), (v) => v / SHAPE_SCALE) : undefined,
    });
  }
}
