// The terrain's rock as Roadcraft 4.0's (render/terrain.ts:744-819, 853-871): the painted geology picks the rock
// (granite where none was painted, sandstone, basalt), each read triplanar from its own face and top layers of the
// land array, tinted by its beds by height, broad enough never to alias (granite sheets 30 m, sandstone beds 34 m with
// a 3.3× finer set, basalt flows 56 m), and the rocks height-blended where two meet.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';
import { COOKED, LAND } from './cookedSurfaces.ts';
import { ROCK_TILE } from './surfaceBake.ts';
import { parkMiller } from '../core/rng.ts';

type N = Node;
const { abs, dFdx, dFdy, dot, float, floor, If, int, max, mix, pow, select, smoothstep, sRGBTransferEOTF, step, texture, vec3, vec4 } = T;

/**
 * Beds per table: a bed is looked up by its number modulo this. 64 beds of 34 m repeat every 2.2 km of height, past
 * any relief the map holds.
 */
const BEDS = 64;

/**
 * Each bed's tint, made once from a seeded stream (the shader looks it up by the bed's number; no per-pixel hash or
 * chain of tests). The tints and their shares are 4.0's (terrain.ts:780-818): `pick(r)` gives a bed's tint from its
 * draw, `w` an extra per-bed draw.
 */
function bedTable(seed: number, pick: (r: number) => [number, number, number]): N {
  const rnd = parkMiller(seed);
  return T.uniformArray(Array.from({ length: BEDS }, () => { const [x, y, z] = pick(rnd()); return new THREE.Vector4(x, y, z, rnd()); }), 'vec4');
}
/** Sandstone: mostly tan and orange, now and then a cream, a rust or a brown-grey bed; w < 0.4: a harder bed. */
const SANDSTONE = bedTable(17, (r) => (r < 0.12 ? [1.13, 1.12, 1.1] : r < 0.3 ? [1.05, 1, 0.95] : r < 0.58 ? [1, 1, 1]
  : r < 0.8 ? [1.05, 0.9, 0.78] : r < 0.92 ? [0.9, 0.72, 0.62] : [0.84, 0.78, 0.74]));
/** Granite's exfoliation sheets: between two weatherings. */
const GRANITE = bedTable(47, (r) => [0.9 + 0.16 * r, 0.92 + 0.12 * r, 0.95 + 0.05 * r]);
/** Basalt's flows: barely different greys. */
const BASALT = bedTable(31, (r) => [0.84 + 0.28 * r, 0.87 + 0.19 * r, 0.9 + 0.1 * r]);

/** Bed `i` (a whole number, any sign) of `table`. */
const bed = (table: N, i: N): N => table.element(int(i.sub(floor(i.div(BEDS)).mul(BEDS))));

/** The sandstone's beds by height, level on every cliff, with a 3.3× finer set over them and a darker hard band. */
function sandstoneBeds(y: N, wanderA: N, wanderC: N): N {
  const t = y.add(wanderA.sub(0.5).mul(30)).add(wanderC.sub(0.5).mul(9)).div(34);
  const i = floor(t), f = t.sub(i);
  const tint = mix(bed(SANDSTONE, i).xyz, bed(SANDSTONE, i.add(1)).xyz, smoothstep(0.82, 1, f)).toVar();
  const t2 = t.mul(3.3).add(0.37), i2 = floor(t2);
  tint.mulAssign(mix(vec3(1, 1, 1), mix(bed(SANDSTONE, i2.add(40)).xyz, bed(SANDSTONE, i2.add(41)).xyz, smoothstep(0.8, 1, t2.sub(i2))), 0.35));
  const hard = step(bed(SANDSTONE, i.add(1)).w, 0.4);
  return tint.mul(float(1).sub(hard.mul(0.18).mul(smoothstep(0.84, 0.92, f)).mul(float(1).sub(smoothstep(0.96, 1, f)))));
}

/** Granite's sheets, 30 m apart. */
function graniteSheets(y: N, wanderA: N, wanderC: N): N {
  const t = y.add(wanderA.sub(0.5).mul(60)).add(wanderC.sub(0.5).mul(20)).div(30);
  const i = floor(t);
  return mix(bed(GRANITE, i).xyz, bed(GRANITE, i.add(1)).xyz, smoothstep(0.7, 1, t.sub(i)));
}

/** Basalt's flows, 56 m each, the weathered top of each a little redder. */
function basaltFlows(y: N, wanderA: N): N {
  const t = y.add(wanderA.sub(0.5).mul(34)).div(56);
  const i = floor(t), f = t.sub(i);
  return bed(BASALT, i).xyz.mul(mix(vec3(1, 1, 1), vec3(1.14, 0.97, 0.88), smoothstep(0.78, 0.92, f).mul(float(1).sub(smoothstep(0.97, 1, f)))));
}

/** The soil is the rock it weathered from: its tint by the geology (4.0 terrain.ts:882). */
export function soilTint(geo: N): N {
  return vec3(0.88, 0.86, 0.88).mul(geo.x).add(vec3(1.14, 1.06, 0.92).mul(geo.y)).add(vec3(0.8, 0.56, 0.52).mul(geo.z));
}

