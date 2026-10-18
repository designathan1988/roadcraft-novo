// Prédios: fonte das malhas (gerador procedural nos workers) e o material
// único: janelas alinhadas às paredes, interiores falsos (interior mapping),
// salas acesas à noite, lojas com vitrine e letreiro.

import * as THREE from 'three/webgpu';
import { CELL_SIZE, CELLS_PER_TILE, MAP_CELLS, MAP_PLATES, MAP_TILES, PLATE_SIZE, TILE_SIZE } from '../config.ts';
import { Dirty, cellId, cellOriginX, tileOriginX } from '../core/grid.ts';
import type { JobPool } from '../jobs/pool.ts';
import { boxTransfer } from '../jobs/protocol.ts';
import type { World } from '../world/world.ts';
import { CellLayer, type LayerSource } from './cellLayer.ts';
import { T, lodFadeMask, useCompactVertex, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { ARCHES, ARCH_COUNT, facadeWindowTable } from '../world/arch.ts';
import { cutMask } from './inside.ts';
import { GRASS_TEX, GRASS_TILE } from './surfaceBake.ts';
import { FINISH_BY_MAT, FINISH_COUNT, FINISH_LOOKS, FINISH_SIZE } from '../jobs/buildingFinishes.ts';

const {
  attribute, vec3, vec4, float, int, mix, clamp, fract, fwidth, smoothstep, floor, mod, select, hash, min, abs,
  positionWorld, cameraPosition, sRGBTransferEOTF, dot, max, step, normalize, pow, texture, vec2, cross, transformNormalToView,
} = T;

/**
 * The 13 building finishes as two texture arrays (layer = finish id − 1): albedo tone + roughness, normal + metalness.
 * Neutral until the bake worker answers (mean tone, flat normal): the same image as without textures.
 */
function finishArray(fill: [number, number, number, number]): THREE.DataArrayTexture {
  const n = FINISH_SIZE * FINISH_SIZE * FINISH_COUNT, data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) data.set(fill, i * 4);
  const t = new THREE.DataArrayTexture(data, FINISH_SIZE, FINISH_SIZE, FINISH_COUNT);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
export const FINISH_ALBEDO = finishArray([128, 128, 128, 230]);
export const FINISH_NORMAL = finishArray([128, 128, 255, 0]);
let finishBaked = false;
/** Starts the bake (once): a worker fills both arrays and they go up to the GPU again, with mipmaps. */
function bakeFinishesOnce(): void {
  if (finishBaked || typeof Worker === 'undefined') return;
  finishBaked = true;
  const w = new Worker(new URL('../jobs/buildingFinishWorker.ts', import.meta.url), { type: 'module', name: 'finishes' });
  w.onmessage = (e: MessageEvent<{ albedo: Uint8Array; normal: Uint8Array }>) => {
    (FINISH_ALBEDO.image.data as Uint8Array).set(e.data.albedo); FINISH_ALBEDO.needsUpdate = true;
    (FINISH_NORMAL.image.data as Uint8Array).set(e.data.normal); FINISH_NORMAL.needsUpdate = true;
    w.terminate();
  };
}
/** Per finish: (1 / tile size in m, normal strength, 0, 0). Index = finish id (0 unused). */
const FINISH_LOOK = T.uniformArray(Array.from({ length: FINISH_COUNT + 1 }, (_, k) => new THREE.Vector4(k ? 1 / FINISH_LOOKS[k].worldSize : 0, k ? FINISH_LOOKS[k].normalScale : 0, 0, 0)), 'vec4');
const FINISH_AUTO = T.uniformArray(FINISH_BY_MAT.map((f) => new THREE.Vector4(f, 0, 0, 0)), 'vec4');

/** Ruído de reboco feito uma vez (128², repete sem emenda): R grão fino + manchas, G escorrido (esticado em y). */
function wallNoise(): THREE.DataTexture {
  const N = 128, data = new Uint8Array(N * N * 4);
  const lattice = (g: number, seed: number) => { const v = new Float32Array(g * g); let x = seed * 2654435761 >>> 0; for (let i = 0; i < v.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; v[i] = (x >>> 0) / 4294967296; } return v; };
  const sample = (v: Float32Array, g: number, u: number, w: number) => {
    const x = u * g, y = w * g, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (a: number, b: number) => v[((b % g + g) % g) * g + ((a % g + g) % g)];
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
  const a = lattice(8, 7), b = lattice(32, 11), c = lattice(16, 23);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, w = y / N, o = (y * N + x) * 4;
    data[o] = Math.round(255 * (sample(a, 8, u, w) * 0.55 + sample(b, 32, u, w) * 0.45));
    data[o + 1] = Math.round(255 * sample(c, 16, u, w * 0.25));
    data[o + 2] = 0; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
export const WALL_NOISE = wallNoise();

/** Prédios: fonte das malhas para a camada por células. */
export function createCity(world: World, pool: JobPool): CellLayer {
  const src: LayerSource = {
    hasContent: (c) => world.cellBuildings[c] > 0,
    buildCell: (c, level, priority, done) => {
      const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
      const boxes = world.gatherBoxes([c]);
      pool.submit('buildingMesh', { boxes, originX: cellOriginX(cx), originZ: cellOriginX(cz), extent: CELL_SIZE, lod: level },
        (r) => done(r.mesh), { key: `cell${level}:${c}`, priority, transfer: boxTransfer(boxes) });
    },
    buildTile: (t, priority, done) => {
      const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
      const cells: number[] = [];
      for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) cells.push(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j));
      const boxes = world.gatherBoxes(cells);
      if (boxes.count === 0) { done(null); return; }
      pool.submit('buildingMesh', { boxes, originX: tileOriginX(tx), originZ: tileOriginX(tz), extent: TILE_SIZE, lod: 2 },
        (r) => done(r.mesh), { key: `tile:${t}`, priority, transfer: boxTransfer(boxes) });
    },
    buildPlate: (p, priority, done) => {
      const per = PLATE_SIZE / TILE_SIZE * CELLS_PER_TILE;
      const px = p % MAP_PLATES, pz = (p / MAP_PLATES) | 0;
      const cells: number[] = [];
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
        const ci = px * per + i, cj = pz * per + j;
        if (ci < MAP_CELLS && cj < MAP_CELLS) cells.push(cellId(ci, cj));
      }
      const boxes = world.gatherBoxes(cells);
      if (boxes.count === 0) { done(null); return; }
      pool.submit('buildingMesh', { boxes, originX: cellOriginX(px * per), originZ: cellOriginX(pz * per), extent: PLATE_SIZE, lod: 3 },
        (r) => done(r.mesh), { key: `plate:${p}`, priority, transfer: boxTransfer(boxes) });
    },
  };
  return new CellLayer(src, world.dirty, Dirty.Buildings, createBuildingMaterial(), { near: 1400, evict: 2600, margin: 40, detail: 650, plate: 4200, budget: 256e6 }, false, true);
}


