/// <reference types="node" />
// For the pooled 4.0 parts of the types with variants: the kind (mesh) the cull pass files an instance under, from
// (pose.w >> 12) & 15 (render/props.ts classify), against the kind of its own variant (key bits 24-26, the vertex
// shader's partVariant). Uses the props job's own packing (jobs/props.ts:467 partW / partKey).
import { World } from '../../../src/world/world.ts';
import { emptyBoxes } from '../../../src/shared/contracts/worker.ts';
import { buildBuildingParts } from '../../../src/jobs/buildingGen.ts';
import { POOL_PARTS, VARIANT_TYPES, partW, partKey } from '../../../src/jobs/parts40.ts';
import { propKindTable } from '../../../src/render/propMeshes.ts';
import { Zone } from '../../../src/roads/zones.ts';
const { kindOf } = propKindTable();
const w = new World(); w.heights.fill(10);
let same = 0, other = 0; const byKind: Record<string, [number, number]> = {};
for (let s = 1; s <= 40; s++) for (const [zone, floors, bw, bd] of [[Zone.Residential, 1, 16, 30], [Zone.Residential, 4, 14, 30], [Zone.Mixed, 8, 15, 25], [Zone.Commercial, 3, 18, 30]] as const) {
  const b = emptyBoxes(1); b.x[0] = 128; b.z[0] = 128; b.w[0] = bw; b.d[0] = bd; b.zone[0] = zone; b.floors[0] = floors; b.seed[0] = s * 7919; b.style[0] = s % 12; b.count = 1;
  buildBuildingParts(w.heights, b, () => {}, undefined, (kind, x, y, z, yaw, sx, sy, sz, rgb) => {
    const tv = POOL_PARTS[kind]; if (!tv || !VARIANT_TYPES.has(tv[0])) return;
    const pw = partW(yaw, rgb), key = partKey(tv[0], sx, sy, sz, tv[1]);
    const culled = kindOf[tv[0] * 16 + ((pw >>> 12) & 15)], own = kindOf[tv[0] * 16 + ((key >>> 24) & 7)];
    const e = (byKind[kind] ??= [0, 0]);
    if (culled === own) { same++; e[0]++; } else { other++; e[1]++; }
  });
}
console.log(`instances filed under their own variant's mesh: ${same}; under another variant's mesh: ${other} (${(100 * other / (same + other)).toFixed(1)}%)`);
console.log(JSON.stringify(byKind));
