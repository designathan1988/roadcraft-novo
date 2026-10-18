// Vias na tela: camada por células (malha detalhada perto, fita simplificada
// por ladrilho longe) e o material com as marcas pintadas no shader.

import * as THREE from 'three/webgpu';
import { CELLS_PER_TILE, MAP_CELLS, MAP_TILES } from '../config.ts';
import { Dirty, cellId, cellOriginX, tileOriginX, type DirtyCells } from '../core/grid.ts';
import type { JobPool } from '../jobs/pool.ts';
import { roadGraphTransfer } from '../jobs/protocol.ts';
import { RMAT, RoadCode } from '../jobs/roadMesh.ts';
import type { RoadNetwork } from '../roads/network.ts';
import { MAX_LINES, MAX_PROFILES, TABLE_W, onProfileAdded, profileCount, writeProfileRow } from '../roads/profiles.ts';
import { LAMP_FIRST, LAMP_STEP } from '../jobs/props.ts';
import { nightU } from './scene.ts';
import { wetLook } from './weather.ts';
import { CellLayer, type LayerSource } from './cellLayer.ts';
import { ASPHALT_TEX, ASPHALT_TILE, FOOTWAY_TEX, FOOTWAY_TILE, GRASS_TEX, GRASS_TILE } from './surfaceBake.ts';
import { T, useCompactVertex, type Node, lodFadeMask } from './tsl.ts';

const {
  attribute, vec2, vec3, vec4, float, int, ivec2, abs, mix, clamp, fract, fwidth, max, min, floor, Fn, If, mx_worley_noise_vec2,
  textureLoad, sRGBTransferEOTF, positionWorld, mx_noise_float, select, mod, step, uniform, length, smoothstep, time, sin,
  exp, texture,
} = T;

/** O que o shader das vias precisa do trânsito para os carros de densidade. */
export interface TrafficLook {
  /** Por trecho (512 de largura): R = ocupação a→b, G = b→a, B = desgaste do asfalto pelo uso (simulação). */
  occupancy: THREE.DataTexture;
  /** Centro da janela micro (alvo da câmera). */
  center: Node;
  /** Setas ajustadas à mão por ponta de trecho (R = ponta a, G = ponta b; 3 bits por faixa; 0 = do perfil). */
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

export function createRoads(net: RoadNetwork, pool: JobPool, dirty: DirtyCells, look: TrafficLook): CellLayer {
  const src: LayerSource = {
    hasContent: (c) => net.cellCount[c] > 0,
    buildCell: (c, level, priority, done) => {
      const segs: number[] = [], nodes: number[] = [];
      net.cellContents(c, segs, nodes);
      const graph = net.gather(segs, nodes);
      const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
      pool.submit('roadMesh', { graph, originX: cellOriginX(cx), originZ: cellOriginX(cz), extent: 512, lod: level },
        (r) => done(r.mesh), { key: `road${level}:${c}`, priority: priority - 1, transfer: roadGraphTransfer(graph) });
    },
    buildTile: (t, priority, done) => {
      const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
      const segs: number[] = [], nodes: number[] = [];
      for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) net.cellContents(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j), segs, nodes);
      if (segs.length === 0 && nodes.length === 0) { done(null); return; }
      const graph = net.gather(segs, nodes);
      pool.submit('roadMesh', { graph, originX: tileOriginX(tx), originZ: tileOriginX(tz), extent: 2048, lod: 1 },
        (r) => done(r.mesh), { key: `roadtile:${t}`, priority, transfer: roadGraphTransfer(graph) });
    },
  };
  return new CellLayer(src, dirty, Dirty.Roads, createRoadMaterial(look), { near: 1400, evict: 2200, margin: 80, shadows: false, far: 5500, detail: 600, budget: 192e6 }, true);
}

/** 1 com a ferramenta de zona: mostra as faixas de zona ao lado das vias. */
export const zoneOverlayU = T.uniform(0);
/** Pintura das vias (estilo nas opções): cor da linha branca e da linha central. */
export const paintWhiteU = T.uniform(new THREE.Vector3(0.92, 0.92, 0.88));
export const paintYellowU = T.uniform(new THREE.Vector3(0.95, 0.72, 0.15));
/** Brasil, EUA, Europa, Clássica: [branca, central] em sRGB. */
export const PAINT_STYLES: Record<string, [[number, number, number], [number, number, number]]> = {
  br: [[0.92, 0.92, 0.88], [0.95, 0.72, 0.15]],
  us: [[0.95, 0.95, 0.95], [0.98, 0.78, 0.05]],
  eu: [[0.95, 0.95, 0.93], [0.95, 0.95, 0.93]],
  classic: [[0.93, 0.9, 0.8], [0.85, 0.75, 0.45]],
};
export function setPaintStyle(k: string): void {
  const [w, y] = PAINT_STYLES[k] ?? PAINT_STYLES.br;
  paintWhiteU.value.set(...w); paintYellowU.value.set(...y);
}

