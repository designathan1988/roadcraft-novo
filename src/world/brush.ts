// Terrain brush. A stroke is one command: it keeps the old value of every
// sample it touched and, at the end, the new one. Undo writes the old ones back.
// Cost in proportion to the samples touched.

import { HEIGHT_MAP_RES, HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_HALF, MAP_TILES, SEA_LEVEL, TERRAIN_MAX_Y, TERRAIN_MIN_Y } from '../config.ts';
import { Dirty } from '../core/grid.ts';
import type { Command } from '../core/commands.ts';
import { cellsOfSamples, heightAt, heightIndex, sampleCoord, worldOfSample } from './heights.ts';
import { NO_WATER, WATER_MAP_RES, WATER_SPACING, WATER_TILE_RES, waterCoord, waterIndex } from './ground.ts';
import type { World } from './world.ts';

export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten' | 'mesa' | 'canyon' | 'escarpment' | 'sugarloaf' | 'gully';

/** Ready-made landforms: the rock painted on the ground where the shape rises or falls (Ground). */
export const LANDFORM_ROCK: Partial<Record<BrushMode, number>> = { mesa: 9, canyon: 9, escarpment: 10, sugarloaf: 8, gully: 2 };

export interface BrushParams {
  mode: BrushMode;
  radius: number; // m
  strength: number; // m/s at the centre to raise/lower; fraction/s to smooth/level
}

