// Chão pintado e água dos rios e lagos. Duas grades compartilhadas com os
// workers e com a GPU (uma camada por ladrilho, como as alturas):
// - chão (8 m): R = tipo de chão, G = força da pintura, B = floresta, A = clareira (sem árvore);
// - água (8 m): altura da superfície (−1000 = sem água).
// As duas na mesma grade de 8 m (índice waterIndex): leve o bastante para mapas maiores.
// Pincéis e rios são comandos que guardam antes/depois só do que tocaram.

import { HEIGHT_MAP_RES, HEIGHT_TILE_RES, MAP_HALF, MAP_TILES, SEA_LEVEL, TERRAIN_MIN_Y } from '../config.ts';
import { Dirty } from '../core/grid.ts';
import type { Command } from '../core/commands.ts';
import { heightAt, heightIndex, sampleCoord, worldOfSample } from './heights.ts';
import type { World } from './world.ts';

/** Tipos de chão (canal R). 0 = automático (grama, terra e rocha pela inclinação). */
export const Ground = {
  Auto: 0, Sand: 1, Soil: 2, Meadow: 3, Snow: 4, Gravel: 5, Asphalt: 6, Concrete: 7,
  Granite: 8, Sandstone: 9, Basalt: 10, Cerrado: 11, Flowers: 12, Rocks: 13, Mud: 14,
} as const;
export const GROUND_NAMES: Array<[number, string]> = [
  [Ground.Auto, 'Grama (apaga)'], [Ground.Sand, 'Areia'], [Ground.Soil, 'Terra'], [Ground.Meadow, 'Mato'], [Ground.Snow, 'Neve'],
  [Ground.Gravel, 'Cascalho'], [Ground.Asphalt, 'Asfalto'], [Ground.Concrete, 'Concreto'], [Ground.Granite, 'Rocha: granito'],
  [Ground.Sandstone, 'Rocha: arenito'], [Ground.Basalt, 'Rocha: basalto'], [Ground.Cerrado, 'Cerrado'], [Ground.Flowers, 'Flores'],
  [Ground.Rocks, 'Pedras'], [Ground.Mud, 'Lama'],
];
/** Cor sRGB de cada tipo (o shader lê esta tabela). */
export const GROUND_COLORS = [
  0x6b8545, 0xb8a882, 0x85715a, 0x7a8a4a, 0xeef0f2, 0x9a958c, 0x45484c, 0xa9a59d,
  0x8f8a85, 0xc08458, 0x4a4846, 0x9c8f52, 0x8a9a52, 0x7d7a74, 0x5a4a3a,
];

/** Biomas do mapa: cores da grama e mistura de árvores. */
export const BIOMES = ['Sem ecossistema', 'Cerrado', 'Mata Atlântica', 'Amazônia', 'Caatinga', 'Pampa', 'Pantanal'];

export const WATER_SPACING = 8;
export const WATER_TILE_RES = 1024 / WATER_SPACING; // 128
export const WATER_MAP_RES = WATER_TILE_RES * MAP_TILES;
export const NO_WATER = -1000;
const WSHIFT = Math.log2(WATER_TILE_RES), WMASK = WATER_TILE_RES - 1;

export function waterIndex(gx: number, gz: number): number {
  return (((gz >> WSHIFT) * MAP_TILES + (gx >> WSHIFT)) << (WSHIFT * 2)) + ((gz & WMASK) << WSHIFT) + (gx & WMASK);
}
export const waterCoord = (w: number) => (w + MAP_HALF) / WATER_SPACING;

export function createGroundBuffers(): { ground: SharedArrayBuffer; water: SharedArrayBuffer } {
  const ground = new SharedArrayBuffer(WATER_TILE_RES * WATER_TILE_RES * MAP_TILES * MAP_TILES * 4);
  const water = new SharedArrayBuffer(WATER_TILE_RES * WATER_TILE_RES * MAP_TILES * MAP_TILES * 4);
  new Float32Array(water).fill(NO_WATER);
  return { ground, water };
}

/** Nível da água em (x, z) (o mais alto dos 4 vizinhos; sem água = NO_WATER). */
export function waterAt(w: Float32Array, x: number, z: number): number {
  const gx = Math.floor(waterCoord(x)), gz = Math.floor(waterCoord(z));
  let best = NO_WATER;
  for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
    const ax = gx + dx, az = gz + dz;
    if (ax < 0 || az < 0 || ax >= WATER_MAP_RES || az >= WATER_MAP_RES) continue;
    best = Math.max(best, w[waterIndex(ax, az)]);
  }
  return best;
}

export type GroundMode = 'paint' | 'forest' | 'cut';
/** Espécie do bosque plantado (guardada no canal A enquanto não há clareira): 0 mista, 1 carvalho, 2 cipreste, 3 palmeira. */
export const TREE_SPECIES: Array<[number, string]> = [[0, 'Mistas'], [1, 'Carvalho'], [2, 'Cipreste'], [3, 'Palmeira']];

