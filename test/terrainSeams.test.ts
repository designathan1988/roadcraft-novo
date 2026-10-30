/// <reference types="node" />
// The terrain met by the roads laid on it (jobs/terrainSeams.ts): the ground as it is drawn near the camera — the
// terrain's own 4 m cells where they are not holes, the seams' pieces where they are — against the road's own drawn
// surfaces, in a grid of streets built with the game's tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { planRoad, buildRoad, snap } from '../src/roads/build.ts';
import { buildRoadMesh } from '../src/jobs/roadMesh.ts';
import { buildTerrainSeams, POINT_GROUND, SEAM_CELLS } from '../src/jobs/terrainSeams.ts';
import { heightAt } from '../src/world/heights.ts';
import { CELL_SIZE, HEIGHT_SPACING, MAP_HALF } from '../src/config.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import type { PackedMesh } from '../src/shared/contracts/worker.ts';

/** Triangles of a packed mesh in world units, with each corner's kind (the `col` alpha). */
function triangles(m: PackedMesh): { p: number[]; kind: number[] }[] {
  const k = m.scale / 32767, P = m.position, out: { p: number[]; kind: number[] }[] = [];
  for (let t = 0; t < m.index.length; t += 3) {
    const v = [m.index[t], m.index[t + 1], m.index[t + 2]];
    out.push({ p: v.flatMap((i) => [m.originX + P[i * 4] * k, m.originY + P[i * 4 + 1] * k, m.originZ + P[i * 4 + 2] * k]), kind: v.map((i) => m.color[i * 4 + 3]) });
  }
  return out;
}
type Tri = { p: number[]; kind: number[] };
/** Triangles bucketed by the 4 m square their box touches, for `topAt`. */
function bucketed(list: Tri[]): Map<number, Tri[]> {
  const out = new Map<number, Tri[]>();
  for (const t of list) {
    const xs = [t.p[0], t.p[3], t.p[6]], zs = [t.p[2], t.p[5], t.p[8]];
    for (let j = Math.floor(Math.min(...zs) / 4); j <= Math.floor(Math.max(...zs) / 4); j++) for (let i = Math.floor(Math.min(...xs) / 4); i <= Math.floor(Math.max(...xs) / 4); i++) {
      const key = j * 100003 + i;
      (out.get(key) ?? out.set(key, []).get(key)!).push(t);
    }
  }
  return out;
}
/** The highest of a bucketed triangle list at (x, z) (NaN: none), each corner's height by `y`. */
function topAt(grid: Map<number, Tri[]>, x: number, z: number, y: (t: Tri, c: number) => number): number {
  let best = NaN;
  for (const t of grid.get(Math.floor(z / 4) * 100003 + Math.floor(x / 4)) ?? []) {
    const [ax, , az, bx, , bz, cx, , cz] = t.p;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    if (l1 < -1e-6 || l2 < -1e-6 || l1 + l2 > 1 + 1e-6) continue;
    const h = l1 * y(t, 0) + l2 * y(t, 1) + (1 - l1 - l2) * y(t, 2);
    if (!(h <= best)) best = h;
  }
  return best;
}

