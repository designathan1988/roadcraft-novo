// Contrato entre a página e o pool de workers. Só tipos e dados planos.

import type { Profile } from '../roads/profiles.ts';

export interface SharedWorld {
  /** Alturas do terreno (ver world/heights.ts). */
  heights: SharedArrayBuffer;
  /** Chão pintado e água (ver world/ground.ts). */
  ground: SharedArrayBuffer;
  water: SharedArrayBuffer;
}

/** Prédios genéricos de um ladrilho/célula, em colunas. */
/**
 * Prédios em colunas. Um prédio é o lote (centro, frente w, fundo d, giro) +
 * zona + andares + semente + estilo: o gerador procedural faz o resto. A
 * frente do lote olha para +z local (para a via). Zona 0 = caixa genérica
 * de altura h e cor color (carregador de pior caso antigo).
 */
export interface BoxColumns {
  count: number;
  x: Float32Array; z: Float32Array;
  w: Float32Array; d: Float32Array; h: Float32Array;
  rot: Float32Array;
  color: Uint32Array; // 0xRRGGBB
  seed: Uint32Array;
  zone: Uint8Array; floors: Uint8Array; style: Uint8Array;
  /** Função do prédio (0 = comum). */
  fn: Uint8Array;
  /**
   * Polygon lot (save version 7). shapeN[i] = number of corners (0 = the lot is the rectangle w × d). The corners
   * are in `shape`, SHAPE_STRIDE int16 per building: (x, z) pairs in decimetres in the lot frame (x along the
   * front, z towards the front, the same frame as w/d and `lotToWorld` in world/lotEdit.ts), counter-clockwise seen
   * from above (x right, z up), simple (no crossing edges), all inside the rectangle ±w/2 × ±d/2. Up to SHAPE_MAX
   * corners; a curved side arrives already sampled into corners. The building generator fits the building into it.
   */
  shapeN: Uint8Array;
  shape: Int16Array;
  /** City minute the building was built or last renovated (World.clock); decay is derived from it. */
  built: Float32Array;
  /**
   * How run-down it is, in tenths: 0 (new) to 10 (falling apart). Roadcraft's ageing: 5 days of grace, then 30
   * days to fall apart without maintenance (world/decay.ts). Filled by the page when it gathers the boxes; the
   * cell is marked dirty only when a building passes a tenth. The drawing reads it (stains, broken windows…).
   */
  decay: Uint8Array;
}

/** Most corners of a polygon lot, and int16 per building in BoxColumns.shape. */
export const SHAPE_MAX = 16;
export const SHAPE_STRIDE = SHAPE_MAX * 2;
/** Decimetres per unit of BoxColumns.shape. */
export const SHAPE_SCALE = 10;

/** Malha compacta pronta para a GPU. Posições relativas à origem, em snorm16 × escala. */
export interface PackedMesh {
  originX: number; originY: number; originZ: number;
  scale: number;
  vertexCount: number;
  position: Int16Array; // xyzw, snorm
  normal: Int8Array; // oct xy + 2 livres, snorm
  color: Uint8Array; // rgb + material, unorm
  index: Uint16Array | Uint32Array;
  /** Atributo extra por vértice (vias: u, v, até o fim, código). */
  extra?: Float32Array;
  /** Fachada por vértice (prédios): estilo, semente, tipo, largura da coluna. */
  fac?: Uint8Array;
  /** Coordenadas na parede (u em colunas, h em metros sobre a base), snorm16 × 512. */
  fuv?: Int16Array;
  /** Caixa local (metros, relativa à origem). */
  minY: number; maxY: number;
}

export interface JobPayloads {
  terrainGen: { seed: number; tile: number };
  debugTile: { seed: number; tile: number };
  buildingMesh: { boxes: BoxColumns; originX: number; originZ: number; extent: number; lod: number };
  roadMesh: { graph: RoadGraph; originX: number; originZ: number; extent: number; lod: number };
  roadPaint: { graph: RoadGraph; tile: number };
  lots: { graph: RoadGraph; cell: number };
  props: { graph: RoadGraph; boxes: BoxColumns; cell: number; items?: Float32Array; biome?: number };
  cityGen: { seed: number };
  conform: { tile: number; segs: Float32Array };
  /** ground and water: the tile's painted ground and water, copied by the page with the rest of the snapshot. */
  saveTile: { slot: string; tile: number; heights: Uint16Array; boxes: BoxColumns; roads: RoadSave; ground?: Uint32Array; water?: Float32Array };
  saveMeta: { slot: string; meta: Uint8Array };
  loadTile: { slot: string; tile: number };
  loadMeta: { slot: string };
}

export interface JobResults {
  terrainGen: { tile: number; min: number; max: number };
  debugTile: { tile: number; roadNodes: Float32Array; roadSegs: Int32Array; min: number; max: number };
  buildingMesh: { mesh: PackedMesh | null };
  roadMesh: { mesh: PackedMesh | null };
  roadPaint: { tile: number; texels: Uint8Array; coarse: Uint8Array };
  lots: { cell: number; lots: LotColumns };
  props: { cell: number; props: PropColumns };
  cityGen: { nodes: Float32Array; segs: Int32Array; centers: Float32Array };
  conform: { tile: number; min: number; max: number };
  saveTile: { tile: number; bytes: number };
  saveMeta: { bytes: number };
  loadTile: { tile: number; found: boolean; min: number; max: number; boxes: BoxColumns | null; roads: RoadSave | null; hasWater?: boolean; /** the file exists but cannot be read */ corrupt?: boolean };
  loadMeta: { meta: Uint8Array | null };
}

