// Estado do mundo que vive na página: alturas (compartilhadas com os workers),
// tabelas tipadas, índice espacial e marcação de sujeira.

import { StreetItems } from './items.ts';
import { NO_WATER, createGroundBuffers } from './ground.ts';
import { CELL_COUNT, DirtyCells, Dirty, SpatialIndex, TILE_COUNT, cellX, cellId, tileOfCell, tileX, tileId } from '../core/grid.ts';
import { Table } from '../core/table.ts';
import { createHeightBuffer } from './heights.ts';
import { emptyBoxes, type BoxColumns } from '../jobs/protocol.ts';
import { RoadNetwork } from '../roads/network.ts';

/** Prédios. No marco 1 só caixas genéricas; o gerador procedural entra no marco 4. */
export const buildingSchema = {
  x: Float32Array, z: Float32Array,
  w: Float32Array, d: Float32Array, h: Float32Array,
  rot: Float32Array,
  color: Uint32Array,
  seed: Uint32Array,
  zone: Uint8Array, floors: Uint8Array, style: Uint8Array,
  /** Função (escola, igreja, hospital…; 0 = comum). */
  fn: Uint8Array,
  cell: Int32Array,
};

/** Campos de um prédio (o resto vem do gerador). */
export interface BuildingRec { x: number; z: number; w: number; d: number; h: number; rot: number; color: number; seed: number; zone: number; floors: number; style: number; fn?: number }

/** Dinheiro do começo de um mapa novo. */
export const START_MONEY = 25_000_000;

export class World {
  seed = 1;
  gameId = 0;
  /** Dinheiro em caixa (R$). Vias custam pela largura, comprimento e estrutura. */
  money = START_MONEY;
  /** Modo livre: nada é cobrado. */
  unlimited = false;
  readonly heightsSab: SharedArrayBuffer;
  readonly heights: Float32Array;
  /** Chão pintado (RGBA por amostra de 4 m, ver world/ground.ts) e água (8 m). */
  readonly groundSab: SharedArrayBuffer;
  readonly ground32: Uint32Array;
  readonly waterSab: SharedArrayBuffer;
  readonly water: Float32Array;
  /** Camadas de chão e de água a reenviar; ladrilhos que têm água. */
  readonly groundDirty = new Set<number>();
  readonly waterDirty = new Set<number>();
  readonly tileWater = new Uint8Array(TILE_COUNT);
  /** Bioma do mapa (cores e árvores). */
  biome = 0;
  /** Altura mínima/máxima conservadora por ladrilho (para recorte). */
  readonly tileMin = new Float32Array(TILE_COUNT);
  readonly tileMax = new Float32Array(TILE_COUNT);
  /** Camadas da textura de altura que precisam ser reenviadas. */
  readonly layerDirty = new Set<number>();
  /** Ladrilhos alterados desde o último salvamento. */
  readonly saveDirty = new Uint8Array(TILE_COUNT);
  /** Ladrilhos que existem no salvamento atual. */
  readonly tileInSave = new Uint8Array(TILE_COUNT);

  readonly dirty = new DirtyCells();
  readonly buildings = new Table(buildingSchema, 1 << 16);
  /** Textos das placas do jogador, pela posição (signKey), e nomes de rua por trecho. */
  readonly signTexts = new Map<string, string>();
  readonly streetNames = new Map<number, string>();
  readonly buildingIndex = new SpatialIndex(1 << 16);
  /** Versão dos dados de cada célula (sobe a cada mudança). */
  readonly cellVersion = new Uint32Array(CELL_COUNT);
  /** Prédios por célula. */
  readonly cellBuildings = new Uint32Array(CELL_COUNT);

  readonly roads: RoadNetwork;
  /** Itens de rua postos pelo jogador. */
  readonly items: StreetItems;

  constructor() {
    this.roads = new RoadNetwork(this);
    this.items = new StreetItems(this);
    this.heightsSab = createHeightBuffer();
    this.heights = new Float32Array(this.heightsSab);
    const gb = createGroundBuffers();
    this.groundSab = gb.ground; this.waterSab = gb.water;
    this.ground32 = new Uint32Array(this.groundSab);
    this.water = new Float32Array(this.waterSab);
    this.buildings.onGrow((cap) => this.buildingIndex.grow(cap));
  }