test('terrain seams: the ground meets the footway\'s edge on its height and never stands over a road', () => {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  // a 3 x 3 grid of local streets, 100 m apart, crossing at the origin's cell
  for (let i = 0; i < 3; i++) for (const horiz of [true, false]) {
    const c = -100 + i * 100;
    const a = horiz ? snap(w.roads, -150, c, 8) : snap(w.roads, c, -150, 8);
    const b = horiz ? snap(w.roads, 150, c, 8) : snap(w.roads, c, 150, 8);
    const p = planRoad(w, a, null, b, 0, 0);
    assert.ok(p.ok, p.reason);
    buildRoad(w, p, a, b, 0);
  }
  const net = w.roads;
  // the road cell holding the origin, on the 4 m grid
  const ox = Math.floor((0 + MAP_HALF) / CELL_SIZE) * CELL_SIZE - MAP_HALF, oz = ox;
  const segs: number[] = [], nodes: number[] = [];
  const reach = 100;
  net.segIndex.query(ox - reach, oz - reach, ox + CELL_SIZE + reach, oz + CELL_SIZE + reach, (s) => { segs.push(s); });
  net.nodeIndex.query(ox - reach, oz - reach, ox + CELL_SIZE + reach, oz + CELL_SIZE + reach, (n) => { nodes.push(n); });
  const road = buildRoadMesh(w.heights, net.gather(segs, nodes), ox - 128, oz - 128, 512, 0)!;
  const seams = buildTerrainSeams(w.heights, road, ox, oz);
  assert.ok(seams.mesh, 'seams built');
  const roadTris = bucketed(triangles(road).filter((t) => {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.p;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return Math.abs(ny) >= 0.5 * Math.hypot(nx, ny, nz);
  }));
  const seamTris = bucketed(triangles(seams.mesh!));
  // the ground as drawn: a seam's ground points take the terrain's height (as the shader does), its edge points theirs
  const groundAt = (x: number, z: number): number => {
    const ci = Math.floor((x - ox) / HEIGHT_SPACING), cj = Math.floor((z - oz) / HEIGHT_SPACING);
    if (ci < 0 || cj < 0 || ci >= SEAM_CELLS || cj >= SEAM_CELLS || !seams.holes[cj * SEAM_CELLS + ci]) return heightAt(w.heights, x, z);
    return topAt(seamTris, x, z, (t, c) => (t.kind[c] === POINT_GROUND ? heightAt(w.heights, t.p[c * 3], t.p[c * 3 + 2]) : t.p[c * 3 + 1]));
  };
  // 1. nowhere is the ground over the road's surface
  let over = 0, worstOver = 0, looked = 0;
  for (let x = ox + 1; x < ox + CELL_SIZE - 1; x += 0.37) for (let z = oz + 1; z < oz + CELL_SIZE - 1; z += 0.37) {
    const s = topAt(roadTris, x, z, (t, c) => t.p[c * 3 + 1]);
    if (Number.isNaN(s)) continue;
    looked++;
    const g = groundAt(x, z);
    if (g > s + 0.003) { over++; worstOver = Math.max(worstOver, g - s); }
  }
  // 2. just off a footway's edge, the ground is at the footway's height (no step down to it)
  const edgeU = PROFILE_INFO[0].right;
  let worstStep = 0, steps = 0, worstAt = "";
  for (const street of [0, 100]) for (let x = ox + 20; x < ox + CELL_SIZE - 20; x += 0.53) {
    if (Math.abs(((x % 100) + 100) % 100 - 50) > 35) continue; // clear of the junctions
    for (const side of [-1, 1]) {
      const zEdge = street + side * (edgeU - 0.05), zOff = street + side * (edgeU + 0.1);
      const s = topAt(roadTris, x, zEdge, (t, c) => t.p[c * 3 + 1]);
      // (a street's end is wider than its run: there the point beside is still on the road)
      if (Number.isNaN(s) || zOff < oz || zOff > oz + CELL_SIZE || !Number.isNaN(topAt(roadTris, x, zOff, (t, c) => t.p[c * 3 + 1]))) continue;
      steps++;
      const st = s - groundAt(x, zOff);
      if (st > worstStep) { worstStep = st; worstAt = `${x.toFixed(2)},${zOff.toFixed(2)} edge ${s.toFixed(3)} ground ${groundAt(x, zOff).toFixed(3)}`; }
    }
  }
  assert.ok(looked > 20000 && steps > 200, `points looked at ${looked}, edge points ${steps}`);
  assert.equal(over, 0, `the ground stood over the road at ${over} points (up to ${(worstOver * 100).toFixed(1)} cm)`);
  assert.ok(worstStep < 0.04, `a step of ${(worstStep * 100).toFixed(1)} cm from the footway's edge down to the ground beside it at ${worstAt}`);
});