export type JobKind = keyof JobPayloads;

/** Vias de um ladrilho no salvamento: nós [id, x, z, y] e trechos [id, a, b, cx, cz, perfil, bits, zona esq., zona dir.]. */
export interface RoadSave { nodes: Float32Array; segs: Float32Array; /** Itens de rua (versão 4): 6 números por item. */ items?: Float32Array }
export const NODE_REC = 4;
export const SEG_REC = 9;
/** Registro de trecho na versão 2 do salvamento (sem zonas). */
export const SEG_REC_V2 = 7;

export type ToWorker =
  | { type: 'init'; shared: SharedWorld }
  | { type: 'job'; id: number; kind: JobKind; payload: unknown }
  | { type: 'profiles'; list: Profile[] };

export type FromWorker =
  | { type: 'done'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };

/** Lista de buffers de colunas, para transferir. */
export function boxTransfer(b: BoxColumns): ArrayBuffer[] {
  return boxColumnList(b).map((a) => a.buffer as ArrayBuffer);
}

/** Columns in save order (version 3: 11, 4: + fn, 7: + shapeN, shape, built, decay). */
export function boxColumnList(b: BoxColumns): Array<Float32Array | Uint32Array | Uint8Array | Int16Array> {
  return [b.x, b.z, b.w, b.d, b.h, b.rot, b.color, b.seed, b.zone, b.floors, b.style, b.fn, b.shapeN, b.shape, b.built, b.decay];
}

/** Elements per building of a column (shape has SHAPE_STRIDE, the rest 1). */
export function columnStride(b: BoxColumns, col: ArrayBufferView): number { return col === b.shape ? SHAPE_STRIDE : 1; }

export function emptyBoxes(n: number): BoxColumns {
  return {
    count: n,
    x: new Float32Array(n), z: new Float32Array(n),
    w: new Float32Array(n), d: new Float32Array(n), h: new Float32Array(n),
    rot: new Float32Array(n), color: new Uint32Array(n),
    seed: new Uint32Array(n), zone: new Uint8Array(n), floors: new Uint8Array(n), style: new Uint8Array(n),
    fn: new Uint8Array(n),
    shapeN: new Uint8Array(n), shape: new Int16Array(n * SHAPE_STRIDE), built: new Float32Array(n), decay: new Uint8Array(n),
  };
}

/** Lotes de uma célula (frente para +z local, como os prédios). */
export interface LotColumns {
  count: number;
  x: Float32Array; z: Float32Array; w: Float32Array; d: Float32Array; rot: Float32Array;
  zone: Uint8Array; seed: Uint32Array;
  /** Perfil da via em frente (avenida dá prédio mais alto). */
  profile: Uint8Array;
}

export function lotTransfer(l: LotColumns): ArrayBuffer[] {
  return [l.x, l.z, l.w, l.d, l.rot, l.zone, l.seed, l.profile].map((a) => a.buffer as ArrayBuffer);
}

/**
 * Peças de uma célula (árvores, postes, semáforos, bancos...). Por instância:
 * x, y, z e w = rumo (12 bits) + variante (4) * 4096 + escala (6) * 65536;
 * extra = tipo (4 bits) + chave * 16 (semáforo: nó * 8 + braço; outros: aleatório).
 */
export interface PropColumns {
  count: number;
  data: Float32Array;
  extra: Uint32Array;
}

export function propTransfer(p: PropColumns): ArrayBuffer[] {
  return [p.data.buffer as ArrayBuffer, p.extra.buffer as ArrayBuffer];
}

export function meshTransfer(m: PackedMesh): ArrayBuffer[] {
  const list: ArrayBufferView[] = [m.position, m.normal, m.color, m.index];
  if (m.extra) list.push(m.extra);
  if (m.fac) list.push(m.fac);
  if (m.fuv) list.push(m.fuv);
  return list.map((a) => a.buffer as ArrayBuffer);
}

/** Pedaço da rede viária mandado a um worker: os trechos e nós a montar e os vizinhos que definem os recuos. */
export interface RoadGraph {
  nodeCount: number;
  nx: Float32Array; nz: Float32Array; ny: Float32Array;
  /** 1 = montar o cruzamento/ponta deste nó aqui. */
  nodeOwn: Uint8Array;
  segCount: number;
  sa: Int32Array; sb: Int32Array; // índices nos arrays de nós
  scx: Float32Array; scz: Float32Array;
  sprofile: Uint8Array; sflags: Uint8Array;
  /** 1 = montar este trecho aqui. */
  segOwn: Uint8Array;
  /** Id real do trecho (para a ocupação do trânsito no shader). */
  sid: Int32Array;
  /** Zonas dos lados esquerdo/direito. */
  szl: Uint8Array; szr: Uint8Array;
  /** Id real de cada nó (semáforos). */
  nid: Int32Array;
  /** Controle efetivo de cada nó (Ctl). */
  nctl: Uint8Array;
  /** Regra de cada ponta de trecho: ponta a nos bits 0-2, ponta b nos bits 3-5 (Rule). */
  srule: Uint8Array;
}

export function roadGraphTransfer(g: RoadGraph): ArrayBuffer[] {
  return [g.nx, g.nz, g.ny, g.nodeOwn, g.sa, g.sb, g.scx, g.scz, g.sprofile, g.sflags, g.segOwn, g.sid, g.szl, g.szr, g.nid, g.nctl, g.srule].map((a) => a.buffer as ArrayBuffer);
}
