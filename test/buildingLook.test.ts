/// <reference types="node" />
// The Roadcraft 4.0 look of the buildings (the visual items of the building front): what the photos show, held by
// the geometry the generator writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { BMAT, WIN_REVEAL, buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes, type BoxColumns, type PackedMesh } from '../src/jobs/protocol.ts';
import { Zone } from '../src/roads/zones.ts';
import { facadeWindowTable } from '../src/world/arch.ts';
import { encodeDesign } from '../src/world/design.ts';

type V3 = [number, number, number];

function positions(m: PackedMesh): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const p = m.position, k = m.scale / 32767;
    out.push([m.originX + p[i * 4] * k, m.originY + p[i * 4 + 1] * k, m.originZ + p[i * 4 + 2] * k]);
  }
  return out;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A mixed block: towers, mid-rises, houses and sheds of every style and pattern, and catalog projects, on flat ground. */
function block(): { heights: Float32Array; b: BoxColumns } {
  const w = new World();
  w.heights.fill(10);
  const zones = [Zone.Commercial, Zone.ComHigh, Zone.Residential, Zone.ResHigh, Zone.ResLow, Zone.Industrial, Zone.Mixed, Zone.ComLow];
  const b = emptyBoxes(36);
  for (let i = 0; i < 36; i++) {
    b.x[i] = 18 + (i % 6) * 40; b.z[i] = 18 + Math.floor(i / 6) * 40; b.w[i] = 22 + (i % 3) * 5; b.d[i] = 26 + (i % 4) * 3;
    b.zone[i] = zones[i % zones.length]; b.floors[i] = [1, 2, 4, 7, 12, 18][i % 6]; b.seed[i] = 9001 + i * 7919; b.style[i] = (i * 37) % 128;
  }
  // three catalog projects (their walls go through facadeWall)
  for (const [i, k] of [[33, 3], [34, 12], [35, 25]]) { const e = encodeDesign({ shape: 0, roof: 0, finish: 0, gear: 0, setback: 0, wall: 0xd9c7a6, catalog: k }); b.color[i] = e.color; b.h[i] = e.h; b.w[i] = 34; b.d[i] = 36; }
  b.count = 36;
  return { heights: w.heights, b };
}

/** Triangles of a mesh with their corners, unit normal and plane offset. */
function triangles(m: PackedMesh, pos: V3[]) {
  const out: Array<{ t: number; a: V3; b: V3; c: V3; n: V3; d: number }> = [];
  for (let t = 0; t < m.index.length; t += 3) {
    const a = pos[m.index[t]], b = pos[m.index[t + 1]], c = pos[m.index[t + 2]];
    const n = cross(sub(b, a), sub(c, a)), l = Math.hypot(...n);
    if (l < 1e-6) continue;
    const u: V3 = [n[0] / l, n[1] / l, n[2] / l];
    out.push({ t, a, b, c, n: u, d: dot(u, a) });
  }
  return out;
}

/** Barycentric weights of p (projected on the triangle's plane), or null when outside by more than `tol` metres. */
function bary(p: V3, a: V3, b: V3, c: V3, n: V3, tol: number): V3 | null {
  const area = dot(cross(sub(b, a), sub(c, a)), n);
  const wa = dot(cross(sub(c, b), sub(p, b)), n) / area, wb = dot(cross(sub(a, c), sub(p, c)), n) / area, wc = 1 - wa - wb;
  const scale = Math.sqrt(Math.abs(area));
  return wa > -tol / scale && wb > -tol / scale && wc > -tol / scale ? [wa, wb, wc] : null;
}

