// Drawing layer in levels: L0 and L1 per cell, L2 per tile, L3 per
// plate. Meshes come ready from the workers, only for what is dirty. The choice
// goes down plate → tile → cell by distance (screen error) and falls back to the
// coarsest level that is ready. Every level change fades by dithering:
// the incoming and outgoing meshes use complementary masks for 0.35 s.

import * as THREE from 'three/webgpu';
import { CELL_SIZE, CELLS_PER_TILE, MAP_CELLS, MAP_PLATES, MAP_TILES, PLATE_SIZE, TILE_SIZE } from '../config.ts';
import { CELL_COUNT, TILE_COUNT, cellId, cellOriginX, tileId, tileOfCell, tileOriginX, type DirtyCells, type DirtyKind, type DirtyReader } from '../core/grid.ts';
import type { PackedMesh } from '../jobs/protocol.ts';
import { SHADOW_LENGTH, SHADOW_REACH, sunDirection } from './sun.ts';

export interface LayerSource {
  /** Asks for a cell's mesh at level 0 (everything) or 1 (without small parts). */
  buildCell(c: number, level: number, priority: number, done: (m: PackedMesh | null) => void): void;
  /** Asks for a tile's merged mesh (L2). */
  buildTile(t: number, priority: number, done: (m: PackedMesh | null) => void): void;
  /** Asks for a plate's merged mesh (L3), if the layer has plates. */
  buildPlate?(p: number, priority: number, done: (m: PackedMesh | null) => void): void;
  /** Does the cell have anything to draw? */
  hasContent(c: number): boolean;
  /**
   * For a layer without shadows (`shadows: false`): does this cell, tile or plate still cast one (a road layer's
   * bridges and viaducts)? Asked when its mesh arrives.
   */
  castsShadow?(scope: SlotScope, id: number): boolean;
}

/** What a slot holds: a cell (L0/L1), a tile (L2) or a plate (L3). */
export type SlotScope = 'cell' | 'tile' | 'plate';

export interface LayerOptions {
  /** Distance at which a tile starts drawing by cells. */
  near: number;
  /** Beyond this, cell meshes leave the GPU. */
  evict: number;
  /** Horizontal slack of the boxes (meshes that reach past the cell's edge). */
  margin: number;
  /** Beyond this not even the tile is drawn (0 = no limit). */
  far?: number;
  /** Up to here the cell uses L0; beyond, L1 (0 = L0 only). */
  detail?: number;
  /** Beyond this the whole plate uses L3 (0 = no plates). */
  plate?: number;
  /** Video memory ceiling (bytes): past it, cells leave closer in. */
  budget?: number;
  shadows?: boolean;
  /** Sparse layer (detail near the camera): draws the cells it has, without waiting for the whole tile. */
  sparse?: boolean;
}

/** One mesh of the layer: a cell, a tile or a plate (`size` metres from its origin corner). */
interface Slot { mesh: THREE.Mesh | null; built: number; requested: number; minY: number; maxY: number; bytes: number; size: number; scope: SlotScope; id: number }
const slot = (size: number, scope: SlotScope) => (_: unknown, id: number): Slot => ({ mesh: null, built: 0, requested: 0, minY: 0, maxY: 0, bytes: 0, size, scope, id });

const FADE = 0.35;
const PLATE_COUNT = MAP_PLATES * MAP_PLATES;
const TILES_PER_PLATE = PLATE_SIZE / TILE_SIZE;

interface FadeData { fade?: number; since?: number; instant?: boolean; dead?: boolean; freed?: boolean; drawnAt?: number }

/** Once the mesh is on the GPU the CPU copy is no longer needed: swap it for an empty one (count stays). */
function freeCpuCopy(g: THREE.BufferGeometry): void {
  for (const k of Object.keys(g.attributes)) {
    const a = g.attributes[k] as THREE.BufferAttribute;
    a.array = new (a.array.constructor as new (n: number) => typeof a.array)(0);
  }
  const ix = g.index;
  if (ix) { const C = ix.array.constructor as new (n: number) => Uint16Array | Uint32Array; ix.array = new C(0); }
}

