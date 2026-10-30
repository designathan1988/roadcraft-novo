// Roads on screen: a layer by cells (detailed mesh near, simplified ribbon per tile far) and the material that
// paints every marking in the shader. The mesh holds only the section (asphalt, curb, sidewalk, median); the look
// of Roadcraft's streets (gutter, curb stones, sidewalk panels, tactile paving, drains, manholes, worn paint,
// regional crossings) is analytic here, from the road coordinates (u across, v along) and the profile table.

import * as THREE from 'three/webgpu';
import { CELLS_PER_TILE, MAP_CELLS, MAP_TILES } from '../config.ts';
import { Dirty, cellId, cellOriginX, tileOriginX, type DirtyCells } from '../core/grid.ts';
import type { JobPool } from '../jobs/pool.ts';
import { roadGraphTransfer } from '../shared/contracts/worker.ts';
import { RMAT, RoadCode } from '../jobs/roadMesh.ts';
import { DASH_PERIOD, DASH_STEPS } from '../roads/dash.ts';
import type { RoadNetwork } from '../roads/network.ts';
import { heightAt } from '../world/heights.ts';
import { MAX_LINES, MAX_PROFILES, TABLE_W, TAG_RULE, onProfileAdded, profileCount, writeProfileRow } from '../roads/profiles.ts';
import { LAMP_FIRST, LAMP_STEP } from '../jobs/props.ts';
import { nightU } from './scene.ts';
import { wetLook } from './weather.ts';
import { CellLayer, type LayerSource } from './cellLayer.ts';
import { ASPHALT_TEX, ASPHALT_TILE } from './surfaceBake.ts';
import { COOKED, loadCookedSurfaces } from './cookedSurfaces.ts';
import { T, useCompactVertex, type Node, lodFadeMask } from './tsl.ts';
import type { NodeId, SegId } from '../core/ids.ts';

const {
  attribute, vec2, vec3, vec4, float, int, ivec2, abs, mix, clamp, fract, fwidth, max, min, floor, Fn, If, mx_worley_noise_vec2,
  textureLoad, sRGBTransferEOTF, positionWorld, transformNormalToView, normalize, mx_noise_float, select, mod, step, uniform, length, smoothstep, time, sin,
  exp, texture, varying,
} = T;

/** What the road shader needs from the traffic for the density cars. */
export interface TrafficLook {
  /** Per segment (512 wide): R = occupancy a→b, G = b→a, B = asphalt wear from use (simulation). */
  occupancy: THREE.DataTexture;
  /** Centre of the micro window (the camera target). */
  center: Node;
  /** Arrows set by hand per segment end (R = end a, G = end b; 3 bits per lane; 0 = from the profile). */
  arrows: THREE.DataTexture;
}

export function createTrafficLook(sab: SharedArrayBuffer): TrafficLook {
  const data = new Uint8Array(sab);
  const rows = data.length / 4 / 512;
  const tex = new THREE.DataTexture(data, 512, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const arrows = new THREE.DataTexture(new Float32Array(rows * 512 * 2), 512, rows, THREE.RGFormat, THREE.FloatType);
  arrows.minFilter = THREE.NearestFilter;
  arrows.magFilter = THREE.NearestFilter;
  arrows.needsUpdate = true;
  return { occupancy: tex, center: uniform(new THREE.Vector2()), arrows };
}

/** Height over the ground from which a road is a bridge (as `roads/economy.ts` charges it). */
const BRIDGE_GAP = 4.5;

/** Does any segment of these cells run over a bridge (its height over the ground past BRIDGE_GAP)? */
function hasBridge(net: RoadNetwork, heights: Float32Array, cells: number[]): boolean {
  const sc = net.segs.cols, nc = net.nodes.cols, segs: SegId[] = [], nodes: NodeId[] = [];
  for (const c of cells) net.cellContents(c, segs, nodes);
  for (const s of segs) {
    const a = sc.a[s], b = sc.b[s];
    // the road's height is linear from node to node along the curve: 9 samples
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, u = 1 - t;
      const x = u * u * nc.x[a] + 2 * u * t * sc.cx[s] + t * t * nc.x[b];
      const z = u * u * nc.z[a] + 2 * u * t * sc.cz[s] + t * t * nc.z[b];
      if (nc.y[a] * u + nc.y[b] * t - heightAt(heights, x, z) > BRIDGE_GAP) return true;
    }
  }
  return false;
}

/**
 * Roads by cells. The layer casts no shadow (a road on the ground would shadow only itself), except the cells and
 * tiles with a bridge or a viaduct when the heights are given.
 */