/** Traço do pincel de chão: pintura, floresta (planta) ou corte (clareira). */
export class GroundStroke implements Command {
  readonly label = 'pintar o chão';
  private world: World;
  private before = new Map<number, number>();
  private idx = new Int32Array(0);
  private old = new Uint32Array(0);
  private after = new Uint32Array(0);
  private box = [Infinity, Infinity, -Infinity, -Infinity];

  constructor(world: World) { this.world = world; }

  dab(x: number, z: number, radius: number, mode: GroundMode, kind: number, strength: number, dt: number, species = 0): void {
    const g = this.world.ground32;
    const r = radius / WATER_SPACING;
    const cx = waterCoord(x), cz = waterCoord(z);
    const gx0 = Math.max(0, Math.floor(cx - r)), gx1 = Math.min(WATER_MAP_RES - 1, Math.ceil(cx + r));
    const gz0 = Math.max(0, Math.floor(cz - r)), gz1 = Math.min(WATER_MAP_RES - 1, Math.ceil(cz + r));
    const k = Math.min(1, strength * dt * 3);
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
      const d = Math.hypot(gx - cx, gz - cz) / Math.max(r, 0.75);
      if (d >= 1) continue;
      const f = (0.5 + 0.5 * Math.cos(d * Math.PI)) * k;
      const i = waterIndex(gx, gz);
      const v = g[i];
      if (!this.before.has(i)) this.before.set(i, v);
      let R = v & 255, G = (v >> 8) & 255, B = (v >> 16) & 255, A = (v >>> 24) & 255;
      if (mode === 'paint') {
        if (kind === Ground.Auto) G = Math.max(0, G - Math.round(255 * f));
        else if (R === kind || G < 40) { R = kind; G = Math.min(255, G + Math.round(255 * f)); }
        else G = Math.max(0, G - Math.round(255 * f)); // primeiro apaga o outro tipo, depois pinta
      } else if (mode === 'forest') { B = Math.min(255, B + Math.round(255 * f)); A = species & 3; }
      else { B = Math.max(0, B - Math.round(255 * f)); A = Math.min(255, A + Math.round(255 * f)); }
      g[i] = (R | (G << 8) | (B << 16) | (A << 24)) >>> 0;
    }
    this.box[0] = Math.min(this.box[0], gx0); this.box[1] = Math.min(this.box[1], gz0);
    this.box[2] = Math.max(this.box[2], gx1); this.box[3] = Math.max(this.box[3], gz1);
    touchGround(this.world, gx0, gz0, gx1, gz1);
  }

  finish(): boolean {
    const n = this.before.size;
    if (n === 0) return false;
    this.idx = new Int32Array(n); this.old = new Uint32Array(n); this.after = new Uint32Array(n);
    let j = 0;
    for (const [i, v] of this.before) { this.idx[j] = i; this.old[j] = v; this.after[j] = this.world.ground32[i]; j++; }
    this.before.clear();
    return true;
  }

  private write(v: Uint32Array): void {
    const g = this.world.ground32;
    for (let j = 0; j < this.idx.length; j++) g[this.idx[j]] = v[j];
    touchGround(this.world, this.box[0], this.box[1], this.box[2], this.box[3]);
  }

  apply(): void { this.write(this.after); }
  invert(): void { this.write(this.old); }
}

/** Camadas e células do chão tocadas (a floresta muda as peças; a pintura, o terreno). */
function touchGround(world: World, gx0: number, gz0: number, gx1: number, gz1: number): void {
  for (let tz = gz0 >> WSHIFT; tz <= gz1 >> WSHIFT; tz++) for (let tx = gx0 >> WSHIFT; tx <= gx1 >> WSHIFT; tx++) world.groundDirty.add(tz * MAP_TILES + tx);
  const w = (g: number) => g * WATER_SPACING - MAP_HALF;
  world.touchRect(w(gx0) - 8, w(gz0) - 8, w(gx1) + 8, w(gz1) + 8, Dirty.Props);
}

/**
 * Rio: cava um leito ao longo do traço e põe água nele. A superfície desce
 * sempre (nunca sobe rio acima) e fica um pouco abaixo das margens.
 */
export class RiverCommand implements Command {
  readonly label = 'rio';
  private world: World;
  private hIdx: Int32Array; private hOld: Float32Array; private hNew: Float32Array;
  private wIdx: Int32Array; private wOld: Float32Array; private wNew: Float32Array;
  private box: [number, number, number, number];

