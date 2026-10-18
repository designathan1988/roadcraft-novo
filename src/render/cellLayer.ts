// Camada de desenho em níveis: L0 e L1 por célula, L2 por ladrilho, L3 por
// placa. As malhas vêm prontas dos workers, só para o que está sujo. A escolha
// desce placa → ladrilho → célula pela distância (erro de tela) e cai no nível
// mais grosso que estiver pronto. Toda troca de nível esmaece por pontilhado:
// a malha que entra e a que sai usam máscaras complementares por 0,35 s.

import * as THREE from 'three/webgpu';
import { CELL_SIZE, CELLS_PER_TILE, MAP_CELLS, MAP_PLATES, MAP_TILES, PLATE_SIZE, TILE_SIZE } from '../config.ts';
import { CELL_COUNT, TILE_COUNT, cellId, cellOriginX, tileId, tileOfCell, tileOriginX, type DirtyCells, type DirtyKind } from '../core/grid.ts';
import type { PackedMesh } from '../jobs/protocol.ts';

export interface LayerSource {
  /** Pede a malha de uma célula no nível 0 (tudo) ou 1 (sem peças pequenas). */
  buildCell(c: number, level: number, priority: number, done: (m: PackedMesh | null) => void): void;
  /** Pede a malha fundida de um ladrilho (L2). */
  buildTile(t: number, priority: number, done: (m: PackedMesh | null) => void): void;
  /** Pede a malha fundida de uma placa (L3), se a camada tiver. */
  buildPlate?(p: number, priority: number, done: (m: PackedMesh | null) => void): void;
  /** A célula tem algo a desenhar? */
  hasContent(c: number): boolean;
}

export interface LayerOptions {
  /** Distância em que um ladrilho passa a desenhar por células. */
  near: number;
  /** Além disto as malhas de célula saem da GPU. */
  evict: number;
  /** Folga horizontal das caixas (malhas que passam da borda da célula). */
  margin: number;
  /** Além disto nem o ladrilho é desenhado (0 = sem limite). */
  far?: number;
  /** Até aqui a célula usa L0; depois L1 (0 = só L0). */
  detail?: number;
  /** Além disto a placa inteira usa L3 (0 = sem placas). */
  plate?: number;
  /** Teto de memória de vídeo (bytes): passando, as células saem mais perto. */
  budget?: number;
  shadows?: boolean;
  /** Camada esparsa (detalhe perto da câmera): desenha as células que tiver, sem esperar o ladrilho inteiro. */
  sparse?: boolean;
}

interface Slot { mesh: THREE.Mesh | null; built: number; requested: number; minY: number; maxY: number; bytes: number }
const slot = (): Slot => ({ mesh: null, built: 0, requested: 0, minY: 0, maxY: 0, bytes: 0 });

const FADE = 0.35;
const PLATE_COUNT = MAP_PLATES * MAP_PLATES;
const TILES_PER_PLATE = PLATE_SIZE / TILE_SIZE;

interface FadeData { fade?: number; since?: number; instant?: boolean; dead?: boolean; freed?: boolean; drawnAt?: number }