export function createRoads(net: RoadNetwork, pool: JobPool, dirty: DirtyCells, look: TrafficLook, heights?: Float32Array): CellLayer {
  const tileCells = (t: number) => {
    const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0, out: number[] = [];
    for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) out.push(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j));
    return out;
  };
  const src: LayerSource = {
    castsShadow: (scope, id) => !!heights && scope !== 'plate' && hasBridge(net, heights, scope === 'cell' ? [id] : tileCells(id)),
    hasContent: (c) => net.cellCount[c] > 0,
    buildCell: (c, level, priority, done) => {
      const segs: SegId[] = [], nodes: NodeId[] = [];
      net.cellContents(c, segs, nodes);
      const graph = net.gather(segs, nodes);
      const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
      pool.submit('roadMesh', { graph, originX: cellOriginX(cx), originZ: cellOriginX(cz), extent: 512, lod: level },
        (r) => done(r.mesh), { key: `road${level}:${c}`, priority: priority - 1, transfer: roadGraphTransfer(graph) });
    },
    buildTile: (t, priority, done) => {
      const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
      const segs: SegId[] = [], nodes: NodeId[] = [];
      for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) net.cellContents(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j), segs, nodes);
      if (segs.length === 0 && nodes.length === 0) { done(null); return; }
      const graph = net.gather(segs, nodes);
      pool.submit('roadMesh', { graph, originX: tileOriginX(tx), originZ: tileOriginX(tz), extent: 2048, lod: 1 },
        (r) => done(r.mesh), { key: `roadtile:${t}`, priority, transfer: roadGraphTransfer(graph) });
    },
  };
  return new CellLayer(src, dirty, Dirty.Roads, createRoadMaterial(look), { near: 1400, evict: 2200, margin: 80, shadows: false, far: 5500, detail: 600, budget: 192e6 }, true);
}

/** 1 with the zone tool: shows the zone strips beside the roads. */
export const zoneOverlayU = T.uniform(0);
/** Road paint (style in the options): colour of the white line and of the centre line. */
export const paintWhiteU = T.uniform(new THREE.Vector3(0.92, 0.92, 0.88));
export const paintYellowU = T.uniform(new THREE.Vector3(0.95, 0.72, 0.15));
/** Crossing style: 0 Brazil (zebra bars), 1 USA (bars between two transverse lines), 2 Europe (bars), 3 Classic (two lines). */
export const paintStyleU = T.uniform(0);
/** Brazil, USA, Europe, Classic: [white, centre] in sRGB, and the crossing style. */
export const PAINT_STYLES: Record<string, [[number, number, number], [number, number, number], number]> = {
  br: [[0.92, 0.92, 0.88], [0.95, 0.72, 0.15], 0],
  us: [[0.95, 0.95, 0.95], [0.98, 0.78, 0.05], 1],
  eu: [[0.95, 0.95, 0.93], [0.95, 0.95, 0.93], 2],
  classic: [[0.93, 0.9, 0.8], [0.85, 0.75, 0.45], 3],
};
export function setPaintStyle(k: string): void {
  const [w, y, style] = PAINT_STYLES[k] ?? PAINT_STYLES.br;
  paintWhiteU.value.set(...w); paintYellowU.value.set(...y);
  paintStyleU.value = style;
}

/** 1 in the traffic view: each direction's asphalt goes green → yellow → red by occupancy. */
export const trafficOverlayU = T.uniform(0);

/** Gutter width (m): the concrete channel between the asphalt and the curb. */
const GUTTER = 0.45;
/** Tactile paving strip behind the curb at crossings (m). */
const TACTILE = 0.6;
/** Manholes: one per lane about every MANHOLE_STEP metres (some skipped by hash). */
const MANHOLE_STEP = 47;
/** The profiles' asphalt colour (sRGB) the 4.0 map stands for: other tones tint it. */
const PROFILE_ASPHALT = [0x3a / 255, 0x3c / 255, 0x40 / 255];