/**
 * Detalhe das fachadas perto da câmera: peitoris e vergas em 3D (lod −1 no gerador). Uma camada à parte, só
 * de células, com raio curto: longe ela não existe (o shader desenha a janela sozinho).
 */
export function createCityDetail(world: World, pool: JobPool, material: THREE.Material): CellLayer {
  const src: LayerSource = {
    hasContent: (c) => world.cellBuildings[c] > 0,
    buildCell: (c, level, priority, done) => {
      if (level > 0) { done(null); return; } // longe: sem detalhe
      const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
      const boxes = world.gatherBoxes([c]);
      pool.submit('buildingMesh', { boxes, originX: cellOriginX(cx), originZ: cellOriginX(cz), extent: CELL_SIZE, lod: -1 },
        (r) => done(r.mesh), { key: `detail:${c}`, priority: priority - 1, transfer: boxTransfer(boxes) });
    },
    buildTile: (_t, _p, done) => done(null),
    buildPlate: (_p, _q, done) => done(null),
  };
  return new CellLayer(src, world.dirty, Dirty.Buildings, material, { near: 1100, evict: 1400, margin: 30, detail: 220, budget: 48e6, shadows: false, sparse: true }, false, true);
}

/** Faixa [lo, hi] de x, filtrada pela largura do pixel w. */
function band(lo: Node, hi: Node, x: Node, w: Node): Node {
  return smoothstep(lo.sub(w), lo.add(w), x).mul(smoothstep(hi.add(w), hi.sub(w), x));
}