/**
 * Triplanar weights (pow(|n|, 4), 4.0 terrainTriWeights), the three planes' uv at ROCK_TILE and their gradients, held
 * in variables set here, in uniform control flow. DO NOT leave them as plain nodes: TSL declares a shared node where it
 * is first built, and built first inside one rock's If it was set only where that rock showed (a basalt wall with no
 * granite read zero weights: black walls, 2026-10-31).
 */
function planes(p: N, n: N): { ws: N; uv: N[]; d: N[][] } {
  const w3 = pow(abs(n), vec3(4, 4, 4));
  const ws = w3.div(max(w3.x.add(w3.y).add(w3.z), 1e-4)).toVar();
  const uv = [p.zy.div(ROCK_TILE).toVar(), p.xz.div(ROCK_TILE).toVar(), p.xy.div(ROCK_TILE).toVar()];
  return { ws, uv, d: uv.map((u) => [dFdx(u).toVar(), dFdy(u).toVar()]) };
}

/** One rock's triplanar read of `tex`, from its face layer (the walls) and its top layer (looking up): 4.0 rockTriColor. */
function readRock(tex: THREE.Texture, kind: number, pl: { ws: N; uv: N[]; d: N[][] }): N {
  const face = int(LAND.GraniteFace + kind * 2), top = int(LAND.GraniteFace + kind * 2 + 1);
  const { ws, uv, d } = pl;
  return texture(tex, uv[0]).depth(face).grad(d[0][0], d[0][1]).mul(ws.x)
    .add(texture(tex, uv[1]).depth(top).grad(d[1][0], d[1][1]).mul(ws.y))
    .add(texture(tex, uv[2]).depth(face).grad(d[2][0], d[2][1]).mul(ws.z));
}

/**
 * The rock's normal texel (0..1, tangent-space as baked) at `p`: each painted rock's normal layers by `geo`, read only
 * where `rockW` shows rock (flat elsewhere). 4.0 rockTriNormal reads them by the colour's height-blended mix; here by
 * the geology's weights, which differ from it only along a boundary between two rocks.
 */
export function rockNormal(p: N, n: N, rockW: N, geo: N): N {
  const tex = COOKED['terrain-land.normal'], pl = planes(p, n);
  const out = vec4(0.5, 0.5, 1, 1).toVar();
  If(rockW.greaterThan(0.001), () => {
    const acc = vec4(0, 0, 0, 0).toVar();
    for (let k = 0; k < 3; k++) {
      const wk = k === 0 ? geo.x : k === 1 ? geo.y : geo.z;
      If(wk.greaterThan(0.01), () => { acc.addAssign(readRock(tex, k, pl).mul(wk)); });
    }
    out.assign(acc);
  });
  return out;
}

/**
 * The rock's colour (linear) at `p` with normal `n`: `geo` the geology's weights (granite, sandstone, basalt; summing to
 * 1), `wanderA`/`wanderC` the blend's 0.00575 and 0.05 per metre noises. Read only where `rockW` shows rock; the
 * gradients are taken before the branch (a texture read inside it needs them given).
 */
export function rockColour(p: N, n: N, rockW: N, geo: N, wanderA: N, wanderC: N): N {
  const tex = COOKED['terrain-land.map'], pl = planes(p, n);
  // the baked texels are sRGB: to linear before the beds' tints
  const read = (kind: number, weight: N, out: N): void => {
    If(rockW.greaterThan(0.001).and(weight.greaterThan(0.01)), () => { out.assign(sRGBTransferEOTF(readRock(tex, kind, pl).xyz)); });
  };
  const cG = vec3(0, 0, 0).toVar(), cS = vec3(0, 0, 0).toVar(), cB = vec3(0, 0, 0).toVar();
  read(0, geo.x, cG); read(1, geo.y, cS); read(2, geo.z, cB);
  const g = cG.mul(graniteSheets(p.y, wanderA, wanderC)), s = cS.mul(sandstoneBeds(p.y, wanderA, wanderC)), b = cB.mul(basaltFlows(p.y, wanderA));
  // height-blended between the rocks: a boundary breaks along the stone instead of fading one rock into the other
  const lw = vec3(0.3, 0.6, 0.1);
  const has = step(vec3(0.01, 0.01, 0.01), geo);
  const hk = geo.add(vec3(dot(g, lw), dot(s, lw), dot(b, lw)).mul(0.6)).mul(has);
  const topK = max(hk.x, max(hk.y, hk.z)).sub(0.12);
  const bk = max(hk.sub(topK), vec3(0, 0, 0)).mul(has);
  const mixW = bk.div(max(bk.x.add(bk.y).add(bk.z), 1e-4));
  const c = g.mul(mixW.x).add(s.mul(mixW.y)).add(b.mul(mixW.z));
  // where no rock shows, the granite's mean (4.0: rockColor's default 0.45, 0.43, 0.4)
  return select(rockW.greaterThan(0.001), c, vec3(0.45, 0.43, 0.4));
}