/** Marks the layers, tiles and cells a rectangle of samples affects. */
function touchSamples(world: World, gx0: number, gz0: number, gx1: number, gz1: number): void {
  const shift = Math.log2(HEIGHT_TILE_RES);
  for (let tz = gz0 >> shift; tz <= gz1 >> shift; tz++) {
    for (let tx = gx0 >> shift; tx <= gx1 >> shift; tx++) world.layerDirty.add(tz * MAP_TILES + tx);
  }
  // buildings on the terrain depend on its height
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
 * Flattens the whole map to one height. It is the only edit that touches the whole map (asked for by the player,
 * once); the undo keeps the old heights quantized to 16 bits (2 bytes per sample).
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
  /** Water samples under the stroke: their level before the stroke and the level the land now allows. */
  private wBefore = new Map<number, number>();
  private wDesired = new Map<number, number>();
  private wIdx = new Int32Array(0); private wOld = new Float32Array(0); private wNew = new Float32Array(0);
  private flattenTo: number | null = null;
  finished = false;

  constructor(world: World) { this.world = world; }

  /** Applies one step of the brush at (x, z) for dt seconds. */
  dab(x: number, z: number, p: BrushParams, dt: number): void {
    const h = this.world.heights;
    if ((p.mode === 'flatten' || LANDFORM_ROCK[p.mode] !== undefined) && this.flattenTo === null) this.flattenTo = heightAt(h, x, z);
    // height (or depth) of the landforms by the strength: 0.4 → 45 m
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
        const f = 0.5 + 0.5 * Math.cos(d * Math.PI); // soft falloff
        const i = heightIndex(gx, gz);
        const v = h[i];
        if (!this.before.has(i)) this.before.set(i, v);
        let nv = v;
        switch (p.mode) {
          case 'raise': nv = v + p.strength * dt * f; break;
          case 'lower': nv = v - p.strength * dt * f; break;
          case 'flatten': nv = v + (this.flattenTo! - v) * k * f; break;
          // mesa and escarpment: flat top at the start height + H, cliffs (escarpment: two steps)
          case 'mesa': nv = Math.max(v, base + H * smoothstep01((1 - d) / 0.18)); break;
          case 'escarpment': nv = Math.max(v, base + H * (0.55 * smoothstep01((1 - d) / 0.08) + 0.45 * smoothstep01((0.6 - d) / 0.08))); break;
          // canyon: flat bottom, nearly vertical walls
          case 'canyon': nv = Math.min(v, Math.max(SEA_LEVEL + 2, base - H) + (base - Math.max(SEA_LEVEL + 2, base - H)) * (1 - smoothstep01((1 - d) / 0.2))); break;
          // sugarloaf: a dome with steep flanks
          case 'sugarloaf': nv = Math.max(v, base + H * 1.6 * Math.pow(Math.max(0, 1 - d * d), 0.7)); break;
          // gully: a V groove that deepens as it is dragged
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
    this.syncWater(gx0, gz0, gx1, gz1);
    touchSamples(this.world, gx0, gz0, gx1, gz1);
  }

  /**
   * Land raised above a water sample dries it; land lowered back under it rewets it from the stroke's original level.
   * Without this the water plane stayed over the new ground and showed as stripes along the bank.
   */
  private syncWater(gx0: number, gz0: number, gx1: number, gz1: number): void {
    const w = this.world, h = w.heights;
    const wx0 = Math.max(0, Math.floor(waterCoord(worldOfSample(gx0) - HEIGHT_SPACING)));
    const wx1 = Math.min(WATER_MAP_RES - 1, Math.ceil(waterCoord(worldOfSample(gx1) + HEIGHT_SPACING)));
    const wz0 = Math.max(0, Math.floor(waterCoord(worldOfSample(gz0) - HEIGHT_SPACING)));
    const wz1 = Math.min(WATER_MAP_RES - 1, Math.ceil(waterCoord(worldOfSample(gz1) + HEIGHT_SPACING)));
    for (let gz = wz0; gz <= wz1; gz++) for (let gx = wx0; gx <= wx1; gx++) {
      const i = waterIndex(gx, gz);
      const level = this.wBefore.get(i) ?? w.water[i];
      if (level === NO_WATER) continue;
      this.wBefore.set(i, level);
      const ground = heightAt(h, gx * WATER_SPACING - MAP_HALF, gz * WATER_SPACING - MAP_HALF);
      const next = ground > level - 0.5 ? NO_WATER : level;
      this.wDesired.set(i, next);
      if (w.water[i] === next) continue;
      w.water[i] = next;
      const tile = i >> (2 * Math.log2(WATER_TILE_RES));
      w.waterDirty.add(tile);
      if (next !== NO_WATER) w.tileWater[tile] = 1;
    }
  }

  /** Closes the stroke: freezes the before/after values into typed arrays. */
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
    // keep only the water samples this stroke actually changed
    const wi: number[] = [], wo: number[] = [], wn: number[] = [];
    for (const [i, old] of this.wBefore) {
      const next = this.wDesired.get(i) ?? old;
      if (next === old) continue;
      wi.push(i); wo.push(old); wn.push(next);
    }
    this.wIdx = new Int32Array(wi); this.wOld = new Float32Array(wo); this.wNew = new Float32Array(wn);
    this.wBefore.clear(); this.wDesired.clear();
    return true;
  }

  private write(values: Float32Array, water: Float32Array): void {
    const w = this.world, h = w.heights;
    for (let j = 0; j < this.idx.length; j++) {
      h[this.idx[j]] = values[j];
      extendBounds(w, this.idx[j], values[j]);
      w.layerDirty.add(this.idx[j] >> (2 * Math.log2(HEIGHT_TILE_RES)));
    }
    for (let j = 0; j < this.wIdx.length; j++) {
      const i = this.wIdx[j], v = water[j];
      w.water[i] = v;
      const tile = i >> (2 * Math.log2(WATER_TILE_RES));
      w.waterDirty.add(tile);
      if (v !== NO_WATER) w.tileWater[tile] = 1;
    }
    // only the cells of the samples the stroke touched (a long stroke's box would cover many more)
    this.cells ??= cellsOfSamples(this.idx);
    this.near ??= cellsOfSamples(this.idx, 40);
    for (const c of this.cells) w.touchCell(c, Dirty.Terrain | TERRAIN_FOLLOWERS);
    for (const c of this.near) w.touchCell(c, Dirty.Buildings);
  }
  private cells: number[] | null = null;
  /** Cells whose buildings may stand on the samples (a building reaches up to ~40 m from its centre's cell). */
  private near: number[] | null = null;

  get bytes(): number { return this.idx.byteLength + this.old.byteLength + this.after.byteLength + this.wIdx.byteLength + this.wOld.byteLength + this.wNew.byteLength; }

  apply(): void { if (this.finished) this.write(this.after, this.wNew); }
  invert(): void { this.write(this.old, this.wOld); }
}