/** 1 na vista de trânsito: o asfalto de cada sentido pinta verde → amarelo → vermelho pela ocupação. */
export const trafficOverlayU = T.uniform(0);

export function createRoadMaterial(look: TrafficLook): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  useCompactVertex(m, 'vRoadNormal');
  // profundidade invertida: deslocamento positivo puxa para perto da câmera
  m.polygonOffset = true;
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 2;

  // tabela dos perfis (linhas, faixas, postes, piso): uma linha por perfil, refeita quando um perfil novo chega
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
  const code = floor(road.w.add(0.5));
  const segId = int(floor(code.div(16)));
  const tag = floor(attribute('position', 'vec4').w.mul(32767).add(0.5));
  const profile = mod(tag, 256);
  // regra de cada ponta (Rule): 2 dê a preferência, 3 pare, 4 semáforo
  const ruleA = mod(floor(tag.div(256)), 8), ruleB = mod(floor(tag.div(2048)), 8);
  const flags = mod(code, 16);
  const bit = (b: number) => step(float(0.5), mod(floor(flags.div(b)), 2));
  const crossA = bit(RoadCode.CrossA), crossB = bit(RoadCode.CrossB), oneWay = bit(RoadCode.OneWay);

  // derivadas separadas: linhas ao longo da via dependem de u, tracejado de v
  const fu = max(fwidth(u), float(0.003));
  const fv = max(fwidth(v), float(0.003));
  /** Cobertura exata (filtro de caixa) de uma faixa de largura w em torno de 0. */
  const band = (d: Node, w: Node, f: Node) =>
    clamp(min(d.add(f.mul(0.5)), w.mul(0.5)).sub(max(d.sub(f.mul(0.5)), w.mul(-0.5))).div(f), 0, 1);
  /** Integral da onda quadrada (período 1, fração ligada duty). */
  const sqInt = (x: Node, duty: number) => floor(x).mul(duty).add(min(fract(x), float(duty)));
  /** Onda quadrada filtrada pela pegada f (em períodos). */
  const square = (x: Node, duty: number, f: Node) => clamp(sqInt(x.add(f.mul(0.5)), duty).sub(sqInt(x.sub(f.mul(0.5)), duty)).div(f), 0, 1);
  /** Janela [a, b] em x, filtrada. */
  const windowAt = (x: Node, a: number, b: number, f: Node) => band(x.sub((a + b) / 2), float(b - a), f);

  // linhas do perfil
  const inZone = max(crossA.mul(windowAt(v, -10, 4.6, fv)), crossB.mul(windowAt(toEnd, -10, 4.6, fv)));
  let white: Node = float(0), yellow: Node = float(0);
  const dash = square(v.div(9), 0.38, fv.div(9));
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
  white = white.mul(off);
  yellow = yellow.mul(off);

  // faixa de pedestre (zebra) e linha de retenção junto aos cruzamentos
  const zebraStripes = square(u.div(1.1).add(0.25), 0.5, fu.div(1.1));
  const zebra = zebraStripes.mul(max(crossA.mul(windowAt(v, 0.7, 3.6, fv)), crossB.mul(windowAt(toEnd, 0.7, 3.6, fv))));
  // trilhos (lastro): sem faixa de pedestre nem retenção no próprio trilho
  const railProfile = step(float(2.5), textureLoad(table, ivec2(int(MAX_LINES * 2 + 1), int(profile))).x);
  // linha de retenção só onde se para (pare: mais grossa; semáforo); dê a preferência: dentes
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
  white = max(white, max(zebra, max(max(stopA, stopB), max(yieldA, yieldB))).mul(float(1).sub(railProfile)));

  // faixa em que o fragmento está: setas perto do cruzamento e faixa de ônibus
  let selU: Node = float(0), selDir: Node = float(0), selW: Node = float(0), selT: Node = float(0), inLane: Node = float(0);
  for (let k = 0; k < MAX_LINES; k++) {
    const e = textureLoad(table, ivec2(int(k + MAX_LINES), int(profile)));
    const here = step(abs(u.sub(e.x)), e.z.mul(0.5)).mul(step(float(0.1), e.z));
    selU = mix(selU, e.x, here); selDir = mix(selDir, e.y, here); selW = mix(selW, e.z, here); selT = mix(selT, e.w, here);
    inLane = max(inLane, here);
  }
  const isRail = step(float(15.5), selT).mul(inLane);
  const isBus = step(float(7.5), selT.sub(isRail.mul(16))).mul(inLane);
  const turnsSet = selT.sub(isBus.mul(8)).sub(isRail.mul(16));
  // quantas faixas no sentido e o índice desta (0 = a mais à direita de quem anda)
  let nDir: Node = float(0), idx: Node = float(0);
  for (let k = 0; k < MAX_LINES; k++) {
    const e = textureLoad(table, ivec2(int(k + MAX_LINES), int(profile)));
    const same = step(float(0.1), e.z).mul(step(abs(e.y.sub(selDir)), float(0.5)));
    nDir = nDir.add(same);
    idx = idx.add(same.mul(select(selDir.greaterThan(0), step(e.x, selU.sub(0.01)), step(selU.add(0.01), e.x))));
  }
  const autoT = select(nDir.lessThan(1.5), float(7), select(idx.lessThan(0.5), float(6), select(idx.greaterThan(nDir.sub(1.5)), float(3), float(2))));
  // conexões ajustadas no cruzamento desta ponta: a seta é a das saídas escolhidas
  const ov = textureLoad(look.arrows, ivec2(segId.mod(int(512)), segId.div(int(512))));
  const ovCode = select(selDir.greaterThan(0), ov.y, ov.x);
  const ovTurns = mod(floor(ovCode.div(T.exp2(idx.mul(3)))), 8);
  const turnsEff = select(ovCode.greaterThan(0.5), ovTurns, select(turnsSet.greaterThan(0.5), turnsSet, autoT));
  const hasL = mod(turnsEff, 2), hasS = mod(floor(turnsEff.div(2)), 2), hasR = mod(floor(turnsEff.div(4)), 2);
  // seta: 5 m antes da linha de retenção, apontando para o cruzamento
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
  white = max(white, arrow.mul(off));

  const isAsphalt = step(abs(matId.sub(RMAT.Asphalt)), float(0.1));
  const paintW = white.mul(isAsphalt);
  const paintY = yellow.mul(isAsphalt);

  // cor base com variação larga (manchas de asfalto, grama)
  const p = positionWorld;
  const blotch = mx_noise_float(p.xz.mul(0.08)).mul(0.06);
  let c: Node = sRGBTransferEOTF(col.xyz).mul(float(1).add(blotch));
  const isSidewalk = step(abs(matId.sub(RMAT.Sidewalk)), float(0.1));
  // asfalto como o do roadcraft: grão fino (some de longe), trilha das rodas mais clara a ±0,85 m do centro da faixa,
  // óleo no meio, e a beira fora das faixas (sarjeta, acostamento) mais escura
  {
    // brita, remendos e manchas assados (`surfaceBake.ts`): ao longo da via, então os remendos seguem a faixa
    const asph = texture(ASPHALT_TEX, vec2(u, v).div(ASPHALT_TILE)).r;
    const grain = asph.sub(0.5).mul(2);
    const lc = abs(u.sub(selU));
    // desgaste pelo uso (roadcraft `wear.ts`, aqui por trecho e vindo da simulação: o mapa inteiro envelhece sem
    // custo): a trilha das rodas escurece de borracha, o asfalto todo perde o preto e, gasto, ganha remendos
    const used = textureLoad(look.occupancy, ivec2(segId.mod(int(512)), segId.div(int(512)))).z;
    const tw = T.exp(lc.sub(0.85).div(0.3).pow(2).negate());
    const track = tw.mul(float(0.08).sub(used.mul(0.26)));
    const oil = T.exp(lc.div(0.32).pow(2).negate()).mul(float(0.1).add(used.mul(0.06)));
    const laneWear = inLane.mul(float(1).sub(isRail)).mul(track.sub(oil));
    const gutter = float(1).sub(inLane).mul(0.12);
    const patch = smoothstep(float(0.9).sub(used.mul(0.35)), float(0.93).sub(used.mul(0.35)), asph).mul(step(float(0.35), used)).mul(0.14);
    c = c.mul(float(1).add(isAsphalt.mul(grain.add(laneWear).sub(gutter).add(used.mul(0.07)).sub(patch))));
  }
  // calçada: bloquete de concreto em fiada corrida ao longo da via (2 em cada 3 trechos) ou placas de 1,5 m
  const segPick = fract(sin(segId.toFloat().mul(12.9898)).mul(43758.5));
  const usePavers = isSidewalk.mul(step(segPick, float(0.66)));
  const foot = texture(FOOTWAY_TEX, vec2(v, u).div(FOOTWAY_TILE)).r;
  c = c.mul(float(1).add(usePavers.mul(foot.sub(0.5).mul(2.6))));
  const g = fract(p.xz.div(1.5));
  const fw2 = max(fwidth(p.xz.x), float(0.001)).div(1.5);
  const joint = max(band(g.x.sub(0.5), float(0.94), fw2), band(g.y.sub(0.5), float(0.94), fw2));
  const slabs = isSidewalk.sub(usePavers);
  const jointMask = float(1).sub(joint).mul(clamp(float(1).sub(fw2.mul(8)), 0, 1)).mul(slabs);
  c = c.mul(float(1).sub(jointMask.mul(0.25)));
  // cada placa da calçada com o seu tom (±4%)
  const slabId = floor(p.xz.div(1.5));
  const slabHash = fract(sin(slabId.x.mul(127.1).add(slabId.y.mul(311.7))).mul(43758.5));
  c = c.mul(float(1).add(slabs.mul(slabHash.sub(0.5).mul(0.08)).mul(clamp(float(1).sub(fw2.mul(8)), 0, 1))));
  const isGrass = step(abs(matId.sub(RMAT.Grass)), float(0.1));
  c = c.mul(mix(vec3(1, 1, 1), texture(GRASS_TEX, p.xz.div(GRASS_TILE)).xyz.mul(2), isGrass));

  // pisos: concreto em placas, paralelepípedo, bloquete, pedra portuguesa (somem quando a pedra fica menor que o pixel)
  const surf = textureLoad(table, ivec2(int(MAX_LINES * 2 + 1), int(profile))).x;
  const isPlain = step(abs(matId.sub(RMAT.Plain)), float(0.1));
  const carriage = max(step(abs(matId.sub(RMAT.Asphalt)), float(0.1)), isPlain);
  const isPavers = step(abs(matId.sub(RMAT.Pavers)), float(0.1));
  const isStone = step(abs(matId.sub(RMAT.Stone)), float(0.1));
  const pix = max(fwidth(p.x), fwidth(p.z));
  const cobble = carriage.mul(step(float(1.5), surf));
  const concrete = carriage.mul(step(abs(surf.sub(1)), float(0.5)));
  // concreto: junta a cada 4,5 m e tom por placa
  const slab = floor(v.div(4.5));
  const slabTone = fract(sin(slab.mul(91.7).add(segId.toFloat().mul(13.1))).mul(43758.5)).mul(0.08).sub(0.04);
  const jv = band(fract(v.div(4.5).add(0.5)).sub(0.5).mul(4.5), float(0.04), fv);
  c = c.mul(float(1).add(concrete.mul(slabTone.sub(jv.mul(0.35)))));
  // bloquete: tijolinhos 20 × 10 cm desencontrados
  const bq = p.xz.div(vec2(0.2, 0.1));
  const bRow = floor(bq.y);
  const bx = fract(bq.x.add(mod(bRow, 2).mul(0.5))), by = fract(bq.y);
  const grout = max(step(bx, float(0.08)), step(by, float(0.12)));
  const paversFine = clamp(float(1).sub(pix.mul(12)), 0, 1);
  c = c.mul(float(1).sub(isPavers.mul(grout).mul(paversFine).mul(0.3)));
  // pedras (paralelepípedo e portuguesa): células com rejunte; só onde existem
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
  // pedra portuguesa: ondas pretas sobre o creme (calçadão)
  const wave = step(float(0.62), sin(p.x.mul(0.55).add(sin(p.z.mul(0.42)).mul(1.8))).mul(0.5).add(0.5));
  c = mix(c, c.mul(0.18), isStone.mul(wave));

  // trilhos: dormentes a cada 0,65 m e os dois trilhos de aço (somem quando ficam menores que o pixel)
  const ru = u.sub(selU);
  const sleeper = square(v.div(0.65), 0.38, fv.div(0.65)).mul(step(abs(ru), float(1.3)));
  const railLine = max(band(abs(ru).sub(0.75), float(0.09), fu), float(0));
  const railFine = clamp(float(1).sub(pix.mul(4)), 0, 1);
  const rails = isRail.mul(isAsphalt);
  c = mix(c, sRGBTransferEOTF(vec3(0.42, 0.36, 0.3)), sleeper.mul(rails).mul(mix(float(0.35), float(1), railFine)));
  c = mix(c, sRGBTransferEOTF(vec3(0.62, 0.62, 0.64)), railLine.mul(rails).mul(mix(float(0.5), float(1), railFine)));
  // lastro: cascalho miúdo
  c = c.mul(float(1).add(railProfile.mul(isAsphalt).mul(mx_noise_float(p.xz.mul(6)).mul(0.18)).mul(clamp(float(1).sub(pix.mul(3)), 0, 1))));
  // faixa de ônibus: asfalto avermelhado
  c = mix(c, sRGBTransferEOTF(vec3(0.42, 0.16, 0.13)), isBus.mul(isAsphalt).mul(0.8));
  const paintWhite = sRGBTransferEOTF(paintWhiteU);
  const paintYellow = sRGBTransferEOTF(paintYellowU);
  c = mix(c, paintWhite, clamp(paintW, 0, 1));
  c = mix(c, paintYellow, clamp(paintY, 0, 1));

  // carros de densidade: longe da janela micro, cada faixa mostra carros
  // andando conforme a ocupação do trecho (de 0 a 1 = para-choque com para-choque)
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

  // vista de trânsito: cor do sentido pela ocupação (u < 0 é a mão de a → b)
  const sideOcc = select(oneWay.greaterThan(0.5).or(u.lessThan(0)), occ.x, occ.y);
  const ramp = mix(mix(vec3(0.15, 0.75, 0.25), vec3(0.95, 0.8, 0.15), clamp(sideOcc.mul(2.2), 0, 1)),
    vec3(0.9, 0.12, 0.1), clamp(sideOcc.mul(2.2).sub(1), 0, 1));
  const traffic = trafficOverlayU.mul(isAsphalt);
  c = mix(c, sRGBTransferEOTF(ramp).mul(0.7), traffic.mul(0.85));

  // faixa de zona: só com a ferramenta, meio transparente por pontilhado
  const isZone = step(abs(matId.sub(RMAT.Zone)), float(0.1));
  const zoneShow = zoneOverlayU.mul(step(T.interleavedGradientNoise(T.screenCoordinate.xy), float(0.7)));
  m.maskNode = lodFadeMask().and(isZone.lessThan(0.5).or(zoneShow.greaterThan(0.5)));
  // à noite: poças de luz dos postes (mesmo passo e lados que as peças em jobs/props.ts)
  const lt = textureLoad(table, ivec2(int(MAX_LINES * 2), int(profile)));
  const kf = v.sub(LAMP_FIRST).div(LAMP_STEP);
  const pool = (k: Node) => {
    const dv = v.sub(k.mul(LAMP_STEP).add(LAMP_FIRST));
    // canteiro: dois braços (±1,9 m do meio); sem canteiro: postes sempre do lado direito (se houver calçada)
    const sideU = select(abs(lt.y).greaterThan(0.01), lt.y, lt.z);
    const du1 = select(lt.x.greaterThan(0.5), u.sub(lt.w.add(1.9)), u.sub(sideU));
    const du2 = select(lt.x.greaterThan(0.5), u.sub(lt.w.sub(1.9)), float(99));
    const g = (du: Node) => exp(du.mul(du).add(dv.mul(dv)).div(-2 * 7.5 * 7.5));
    return g(du1).add(g(du2)).mul(step(float(-0.5), k));
  };
  const k0 = floor(kf);
  const light = pool(k0).add(pool(k0.add(1)));
  const notJunction = float(1).sub(step(abs(matId.sub(RMAT.Plain)), float(0.1)));
  const lampLight = c.mul(sRGBTransferEOTF(vec3(1, 0.82, 0.55))).mul(light.mul(notJunction).mul(nightU).mul(1.6));
  m.emissiveNode = sRGBTransferEOTF(col.xyz).mul(isZone).mul(0.35).add(lampLight).add(sRGBTransferEOTF(ramp).mul(traffic).mul(0.25));

  const [wc, wr] = wetLook(c, select(isAsphalt.greaterThan(0.5), mix(float(0.92), float(0.6), clamp(paintW.add(paintY), 0, 1)), float(0.85)));
  m.colorNode = vec4(wc, 1);
  m.roughnessNode = wr;
  m.metalnessNode = float(0);
  return m;
}
