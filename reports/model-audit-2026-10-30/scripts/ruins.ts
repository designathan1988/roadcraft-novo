/// <reference types="node" />
// Demolition: a building's ruin as the ruin worker makes it (features/demolition/ruin/worker.ts: buildingForRuin, then
// fractureBuilding), for buildings of the common kinds on flat ground; and the debris shapes (blast/debris.ts) are read
// from the code (see demolition.md). Writes data/ruins.json and sheets/ruin-*.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { World } from '../../../src/world/world.ts';
import { emptyBoxes } from '../../../src/shared/contracts/worker.ts';
import { buildingForRuin, buildBuildings } from '../../../src/jobs/buildingGen.ts';
import { fractureBuilding, gather, type Attached } from '../../../src/features/demolition/ruin/fracture.ts';
import { Zone } from '../../../src/roads/zones.ts';
import { stats } from './geom.ts';
import { sheet } from './raster.ts';

const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true }); mkdirSync(out + 'sheets', { recursive: true });
const w = new World(); w.heights.fill(10);
const CASES: Array<[string, number, number, number, number]> = [
  ['house 2 floors', Zone.Residential, 2, 16, 18], ['apartments 4 floors', Zone.Residential, 4, 14, 30], ['mixed 8 floors', Zone.Mixed, 8, 15, 30],
  ['commercial 16 floors', Zone.Commercial, 16, 27, 17], ['commercial 30 floors', Zone.Commercial, 30, 22, 36],
];
const rows: unknown[] = [];
for (const [name, zone, floors, bw, bd] of CASES) {
  const b = emptyBoxes(1);
  b.x[0] = 128; b.z[0] = 128; b.w[0] = bw; b.d[0] = bd; b.zone[0] = zone; b.floors[0] = floors; b.seed[0] = 1234 + floors; b.style[0] = 3; b.count = 1;
  const shell = buildBuildings(w.heights, b, 0, 0, 256, 0);
  const att: Attached = { kinds: [], rows: [] };
  const t0 = performance.now();
  const mb = buildingForRuin(w.heights, b, 0, gather(att));
  const r = fractureBuilding(mb, b.seed[0], 0, att);
  const ms = performance.now() - t0;
  if (!r) { rows.push({ name, ruin: null }); continue; }
  const n = r.position.length / 4, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos.set(r.position.subarray(i * 4, i * 4 + 3), i * 3); col[i * 3] = r.color[i * 4] / 255; col[i * 3 + 1] = r.color[i * 4 + 1] / 255; col[i * 3 + 2] = r.color[i * 4 + 2] / 255; }
  const s = stats({ pos, index: null, col });
  const attachedN = r.attached.length / 11;
  rows.push({ name, floors, shellTrisL0: shell ? shell.index.length / 3 : 0, ruinVertices: n, ruinTriangles: n / 3, indexed: false, bytesPerVertex: 16 + 4 + 4 + 4 + 4 + 4, ruinKB: Math.round(n * 36 / 1024), fragments: r.fragmentCount, attachedInstances: attachedN, kinds: r.kinds.length, weldable: s.weldable, tiny: s.tiny, ms: Math.round(ms) });
  sheet(out + `sheets/ruin-${name.replace(/\s+/g, '-')}.png`, `Ruin of a ${name} (fractured shell, before it falls)`, [`${(n / 3).toLocaleString('en-US')} triangles, ${n.toLocaleString('en-US')} vertices, not indexed, 36 B/vertex; ${r.fragmentCount} fragments; ${attachedN} attached part instances`, `intact level-0 shell: ${shell ? (shell.index.length / 3).toLocaleString('en-US') : 0} triangles; fracture took ${Math.round(ms)} ms in Node`], { pos, index: null, col });
}
writeFileSync(out + 'data/ruins.json', JSON.stringify(rows, null, 1));
console.log(JSON.stringify(rows, null, 1));
