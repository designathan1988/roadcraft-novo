/// <reference types="node" />
// Asphalt continuity through a junction: every lane point of every approach, and the lane points a driver crosses
// through the junction, must be covered by asphalt triangles (never a hole between the segment and the junction fan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadNetwork } from '../src/roads/network.ts';
import { buildRoadMesh, RMAT } from '../src/jobs/roadMesh.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import { DASH_PERIOD, dashPhases } from '../src/roads/dash.ts';

const GROUND = 10;

interface Tri { a: [number, number]; b: [number, number]; c: [number, number] }

function mesh(w: World, net: RoadNetwork, extent = 64) {
  const segs: number[] = [], nodes: number[] = [];
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) segs.push(s);
  for (let n = 0; n < net.nodes.end; n++) if (net.nodes.alive[n]) nodes.push(n);
  const m = buildRoadMesh(w.heights, net.gather(segs, nodes), 0, 0, extent, 0)!;
  const k = m.scale / 32767, p = m.position;
  const tris: Tri[] = [];
  for (let t = 0; t < m.index.length; t += 3) {
    const i = m.index[t], j = m.index[t + 1], l = m.index[t + 2];
    const mat = m.color[i * 4 + 3] & 15;
    if (mat !== RMAT.Asphalt && mat !== RMAT.Plain) continue;
    tris.push({ a: [m.originX + p[i * 4] * k, m.originZ + p[i * 4 + 2] * k],
      b: [m.originX + p[j * 4] * k, m.originZ + p[j * 4 + 2] * k],
      c: [m.originX + p[l * 4] * k, m.originZ + p[l * 4 + 2] * k] });
  }
  return tris;
}

function inside(t: Tri, x: number, z: number): boolean {
  const d = (a: [number, number], b: [number, number], c: [number, number]) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  const ab = d([x, z], t.b, t.a), bc = d([x, z], t.c, t.b), ca = d([x, z], t.a, t.c);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

test('dashes keep their phase across a node, instead of restarting at every segment', () => {
  const g = { nodeCount: 3, segCount: 2, sa: Int32Array.of(0, 1), sb: Int32Array.of(1, 2) };
  const phase = dashPhases(g, [30, 40]);
  assert.equal(phase[0], 0);
  assert.ok(Math.abs(phase[1] - (30 % DASH_PERIOD)) < 1e-6, `phase ${phase[1]} after 30 m`);
});

test('asphalt covers every lane point across a junction (no seam between segment and fan)', () => {
  for (const profile of [0, 18]) {
    const { w, net } = (() => { const w = new World(); w.heights.fill(GROUND - 0.1); return { w, net: new RoadNetwork(w) }; })();
    const c = net.addNode({ x: 0, z: 0, y: GROUND });
    for (const [x, z] of [[70, 0], [0, 70], [-70, 0], [0, -70]]) net.addSeg({ a: c, b: net.addNode({ x, z, y: GROUND }), cx: x / 2, cz: z / 2, profile, flags: 0 });
    const tris = mesh(w, net);
    const info = PROFILE_INFO[profile];
    const lanes = [...info.fwd, ...info.back].map((l) => l.u);
    const holes: string[] = [];
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      for (let d = 3; d <= 28; d += 1) for (const u of lanes) {
        const x = dx * d - dz * u, z = dz * d + dx * u;
        if (!tris.some((t) => inside(t, x, z)) && holes.length < 12) holes.push(`${dx},${dz} d=${d} u=${u}`);
      }
    }
    assert.deepEqual(holes, [], `profile ${profile}: asphalt holes at ${holes.join('; ')}`);
  }
});