  /** Marca células sujas e o que depende delas (salvamento, versão). */
  touchRect(minX: number, minZ: number, maxX: number, maxZ: number, kinds: number): void {
    if (kinds & (Dirty.Roads | Dirty.Buildings | Dirty.Terrain)) kinds |= Dirty.Props;
    this.dirty.markRect(minX, minZ, maxX, maxZ, kinds);
    const x0 = cellX(minX), x1 = cellX(maxX), z0 = cellX(minZ), z1 = cellX(maxZ);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) this.cellVersion[cellId(cx, cz)]++;
    const tx0 = tileX(minX), tx1 = tileX(maxX), tz0 = tileX(minZ), tz1 = tileX(maxZ);
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) this.saveDirty[tileId(tx, tz)] = 1;
  }

  touchCell(cid: number, kinds: number): void {
    if (kinds & (Dirty.Roads | Dirty.Buildings | Dirty.Terrain)) kinds |= Dirty.Props;
    this.dirty.mark(cid, kinds);
    this.cellVersion[cid]++;
    this.saveDirty[tileOfCell(cid)] = 1;
  }

  /** Moradores e empregos (contas O(1) a cada prédio que entra, sai ou muda). */
  residents = 0;
  jobs = 0;

  /** Moradores e vagas de trabalho de um prédio, pela zona, área e andares. */
  static capacity(zone: number, w: number, d: number, floors: number): [number, number] {
    const area = w * d * 0.6 * floors; // área útil aproximada (lote vazio: 0 andares, ninguém)
    switch (zone) {
      case 1: return [Math.round(area / 28), 0]; // residencial
      case 2: return [0, Math.round(area / 18)]; // comercial
      case 3: return [0, Math.round(area / 45)]; // industrial
      case 4: return [Math.round(area / 40), Math.round(area / 40)]; // misto
      default: return [0, 0];
    }
  }

  private count(id: number, sign: number): void {
    const c = this.buildings.cols;
    const [r, j] = World.capacity(c.zone[id], c.w[id], c.d[id], c.floors[id]);
    this.residents += r * sign; this.jobs += j * sign;
  }

  addBuilding(b: BuildingRec, at?: number): number {
    let id: number;
    if (at !== undefined) { this.buildings.allocAt(at); id = at; } else id = this.buildings.alloc();
    const c = this.buildings.cols;
    const { x, z } = b;
    c.x[id] = x; c.z[id] = z; c.w[id] = b.w; c.d[id] = b.d; c.h[id] = b.h; c.rot[id] = b.rot; c.color[id] = b.color;
    c.seed[id] = b.seed; c.zone[id] = b.zone; c.floors[id] = b.floors; c.style[id] = b.style; c.fn[id] = b.fn ?? 0;
    const cid = cellId(cellX(x), cellX(z));
    c.cell[id] = cid;
    this.buildingIndex.insert(id, x, z);
    this.cellBuildings[cid]++;
    this.count(id, 1);
    this.touchCell(cid, Dirty.Buildings);
    return id;
  }

  /** Dados de um prédio, para comandos (desfazer). */
  buildingRec(id: number): number[] {
    const c = this.buildings.cols;
    return [id, c.x[id], c.z[id], c.w[id], c.d[id], c.h[id], c.rot[id], c.color[id], c.seed[id], c.zone[id], c.floors[id], c.style[id], c.fn[id]];
  }

  restoreBuilding(r: number[]): void {
    this.addBuilding({ x: r[1], z: r[2], w: r[3], d: r[4], h: r[5], rot: r[6], color: r[7], seed: r[8], zone: r[9], floors: r[10], style: r[11], fn: r[12] ?? 0 }, r[0]);
  }

  /** Muda andares/estilo (edição do jogador). */
  editBuilding(id: number, floors: number, style: number, fn = this.buildings.cols.fn[id]): void {
    const c = this.buildings.cols;
    this.count(id, -1);
    c.floors[id] = floors; c.style[id] = style; c.fn[id] = fn;
    this.count(id, 1);
    this.touchCell(c.cell[id], Dirty.Buildings);
  }

  /** Projeto do criador (campos color e h) e andares: a malha do prédio é refeita. */
  setDesign(id: number, color: number, h: number, floors: number): void {
    const c = this.buildings.cols;
    this.count(id, -1);
    c.color[id] = color; c.h[id] = h; c.floors[id] = floors;
    this.count(id, 1);
    this.touchCell(c.cell[id], Dirty.Buildings);
  }

  removeBuilding(id: number): void {
    if (!this.buildings.alive[id]) return;
    this.buildingIndex.remove(id);
    this.count(id, -1);
    const cid = this.buildings.cols.cell[id];
    this.cellBuildings[cid]--;
    this.touchCell(cid, Dirty.Buildings);
    this.buildings.release(id);
  }

  /** Copia os prédios de uma célula (ou de um ladrilho) para colunas transferíveis. */
  gatherBoxes(cells: number[]): BoxColumns {
    let n = 0;
    for (const c of cells) n += this.cellBuildings[c];
    const out = emptyBoxes(n);
    const col = this.buildings.cols;
    let k = 0;
    for (const c of cells) {
      this.buildingIndex.queryCell(c, (id) => {
        if (col.cell[id] !== c) return;
        out.x[k] = col.x[id]; out.z[k] = col.z[id]; out.w[k] = col.w[id]; out.d[k] = col.d[id];
        out.h[k] = col.h[id]; out.rot[k] = col.rot[id]; out.color[k] = col.color[id];
        out.seed[k] = col.seed[id]; out.zone[k] = col.zone[id]; out.floors[k] = col.floors[id]; out.style[k] = col.style[id]; out.fn[k] = col.fn[id];
        k++;
      });
    }
    out.count = k;
    return out;
  }

  /** Chão sem pintura e sem água (mapa novo, carregar). */
  clearGround(): void {
    this.ground32.fill(0);
    this.water.fill(NO_WATER);
    this.tileWater.fill(0);
    for (let t = 0; t < TILE_COUNT; t++) { this.groundDirty.add(t); this.waterDirty.add(t); }
  }

  clearBuildings(): void {
    this.buildingIndex.clear();
    this.buildings.clear();
    this.cellBuildings.fill(0);
    this.residents = 0; this.jobs = 0;
  }
}