/** Depois que a malha subiu para a GPU, a cópia na CPU não serve mais: troca por um vazio (count fica). */
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
  private tiles: Slot[] = Array.from({ length: TILE_COUNT }, slot);
  private plates: Slot[] = Array.from({ length: PLATE_COUNT }, slot);
  private cellVer = new Uint32Array(CELL_COUNT).fill(1);
  private tileVer = new Uint32Array(TILE_COUNT).fill(1);
  private plateVer = new Uint32Array(PLATE_COUNT).fill(1);
  private tileNear = new Uint8Array(TILE_COUNT);
  private cellFine = new Uint8Array(CELL_COUNT);
  private plateFar = new Uint8Array(PLATE_COUNT);
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3();
  private pv = new THREE.Matrix4();
  private camPos = new THREE.Vector3();
  private src: LayerSource;
  private dirty: DirtyCells;
  private kind: DirtyKind;
  private opt: LayerOptions;
  private extra: boolean;
  private facade: boolean;
  private shown = new Set<THREE.Mesh>();
  private next = new Set<THREE.Mesh>();
  private fading: Array<{ mesh: THREE.Mesh; t0: number }> = [];
  private frame = 0;
  /** Escala das distâncias pela resolução (1 = 1080p, 45°). */
  pixelScale = 1;
  gpuBytes = 0;
  /** Encolhe o raio de descarte quando a memória passa do teto. */
  private evictScale = 1;

  constructor(src: LayerSource, dirty: DirtyCells, kind: DirtyKind, material: THREE.Material, opt: LayerOptions, extra = false, facade = false) {
    this.src = src;
    this.dirty = dirty;
    this.kind = kind;
    this.material = material;
    this.opt = opt;
    this.extra = extra;
    this.facade = facade;
    this.cells = [Array.from({ length: CELL_COUNT }, slot)];
    if (opt.detail) this.cells.push(Array.from({ length: CELL_COUNT }, slot));
    this.group.matrixAutoUpdate = false;
  }

  /** Malha mínima com o mesmo formato de vértice, para compilar o shader na carga. */
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

  /** Consome as células sujas deste tipo e pede as malhas novas. */
  processDirty(): void {
    const cells = this.dirty.drain(this.kind);
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
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(m.originX, m.originY, m.originZ);
    mesh.scale.setScalar(m.scale);
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.castShadow = this.opt.shadows ?? true;
    mesh.receiveShadow = true;
    // reconstrução por edição troca na hora (sem buraco do esmaecimento)
    (mesh.userData as FadeData).instant = replacing;
    (mesh as { parent: THREE.Object3D | null }).parent = this.group;
    s.mesh = mesh;
    s.minY = m.originY + m.minY;
    s.maxY = m.originY + m.maxY;
    s.bytes = m.position.byteLength + m.normal.byteLength + m.color.byteLength + m.index.byteLength + (m.extra?.byteLength ?? 0) + (m.fac?.byteLength ?? 0) + (m.fuv?.byteLength ?? 0);
    this.gpuBytes += s.bytes;
  }

  /** Escolhe o que desenhar. */
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
    const usePlate = far && ps.mesh !== null;
    for (let j = 0; j < TILES_PER_PLATE; j++) for (let i = 0; i < TILES_PER_PLATE; i++) {
      this.visitTile(px * TILES_PER_PLATE + i, pz * TILES_PER_PLATE + j, visible && !usePlate);
    }
    if (usePlate && visible) this.draw(ps.mesh!, x, z, PLATE_SIZE, ps);
  }

  private tileKeep(): number {
    const limit = this.opt.plate ? this.opt.plate * 1.25 : (this.opt.far || 1e9);
    return limit * this.pixelScale;
  }

  private evictDist(): number {
    const near = this.opt.near * this.pixelScale * 1.15;
    return near + (this.opt.evict * this.pixelScale - near) * this.evictScale;
  }

  private draw(mesh: THREE.Mesh, x: number, z: number, size: number, s: Slot): void {
    const m = this.opt.margin;
    this.box.min.set(x - m, s.minY, z - m);
    this.box.max.set(x + size + m, s.maxY, z + size + m);
    if (this.frustum.intersectsBox(this.box)) this.next.add(mesh);
  }

  private visitTile(tx: number, tz: number, mayDraw: boolean): void {
    if (tx >= MAP_TILES || tz >= MAP_TILES) return;
    const t = tileId(tx, tz);
    const ox = tileOriginX(tx), oz = tileOriginX(tz);
    const dist = this.distTo(ox, oz, TILE_SIZE);
    const nearD = this.opt.near * this.pixelScale;
    const near = this.tileNear[t] ? dist < nearD * 1.12 : dist < nearD * 0.88;
    this.tileNear[t] = near ? 1 : 0;
    const ts = this.tiles[t];
    // o ladrilho (L2) só fica na GPU na faixa em que pode ser desenhado
    const keep = this.tileKeep();
    if (dist < keep) { if (ts.requested !== this.tileVer[t]) this.requestTile(t); }
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
          // L0 longe da câmera sai da GPU (o L1 cobre)
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
    if (!mayDraw) return;
    if (this.opt.far && dist > this.opt.far) return;

    if (cellsReady) {
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
    } else if (ts.mesh) {
      this.draw(ts.mesh, ox, oz, TILE_SIZE, ts);
    }
  }

  /** Esmaecimento: quem entrou sobe, quem saiu desce, com máscaras complementares. */
  private applyFades(): void {
    const now = performance.now() / 1000;
    const out = this.group.children;
    out.length = 0;
    this.frame++;
    for (const mesh of this.next) {
      const u = mesh.userData as FadeData;
      // já foi desenhada num quadro anterior: os dados estão na GPU
      if (!u.freed) { if (u.drawnAt === undefined) u.drawnAt = this.frame; else if (this.frame - u.drawnAt >= 2) { freeCpuCopy(mesh.geometry); u.freed = true; } }
      if (!this.shown.has(mesh)) {
        u.since = u.instant || this.shown.size === 0 ? -1e9 : now;
        u.instant = false;
        const i = this.fading.findIndex((f) => f.mesh === mesh);
        if (i >= 0) { this.fading[i] = this.fading[this.fading.length - 1]; this.fading.pop(); }
      }
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

  /** Esquece tudo (ao carregar outra cidade). */
  reset(): void {
    for (const level of this.cells) for (const s of level) { this.setMesh(s, null, 0); s.requested = 0; }
    for (const s of this.tiles) { this.setMesh(s, null, 0); s.requested = 0; }
    for (const s of this.plates) { this.setMesh(s, null, 0); s.requested = 0; }
    this.cellVer.fill(1);
    this.tileVer.fill(1);
    this.plateVer.fill(1);
    this.shown.clear();
    this.fading.length = 0;
    this.group.children.length = 0;
  }
}
