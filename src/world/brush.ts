// Pincel de terreno. Um traço é um comando: guarda o valor antigo de cada
// amostra tocada e, no fim, o novo. Desfazer escreve os antigos de volta.
// Custo proporcional às amostras tocadas.

import { HEIGHT_MAP_RES, HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_TILES, SEA_LEVEL, TERRAIN_MAX_Y, TERRAIN_MIN_Y } from '../config.ts';
import { Dirty } from '../core/grid.ts';
import type { Command } from '../core/commands.ts';
import { heightAt, heightIndex, sampleCoord, worldOfSample } from './heights.ts';
import type { World } from './world.ts';

export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten' | 'mesa' | 'canyon' | 'escarpment' | 'sugarloaf' | 'gully';

/** Relevos prontos: a rocha pintada no chão onde a forma sobe ou desce (Ground). */
export const LANDFORM_ROCK: Partial<Record<BrushMode, number>> = { mesa: 9, canyon: 9, escarpment: 10, sugarloaf: 8, gully: 2 };

export interface BrushParams {
  mode: BrushMode;
  radius: number; // m
  strength: number; // m/s no centro para subir/descer; fração/s para alisar/nivelar
}

/** Marca as camadas, ladrilhos e células afetadas por um retângulo de amostras. */
function touchSamples(world: World, gx0: number, gz0: number, gx1: number, gz1: number): void {
  const shift = Math.log2(HEIGHT_TILE_RES);
  for (let tz = gz0 >> shift; tz <= gz1 >> shift; tz++) {
    for (let tx = gx0 >> shift; tx <= gx1 >> shift; tx++) world.layerDirty.add(tz * MAP_TILES + tx);
  }
  // prédios em cima do terreno dependem da altura
  world.touchRect(worldOfSample(gx0) - HEIGHT_SPACING, worldOfSample(gz0) - HEIGHT_SPACING,
    worldOfSample(gx1) + HEIGHT_SPACING, worldOfSample(gz1) + HEIGHT_SPACING, Dirty.Terrain | Dirty.Buildings | TERRAIN_FOLLOWERS);
}

/** What sits on the terrain besides buildings: the road meshes and their paint follow it, lots are cut by slope. */
export const TERRAIN_FOLLOWERS = Dirty.Roads | Dirty.RoadPaint | Dirty.Lots;

function extendBounds(world: World, idx: number, v: number): void {
  const tile = idx >> (2 * Math.log2(HEIGHT_TILE_RES));
  if (v < world.tileMin[tile]) world.tileMin[tile] = v;
  if (v > world.tileMax[tile]) world.tileMax[tile] = v;
}

function smoothstep01(t: number): number { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); }

/**
 * Aplaina o mapa inteiro numa altura. É a única edição que toca o mapa todo (pedida pelo jogador,
 * uma vez); o desfazer guarda as alturas antigas quantizadas em 16 bits (2 bytes por amostra).
 */
export class FlattenMap implements Command {
  readonly label = 'aplainar mapa';
  private world: World;
  private old: Uint16Array;
  get bytes(): number { return this.old.byteLength; }
  private y: number;
  constructor(world: World, y: number) {
    this.world = world;
    this.y = y;
    const h = world.heights, span = TERRAIN_MAX_Y - TERRAIN_MIN_Y;
    this.old = new Uint16Array(h.length);
    for (let i = 0; i < h.length; i++) this.old[i] = Math.round((h[i] - TERRAIN_MIN_Y) / span * 65535);
  }
  private touchAll(): void {
    const w = this.world;
    for (let t = 0; t < MAP_TILES * MAP_TILES; t++) w.layerDirty.add(t);
    touchSamples(w, 0, 0, HEIGHT_MAP_RES - 1, HEIGHT_MAP_RES - 1);
  }
  apply(): void {
    this.world.heights.fill(this.y);
    this.world.tileMin.fill(this.y); this.world.tileMax.fill(this.y);
    this.touchAll();
  }
  invert(): void {
    const h = this.world.heights, span = TERRAIN_MAX_Y - TERRAIN_MIN_Y, w = this.world;
    w.tileMin.fill(Infinity); w.tileMax.fill(-Infinity);
    for (let i = 0; i < h.length; i++) { h[i] = TERRAIN_MIN_Y + this.old[i] / 65535 * span; extendBounds(w, i, h[i]); }
    this.touchAll();
  }
}

export class BrushStroke implements Command {
  readonly label = 'pincel de terreno';
  private world: World;
  private before = new Map<number, number>();
  private idx: Int32Array = new Int32Array(0);
  private after: Float32Array = new Float32Array(0);
  private old: Float32Array = new Float32Array(0);
  private gx0 = Infinity; private gz0 = Infinity; private gx1 = -Infinity; private gz1 = -Infinity;
  private flattenTo: number | null = null;
  finished = false;