/** Material único dos prédios. Materiais pelo canal alfa da cor (BMAT no gerador). */
/** Janela e acabamento por estilo, para o shader. */
const ARCH_WIN = T.uniformArray(facadeWindowTable().map(([a, b, c, d]) => new THREE.Vector4(a, b, c, d)), 'vec4');
const ARCH_TRIM = T.uniformArray(ARCHES.map((a) => { const c = new THREE.Color(a.trim).convertSRGBToLinear(); return new THREE.Vector4(c.r, c.g, c.b, 1); }), 'vec4');

export function createBuildingMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const n = useCompactVertex(m, 'vBldNormal');
  // dither da troca de nível e o corte do "ver por dentro"
  m.maskNode = lodFadeMask().and(cutMask());

  bakeFinishesOnce();
  const col = attribute('col', 'vec4');
  const matByte = floor(col.w.mul(255).add(0.5));
  const mat = mod(matByte, 16);
  // acabamento: nibble alto do byte de material (0 = o padrão do material)
  const finV = floor(matByte.div(16));
  const fin = select(finV.greaterThan(0.5), finV, FINISH_AUTO.element(int(mat)).x);
  const hasFin = step(float(0.5), fin);
  // gramado do lote com o mesmo gramado assado do terreno
  const lawn = step(abs(mat.sub(7)), float(0.5));
  const base = sRGBTransferEOTF(col.xyz).mul(mix(vec3(1, 1, 1), texture(GRASS_TEX, positionWorld.xz.div(GRASS_TILE)).xyz.mul(2), lawn));
  const fac = attribute('fac', 'vec4').mul(255);
  const fuv = attribute('fuv', 'vec2').mul(512);

  const kindByte = floor(fac.z.add(0.5));
  const kind = mod(kindByte, 4);
  const shop = mod(floor(kindByte.div(4)), 2);
  const fh = floor(kindByte.div(8)).mul(0.1).add(2.5);
  const colW = fac.w.div(20);
  const seed = floor(fac.y.add(0.5)).add(floor(fac.x.add(0.5)).mul(256));

  const isCurtain = step(abs(mat.sub(3)), float(0.5));
  const isWall = step(mat, float(0.5));
  const isMetal = step(abs(mat.sub(5)), float(0.5));
  const vertical = step(abs(n.y), float(0.3));
  const hasWin = step(float(0.5), colW).mul(vertical).mul(max(max(isWall, isCurtain), isMetal));

  // coordenadas da fachada: colunas (cortina: sala a cada 2 colunas) e andares
  const ground = shop.mul(4.4);
  const hh = fuv.y.sub(ground);
  const inShop = shop.mul(step(hh, float(0))).mul(step(float(0), fuv.y));
  const roomH = select(inShop.greaterThan(0.5), float(4.4), fh);
  const yy = select(inShop.greaterThan(0.5), fuv.y.div(4.4), hh.div(fh));
  const span = select(isCurtain.greaterThan(0.5), float(2), float(1));
  const uu = fuv.x.div(span);
  const cu = floor(uu), fl = floor(yy);
  const fx = fract(uu), fy = fract(yy);
  const wu = fwidth(uu).add(1e-4), wy = fwidth(yy).add(1e-4);
  const rnd = hash(cu.add(fl.add(64).mul(1013)).add(seed.mul(7919)));
  const rnd2 = hash(cu.mul(31).add(fl.add(64).mul(577)).add(seed.mul(131)).add(17));
  const sty = hash(seed.add(3));

  // janelas pelo estilo de arquitetura (folga lateral, peitoril, verga, venezianas/moldura)
  const archId = int(floor(fac.x.add(0.5)));
  const ap = ARCH_WIN.element(archId);
  const ww = ap.x, wLow = ap.y, wHigh = ap.z;
  const hasShutters = mod(ap.w, 2), hasFrame = mod(floor(ap.w.div(2)), 2);
  // facade pattern bay rule: 4 = every third bay blank (art deco piers), 8 = only every third bay glazed (industrial)
  const skip3 = mod(floor(ap.w.div(4)), 2), only3 = mod(floor(ap.w.div(8)), 2);
  const cm = mod(cu, 3);
  const bayOn = float(1).sub(max(skip3.mul(step(abs(cm.sub(1)), float(0.5))), only3.mul(step(float(0.5), cm))).mul(float(1).sub(inShop)));
  const avgBay = float(1).sub(skip3.mul(1 / 3)).sub(only3.mul(2 / 3));
  const punched = band(ww, float(1).sub(ww), fx, wu).mul(band(wLow, wHigh, fy, wy));
  const houseWin = punched;
  const strip = band(ww, float(1).sub(ww), fx, wu).mul(band(wLow, wHigh, fy, wy));
  // moldura (faixa clara de ~8 cm em volta) e venezianas abertas dos lados
  const fu = float(0.08).div(colW), fyy = float(0.08).div(fh);
  const frameOuter = band(ww.sub(fu), float(1).sub(ww).add(fu), fx, wu).mul(band(wLow.sub(fyy), wHigh.add(fyy.mul(1.5)), fy, wy));
  const shutW = min(ww.sub(0.02), float(1).sub(ww.mul(2)).mul(0.45));
  const shutter = max(band(ww.sub(shutW), ww.sub(0.01), fx, wu), band(float(1).sub(ww).add(0.01), float(1).sub(ww).add(shutW), fx, wu))
    .mul(band(wLow, wHigh, fy, wy)).mul(hasShutters).mul(step(float(0.25), rnd2));
  const curtainGlass = band(float(0.02), float(0.98), fract(fuv.x), fwidth(fuv.x).add(1e-4)).mul(band(float(0.24), float(0.98), fy, wy));
  let win: Node = select(kind.lessThan(0.5), punched, select(kind.lessThan(1.5), curtainGlass, select(kind.lessThan(2.5), houseWin, strip)));
  // vitrine da loja e letreiro acima
  const shopWin = band(float(0.05), float(0.95), fx, wu).mul(band(float(0.05), float(0.76), fy, wy));
  const sign = band(float(0.8), float(0.95), fy, wy).mul(band(float(0.02), float(0.98), fx, wu));
  win = select(inShop.greaterThan(0.5), shopWin, win);
  win = win.mul(hasWin).mul(step(float(0), yy).max(inShop)).mul(bayOn);
  const signMask = sign.mul(inShop).mul(hasWin).mul(step(float(0.35), rnd2));

  // interior falso: raio da câmera dentro de uma sala do tamanho da janela
  const V = normalize(positionWorld.sub(cameraPosition));
  const tng = vec3(n.z, 0, n.x.negate());
  const depth = select(inShop.greaterThan(0.5), float(8), float(4.5));
  const d = vec3(dot(V, tng).div(colW.mul(span)), V.y.div(roomH), max(dot(V, n.negate()), 0.02).div(depth));
  const sx = select(d.x.greaterThanEqual(0), max(d.x, 1e-4), min(d.x, -1e-4));
  const sy = select(d.y.greaterThanEqual(0), max(d.y, 1e-4), min(d.y, -1e-4));
  const ix = step(float(0), sx).sub(fx).div(sx);
  const iy = step(float(0), sy).sub(fy).div(sy);
  const iz = float(1).div(d.z);
  const tmin = min(min(ix, iy), iz);
  const hz = clamp(d.z.mul(tmin), 0, 1);
  const wallTone = mix(vec3(0.62, 0.55, 0.46), vec3(0.5, 0.56, 0.6), rnd);
  const backC = wallTone;
  const sideC = wallTone.mul(0.78);
  const floorC = mix(vec3(0.24, 0.17, 0.11), vec3(0.32, 0.3, 0.28), rnd2);
  const ceilC = vec3(0.86, 0.85, 0.82);
  const hitY = select(sy.lessThan(0), floorC, ceilC);
  let room: Node = select(iz.lessThanEqual(min(ix, iy)), backC, select(ix.lessThan(iy), sideC, hitY));
  room = room.mul(float(1).sub(hz.mul(0.45)));
  // móvel/divisória escura no fundo de algumas salas
  room = room.mul(mix(float(1), float(0.55), step(float(0.7), rnd2).mul(step(iz, min(ix, iy)))));

  // noite: parte das salas acesas (mais tarde, menos); lojas e letreiros sempre
  const lit = step(rnd, mix(float(0.15), float(0.62), sty)).max(inShop);
  const lamp = mix(vec3(1.0, 0.84, 0.58), vec3(0.85, 0.92, 1.0), step(float(0.75), rnd2));
  const night = nightU;
  const dayInside = room.mul(select(inShop.greaterThan(0.5), float(0.3), float(0.11)));
  const nightInside = room.mul(lamp).mul(lit).mul(select(inShop.greaterThan(0.5), float(1.7), float(1.5)));
  // persiana (lâminas, baixada até uma altura) ou cortina (painéis dos lados) em parte das janelas
  const r3 = hash(cu.mul(17).add(fl.add(64).mul(733)).add(seed.mul(53)).add(91));
  const lx = clamp(fx.sub(ww).div(float(1).sub(ww.mul(2)).max(0.05)), 0, 1);
  const ly = clamp(fy.sub(wLow).div(wHigh.sub(wLow).max(0.05)), 0, 1);
  const blindDown = hash(r3.mul(97.1)).mul(0.75).add(0.15);
  // lâminas da persiana: só de perto (18 por janela viram ruído quando a janela tem poucos pixels)
  const slatFade = clamp(float(1).sub(fwidth(ly.mul(18)).mul(1.5)), 0, 1);
  const slats = smoothstep(float(0.35), float(0.5), fract(ly.mul(18))).mul(0.25).mul(slatFade).add(float(1).sub(slatFade.mul(0.25)));
  const blinds = step(r3, float(0.32)).mul(step(float(1).sub(blindDown), ly));
  const curtW = hash(r3.mul(53.7)).mul(0.22).add(0.12);
  const curtains = step(float(0.32), r3).mul(step(r3, float(0.5))).mul(step(lx, curtW).max(step(float(1).sub(curtW), lx)));
  // cortina em tons neutros (creme, cinza claro); só uma ou outra colorida
  const curtC = mix(mix(vec3(0.72, 0.66, 0.56), vec3(0.64, 0.64, 0.62), step(float(0.55), hash(r3.mul(11.3)))), vec3(0.5, 0.3, 0.24), step(float(0.88), hash(r3.mul(5.9))));
  const blindC = mix(vec3(0.78, 0.76, 0.7), vec3(0.6, 0.62, 0.64), hash(r3.mul(3.3)));
  const cover = blinds.max(curtains).mul(float(1).sub(inShop));
  const coverC = select(blinds.greaterThan(0.5), blindC.mul(slats), curtC);
  // tecido de dia: iluminado pela luz que entra; à noite, aceso por trás se a sala está acesa
  const inside = mix(mix(dayInside, coverC.mul(0.32), cover), mix(nightInside, coverC.mul(lamp).mul(lit).mul(0.9), cover), night);

  // vidro: reflexo pelo ângulo (Fresnel de Schlick)
  const cosV = clamp(dot(V.negate(), n), 0, 1);
  const F = float(0.04).add(float(0.96).mul(pow(float(1).sub(cosV), 5)));
  const skyRefl = mix(vec3(0.34, 0.4, 0.46), vec3(0.62, 0.7, 0.78), clamp(V.y.negate().add(0.3), 0, 1)).mul(float(1).sub(night.mul(0.92)));
  const glassTint = select(isCurtain.greaterThan(0.5), base.mul(0.35), vec3(0.03, 0.04, 0.05));
  const refl = max(F, 0.2);

  // longe: média da fachada (sem moiré)
  // longe: média da fachada antes de a janela ficar com poucos pixels (o padrão fino tremia com o TRAA)
  const detail = clamp(float(1.3).sub(max(wu, wy).mul(4.5)), 0, 1);
  const avgWin = select(kind.lessThan(0.5), float(0.6 * 0.56), select(kind.lessThan(1.5), float(0.74), select(kind.lessThan(2.5), float(0.2), float(0.2))))
    .mul(hasWin).mul(step(float(0), yy).max(inShop)).mul(mix(avgBay, float(1), inShop));
  const avgLit = mix(float(0.15), float(0.62), sty).max(inShop);
  const winAmt = mix(avgWin, win, detail);
  // de longe, à noite: média das janelas mais fraca e amarela (forte demais deixava a fachada inteira marrom)
  const insideAmt = mix(mix(vec3(0.07, 0.065, 0.06), vec3(1.0, 0.88, 0.64).mul(avgLit).mul(0.42), night), inside, detail);

  // espaço entre andares da cortina de vidro: opaco, cor do vidro escurecida
  const wallC = select(isCurtain.greaterThan(0.5), base.mul(0.55), base);
  const signC = mix(vec3(0.85, 0.2, 0.15), vec3(0.15, 0.4, 0.85), rnd).mul(mix(float(1), float(0.6), step(float(0.5), rnd2)));
  // moldura e venezianas (só onde há janela de verdade, não na cortina de vidro)
  const archMask = bayOn.mul(hasWin).mul(step(kind, float(0.5)).max(step(float(1.5), kind))).mul(step(float(0), yy)).mul(float(1).sub(inShop)).mul(detail);
  const trimC = ARCH_TRIM.element(int(mod(floor(fac.x.add(0.5)), ARCH_COUNT))).xyz;
  const shutterC = mix(mix(vec3(0.12, 0.3, 0.18), vec3(0.18, 0.28, 0.45), step(float(0.5), sty)), vec3(0.35, 0.22, 0.12), step(float(0.8), sty));
  const frameAmt = clamp(frameOuter.sub(win), 0, 1).mul(hasFrame).mul(archMask);
  const shutterAmt = shutter.mul(archMask);
  let wallFinal: Node = mix(mix(wallC, trimC, frameAmt), shutterC, shutterAmt);
  const P = positionWorld;
  // acabamento: UV em metros no plano da face (u na horizontal da face, v subindo; na laje, x e z)
  const look = FINISH_LOOK.element(int(floor(fin.add(0.5))));
  const faceH = vec2(n.z, n.x.negate());
  const flatFace = step(dot(faceH, faceH), float(0.0025));
  const tAx = normalize(mix(vec3(faceH.x, 0, faceH.y), vec3(1, 0, 0), flatFace));
  const bAx = cross(n, tAx);
  const fuvM = vec2(dot(P, tAx), dot(P, bAx)).mul(look.x);
  const layer = int(max(fin.sub(1), float(0)));
  const finA = texture(FINISH_ALBEDO, fuvM).depth(layer);
  const finN = texture(FINISH_NORMAL, fuvM).depth(layer);
  const finTone = mix(vec3(1, 1, 1), finA.xyz.mul(2), hasFin);
  const wn = texture(WALL_NOISE, vec2(P.x.add(P.z), P.y).mul(0.11));
  const grain = wn.r.mul(2).sub(1);
  const isFacade = hasWin.max(vertical.mul(isWall));
  const plain = float(1).sub(isCurtain).mul(float(1).sub(hasFin));
  const winCol = band(ww, float(1).sub(ww), fx, wu).mul(hasWin).mul(bayOn).mul(float(1).sub(inShop)).mul(step(float(0), yy));
  // escorrido de chuva sob a janela (mais escuro perto do peitoril)
  const streakN = wn.g;
  const streak = winCol.mul(step(fy, wLow)).mul(smoothstep(float(0), wLow, fy)).mul(streakN).mul(0.16).mul(step(kind, float(0.5)).max(step(float(1.5), kind)));
  // laje: friso escuro no piso de cada andar (só nas fachadas de janelas soltas)
  const slab = band(float(-0.012), float(0.03), fy, wy).mul(step(kind, float(0.5))).mul(hasWin).mul(float(1).sub(inShop)).mul(step(float(0.5), yy));
  // peitoril claro (pega o sol de cima) e a sombra dele logo abaixo
  const sillW = band(ww.sub(0.04), float(1).sub(ww).add(0.04), fx, wu).mul(hasWin).mul(bayOn).mul(float(1).sub(inShop)).mul(step(float(0), yy)).mul(step(kind, float(0.5)).max(step(float(1.5), kind)));
  const sill = sillW.mul(band(wLow.sub(float(0.06)), wLow, fy, wy));
  const sillShadow = sillW.mul(band(wLow.sub(float(0.12)), wLow.sub(float(0.06)), fy, wy));
  const wallK = float(1).add(grain.mul(0.11).mul(plain)).sub(streak).sub(slab.mul(0.22)).sub(sillShadow.mul(0.3));
  const sillAmt = sill.mul(isFacade).mul(detail).mul(float(1).sub(isCurtain));
  wallFinal = mix(wallFinal.mul(wallK).mul(finTone), mix(trimC, vec3(0.86, 0.84, 0.8), 0.5), sillAmt);
  // recuo de verdade pelo ângulo de visão: o vidro fica ~22 cm para dentro; onde a abertura (na parede) não
  // mostra o vidro, aparece a parede do vão (em sombra), do lado oposto ao olhar
  const inward = max(dot(V, n.negate()), float(0.15));
  const recess = float(0.22);
  const offU = dot(V, tng).div(inward).mul(recess).div(colW.mul(span));
  const offY = V.y.div(inward).mul(recess).div(fh);
  const glassSeen = band(ww, float(1).sub(ww), fx.add(offU), wu).mul(band(wLow, wHigh, fy.add(offY), wy));
  const deepWin = step(kind, float(0.5)).max(step(float(1.5), kind)).mul(float(1).sub(inShop));
  const reveal = clamp(punched.sub(glassSeen), 0, 1).mul(winCol).mul(deepWin).mul(detail);
  const glassC = mix(glassTint.add(skyRefl.mul(refl)), wallC.mul(0.42), reveal);
  const albedo = mix(mix(wallFinal, glassC, winAmt), signC, signMask.mul(detail));
  m.colorNode = vec4(albedo, 1);
  m.emissiveNode = insideAmt.mul(winAmt).mul(float(1).sub(refl)).mul(float(1).sub(reveal)).add(signC.mul(signMask).mul(detail).mul(night).mul(1.8));

  const rough0 = select(mat.equal(7), float(0.95), select(mat.equal(5), float(0.45), select(mat.equal(2), float(0.7), float(0.86))));
  const rough = mix(rough0, finA.w, hasFin);
  m.roughnessNode = mix(rough, float(0.12), winAmt);
  m.metalnessNode = max(select(mat.equal(5), float(0.35), float(0)), finN.w.mul(hasFin)).mul(float(1).sub(winAmt));
  // relevo do acabamento (fora do vidro), na base da face
  const nm = finN.xyz.mul(2).sub(1);
  const nk = look.y.mul(hasFin).mul(float(1).sub(winAmt)).mul(float(1).sub(sillAmt));
  const nW = normalize(tAx.mul(nm.x.mul(nk)).add(bAx.mul(nm.y.mul(nk))).add(n.mul(nm.z)));
  m.normalNode = transformNormalToView(nW);
  return m;
}