export class CellLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.Material;
  private cells: Slot[][];
  private tiles: Slot[] = Array.from({ length: TILE_COUNT }, slot(TILE_SIZE, 'tile'));
  private plates: Slot[] = Array.from({ length: PLATE_COUNT }, slot(PLATE_SIZE, 'plate'));
  private cellVer = new Uint32Array(CELL_COUNT).fill(1);
  private tileVer = new Uint32Array(TILE_COUNT).fill(1);
  private plateVer = new Uint32Array(PLATE_COUNT).fill(1);
  private tileNear = new Uint8Array(TILE_COUNT);
  /** The tile's cells are all ready this frame (it draws by cells). */
  private tileCellsReady = new Uint8Array(TILE_COUNT);
  private cellFine = new Uint8Array(CELL_COUNT);
  private plateFar = new Uint8Array(PLATE_COUNT);
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3();
  private pv = new THREE.Matrix4();
  private camPos = new THREE.Vector3();
  private src: LayerSource;
  /** This layer's own list of dirty cells (the detail layer reads the same kind). */
  private dirty: DirtyReader;
  private opt: LayerOptions;
  private extra: boolean;
  private facade: boolean;
  private shown = new Set<THREE.Mesh>();
  private next = new Set<THREE.Mesh>();
  private fading: Array<{ mesh: THREE.Mesh; t0: number }> = [];
  private frame = 0;
  /** What the layer draws changed in the last `update` (the shadow cascades are redrawn). */
  changed = true;
  /** Distance scale by resolution (1 = 1080p, 45°). */
  pixelScale = 1;
  gpuBytes = 0;
  /** Shrinks the eviction radius when memory passes the ceiling. */
  private evictScale = 1;

  constructor(src: LayerSource, dirty: DirtyCells, kind: DirtyKind, material: THREE.Material, opt: LayerOptions, extra = false, facade = false) {
    this.src = src;
    this.dirty = dirty.reader(kind);
    this.material = material;
    this.opt = opt;
    this.extra = extra;
    this.facade = facade;
    this.cells = [Array.from({ length: CELL_COUNT }, slot(CELL_SIZE, 'cell'))];
    if (opt.detail) this.cells.push(Array.from({ length: CELL_COUNT }, slot(CELL_SIZE, 'cell')));
    this.group.matrixAutoUpdate = false;
  }

  /** A minimal mesh with the same vertex format, to compile the shader at load. */
  warmupMesh(): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Int16Array(12), 4, true));
    g.setAttribute('nrm', new THREE.BufferAttribute(new Int8Array(12), 4, true));
    g.setAttribute('col', new THREE.BufferAttribute(new Uint8Array(12), 4, true));
    if (this.extra) g.setAttribute('road', new THREE.BufferAttribute(new Float32Array(12), 4));
    if (this.facade) {
      g.setAttribute('fac', new THREE.BufferAttribute(new Uint8Array(12), 4, true));
      g.setAttribute('fuv', new THREE.BufferAttribute(new Int16Array(6), 2, true));
    }
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const m = new THREE.Mesh(g, this.material);
    m.frustumCulled = false;
    return m;
  }

  private plateOf(t: number): number {
    const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
    return ((tz / TILES_PER_PLATE) | 0) * MAP_PLATES + ((tx / TILES_PER_PLATE) | 0);
  }

  /** Takes this kind's dirty cells and asks for the new meshes. */
  processDirty(): void {
    const cells = this.dirty.drain();
    for (const c of cells) {
      this.cellVer[c]++;
      const t = tileOfCell(c);
      this.tileVer[t]++;
      this.plateVer[this.plateOf(t)]++;
    }
    for (const c of cells) {
      const t = tileOfCell(c);
      for (let l = 0; l < this.cells.length; l++) {
        const s = this.cells[l][c];
        if (s.mesh || s.requested) this.requestCell(c, l);
      }
      if (this.tiles[t].requested && this.tiles[t].requested !== this.tileVer[t]) this.requestTile(t);
      const p = this.plateOf(t);
      if (this.plates[p].requested && this.plates[p].requested !== this.plateVer[p]) this.requestPlate(p);
    }
  }

  private distTo(x: number, z: number, size: number): number {
    const dx = Math.max(x - this.camPos.x, 0, this.camPos.x - (x + size));
    const dz = Math.max(z - this.camPos.z, 0, this.camPos.z - (z + size));
    return Math.hypot(dx, dz);
  }

  private requestCell(c: number, level: number): void {
    const s = this.cells[level][c];
    const v = this.cellVer[c];
    if (s.requested === v) return;
    s.requested = v;
    if (!this.src.hasContent(c)) { this.setMesh(s, null, v); return; }
    const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
    const pr = this.distTo(cellOriginX(cx), cellOriginX(cz), CELL_SIZE) + level * 300;
    this.src.buildCell(c, level, pr, (m) => { if (s.requested === v) this.setMesh(s, m, v); });
  }

  private requestTile(t: number): void {
    const s = this.tiles[t];
    const v = this.tileVer[t];
    s.requested = v;
    const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
    const pr = 2000 + this.distTo(tileOriginX(tx), tileOriginX(tz), TILE_SIZE);
    this.src.buildTile(t, pr, (m) => { if (s.requested === v) this.setMesh(s, m, v); });
  }

  private requestPlate(p: number): void {
    const s = this.plates[p];
    const v = this.plateVer[p];
    if (s.requested === v || !this.src.buildPlate) return;
    s.requested = v;
    const x = tileOriginX((p % MAP_PLATES) * TILES_PER_PLATE), z = tileOriginX(((p / MAP_PLATES) | 0) * TILES_PER_PLATE);
    const pr = 4000 + this.distTo(x, z, PLATE_SIZE);
    this.src.buildPlate(p, pr, (m) => { if (s.requested === v) this.setMesh(s, m, v); });
  }

  private setMesh(s: Slot, m: PackedMesh | null, version: number): void {
    const replacing = s.mesh !== null && m !== null;
    if (s.mesh) {
      (s.mesh.userData as FadeData).dead = true;
      s.mesh.geometry.dispose();
      // three keeps a mesh's render objects (bindings, uniform buffers, one per pass and shadow cascade) until the
      // mesh itself or its material is disposed; the material is shared, so the mesh must be
      s.mesh.dispose();
      this.gpuBytes -= s.bytes;
      s.mesh = null;
      s.bytes = 0;
    }
    s.built = version;
    if (!m) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 4, true));
    g.setAttribute('nrm', new THREE.BufferAttribute(m.normal, 4, true));
    g.setAttribute('col', new THREE.BufferAttribute(m.color, 4, true));
    if (this.extra && m.extra) g.setAttribute('road', new THREE.BufferAttribute(m.extra, 4));
    if (this.facade) {
      g.setAttribute('fac', new THREE.BufferAttribute(m.fac ?? new Uint8Array(m.vertexCount * 4), 4, true));
      g.setAttribute('fuv', new THREE.BufferAttribute(m.fuv ?? new Int16Array(m.vertexCount * 2), 2, true));
    }
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    // bounds from what the worker already knows (the slot's square plus the margin, the mesh's height range), in the
    // mesh's local units: three would otherwise walk every vertex on the main thread at the first draw
    const k = 1 / m.scale, e = this.opt.margin;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-e * k, m.minY * k, -e * k), new THREE.Vector3((s.size + e) * k, m.maxY * k, (s.size + e) * k));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(m.originX, m.originY, m.originZ);
    mesh.scale.setScalar(m.scale);
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    // three culls it per camera with the bounds above: each shadow cascade draws only the meshes inside it (without
    // this every mesh the layer chose went into all 3 cascades, plates 4-10 km away included)
    mesh.frustumCulled = true;
    mesh.castShadow = (this.opt.shadows ?? true) || (this.src.castsShadow?.(s.scope, s.id) ?? false);
    mesh.receiveShadow = true;
    // a rebuild after an edit swaps at once (no fade hole)
    (mesh.userData as FadeData).instant = replacing;
    (mesh as { parent: THREE.Object3D | null }).parent = this.group;
    s.mesh = mesh;
    s.minY = m.originY + m.minY;
    s.maxY = m.originY + m.maxY;
    s.bytes = m.position.byteLength + m.normal.byteLength + m.color.byteLength + m.index.byteLength + (m.extra?.byteLength ?? 0) + (m.fac?.byteLength ?? 0) + (m.fuv?.byteLength ?? 0);
    this.gpuBytes += s.bytes;
  }

  /** Chooses what to draw. */
  update(camera: THREE.Camera, camPos: THREE.Vector3): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.camPos.copy(camPos);
    const budget = this.opt.budget ?? Infinity;
    if (this.gpuBytes > budget) this.evictScale = Math.max(0, this.evictScale - 0.02);
    else if (this.gpuBytes < budget * 0.8) this.evictScale = Math.min(1, this.evictScale + 0.005);
    this.next.clear();
    for (let pz = 0; pz < MAP_PLATES; pz++) for (let px = 0; px < MAP_PLATES; px++) this.visitPlate(px, pz);
    this.applyFades();
  }

  private visitPlate(px: number, pz: number): void {
    const p = pz * MAP_PLATES + px;
    const x = tileOriginX(px * TILES_PER_PLATE), z = tileOriginX(pz * TILES_PER_PLATE);
    const m = this.opt.margin;
    this.box.min.set(x - m, -200, z - m);
    this.box.max.set(x + PLATE_SIZE + m, 1200, z + PLATE_SIZE + m);
    const visible = this.frustum.intersectsBox(this.box);
    const dist = this.distTo(x, z, PLATE_SIZE);
    const limit = (this.opt.plate ?? 0) * this.pixelScale;
    let far = false;
    if (limit > 0) {
      far = this.plateFar[p] ? dist > limit * 0.9 : dist > limit * 1.1;
      this.plateFar[p] = far ? 1 : 0;
      if (far && visible) this.requestPlate(p);
    }
    const ps = this.plates[p];
    // tiles: asked for and kept unless the plate is far and ready to stand in for them
    const plateCovers = far && ps.mesh !== null;
    let tilesCover = true;
    for (let j = 0; j < TILES_PER_PLATE; j++) for (let i = 0; i < TILES_PER_PLATE; i++) {
      if (!this.manageTile(px * TILES_PER_PLATE + i, pz * TILES_PER_PLATE + j, limit > 0 && !plateCovers)) tilesCover = false;
    }
    // the camera came close and the tiles cover the plate: it leaves the GPU (it used to stay for the whole session,
    // pushing the memory ceiling down onto the near cells)
    if (!far && tilesCover && (ps.mesh || ps.requested) && dist < limit * 0.8) { this.setMesh(ps, null, 0); ps.requested = 0; }
    if (!visible) return;
    // never a hole: the plate stands in while its tiles are not all ready (the camera came closer), the tiles while
    // the plate is not ready
    if (ps.mesh && (far || !tilesCover)) { this.draw(ps.mesh, x, z, PLATE_SIZE, ps); return; }
    for (let j = 0; j < TILES_PER_PLATE; j++) for (let i = 0; i < TILES_PER_PLATE; i++) this.drawTile(px * TILES_PER_PLATE + i, pz * TILES_PER_PLATE + j);
  }

  private tileKeep(): number {
    return this.opt.plate ? this.opt.plate * 1.25 * this.pixelScale : (this.opt.far ? this.farLimit() : 1e9);
  }

  /**
   * How far the layer draws (`far`): farther at high resolutions (more pixels per metre), never nearer than at
   * 1080p (a road network cut at 2.7 km below 1080p read as a hole). The same limit keeps and draws the tiles.
   */
  private farLimit(): number {
    return (this.opt.far ?? 0) * Math.max(1, this.pixelScale);
  }

  private evictDist(): number {
    const near = this.opt.near * this.pixelScale * 1.15;
    return near + (this.opt.evict * this.pixelScale - near) * this.evictScale;
  }

  private draw(mesh: THREE.Mesh, x: number, z: number, size: number, s: Slot): void {
    const m = this.opt.margin;
    this.box.min.set(x - m, s.minY, z - m);
    this.box.max.set(x + size + m, s.maxY, z + size + m);
    if (this.frustum.intersectsBox(this.box)) { this.next.add(mesh); return; }
    // outside the view but within the shadows' reach: its shadow may fall into the view. The box is stretched along
    // the shadow (away from the sun, as long as its height casts it); three culls the mesh out of the main pass and
    // draws it only into the cascades it reaches
    const sun = sunDirection;
    if (mesh.castShadow && sun.y > 0.02 && this.distTo(x, z, size) < SHADOW_REACH * this.pixelScale) {
      const len = Math.min(SHADOW_LENGTH, (s.maxY - s.minY) / sun.y);
      const dx = -sun.x * len, dz = -sun.z * len;
      this.box.min.set(Math.min(this.box.min.x, this.box.min.x + dx), s.minY - (s.maxY - s.minY), Math.min(this.box.min.z, this.box.min.z + dz));
      this.box.max.set(Math.max(this.box.max.x, this.box.max.x + dx), s.maxY, Math.max(this.box.max.z, this.box.max.z + dz));
      if (this.frustum.intersectsBox(this.box)) this.next.add(mesh);
    }
  }

  /**
   * Asks for and evicts a tile's meshes (its cells near the camera, its L2 farther). `needed`: nothing coarser covers
   * the tile, so its L2 is asked for at any distance. Returns whether what the tile would draw is ready.
   */
  private manageTile(tx: number, tz: number, needed: boolean): boolean {
    if (tx >= MAP_TILES || tz >= MAP_TILES) return true;
    const t = tileId(tx, tz);
    const ox = tileOriginX(tx), oz = tileOriginX(tz);
    const dist = this.distTo(ox, oz, TILE_SIZE);
    const nearD = this.opt.near * this.pixelScale;
    const near = this.tileNear[t] ? dist < nearD * 1.12 : dist < nearD * 0.88;
    this.tileNear[t] = near ? 1 : 0;
    const ts = this.tiles[t];
    // the tile (L2) stays on the GPU only in the band where it can be drawn, or while its plate cannot stand in
    const keep = this.tileKeep();
    if (dist < keep || needed) { if (ts.requested !== this.tileVer[t]) this.requestTile(t); }
    else if (dist > keep * 1.15 && (ts.mesh || ts.requested)) { this.setMesh(ts, null, 0); ts.requested = 0; }
    const detail = (this.opt.detail ?? 0) * this.pixelScale;
    const levels = this.cells.length;

    let cellsReady = near;
    if (near) {
      for (let j = 0; j < CELLS_PER_TILE; j++) {
        for (let i = 0; i < CELLS_PER_TILE; i++) {
          const ci = tx * CELLS_PER_TILE + i, cj = tz * CELLS_PER_TILE + j;
          const c = cellId(ci, cj);
          const cd = this.distTo(cellOriginX(ci), cellOriginX(cj), CELL_SIZE);
          const fine = levels === 1 || (this.cellFine[c] ? cd < detail * 1.15 : cd < detail * 0.85);
          this.cellFine[c] = fine ? 1 : 0;
          const want = fine ? 0 : 1;
          this.requestCell(c, want);
          if (!this.opt.sparse && !this.cells[want][c].mesh && !(levels > 1 && this.cells[1 - want][c].mesh) && this.src.hasContent(c)) cellsReady = false;
          // L0 far from the camera leaves the GPU (L1 covers it)
          if (levels > 1 && cd > detail * 1.6) {
            const s0 = this.cells[0][c];
            if (s0.mesh || s0.requested) { this.setMesh(s0, null, 0); s0.requested = 0; }
          }
        }
      }
    } else if (dist > this.evictDist()) {
      for (let j = 0; j < CELLS_PER_TILE; j++) {
        for (let i = 0; i < CELLS_PER_TILE; i++) {
          const c = cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j);
          for (let l = 0; l < levels; l++) {
            const s = this.cells[l][c];
            if (s.mesh || s.requested) { this.setMesh(s, null, 0); s.requested = 0; }
          }
        }
      }
    }
    this.tileCellsReady[t] = cellsReady ? 1 : 0;
    // built and empty (nothing to draw) counts as ready
    return cellsReady || ts.mesh !== null || (ts.built !== 0 && ts.built === this.tileVer[t]);
  }

  /** Draws a tile: its cells when they are all ready, else its L2. */
  private drawTile(tx: number, tz: number): void {
    if (tx >= MAP_TILES || tz >= MAP_TILES) return;
    const t = tileId(tx, tz);
    const ox = tileOriginX(tx), oz = tileOriginX(tz);
    if (this.opt.far && this.distTo(ox, oz, TILE_SIZE) > this.farLimit()) return;
    const levels = this.cells.length;
    if (this.tileCellsReady[t]) {
      for (let j = 0; j < CELLS_PER_TILE; j++) {
        for (let i = 0; i < CELLS_PER_TILE; i++) {
          const c = cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j);
          const want = this.cellFine[c] || levels === 1 ? 0 : 1;
          let s = this.cells[want][c];
          if (!s.mesh && levels > 1) s = this.cells[1 - want][c];
          if (!s.mesh) continue;
          this.draw(s.mesh, cellOriginX(tx * CELLS_PER_TILE + i), cellOriginX(tz * CELLS_PER_TILE + j), CELL_SIZE, s);
        }
      }
    } else {
      const ts = this.tiles[t];
      if (ts.mesh) this.draw(ts.mesh, ox, oz, TILE_SIZE, ts);
    }
  }

  /** Fading: what came in rises, what left goes down, with complementary masks. */
  private applyFades(): void {
    const now = performance.now() / 1000;
    const out = this.group.children;
    out.length = 0;
    this.frame++;
    // what is drawn changed this frame (a mesh came, left, was swapped or is fading): the shadow maps must follow
    this.changed = this.fading.length > 0 || this.next.size !== this.shown.size;
    if (!this.changed) for (const m of this.next) if (!this.shown.has(m)) { this.changed = true; break; }
    // an outgoing mesh thrown away mid-fade (evicted, rebuilt): what fades in where it was shows whole at once (its
    // dither left holes where the outgoing one no longer covered)
    let lostOutgoing = false;
    for (const f of this.fading) if ((f.mesh.userData as FadeData).dead) lostOutgoing = true;
    for (const m of this.shown) if (!this.next.has(m) && (m.userData as FadeData).dead) lostOutgoing = true;
    // a hidden layer (?semdetalhe) draws nothing: its meshes' data must stay until they really reach the GPU
    const drawn = this.group.visible;
    for (const mesh of this.next) {
      const u = mesh.userData as FadeData;
      // already drawn in an earlier frame: the data is on the GPU
      if (!u.freed && drawn) { if (u.drawnAt === undefined) u.drawnAt = this.frame; else if (this.frame - u.drawnAt >= 2) { freeCpuCopy(mesh.geometry); u.freed = true; } }
      if (!this.shown.has(mesh)) {
        const i = this.fading.findIndex((f) => f.mesh === mesh);
        if (i >= 0) {
          // it comes back while fading out: it goes on from how visible it still was (restarting from 0 jumped)
          const left = Math.max(0, 1 - (now - this.fading[i].t0) / FADE);
          u.since = now - left * FADE;
          this.fading[i] = this.fading[this.fading.length - 1]; this.fading.pop();
        } else u.since = u.instant || this.shown.size === 0 ? -1e9 : now;
        u.instant = false;
      }
      if (lostOutgoing) u.since = -1e9;
      u.fade = Math.min(1, (now - (u.since ?? -1e9)) / FADE);
      out.push(mesh);
    }
    for (const mesh of this.shown) {
      if (!this.next.has(mesh) && !(mesh.userData as FadeData).dead) this.fading.push({ mesh, t0: now });
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      const a = (now - f.t0) / FADE;
      const u = f.mesh.userData as FadeData;
      if (a >= 1 || u.dead) { this.fading[i] = this.fading[this.fading.length - 1]; this.fading.pop(); continue; }
      u.fade = -Math.max(a, 1e-3);
      out.push(f.mesh);
    }
    const t = this.shown; this.shown = this.next; this.next = t;
  }

  /** Forgets everything (when loading another city). */
  reset(): void {
    for (const level of this.cells) for (const s of level) { this.setMesh(s, null, 0); s.requested = 0; }
    for (const s of this.tiles) { this.setMesh(s, null, 0); s.requested = 0; }
    for (const s of this.plates) { this.setMesh(s, null, 0); s.requested = 0; }
    // versions only go forward: a job of the previous city still running answers with its old version and is dropped
    // (back to 1, the new city's first request had the same version as the old city's and took its mesh)
    for (const ver of [this.cellVer, this.tileVer, this.plateVer]) for (let i = 0; i < ver.length; i++) ver[i]++;
    this.shown.clear();
    this.fading.length = 0;
    this.group.children.length = 0;
  }
}
