/// <reference types="node" />
// Kerbs and medians at Roadcraft 4.0's heights (render/roadSurfaceReads.ts, world/roadTypes.ts): the footway at 15 cm,
// its kerb stone 1 cm proud of it (16 cm); a median's kerb at 15 cm and its planting 2 cm over it (17 cm). The kerb
// stone runs round the junction corners, and a corner's footway keeps its width all the way round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadNetwork } from '../src/roads/network.ts';
import { buildRoadMesh, RMAT } from '../src/jobs/roadMesh.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import type { NodeId, SegId } from '../src/core/ids.ts';
import { asNode, asSeg } from '../src/core/ids.ts';

const GROUND = 10;

interface V { x: number; y: number; z: number; mat: number; u: number; junction: boolean }

/** The road mesh of every segment and node of `net`, decoded (heights above the flat ground). */
function mesh(w: World, net: RoadNetwork): V[] {
  const segs: SegId[] = [], nodes: NodeId[] = [];
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) segs.push(asSeg(s));
  for (let n = 0; n < net.nodes.end; n++) if (net.nodes.alive[n]) nodes.push(asNode(n));
  // a small extent: the packing doubles it to fit, keeping a fine step (≤ 0.4 cm for these meshes)
  const m = buildRoadMesh(w.heights, net.gather(segs, nodes), 0, 0, 16, 0)!;
  const k = m.scale / 32767, out: V[] = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const e = m.extra!;
    out.push({
      x: m.originX + m.position[i * 4] * k, y: m.originY + m.position[i * 4 + 1] * k - GROUND, z: m.originZ + m.position[i * 4 + 2] * k,
      mat: m.color[i * 4 + 3], u: e[i * 4], junction: e[i * 4 + 1] === 0 && e[i * 4 + 2] === 0,
    });
  }
  return out;
}

function flatWorld(): { w: World; net: RoadNetwork } {
  const w = new World();
  w.heights.fill(GROUND - 0.1);
  return { w, net: new RoadNetwork(w) };
}

const top = (vs: V[]) => Math.max(...vs.map((v) => v.y));
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.004, `${what}: ${a.toFixed(3)} m, should be ${b} m`);

test('an avenue: footway 15 cm, its kerb 16 cm; the median kerb 15 cm and its planting 17 cm', () => {
  const { w, net } = flatWorld();
  const avenue = PROFILE_INFO.findIndex((p) => p.name === 'profile.avenue');
  const a = net.addNode({ x: -40, z: 0, y: GROUND }), b = net.addNode({ x: 40, z: 0, y: GROUND });
  net.addSeg({ a, b, cx: 0, cz: 0, profile: avenue, flags: 0 });
  const vs = mesh(w, net).filter((v) => !v.junction && Math.abs(v.x) < 30);
  const info = PROFILE_INFO[avenue];
  const footwayKerb = vs.filter((v) => v.mat === RMAT.Curb && Math.abs(v.u) > info.asphaltRight - 0.01);
  const medianKerb = vs.filter((v) => v.mat === RMAT.Curb && Math.abs(v.u) < info.asphaltRight - 1);
  const planting = vs.filter((v) => v.mat === RMAT.Grass);
  const footway = vs.filter((v) => v.mat !== RMAT.Curb && Math.abs(v.u) > info.asphaltRight + 0.5);
  assert.ok(footwayKerb.length && medianKerb.length && planting.length && footway.length);
  near(top(footway), 0.15, 'footway');
  near(top(footwayKerb), 0.16, 'footway kerb');
  near(top(medianKerb), 0.15, 'median kerb');
  near(top(planting), 0.17, 'median planting');
});

test('the kerb stone runs round a junction corner at 16 cm, the corner footway at 15 cm', () => {
  const { w, net } = flatWorld();
  const c = net.addNode({ x: 0, z: 0, y: GROUND });
  for (const [x, z] of [[60, 0], [0, 60], [-60, 0], [0, -60]]) net.addSeg({ a: c, b: net.addNode({ x, z, y: GROUND }), cx: x / 2, cz: z / 2, profile: 0, flags: 0 });
  const corner = mesh(w, net).filter((v) => v.junction && Math.abs(v.x) > 3 && Math.abs(v.z) > 3);
  const kerb = corner.filter((v) => v.mat === RMAT.Curb), walk = corner.filter((v) => v.mat === RMAT.Sidewalk);
  near(top(kerb), 0.16, 'corner kerb');
  near(top(walk), 0.15, 'corner footway');
  // a kerb band on top, not only the face: kerb vertices at the top height on two lines (the face's and the band's back)
  const lines = new Set(kerb.filter((v) => v.y > 0.155).map((v) => Math.hypot(v.x, v.z).toFixed(1)));
  assert.ok(lines.size >= 4, `the kerb's top has vertices at only ${lines.size} distances from the node`);
});

test('a skewed avenue junction: every corner footway keeps its width all the way round', () => {
  const { w, net } = flatWorld();
  const avenue = PROFILE_INFO.findIndex((p) => p.name === 'profile.avenue'), bike = PROFILE_INFO.findIndex((p) => p.name === 'profile.avenueWithCycleTrack');
  const c = net.addNode({ x: 0, z: 0, y: GROUND });
  // the four legs of node 399 in the seed-1 city (directions and profiles), long enough for their corners
  const legs: Array<[number, number, number, number]> = [[0.41, -0.91, 90, bike], [-0.38, 0.93, 90, bike], [1, -0.03, 90, avenue], [-1, 0.03, 90, avenue]];
  for (const [dx, dz, len, p] of legs) {
    const l = Math.hypot(dx, dz), x = (dx / l) * len, z = (dz / l) * len;
    net.addSeg({ a: c, b: net.addNode({ x, z, y: GROUND }), cx: x / 2, cz: z / 2, profile: p, flags: 0 });
  }
  const all = mesh(w, net), vs = all.filter((v) => v.junction && Math.hypot(v.x, v.z) < 45);
  // where a corner meets a leg, its edge is the leg's own (the foot of the segment's skirt at its mouth)
  const mouths = all.filter((v) => !v.junction && v.y < -0.3);
  // the carriageway's edge: the junction's asphalt fan (its first vertex is the centre, then the ring in order)
  const fan = vs.filter((v) => v.mat === RMAT.Plain);
  const ring = fan.slice(1);
  const toEdge = (x: number, z: number) => {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length], dx = q.x - p.x, dz = q.z - p.z, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / l2));
      best = Math.min(best, Math.hypot(x - p.x - dx * t, z - p.z - dz * t));
    }
    return best;
  };
  // the footway's outer edge round the corners: the foot of its skirt
  const outer = vs.filter((v) => v.mat === RMAT.Sidewalk && v.y < -0.3 && !mouths.some((m) => Math.hypot(m.x - v.x, m.z - v.z) < 0.05));
  assert.ok(ring.length > 8 && outer.length > 8);
  const widths = [avenue, bike].map((p) => PROFILE_INFO[p].right - PROFILE_INFO[p].asphaltRight);
  const lo = Math.min(...widths) - 0.35, hi = Math.max(...widths) + 0.35;
  const off = outer.map((v) => toEdge(v.x, v.z)).filter((d) => d < lo || d > hi);
  assert.equal(off.length, 0, `corner footway edge points ${off.map((d) => d.toFixed(2)).join(', ')} m from the carriageway (footway ${lo + 0.35}–${hi - 0.35} m wide)`);
});
