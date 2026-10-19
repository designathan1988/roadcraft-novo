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

test('telhado 3: flat roofs carry the 4.0 parapet (0.85 m, membrane inside) and the plant the 4.0 plans', async () => {
  const { buildingVolumes } = await import('../src/jobs/buildingGen.ts');
  const { planRoofPlant, FLAT_ROOFS } = await import('../src/world/roofPlant.ts');
  // the plan: deterministic, inside the parapet's margin, a lift room on a block of 4 storeys or more
  const site = { seed: 77, volume: 0, use: 'residential' as const, storeys: 8, x0: -10, z0: -12, x1: 10, z1: 12, age: 0.4 };
  const a = planRoofPlant(site), b2 = planRoofPlant(site);
  assert.deepEqual(a, b2);
  assert.ok(a.some((it) => it.kind === 'liftRoom'));
  for (const it of a) assert.ok(it.x0 >= -9.2 && it.x1 <= 9.2 && it.z0 >= -11.2 && it.z1 <= 11.2, `${it.kind} off the roof`);
  // the mesh: on the mid-rises, coping tops 0.85 m over the roof and a lift room 2.5 m over it; membranes of the 4.0
  const { heights, b } = block();
  const m = buildBuildings(heights, b, 0, 0, 256, 0)!, p = positions(m);
  const rgb = (i: number) => (m.color[i * 4] << 16) | (m.color[i * 4 + 1] << 8) | m.color[i * 4 + 2];
  let roofs = 0, withParapet = 0, withLift = 0;
  for (let k = 0; k < 33; k++) {
    if (b.zone[k] === Zone.Industrial || b.floors[k] < 4) continue;
    const vols = buildingVolumes(heights, b, k);
    if (!vols.length) continue;
    const top = Math.max(...vols.map((v) => v.y1));
    const near = (y: number) => p.some(([, py], i) => Math.abs(py - y) < 0.01 && (m.color[i * 4 + 3] & 15) === 4 && Math.hypot(p[i][0] - b.x[k], p[i][2] - b.z[k]) < 30);
    roofs++;
    if (near(top + 0.85)) withParapet++;
    if (near(top + 2.5)) withLift++;
  }
  assert.ok(roofs >= 8, `${roofs} roofs`);
  assert.ok(withParapet >= roofs * 0.8, `${withParapet}/${roofs} with the 0.85 m parapet`);
  assert.ok(withLift >= roofs * 0.5, `${withLift}/${roofs} with the lift room`);
  let membrane = 0;
  for (let i = 0; i < m.vertexCount; i++) if ((m.color[i * 4 + 3] & 15) === 1 && FLAT_ROOFS.includes(rgb(i))) membrane++;
  assert.ok(membrane > 40, `${membrane} membrane vertices`);
});

test('telhado 4: pitched roofs have the 4.0 body (18 cm fascia, soffit, ridge cap) and gable triangles in the wall', async () => {
  const { hip } = await import('../src/jobs/buildingGen.ts');
  const { MeshBuilder } = await import('../src/jobs/meshBuilder.ts');
  const mb = new MeshBuilder(false, true);
  hip(mb, { cx: 0, cz: 0, c: 1, s: 0, base: 0 }, -5, 5, -8, 8, 6, 2.5, 0x993322, 0xf0f0f0);
  const cols = new Set<number>();
  let lowest = Infinity, highest = -Infinity;
  for (let i = 0; i < mb.v; i++) { cols.add(mb.col[i]); lowest = Math.min(lowest, mb.pos[i * 3 + 1]); highest = Math.max(highest, mb.pos[i * 3 + 1]); }
  const shade = (c: number, k: number) => (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);
  assert.ok(cols.has(shade(0xf0f0f0, 0.92)), 'fascia in the trim x 0.92');
  assert.ok(cols.has(shade(0xf0f0f0, 0.7)), 'soffit in the trim x 0.7');
  assert.ok(cols.has(shade(0x993322, 0.85)), 'ridge cap');
  // the eave 45 cm out falls by the slope, the body 18 cm under it; the cap 7 cm over the ridge
  const slope = 2.5 / 5;
  assert.ok(Math.abs(lowest - (6 - 0.45 * slope - 0.18)) < 1e-3, `fascia bottom ${lowest}`);
  assert.ok(Math.abs(highest - (6 + 2.5 + 0.07)) < 1e-3, `ridge cap ${highest}`);
});

test('janela 1b: every pane has the 4.0 frame in front of it (border, mullion, transom at 68 %)', () => {
  const { heights, b } = block();
  const md = buildBuildings(heights, b, 0, 0, 256, -1)!, pd = positions(md);
  const glass = triangles(md, pd).filter((g) => (md.color[md.index[g.t] * 4 + 3] & 15) === BMAT.WinGlass && g.n[1] === 0 || (md.color[md.index[g.t] * 4 + 3] & 15) === BMAT.WinGlass && Math.abs(g.n[1]) < 0.1);
  // frame vertices: 6 cm in front of a pane (the frame's front face), by plane
  const frames = pd.filter((_, i) => (md.color[i * 4 + 3] & 15) === BMAT.Plain);
  let checked = 0;
  const missing: string[] = [];
  for (let k = 0; k < glass.length; k += 2) {
    const g = glass[k];
    const ys = [g.a[1], g.b[1], g.c[1]], y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y1 - y0 < 1) continue;
    const ty = y0 + (y1 - y0) * 0.68, c: V3 = [(g.a[0] + g.b[0] + g.c[0]) / 3, ty, (g.a[2] + g.b[2] + g.c[2]) / 3];
    checked++;
    const hit = frames.some((p) => Math.abs(p[1] - ty) < 0.02 * (y1 - y0) + 0.008 && Math.abs(Math.abs(dot(g.n, p) - g.d) - 0.06) < 0.012 && Math.hypot(p[0] - c[0], p[2] - c[2]) < 2);
    if (!hit && missing.length < 5) missing.push(`pane at ${c.map((v) => v.toFixed(1)).join(', ')} without its transom`);
  }
  assert.ok(checked > 50, `${checked} panes`);
  assert.deepEqual(missing, []);
});

test('vidro 1c: curtain walls stand the 4.0 fins and transoms, in the mullion colour of a 4.0 palette', () => {
  const w = new World();
  w.heights.fill(10);
  const b = emptyBoxes(12);
  // towers of every style: the glass style (Envidraçado) comes up among them
  for (let i = 0; i < 12; i++) { b.x[i] = 30 + (i % 4) * 60; b.z[i] = 40 + Math.floor(i / 4) * 70; b.w[i] = 30; b.d[i] = 34; b.zone[i] = Zone.Commercial; b.floors[i] = 20; b.seed[i] = 300 + i * 977; b.style[i] = i * 11; }
  b.count = 12;
  const md = buildBuildings(w.heights, b, 0, 0, 256, -1)!;
  const mull = new Set([0xd5dadd, 0x5a6168, 0xe8efee, 0xcfd6d3]);
  let fins = 0;
  for (let i = 0; i < md.vertexCount; i++) if (mull.has((md.color[i * 4] << 16) | (md.color[i * 4 + 1] << 8) | md.color[i * 4 + 2])) fins++;
  assert.ok(fins > 500, `${fins} fin and transom vertices in the 4.0 mullion colours`);
});