  constructor(world: World) { this.world = world; }

  /** Aplica um passo do pincel em (x, z) durante dt segundos. */
  dab(x: number, z: number, p: BrushParams, dt: number): void {
    const h = this.world.heights;
    if ((p.mode === 'flatten' || LANDFORM_ROCK[p.mode] !== undefined) && this.flattenTo === null) this.flattenTo = heightAt(h, x, z);
    // altura (ou fundura) dos relevos pela força: 0,4 → 45 m
    const H = 5 + p.strength * 100, base = this.flattenTo ?? 0;
    const r = p.radius / HEIGHT_SPACING;
    const cx = sampleCoord(x), cz = sampleCoord(z);
    const gx0 = Math.max(0, Math.floor(cx - r)), gx1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(cx + r));
    const gz0 = Math.max(0, Math.floor(cz - r)), gz1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(cz + r));
    if (gx0 > gx1 || gz0 > gz1) return;
    const k = Math.min(1, p.strength * dt);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const d = Math.hypot(gx - cx, gz - cz) / r;
        if (d >= 1) continue;
        const f = 0.5 + 0.5 * Math.cos(d * Math.PI); // queda suave
        const i = heightIndex(gx, gz);
        const v = h[i];
        if (!this.before.has(i)) this.before.set(i, v);
        let nv = v;
        switch (p.mode) {
          case 'raise': nv = v + p.strength * dt * f; break;
          case 'lower': nv = v - p.strength * dt * f; break;
          case 'flatten': nv = v + (this.flattenTo! - v) * k * f; break;
          // chapada e escarpa: topo plano na altura do começo + H, paredões (escarpa: dois degraus)
          case 'mesa': nv = Math.max(v, base + H * smoothstep01((1 - d) / 0.18)); break;
          case 'escarpment': nv = Math.max(v, base + H * (0.55 * smoothstep01((1 - d) / 0.08) + 0.45 * smoothstep01((0.6 - d) / 0.08))); break;
          // cânion: fundo plano, paredes quase verticais
          case 'canyon': nv = Math.min(v, Math.max(SEA_LEVEL + 2, base - H) + (base - Math.max(SEA_LEVEL + 2, base - H)) * (1 - smoothstep01((1 - d) / 0.2))); break;
          // pão de açúcar: cúpula de flancos íngremes
          case 'sugarloaf': nv = Math.max(v, base + H * 1.6 * Math.pow(Math.max(0, 1 - d * d), 0.7)); break;
          // ravina: sulco em V que se aprofunda arrastando
          case 'gully': nv = Math.max(Math.min(v, SEA_LEVEL + 1.5), v - Math.min(H * 0.25, 3) * dt * 4 * (1 - d) * (1 - d)); break;
          case 'smooth': {
            const a = gx > 0 ? h[heightIndex(gx - 1, gz)] : v;
            const b = gx < HEIGHT_MAP_RES - 1 ? h[heightIndex(gx + 1, gz)] : v;
            const c = gz > 0 ? h[heightIndex(gx, gz - 1)] : v;
            const e = gz < HEIGHT_MAP_RES - 1 ? h[heightIndex(gx, gz + 1)] : v;
            nv = v + ((a + b + c + e) * 0.25 - v) * k * f;
            break;
          }
        }
        nv = Math.max(TERRAIN_MIN_Y, Math.min(TERRAIN_MAX_Y, nv));
        h[i] = nv;
        extendBounds(this.world, i, nv);
      }
    }
    this.gx0 = Math.min(this.gx0, gx0); this.gz0 = Math.min(this.gz0, gz0);
    this.gx1 = Math.max(this.gx1, gx1); this.gz1 = Math.max(this.gz1, gz1);
    touchSamples(this.world, gx0, gz0, gx1, gz1);
  }

  /** Fecha o traço: congela os valores antes/depois em arrays tipados. */
  finish(): boolean {
    this.finished = true;
    const n = this.before.size;
    if (n === 0) return false;
    this.idx = new Int32Array(n);
    this.old = new Float32Array(n);
    this.after = new Float32Array(n);
    let j = 0;
    for (const [i, v] of this.before) {
      this.idx[j] = i; this.old[j] = v; this.after[j] = this.world.heights[i]; j++;
    }
    this.before.clear();
    return true;
  }

  private write(values: Float32Array): void {
    const h = this.world.heights;
    for (let j = 0; j < this.idx.length; j++) {
      h[this.idx[j]] = values[j];
      extendBounds(this.world, this.idx[j], values[j]);
    }
    touchSamples(this.world, this.gx0, this.gz0, this.gx1, this.gz1);
  }

  get bytes(): number { return this.idx.byteLength + this.old.byteLength + this.after.byteLength; }

  apply(): void { if (this.finished) this.write(this.after); }
  invert(): void { this.write(this.old); }
}