  constructor(world: World, pts: Array<[number, number]>, width: number, depth: number) {
    this.world = world;
    const h = world.heights, wat = world.water;
    // pontos a cada 4 m ao longo do traço
    // pontos repetidos (duplo clique) saem
    pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 2);
    const path: Array<[number, number]> = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));
      for (let k = 0; k < n; k++) path.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
    }
    path.push(pts[pts.length - 1]);
    // nível da água: altura do chão menos 0,8 m, nunca subindo ao longo do caminho, nunca abaixo do mar
    const level = new Float64Array(path.length);
    let prev = Infinity;
    for (let i = 0; i < path.length; i++) {
      const g = heightAt(h, path[i][0], path[i][1]) - 0.8;
      prev = Math.min(prev, g);
      level[i] = Math.max(SEA_LEVEL + 0.1, prev);
    }
    const half = width / 2;
    const hMap = new Map<number, number>(), wMap = new Map<number, number>();
    let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity;
    // terreno: leito em U (fundo = nível − profundidade), margens suaves até 1,6 × meia largura
    path.forEach(([x, z], i) => {
      const reach = half * 1.6 + 4;
      const ax = Math.max(0, Math.floor(sampleCoord(x - reach))), bx = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(x + reach)));
      const az = Math.max(0, Math.floor(sampleCoord(z - reach))), bz = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(z + reach)));
      gx0 = Math.min(gx0, ax); gz0 = Math.min(gz0, az); gx1 = Math.max(gx1, bx); gz1 = Math.max(gz1, bz);
      for (let gz = az; gz <= bz; gz++) for (let gx = ax; gx <= bx; gx++) {
        const d = Math.hypot(worldOfSample(gx) - x, worldOfSample(gz) - z);
        if (d > reach) continue;
        const idx = heightIndex(gx, gz);
        const cur = hMap.has(idx) ? hMap.get(idx)! : h[idx];
        const t = d / half;
        const bed = t < 1 ? level[i] - depth * (1 - t * t) : level[i] + (t - 1) * 2.5;
        if (bed < cur) hMap.set(idx, Math.max(TERRAIN_MIN_Y, bed));
      }
      // água: células de 8 m dentro da largura (e uma a mais, escondida pela margem)
      const wr = half + WATER_SPACING;
      const wx0 = Math.max(0, Math.floor(waterCoord(x - wr))), wx1 = Math.min(WATER_MAP_RES - 1, Math.ceil(waterCoord(x + wr)));
      const wz0 = Math.max(0, Math.floor(waterCoord(z - wr))), wz1 = Math.min(WATER_MAP_RES - 1, Math.ceil(waterCoord(z + wr)));
      for (let gz = wz0; gz <= wz1; gz++) for (let gx = wx0; gx <= wx1; gx++) {
        const d = Math.hypot(gx * WATER_SPACING - MAP_HALF - x, gz * WATER_SPACING - MAP_HALF - z);
        if (d > wr) continue;
        const idx = waterIndex(gx, gz);
        const cur = wMap.has(idx) ? wMap.get(idx)! : wat[idx];
        wMap.set(idx, cur === NO_WATER ? level[i] : Math.min(cur, level[i]));
      }
    });
    const pack = (m: Map<number, number>, src: Float32Array): [Int32Array, Float32Array, Float32Array] => {
      const idx = new Int32Array(m.size), o = new Float32Array(m.size), n = new Float32Array(m.size);
      let j = 0;
      for (const [i, v] of m) { idx[j] = i; o[j] = src[i]; n[j] = v; j++; }
      return [idx, o, n];
    };
    [this.hIdx, this.hOld, this.hNew] = pack(hMap, h);
    [this.wIdx, this.wOld, this.wNew] = pack(wMap, wat);
    this.box = [gx0, gz0, gx1, gz1];
  }

  get empty(): boolean { return this.hIdx.length === 0 && this.wIdx.length === 0; }

  private write(hv: Float32Array, wv: Float32Array): void {
    const w = this.world, h = w.heights;
    const shift = 2 * Math.log2(HEIGHT_TILE_RES), wshift = 2 * WSHIFT;
    for (let j = 0; j < this.hIdx.length; j++) {
      const i = this.hIdx[j];
      h[i] = hv[j];
      const tile = i >> shift;
      if (hv[j] < w.tileMin[tile]) w.tileMin[tile] = hv[j];
      w.layerDirty.add(tile);
    }
    for (let j = 0; j < this.wIdx.length; j++) {
      const i = this.wIdx[j];
      w.water[i] = wv[j];
      const tile = i >> wshift;
      w.waterDirty.add(tile);
      if (wv[j] !== NO_WATER) w.tileWater[tile] = 1;
    }
    const [gx0, gz0, gx1, gz1] = this.box;
    w.touchRect(worldOfSample(gx0) - 4, worldOfSample(gz0) - 4, worldOfSample(gx1) + 4, worldOfSample(gz1) + 4, Dirty.Terrain | Dirty.Buildings | Dirty.Roads | Dirty.RoadPaint | Dirty.Lots);
  }

  apply(): void { this.write(this.hNew, this.wNew); }
  invert(): void { this.write(this.hOld, this.wOld); }
}
