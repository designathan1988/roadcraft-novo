/// <reference types="node" />
// Vehicles: every batch the VehicleRenderer builds (render/vehicles.ts constructor: near models, their glass, the same
// models beyond the shadow range with a blob, the middle-distance silhouettes and the scaled box), read from the
// renderer's own geometries after construction. Writes data/vehicles.json and sheets/vehicle-*.png.
import { mkdirSync, writeFileSync } from 'node:fs';
process.on('unhandledRejection', () => { /* PeopleRenderer.load() fetches files that do not exist in Node */ });
const { VehicleRenderer } = await import('../../../src/render/vehicles.ts');
const { geoStats, flatOfThree } = await import('./geom.ts');
const { sheet, grid } = await import('./raster.ts');
type Geo = import('./geom.ts').Geo;

const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true }); mkdirSync(out + 'sheets', { recursive: true });

const reader = { acquire() {}, count: 0, data: new Float32Array(0), tiled: false, tiles: new Uint32Array(0), originX: 0, originZ: 0, dt: 100, tickTime: 0 };
const vr = new VehicleRenderer(reader as never) as unknown as Record<string, unknown>;
interface Batch { mesh: { geometry: Geo & { index: unknown }; castShadow: boolean; material: { side: number; transparent: boolean } }; cap: number }
const NEAR_NAMES = ['car sedan', 'car hatch', 'car suv', 'car van', 'car pickup', 'motorbike', 'bus', 'truck', 'person (simple)', 'wagon', 'bicycle'];
const FAR_NAMES = ['car sedan', 'car hatch', 'car suv', 'car van', 'car pickup', 'motorbike', 'bus', 'truck'];
const rows: unknown[] = [];
const thumbs: Parameters<typeof grid>[2] = [];
const one = (group: string, name: string, b: Batch | null, range: string) => {
  if (!b) return;
  const g = b.mesh.geometry;
  // the InstancedBufferGeometry holds the base attributes and the per-instance ones: count only per-vertex ones
  const base = { attributes: Object.fromEntries(Object.entries(g.attributes).filter(([, a]) => !(a as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute)), index: g.index } as Geo;
  const inst = Object.entries(g.attributes).filter(([, a]) => (a as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute).map(([n, a]) => `${n}:${a.itemSize}x${a.array.constructor.name.replace('Array', '')}`);
  const s = geoStats(base);
  rows.push({ group, name, range, cap: b.cap, castShadow: b.mesh.castShadow, doubleSide: b.mesh.material.side === 2, transparent: !!b.mesh.material.transparent, perInstance: inst.join(' '), ...s, capBytes: b.cap * 48 });
  thumbs.push({ name: `${group}: ${name}`, caption: `${s.triangles}T ${s.indexed ? 'IDX' : 'NOIDX'} ${s.bytesPerVertex}B/V`, f: flatOfThree(base) });
};
(vr.near as Batch[]).forEach((b, i) => one('near (0-90 m, shadows)', NEAR_NAMES[i], b, '0-90 m with shadow (people to 70 m)'));
(vr.nearGlass as Array<Batch | null>).forEach((b, i) => one('near glass', FAR_NAMES[i], b, '0-90 m'));
(vr.nearFar as Batch[]).forEach((b, i) => one('near, no shadow + blob', FAR_NAMES[i], b, '90-200 m'));
one('mid', 'scaled box (bus, truck, people, bikes)', vr.mid as Batch, '200-1700 m');
(vr.midCars as Batch[]).forEach((b, i) => one('mid cars', FAR_NAMES[i], b, '200-1700 m'));
writeFileSync(out + 'data/vehicles.json', JSON.stringify({ rows, wreckModels: (vr.wreckModels as Geo[]).map((g, i) => ({ i, ...geoStats(g) })) }, null, 1));
grid(out + 'sheets/vehicles-batches.png', 'VEHICLE RENDERER BATCHES (ONE INSTANCED DRAW EACH), BASE MESH PER INSTANCE', thumbs, 6, 220);
const nb = vr.near as Batch[];
for (const [i, n] of [[0, 'sedan'], [6, 'bus'], [7, 'truck'], [5, 'motorbike']] as const) {
  const g = nb[i].mesh.geometry, base = { attributes: Object.fromEntries(Object.entries(g.attributes).filter(([, a]) => !(a as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute)), index: g.index } as Geo;
  const s = geoStats(base);
  sheet(out + `sheets/vehicle-near-${n}.png`, `Moving ${n}, near model (to 200 m, shadow to 90 m)`, [`${s.triangles} triangles, ${s.vertices} vertices (${s.indexed ? 'indexed' : 'not indexed'}), ${s.bytesPerVertex} B/vertex: ${s.layout}`.slice(0, 80), `weldable ${s.weldable} (${(100 * s.weldable / s.vertices).toFixed(0)}%), degenerate ${s.degenerate}, tiny ${s.tiny}, duplicate ${s.duplicate}`], flatOfThree(base));
}
console.log(rows.length, 'batches');