test('janela 1: every window the wall opens has its pane 20 cm in, and every pane sits behind an opening', () => {
  const { heights, b } = block();
  const m0 = buildBuildings(heights, b, 0, 0, 256, 0)!, md = buildBuildings(heights, b, 0, 0, 256, -1)!;
  const p0 = positions(m0), pd = positions(md), table = facadeWindowTable();
  const glass = triangles(md, pd).filter((g) => (md.color[md.index[g.t] * 4 + 3] & 15) === BMAT.WinGlass);
  // the shader's opening (render/city.ts, `hole`) at a point of a main wall triangle, from the interpolated attributes
  const holeAt = (t: number, w: V3): boolean => {
    const i = m0.index[t], f = m0.fac!;
    const fac3 = f[i * 4 + 3], colW = (fac3 >> 1) / 10, kindByte = f[i * 4 + 2];
    if (!(fac3 & 1) || colW < 0.5) return false;
    const kind = kindByte & 3, shop = (kindByte >> 2) & 1, fh = (kindByte >> 3) / 10 + 2.5;
    let u = 0, h = 0;
    for (let q = 0; q < 3; q++) { const v = m0.index[t + q]; u += w[q] * m0.fuv![v * 2] / 32767 * 512; h += w[q] * m0.fuv![v * 2 + 1] / 32767 * 512; }
    const hh = h - shop * 4.4;
    if (hh < 0 || kind === 1) return false;
    const [ww, wLow, wHigh, bits] = table[f[i * 4]];
    const cu = Math.floor(u), fx = u - cu, fy = hh / fh - Math.floor(hh / fh), cm = cu % 3;
    if ((bits & 4 && cm === 1) || (bits & 8 && cm !== 0)) return false;
    const eu = 0.01 / colW, ey = 0.01 / fh;
    return fx >= ww + eu && fx <= 1 - ww - eu && fy >= wLow + ey && fy <= wHigh - ey;
  };
  const walls = triangles(m0, p0).filter((g) => Math.abs(g.n[1]) < 0.3 && m0.fac![m0.index[g.t] * 4 + 3] & 1);
  assert.ok(walls.length > 100, `${walls.length} opened wall triangles`);
  assert.ok(glass.length > 200, `${glass.length} pane triangles`);
  const paneBehind = (p: V3, n: V3) => glass.some((g) => dot(g.n, n) > 0.99 && Math.abs(dot(g.n, p) - g.d) < 0.01 && bary(p, g.a, g.b, g.c, g.n, 0.012));
  // every opening: sampled over each wall triangle (4 samples per m², a deterministic lattice)
  let opened = 0;
  const lost: string[] = [];
  for (const w of walls) {
    const area = Math.hypot(...cross(sub(w.b, w.a), sub(w.c, w.a))) / 2, k = Math.max(4, Math.ceil(Math.sqrt(area * 4)));
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
      const wb: V3 = [(i + 0.33) / (k + 0.5), (j + 0.33) / (k + 0.5), 0];
      wb[2] = 1 - wb[0] - wb[1];
      if (wb[2] < 0 || !holeAt(w.t, wb)) continue;
      opened++;
      const p: V3 = [0, 1, 2].map((q) => wb[0] * w.a[q] + wb[1] * w.b[q] + wb[2] * w.c[q]) as V3;
      const back: V3 = [p[0] - w.n[0] * WIN_REVEAL, p[1] - w.n[1] * WIN_REVEAL, p[2] - w.n[2] * WIN_REVEAL];
      if (!paneBehind(back, w.n) && lost.length < 8) lost.push(`opening at (${p.map((x) => x.toFixed(2)).join(', ')}) without a pane`);
    }
  }
  assert.ok(opened > 500, `${opened} samples in openings`);
  // every pane: its middle, 20 cm out, is an opening of a wall of the same facing
  for (const g of glass) {
    const c: V3 = [0, 1, 2].map((q) => (g.a[q] + g.b[q] + g.c[q]) / 3) as V3;
    const front: V3 = [c[0] + g.n[0] * WIN_REVEAL, c[1] + g.n[1] * WIN_REVEAL, c[2] + g.n[2] * WIN_REVEAL];
    const hit = walls.some((w) => {
      if (dot(w.n, g.n) < 0.99 || Math.abs(dot(w.n, front) - w.d) > 0.01) return false;
      const wb = bary(front, w.a, w.b, w.c, w.n, 0);
      return wb !== null && holeAt(w.t, wb);
    });
    if (!hit && lost.length < 16) lost.push(`pane at (${c.map((x) => x.toFixed(2)).join(', ')}) behind no opening`);
  }
  assert.deepEqual(lost, []);
});

test('paredes 2: the wall paints are the muted 4.0 ones (no paint more saturated than 4.0 brick)', async () => {
  const { ARCHES } = await import('../src/world/arch.ts');
  const loud: string[] = [];
  for (const a of ARCHES) for (const c of a.walls) {
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    if ((Math.max(r, g, b) - Math.min(r, g, b)) / 255 > 0.4) loud.push(`${a.name} ${c.toString(16)}`);
  }
  assert.deepEqual(loud, []);
});

test('paredes 2: near, every block has the 4.0 stone plinth, storey bands and cornice in the detail layer', async () => {
  const { buildingVolumes } = await import('../src/jobs/buildingGen.ts');
  const { heights, b } = block();
  const md = buildBuildings(heights, b, 0, 0, 256, -1)!, pd = positions(md);
  const rgb = (i: number) => (md.color[i * 4] << 16) | (md.color[i * 4 + 1] << 8) | md.color[i * 4 + 2];
  // the plinth: stone (finish 4 in the high nibble), in the 4.0 plinth colour
  let plinth = 0;
  for (let i = 0; i < md.vertexCount; i++) if (rgb(i) === 0x7f786d && md.color[i * 4 + 3] >> 4 === 4) plinth++;
  assert.ok(plinth > 8 * 10, `${plinth} plinth vertices`);
  // the bands: on a mid-rise without style bands, faces 7 cm out of the wall at a floor line, 22 cm high in all
  let banded = 0;
  for (let k = 0; k < b.count; k++) {
    const vols = buildingVolumes(heights, b, k);
    const v = vols.find((x) => x.y1 - x.y0 > 12);
    if (!v) continue;
    const lineYs = new Set<number>();
    for (let y = v.base + v.ground; y < v.y1 - 1; y += v.fh) lineYs.add(Math.round(y * 100));
    for (const [, y] of pd) if (lineYs.has(Math.round((y + 0.11) * 100)) || lineYs.has(Math.round((y - 0.11) * 100))) { banded++; break; }
  }
  assert.ok(banded >= 6, `${banded} buildings with storey bands`);
});