export function createRoadMaterial(look: TrafficLook): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const nW = useCompactVertex(m, 'vRoadNormal');
  loadCookedSurfaces();
  // reversed depth: a positive offset pulls toward the camera
  m.polygonOffset = true;
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 2;

  // profile table (lines, lanes, lamps, surface, curbs): one row per profile, rewritten when a new profile arrives
  const tdata = new Float32Array(TABLE_W * MAX_PROFILES * 4);
  for (let i = 0; i < profileCount(); i++) writeProfileRow(tdata, i);
  const table = new THREE.DataTexture(tdata, TABLE_W, MAX_PROFILES, THREE.RGBAFormat, THREE.FloatType);
  table.minFilter = THREE.NearestFilter;
  table.magFilter = THREE.NearestFilter;
  table.needsUpdate = true;
  onProfileAdded((id) => {
    if (id < 0) { tdata.fill(0); for (let i = 0; i < profileCount(); i++) writeProfileRow(tdata, i); }
    else writeProfileRow(tdata, id);
    table.needsUpdate = true;
  });

  const col = attribute('col', 'vec4');
  const matId = floor(col.w.mul(255).add(0.5));
  const road = attribute('road', 'vec4');
  const u = road.x, v = road.y, toEnd = road.z;
  // the code (segment id × 256 + dash phase × 16 + flags) is whole and the same at a surface's vertices: passed flat
  // (three r186 VaryingNode.setInterpolation; WGSL @interpolate(flat, either)). Interpolated, a code of a few million
  // (any road built in a large city: ids ~20,000) came out ±1 fragment by fragment (float32 steps 0.5 there), its flag
  // bits flipped and the zebra, the stop line and other segments' wear showed through as specks.
  const code = floor(varying(road.w).setInterpolation('flat', 'either').add(0.5));
  const segId = int(floor(code.div(16 * DASH_STEPS)));
  const dashPhase = mod(floor(code.div(16)), float(DASH_STEPS)).mul(DASH_PERIOD / DASH_STEPS);
  const tag = floor(attribute('position', 'vec4').w.mul(32767).add(0.5));
  const profile = mod(tag, TAG_RULE);
  // rule of each end (Rule): 2 yield, 3 stop, 4 signal (the tag as roads/profiles.ts packRoadTag packs it)
  const ruleA = mod(floor(tag.div(TAG_RULE)), 8), ruleB = mod(floor(tag.div(TAG_RULE * 8)), 8);
  const flags = mod(code, 16);
  const bit = (b: number) => step(float(0.5), mod(floor(flags.div(b)), 2));
  const crossA = bit(RoadCode.CrossA), crossB = bit(RoadCode.CrossB), oneWay = bit(RoadCode.OneWay);
  // junction fans, bulbs and corners carry no road coordinates (all zero): they fall back to world space
  const roadUV = abs(u).add(abs(v)).add(abs(toEnd)).greaterThan(0.001).toFloat();
  const extra = textureLoad(table, ivec2(int(MAX_LINES * 2 + 1), int(profile)));
  const curbR = extra.y, curbL = extra.z;
  const used = textureLoad(look.occupancy, ivec2(segId.mod(int(512)), segId.div(int(512)))).z.mul(roadUV);

  // separate derivatives: lines along the road depend on u, dashes on v
  const fu = max(fwidth(u), float(0.003));
  const fv = max(fwidth(v), float(0.003));
  /** Exact coverage (box filter) of a band of width w round 0. */
  const band = (d: Node, w: Node, f: Node) =>
    clamp(min(d.add(f.mul(0.5)), w.mul(0.5)).sub(max(d.sub(f.mul(0.5)), w.mul(-0.5))).div(f), 0, 1);
  /** Integral of the square wave (period 1, on fraction duty). */
  const sqInt = (x: Node, duty: number) => floor(x).mul(duty).add(min(fract(x), float(duty)));
  /** Square wave filtered by the footprint f (in periods). */
  const square = (x: Node, duty: number, f: Node) => clamp(sqInt(x.add(f.mul(0.5)), duty).sub(sqInt(x.sub(f.mul(0.5)), duty)).div(f), 0, 1);
  /** Window [a, b] in x, filtered. */
  const windowAt = (x: Node, a: number, b: number, f: Node) => band(x.sub((a + b) / 2), float(b - a), f);

  // profile lines
  const inZone = max(crossA.mul(windowAt(v, -10, 4.6, fv)), crossB.mul(windowAt(toEnd, -10, 4.6, fv)));
  let white: Node = float(0), yellow: Node = float(0);
  const dash = square(v.add(dashPhase).div(DASH_PERIOD), 0.38, fv.div(DASH_PERIOD));
  for (let k = 0; k < MAX_LINES; k++) {
    const e = textureLoad(table, ivec2(int(k), int(profile)));
    const lu = e.x, lw = e.y, kind = e.z, color = e.w;
    const d = u.sub(lu);
    const solid = band(d, lw, fu);
    const double = band(d.sub(0.12), lw, fu).add(band(d.add(0.12), lw, fu));
    const isSolid = step(abs(kind.sub(1)), float(0.1));
    const isDash = step(abs(kind.sub(2)), float(0.1));
    const isDouble = step(abs(kind.sub(3)), float(0.1));
    const line = solid.mul(isSolid).add(solid.mul(dash).mul(isDash)).add(double.mul(isDouble));
    white = max(white, line.mul(step(color, float(0.5))));
    yellow = max(yellow, line.mul(step(float(0.5), color)));
  }
  const off = float(1).sub(inZone);
  // junction fans have no road coordinates (roadUV = 0): their profile lines must not be painted across the junction
  white = white.mul(off).mul(roadUV);
  yellow = yellow.mul(off).mul(roadUV);

  // pedestrian crossing and stop line at the junctions, in the regional style
  const zoneCross = max(crossA.mul(windowAt(v, 0.7, 3.6, fv)), crossB.mul(windowAt(toEnd, 0.7, 3.6, fv)));
  const bars = square(u.div(1.1).add(0.25), 0.5, fu.div(1.1)).mul(step(paintStyleU, float(2.5)));
  const edgeLines = max(max(windowAt(v, 0.7, 0.95, fv), windowAt(v, 3.35, 3.6, fv)).mul(crossA),
    max(windowAt(toEnd, 0.7, 0.95, fv), windowAt(toEnd, 3.35, 3.6, fv)).mul(crossB))
    .mul(step(abs(paintStyleU.sub(1)), float(0.5)).add(step(float(2.5), paintStyleU)));
  const zebra = max(bars.mul(zoneCross), edgeLines);
  // rails (ballast): no crossing or stop line on the track itself
  const railProfile = step(float(2.5), extra.x);
  // stop line only where one stops (stop: thicker; signal); yield: teeth
  const lineA = step(float(2.5), ruleA), lineB = step(float(2.5), ruleB);
  const thickA = select(abs(ruleA.sub(3)).lessThan(0.5), float(4.75), float(4.35)), thickB = select(abs(ruleB.sub(3)).lessThan(0.5), float(4.75), float(4.35));
  const sideA = crossA.mul(float(1).sub(oneWay)).mul(clamp(u.div(fu).add(0.5), 0, 1));
  const sideB = crossB.mul(max(oneWay, clamp(u.negate().div(fu).add(0.5), 0, 1)));
  const stopA = sideA.mul(lineA).mul(band(v.sub(thickA.add(3.95).mul(0.5)), thickA.sub(3.95), fv));
  const stopB = sideB.mul(lineB).mul(band(toEnd.sub(thickB.add(3.95).mul(0.5)), thickB.sub(3.95), fv));
  const tooth = (d: Node) => {
    const x = abs(fract(u.div(0.9)).sub(0.5)), y = d.sub(3.95).div(0.6);
    return step(x, float(0.32).mul(float(1).sub(y))).mul(step(float(0), y)).mul(step(y, float(1)));
  };
  const yieldA = sideA.mul(step(abs(ruleA.sub(2)), float(0.5))).mul(tooth(v));
  const yieldB = sideB.mul(step(abs(ruleB.sub(2)), float(0.5))).mul(tooth(toEnd));
  const crossPaint = max(zebra, max(max(stopA, stopB), max(yieldA, yieldB))).mul(float(1).sub(railProfile));

  // the lane the fragment is in: arrows near the junction and bus lane
  let selU: Node = float(0), selDir: Node = float(0), selW: Node = float(0), selT: Node = float(0), inLane: Node = float(0);
  for (let k = 0; k < MAX_LINES; k++) {
    const e = textureLoad(table, ivec2(int(k + MAX_LINES), int(profile)));
    const here = step(abs(u.sub(e.x)), e.z.mul(0.5)).mul(step(float(0.1), e.z));
    selU = mix(selU, e.x, here); selDir = mix(selDir, e.y, here); selW = mix(selW, e.z, here); selT = mix(selT, e.w, here);
    inLane = max(inLane, here);
  }
  inLane = inLane.mul(roadUV);
  const isRail = step(float(15.5), selT).mul(inLane);
  const isBus = step(float(7.5), selT.sub(isRail.mul(16))).mul(inLane);
  const turnsSet = selT.sub(isBus.mul(8)).sub(isRail.mul(16));
  // lanes in this direction and this one's index (0 = the rightmost for whoever drives in it)
  let nDir: Node = float(0), idx: Node = float(0);
  for (let k = 0; k < MAX_LINES; k++) {
    const e = textureLoad(table, ivec2(int(k + MAX_LINES), int(profile)));
    const same = step(float(0.1), e.z).mul(step(abs(e.y.sub(selDir)), float(0.5)));
    nDir = nDir.add(same);
    idx = idx.add(same.mul(select(selDir.greaterThan(0), step(e.x, selU.sub(0.01)), step(selU.add(0.01), e.x))));
  }
  const autoT = select(nDir.lessThan(1.5), float(7), select(idx.lessThan(0.5), float(6), select(idx.greaterThan(nDir.sub(1.5)), float(3), float(2))));
  // connections set at this end's junction: the arrow shows the chosen exits
  const ov = textureLoad(look.arrows, ivec2(segId.mod(int(512)), segId.div(int(512))));
  const ovCode = select(selDir.greaterThan(0), ov.y, ov.x);
  const ovTurns = mod(floor(ovCode.div(T.exp2(idx.mul(3)))), 8);
  const turnsEff = select(ovCode.greaterThan(0.5), ovTurns, select(turnsSet.greaterThan(0.5), turnsSet, autoT));
  const hasL = mod(turnsEff, 2), hasS = mod(floor(turnsEff.div(2)), 2), hasR = mod(floor(turnsEff.div(4)), 2);
  // arrow: 5 m before the stop line, pointing to the junction
  const approach = select(selDir.greaterThan(0), toEnd, v);
  const atJunction = select(selDir.greaterThan(0), crossB, crossA);
  const showArrow = inLane.mul(atJunction).mul(float(1).sub(isRail)).mul(max(max(step(float(1.5), nDir), step(float(0.5), turnsSet)), step(float(0.5), ovCode))).mul(step(approach, float(12.5))).mul(step(float(6.5), approach));
  const ax = u.sub(selU).mul(selDir), ay = float(12).sub(approach);
  const segD = (ax0: number, ay0: number, bx: number, by: number, r: number) => {
    const pax = ax.sub(ax0), pay = ay.sub(ay0);
    const ex = bx - ax0, ey = by - ay0;
    const h = clamp(pax.mul(ex).add(pay.mul(ey)).div(ex * ex + ey * ey), 0, 1);
    return T.length(vec2(pax.sub(h.mul(ex)), pay.sub(h.mul(ey)))).sub(r);
  };
  const headD = (tx: number, ty: number, dx: number, dy: number, len: number, hw: number) => {
    const l = Math.hypot(dx, dy); dx /= l; dy /= l;
    const rx = ax.sub(tx), ry = ay.sub(ty);
    const back = rx.mul(-dx).add(ry.mul(-dy));
    const side = abs(rx.mul(-dy).add(ry.mul(dx)));
    return max(side.sub(back.mul(hw / len)), max(back.negate(), back.sub(len)));
  };
  const BIG = 99;
  let dArrow: Node = select(hasS.greaterThan(0.5), min(segD(0, 0, 0, 3.4, 0.14), headD(0, 5, 0, 1, 1.6, 0.55)), segD(0, 0, 0, 2.6, 0.14));
  dArrow = min(dArrow, select(hasL.greaterThan(0.5), min(segD(0, 2.0, -0.7, 2.75, 0.14), headD(-1.45, 3.45, -1, 0.9, 1.1, 0.5)), float(BIG)));
  dArrow = min(dArrow, select(hasR.greaterThan(0.5), min(segD(0, 2.0, 0.7, 2.75, 0.14), headD(1.45, 3.45, 1, 0.9, 1.1, 0.5)), float(BIG)));
  const arrow = clamp(float(0.5).sub(dArrow.div(max(fu, fv))), 0, 1).mul(showArrow);

  const isAsphalt = step(abs(matId.sub(RMAT.Asphalt)), float(0.1));
  const isPlain = step(abs(matId.sub(RMAT.Plain)), float(0.1));
  const carriage = max(isAsphalt, isPlain);
  const p = positionWorld;
  const pix = max(fwidth(p.x), fwidth(p.z));

  // the asphalt as Roadcraft's (ROAD_SPACE_FRAGMENT): grain baked along the road (patches follow the lanes); junction
  // fans read it in world space. Wheel tracks lighter at ±0.85 m from the lane centre, oil in the middle, and the
  // edge outside the lanes darker. Wear comes per segment from the simulation (the whole map ages at no cost).
  const asphUV = mix(p.xz, vec2(u, v), roadUV);
  const asph = texture(ASPHALT_TEX, asphUV.div(ASPHALT_TILE)).r;
  const lc = abs(u.sub(selU));
  const tw = T.exp(lc.sub(0.85).div(0.3).pow(2).negate()).mul(inLane);

  // paint wears where the wheels run and where the asphalt is old (chipped by the grain), never to nothing
  const paintWear = float(1).sub(tw.mul(used).mul(0.55)).sub(smoothstep(float(0.62).sub(used.mul(0.2)), float(0.75).sub(used.mul(0.2)), asph).mul(0.35));
  white = max(max(white, arrow.mul(off)), crossPaint).mul(clamp(paintWear, 0.35, 1));
  yellow = yellow.mul(clamp(paintWear, 0.35, 1));

  // gutter: concrete channel along the curb, in slabs of 1 m, with a drain grate before each crossing and every 40 m
  const dEdge = min(u.sub(curbR), curbL.sub(u));
  const gutter = isAsphalt.mul(roadUV).mul(float(1).sub(railProfile)).mul(windowAt(dEdge, -0.05, GUTTER, fu));
  const drainAt = max(max(crossA.mul(windowAt(v, 5.2, 6.1, fv)), crossB.mul(windowAt(toEnd, 5.2, 6.1, fv))),
    windowAt(fract(v.div(40).add(0.5)).sub(0.5).mul(40), -0.45, 0.45, fv).mul(step(float(8), v)).mul(step(float(8), toEnd)));
  const drain = gutter.mul(drainAt).mul(windowAt(dEdge, 0.04, GUTTER - 0.04, fu));
  const slats = mix(float(0.55), square(v.mul(9), 0.45, fv.mul(9)), clamp(float(1).sub(pix.mul(10)), 0, 1));
  const gutterJoint = band(fract(v.add(0.5)).sub(0.5), float(0.015), fv);

  // manholes: iron lids in the lane centre, one every ~47 m per lane (some skipped)
  const mk = floor(v.div(MANHOLE_STEP));
  const mHash = fract(sin(mk.mul(17.31).add(segId.toFloat().mul(3.17)).add(selU.mul(5.3))).mul(43758.5));
  const mAlong = v.sub(mk.add(0.3).add(mHash.mul(0.4)).mul(MANHOLE_STEP));
  const mDist = length(vec2(mAlong, u.sub(selU)));
  const manhole = isAsphalt.mul(inLane).mul(float(1).sub(isRail)).mul(step(mHash, float(0.65))).mul(step(float(8), v)).mul(step(float(8), toEnd))
    .mul(clamp(float(0.34).sub(mDist).div(max(pix, float(0.002))).add(0.5), 0, 1));
  const lidRim = smoothstep(0.24, 0.3, mDist);
  const lidGrid = mix(float(0.5), max(square(u.mul(8), 0.3, fu.mul(8)), square(v.mul(8), 0.3, fv.mul(8))), clamp(float(1).sub(pix.mul(12)), 0, 1));

  // base colour with broad variation (asphalt and grass blotches)
  const blotch = mx_noise_float(p.xz.mul(0.08)).mul(0.06);
  let c: Node = sRGBTransferEOTF(col.xyz).mul(float(1).add(blotch));
  // Roadcraft 4.0's surfaces (cooked/surfaces): asphalt every 10.4 m across (u) and along (v) the road, the footway's
  // pavers every 7.2 m, the kerb every 3.2 m (on its face, along and up), the verge's grass every 8.8 m; junction fans
  // read them in world space. The profile's colour tints them (concrete roads, bus lanes keep their tone)
  const tile = (size: number, uv: Node) => uv.div(size);
  const asphMap = sRGBTransferEOTF(texture(COOKED['asphalt.map'], tile(10.4, asphUV)).xyz);
  const tint = (mean: number[]) => sRGBTransferEOTF(col.xyz).div(sRGBTransferEOTF(vec3(mean[0], mean[1], mean[2])));
  const asphaltSurf = isAsphalt.mul(step(extra.x, float(0.5)));
  c = mix(c, asphMap.mul(tint(PROFILE_ASPHALT)).mul(float(1).add(blotch)), asphaltSurf);
  {
    const grain = asph.sub(0.5).mul(2).mul(float(1).sub(asphaltSurf));
    const track = tw.mul(float(0.08).sub(used.mul(0.26)));
    const oil = T.exp(lc.div(0.32).pow(2).negate()).mul(float(0.1).add(used.mul(0.06))).mul(inLane);
    const laneWear = float(1).sub(isRail).mul(track.sub(oil)).mul(isAsphalt);
    const edgeDark = float(1).sub(inLane).mul(0.12).mul(isAsphalt).mul(roadUV);
    const patch = smoothstep(float(0.9).sub(used.mul(0.35)), float(0.93).sub(used.mul(0.35)), asph).mul(step(float(0.35), used)).mul(0.14);
    c = c.mul(float(1).add(carriage.mul(grain.add(laneWear).sub(edgeDark).add(used.mul(0.07)).sub(patch))));
  }
  const concreteC = sRGBTransferEOTF(vec3(0.6, 0.585, 0.55));
  c = mix(c, concreteC.mul(float(1).add(asph.sub(0.5).mul(0.25))).mul(float(1).sub(gutterJoint.mul(0.3))), gutter);
  c = mix(c, sRGBTransferEOTF(vec3(0.1, 0.1, 0.105)).mul(mix(float(1.6), float(0.6), slats)), drain);
  c = mix(c, sRGBTransferEOTF(vec3(0.2, 0.19, 0.18)).mul(mix(float(1), float(0.55), lidRim)).mul(mix(float(0.8), float(1.25), lidGrid)), manhole);

  // curb stones: blocks of 1 m along the road, each with its own tone
  const isCurb = step(abs(matId.sub(RMAT.Curb)), float(0.1)).mul(roadUV);
  const stone = floor(v);
  const stoneTone = fract(sin(stone.mul(78.23).add(segId.toFloat().mul(11.7)).add(u.mul(3.1).floor())).mul(43758.5)).mul(0.1).sub(0.05);
  const stoneJoint = band(fract(v.add(0.5)).sub(0.5), float(0.012), fv);
  c = c.mul(float(1).add(isCurb.mul(stoneTone.sub(stoneJoint.mul(0.35)))));
  {
    const face = step(abs(nW.y), float(0.5));
    const kerbUV = vec2(v, mix(u, p.y, face));
    const kerb = sRGBTransferEOTF(texture(COOKED['kerb.map'], tile(3.2, kerbUV)).xyz);
    c = mix(c, kerb.mul(float(1).sub(stoneJoint.mul(0.3))), isCurb);
  }

  // sidewalk: concrete pavers in running bond along the road (2 in 3 segments) or 1.5 m panels with joints, in road
  // space (they follow the curve); tactile paving behind the curb at each crossing
  const isSidewalk = step(abs(matId.sub(RMAT.Sidewalk)), float(0.1));
  const isPavers = step(abs(matId.sub(RMAT.Pavers)), float(0.1));
  const isStone = step(abs(matId.sub(RMAT.Stone)), float(0.1));
  const walk = max(isSidewalk, max(isPavers, isStone));
  const segPick = fract(sin(segId.toFloat().mul(12.9898)).mul(43758.5));
  void segPick;
  // the footway is the 4.0's (interlocking pavers in running bond, baked): the procedural pavers and slabs give way
  const usePavers = float(0);
  c = c.mul(float(1).add(usePavers));
  const sw = mix(p.xz, vec2(u, v), roadUV);
  const g = fract(sw.div(1.5));
  const fw2 = max(pix, float(0.001)).div(1.5);
  const joint = max(band(g.x.sub(0.5), float(0.94), fw2), band(g.y.sub(0.5), float(0.94), fw2));
  const slabs = float(0).mul(isSidewalk);
  // on the faces (the sidewalk's front and its skirt) u is fixed along them: (v, height) there
  const wallFace = step(abs(nW.y), float(0.5));
  const footUV = tile(7.2, mix(vec2(v, u).mul(roadUV).add(p.xz.mul(float(1).sub(roadUV))), vec2(v, p.y), wallFace));
  // the faces are cast concrete (the kerb's texture), not pavers
  const sideC = mix(sRGBTransferEOTF(texture(COOKED['footway.map'], footUV).xyz), sRGBTransferEOTF(texture(COOKED['kerb.map'], tile(3.2, vec2(v, p.y))).xyz).mul(0.85), wallFace);
  c = mix(c, sideC, isSidewalk);
  const fineSlab = clamp(float(1).sub(fw2.mul(8)), 0, 1);
  c = c.mul(float(1).sub(float(1).sub(joint).mul(fineSlab).mul(slabs).mul(0.3)));
  // each panel its own tone (±5%) and a little grime
  const slabId = floor(sw.div(1.5));
  const slabHash = fract(sin(slabId.x.mul(127.1).add(slabId.y.mul(311.7))).mul(43758.5));
  c = c.mul(float(1).add(slabs.mul(slabHash.sub(0.5).mul(0.1).sub(asph.sub(0.5).mul(0.08))).mul(fineSlab)));
  const dBehind = min(curbR.sub(0.2).sub(u), u.sub(curbL.add(0.2)));
  const tactile = walk.mul(roadUV).mul(windowAt(dBehind, 0.03, TACTILE, fu))
    .mul(max(crossA.mul(windowAt(v, 0.9, 3.4, fv)), crossB.mul(windowAt(toEnd, 0.9, 3.4, fv))));
  const studs = step(length(fract(sw.mul(14)).sub(0.5)), float(0.28));
  const studShade = mix(float(1), mix(float(0.86), float(1.12), studs), clamp(float(1).sub(pix.mul(25)), 0, 1));
  c = mix(c, sRGBTransferEOTF(vec3(0.86, 0.66, 0.14)).mul(studShade), tactile);

  const isGrass = step(abs(matId.sub(RMAT.Grass)), float(0.1));
  c = mix(c, sRGBTransferEOTF(texture(COOKED['verge.map'], tile(8.8, p.xz)).xyz), isGrass);

  // carriageway surfaces: concrete slabs, cobbles, pavers, Portuguese stone (vanish when a stone is under a pixel)
  const surf = extra.x;
  const cobble = carriage.mul(step(float(1.5), surf));
  const concrete = carriage.mul(step(abs(surf.sub(1)), float(0.5)));
  // concrete: a joint every 4.5 m and a tone per slab
  const slab = floor(v.div(4.5));
  const slabTone = fract(sin(slab.mul(91.7).add(segId.toFloat().mul(13.1))).mul(43758.5)).mul(0.08).sub(0.04);
  const jv = band(fract(v.div(4.5).add(0.5)).sub(0.5).mul(4.5), float(0.04), fv);
  c = c.mul(float(1).add(concrete.mul(slabTone.sub(jv.mul(0.35)))));
  // pavers: 20 × 10 cm bricks in running bond
  const bq = p.xz.div(vec2(0.2, 0.1));
  const bRow = floor(bq.y);
  const bx = fract(bq.x.add(mod(bRow, 2).mul(0.5))), by = fract(bq.y);
  const grout = max(step(bx, float(0.08)), step(by, float(0.12)));
  const paversFine = clamp(float(1).sub(pix.mul(12)), 0, 1);
  c = c.mul(float(1).sub(isPavers.mul(grout).mul(paversFine).mul(0.3)));
  // stones (cobbles and Portuguese): cells with grout; only where they exist
  const stones = Fn(() => {
    const shade = float(1).toVar();
    If(cobble.add(isStone).greaterThan(0.5), () => {
      const scale = select(isStone.greaterThan(0.5), float(9), float(4.2));
      const w = mx_worley_noise_vec2(p.xz.mul(scale));
      const edge = clamp(w.y.sub(w.x).mul(4), 0, 1);
      const fine = clamp(float(1).sub(pix.mul(scale).mul(2.5)), 0, 1);
      shade.assign(mix(float(1), mix(float(0.55), float(1.06), edge), fine));
    });
    return shade;
  })();
  c = c.mul(stones);
  // Portuguese stone: black waves on cream (promenade)
  const wave = step(float(0.62), sin(p.x.mul(0.55).add(sin(p.z.mul(0.42)).mul(1.8))).mul(0.5).add(0.5));
  c = mix(c, c.mul(0.18), isStone.mul(wave).mul(float(1).sub(tactile)));

  // rails: sleepers every 0.65 m and the two steel rails (vanish when under a pixel)
  const ru = u.sub(selU);
  const sleeper = square(v.div(0.65), 0.38, fv.div(0.65)).mul(step(abs(ru), float(1.3)));
  const railLine = max(band(abs(ru).sub(0.75), float(0.09), fu), float(0));
  const railFine = clamp(float(1).sub(pix.mul(4)), 0, 1);
  const rails = isRail.mul(isAsphalt);
  c = mix(c, sRGBTransferEOTF(vec3(0.42, 0.36, 0.3)), sleeper.mul(rails).mul(mix(float(0.35), float(1), railFine)));
  c = mix(c, sRGBTransferEOTF(vec3(0.62, 0.62, 0.64)), railLine.mul(rails).mul(mix(float(0.5), float(1), railFine)));
  // ballast: fine gravel
  c = c.mul(float(1).add(railProfile.mul(isAsphalt).mul(mx_noise_float(p.xz.mul(6)).mul(0.18)).mul(clamp(float(1).sub(pix.mul(3)), 0, 1))));
  // bus lane: reddish asphalt
  c = mix(c, sRGBTransferEOTF(vec3(0.42, 0.16, 0.13)), isBus.mul(isAsphalt).mul(0.8));
  const paintMask = isAsphalt.mul(float(1).sub(drain)).mul(float(1).sub(manhole));
  const paintW = clamp(white.mul(paintMask), 0, 1);
  const paintY = clamp(yellow.mul(paintMask), 0, 1);
  c = mix(c, sRGBTransferEOTF(paintWhiteU), paintW);
  c = mix(c, sRGBTransferEOTF(paintYellowU), paintY);

  // density cars: away from the micro window, each lane shows cars moving by the segment's occupancy (0 to 1 =
  // bumper to bumper)
  const occ = textureLoad(look.occupancy, ivec2(segId.mod(int(512)), segId.div(int(512))));
  const far = smoothstep(1250, 1650, length(p.xz.sub(look.center)));
  let carMask: Node = float(0), carTint: Node = float(0);
  for (let k = 0; k < 4; k++) {
    const e = textureLoad(table, ivec2(int(k + MAX_LINES), int(profile)));
    const lu = e.x, ldir = e.y, lw = e.z;
    const o = select(ldir.greaterThan(0), occ.x, occ.y);
    const spacing = float(7.5).div(max(o, float(0.02)));
    const speed = float(13).mul(float(1).sub(o).max(0.05));
    const along = v.mul(ldir).sub(time.mul(speed)).div(spacing).add(float(k).mul(0.37));
    const cell = floor(along);
    const jitter = fract(sin(cell.mul(12.9898).add(segId.toFloat().mul(78.233))).mul(43758.5453));
    const car = square(along.add(jitter.mul(0.3)), 4.3 / 7.5, fv.div(spacing)).mul(step(float(0.01), o)).mul(band(u.sub(lu), lw.mul(0.55), fu)).mul(step(float(0.1), lw));
    carMask = max(carMask, car);
    carTint = select(car.greaterThan(carMask.sub(0.001)), jitter, carTint);
  }
  const carColor = mix(sRGBTransferEOTF(vec3(0.85, 0.85, 0.83)), sRGBTransferEOTF(vec3(0.1, 0.1, 0.12)), step(float(0.5), carTint));
  c = mix(c, mix(carColor, sRGBTransferEOTF(vec3(0.6, 0.12, 0.1)), step(float(0.85), carTint)), carMask.mul(far).mul(isAsphalt).mul(float(1).sub(railProfile)));

  // traffic view: each direction's colour by occupancy (u < 0 is the a → b side)
  const sideOcc = select(oneWay.greaterThan(0.5).or(u.lessThan(0)), occ.x, occ.y);
  const ramp = mix(mix(vec3(0.15, 0.75, 0.25), vec3(0.95, 0.8, 0.15), clamp(sideOcc.mul(2.2), 0, 1)),
    vec3(0.9, 0.12, 0.1), clamp(sideOcc.mul(2.2).sub(1), 0, 1));
  const traffic = trafficOverlayU.mul(isAsphalt);
  c = mix(c, sRGBTransferEOTF(ramp).mul(0.7), traffic.mul(0.85));

  // zone strip: only with the tool, half transparent by dithering
  const isZone = step(abs(matId.sub(RMAT.Zone)), float(0.1));
  const zoneShow = zoneOverlayU.mul(step(T.interleavedGradientNoise(T.screenCoordinate.xy), float(0.7)));
  m.maskNode = lodFadeMask().and(isZone.lessThan(0.5).or(zoneShow.greaterThan(0.5)));
  // at night: the lamps' pools of light (same step and sides as the props in jobs/props.ts)
  const lt = textureLoad(table, ivec2(int(MAX_LINES * 2), int(profile)));
  const kf = v.sub(LAMP_FIRST).div(LAMP_STEP);
  const pool = (k: Node) => {
    const dv = v.sub(k.mul(LAMP_STEP).add(LAMP_FIRST));
    // median: two arms (±1.9 m from the middle); no median: lamps always on the right side (if there is a sidewalk)
    const sideU = select(abs(lt.y).greaterThan(0.01), lt.y, lt.z);
    const du1 = select(lt.x.greaterThan(0.5), u.sub(lt.w.add(1.9)), u.sub(sideU));
    const du2 = select(lt.x.greaterThan(0.5), u.sub(lt.w.sub(1.9)), float(99));
    const gl = (du: Node) => exp(du.mul(du).add(dv.mul(dv)).div(-2 * 7.5 * 7.5));
    return gl(du1).add(gl(du2)).mul(step(float(-0.5), k));
  };
  const k0 = floor(kf);
  const light = pool(k0).add(pool(k0.add(1)));
  // junction fans: lit evenly by the corner lamps (they carry no road coordinates for the pools)
  const lampLight = c.mul(sRGBTransferEOTF(vec3(1, 0.82, 0.55))).mul(light.mul(roadUV).add(isPlain.mul(0.55)).mul(nightU).mul(1.6));
  m.emissiveNode = sRGBTransferEOTF(col.xyz).mul(isZone).mul(0.35).add(lampLight).add(sRGBTransferEOTF(ramp).mul(traffic).mul(0.25));

  // roughness: paint and the iron lids are smoother than the asphalt; concrete in between
  const baseRough = select(carriage.greaterThan(0.5), mix(float(0.92), float(0.6), clamp(paintW.add(paintY), 0, 1)), float(0.85));
  {
    const an = texture(COOKED['asphalt.normal'], tile(10.4, asphUV)).xyz.mul(2).sub(1).mul(asphaltSurf);
    const fn = texture(COOKED['footway.normal'], footUV).xyz.mul(2).sub(1).mul(isSidewalk);
    const k = clamp(float(1).sub(pix.mul(2)), 0, 1).mul(step(float(0.5), nW.y));
    const bend = an.xy.add(fn.xy).mul(k).mul(0.8);
    m.normalNode = transformNormalToView(normalize(nW.add(vec3(bend.x, 0, bend.y))));
  }
  const [wc, wr] = wetLook(c, mix(mix(baseRough, float(0.8), gutter), float(0.45), manhole));
  m.colorNode = vec4(wc, 1);
  m.roughnessNode = wr;
  m.metalnessNode = manhole.mul(0.4);
  return m;
}
