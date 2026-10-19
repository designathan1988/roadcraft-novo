// Itens de rua postos pelo jogador: objetos (árvore, banco, hidrante, placa…)
// e trechos de muro/cerca/sebe/defensa/gradil. Tabela SoA com índice espacial;
// as peças saem no mesmo trabalho de peças da célula. Edição = comando.

import { Table } from '../core/table.ts';
import { MAP_CELLS } from '../config.ts';
import { Dirty, SpatialIndex, cellId, cellX } from '../core/grid.ts';
import type { Command } from '../core/commands.ts';
import type { World } from './world.ts';

/** O que o item é. Objetos usam (x0, z0) e o rumo em x1; trechos vão de (x0, z0) a (x1, z1). */
export const Item = {
  Tree: 0, Bush: 1, Bench: 2, Bin: 3, Lamp: 4, Hydrant: 5, Postbox: 6, Phone: 7, Drain: 8, Bollard: 9, Planter: 10,
  Sign: 11, Conifer: 12, Smoke: 13, Steam: 14, Fire: 15, Fountain: 16,
  Fence: 20, Wall: 21, Hedge: 22, Guardrail: 23, Railing: 24, PoleLine: 25,
  // efeitos (partículas) que vieram depois
  Dust: 26, Soot: 27, Sparks: 28, Spray: 29,
  // elementos do chão (pincel): 30 + variante da peça Ground
  Stones: 30, Pebbles: 31, Gravel: 32, Leaves: 33, Grass: 34, TallGrass: 35, Scrub: 36, Fern: 37, Clover: 38, Flowers: 39, Mushrooms: 40,
  Palm: 41,
  // neblina (pincel do clima): emissor de lençol baixo
  Mist: 42,
  // pessoa feita no criador (parada): variante = cor da roupa + altura × 16
  Person: 43,
} as const;
export const isBarrier = (t: number) => t >= 20 && t <= 25;
/** Fumaça, vapor, fogo, chafariz, poeira, fuligem, faíscas e borrifo: emissores de partículas. */
export const isEffect = (t: number) => (t >= 13 && t <= 16) || (t >= 26 && t <= 29) || t === 42;
export const isGroundElement = (t: number) => t >= 30 && t <= 40;

const schema = { x0: Float32Array, z0: Float32Array, x1: Float32Array, z1: Float32Array, type: Uint8Array, variant: Uint8Array };
/** Registro plano: [id, x0, z0, x1, z1, tipo, variante]. */
export type ItemRec = [number, number, number, number, number, number, number];
/** Sem o id: [x0, z0, x1, z1, tipo, variante]. */
export type ItemBody = [number, number, number, number, number, number];
/** Comprimento máximo de um trecho (o traço é quebrado nisso). */
export const MAX_RUN = 48;

export class StreetItems {
  readonly t = new Table(schema, 1 << 12);
  readonly index = new SpatialIndex(1 << 12);
  private world: World;

  constructor(world: World) {
    this.world = world;
    this.t.onGrow((cap) => this.index.grow(cap));
  }

  get size(): number { return this.t.size; }

  private touch(id: number): void {
    const c = this.t.cols;
    // a peça pode sair numa célula vizinha (trecho que cruza a borda): marca as das pontas e as vizinhas
    const cx0 = cellX(Math.min(c.x0[id], isBarrier(c.type[id]) ? c.x1[id] : c.x0[id])) - 1;
    const cz0 = cellX(Math.min(c.z0[id], isBarrier(c.type[id]) ? c.z1[id] : c.z0[id])) - 1;
    const cx1 = cellX(Math.max(c.x0[id], isBarrier(c.type[id]) ? c.x1[id] : c.x0[id])) + 1;
    const cz1 = cellX(Math.max(c.z0[id], isBarrier(c.type[id]) ? c.z1[id] : c.z0[id])) + 1;
    for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) {
      if (x < 0 || z < 0 || x >= MAP_CELLS || z >= MAP_CELLS) continue;
      this.world.touchCell(cellId(x, z), Dirty.Props | Dirty.Save);
    }
  }

  add(rec: ItemBody | ItemRec, id?: number): number {
    const r = rec.length === 7 ? rec.slice(1) : rec;
    let i: number;
    if (id !== undefined) { this.t.allocAt(id); i = id; } else i = this.t.alloc();
    const c = this.t.cols;
    c.x0[i] = r[0]; c.z0[i] = r[1]; c.x1[i] = r[2]; c.z1[i] = r[3]; c.type[i] = r[4]; c.variant[i] = r[5];
    this.index.insert(i, r[0], r[1]);
    this.touch(i);
    return i;
  }

  rec(id: number): ItemRec {
    const c = this.t.cols;
    return [id, c.x0[id], c.z0[id], c.x1[id], c.z1[id], c.type[id], c.variant[id]];
  }

  remove(id: number): void {
    if (!this.t.alive[id]) return;
    this.touch(id);
    this.index.remove(id);
    this.t.release(id);
  }

  clear(): void { this.t.clear(); this.index.clear(); }

  /** Item mais perto do ponto (objeto pela posição, trecho pela distância à linha). */
  nearest(x: number, z: number, radius: number): number {
    let best = -1, bd = radius;
    const c = this.t.cols;
    this.index.query(x - radius - MAX_RUN, z - radius - MAX_RUN, x + radius + MAX_RUN, z + radius + MAX_RUN, (i) => {
      let d: number;
      if (isBarrier(c.type[i])) {
        const ex = c.x1[i] - c.x0[i], ez = c.z1[i] - c.z0[i];
        const t = Math.max(0, Math.min(1, ((x - c.x0[i]) * ex + (z - c.z0[i]) * ez) / (ex * ex + ez * ez || 1)));
        d = Math.hypot(c.x0[i] + ex * t - x, c.z0[i] + ez * t - z);
      } else d = Math.hypot(c.x0[i] - x, c.z0[i] - z);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Itens que podem ter peças na célula (os dela e os das vizinhas), em registros planos. */
  gather(cell: number, mapCells: number): Float32Array {
    const out: number[] = [];
    const cx = cell % mapCells, cz = (cell / mapCells) | 0;
    const c = this.t.cols;
    for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || z < 0 || x >= mapCells || z >= mapCells) continue;
      this.index.queryCell(z * mapCells + x, (i) => { out.push(c.x0[i], c.z0[i], c.x1[i], c.z1[i], c.type[i], c.variant[i]); });
    }
    return new Float32Array(out);
  }

  /** Itens de um ladrilho para salvar (pela ponta inicial). */
  saveTile(tileOf: (x: number, z: number) => number, tile: number, cells: number[]): Float32Array {
    const out: number[] = [];
    const c = this.t.cols;
    for (const cid of cells) this.index.queryCell(cid, (i) => {
      if (tileOf(c.x0[i], c.z0[i]) !== tile) return;
      out.push(c.x0[i], c.z0[i], c.x1[i], c.z1[i], c.type[i], c.variant[i]);
    });
    return new Float32Array(out);
  }

  loadTile(a: Float32Array): void {
    for (let k = 0; k + 5 < a.length; k += 6) this.add([a[k], a[k + 1], a[k + 2], a[k + 3], a[k + 4], a[k + 5]]);
  }
}

/** Pôr e tirar itens, com desfazer. */
/** Pincel de elementos do chão: espalha tufos pela densidade, ou apaga (um tipo ou todos). Um traço = um comando. */
export class ElementStroke {
  readonly cmd: ItemsCommand;
  private items: StreetItems;
  private acc = 0;
  private seed = (Math.random() * 2 ** 31) >>> 0;
  constructor(items: StreetItems) { this.items = items; this.cmd = new ItemsCommand(items, 'elementos'); }
  private rnd(): number { this.seed = (this.seed * 1103515245 + 12345) >>> 0; return this.seed / 4294967296; }

  /** density: tufos por 100 m²; size 0..15; mode lay | eraseKind | eraseAll. */
  dab(x: number, z: number, r: number, kind: number, density: number, size: number, mode: 'lay' | 'eraseKind' | 'eraseAll', dt: number, spacing = 1.6): void {
    const it = this.items, c = it.t.cols;
    if (mode !== 'lay') {
      const doomed: number[] = [];
      it.index.query(x - r, z - r, x + r, z + r, (i) => {
        if (!(isGroundElement(c.type[i]) || c.type[i] === kind) || (mode === 'eraseKind' && c.type[i] !== kind)) return;
        if (Math.hypot(c.x0[i] - x, c.z0[i] - z) <= r) doomed.push(i);
      });
      for (const i of doomed) this.cmd.remove(i);
      return;
    }
    // quantos tufos neste passo: a densidade enche o círculo em ~2 s de pincel
    this.acc += density / 100 * Math.PI * r * r * Math.min(1, dt) * 0.5;
    let tries = 0;
    while (this.acc >= 1 && tries++ < 64) {
      const a = this.rnd() * Math.PI * 2, d = Math.sqrt(this.rnd()) * r;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      if (it.nearest(px, pz, spacing) >= 0) { this.acc -= 0.5; continue; }
      const v = Math.max(0, Math.min(15, Math.round(size + (this.rnd() - 0.5) * 4)));
      this.cmd.add([px, pz, this.rnd() * Math.PI * 2, 0, kind, v]);
      this.acc -= 1;
    }
  }
}

export class ItemsCommand implements Command {
  readonly label: string;
  private added: ItemRec[] = [];
  private removed: ItemRec[] = [];
  private items: StreetItems;

  constructor(items: StreetItems, label: string) { this.items = items; this.label = label; }

  get empty(): boolean { return this.added.length === 0 && this.removed.length === 0; }

  add(r: ItemBody): number {
    const id = this.items.add(r);
    this.added.push(this.items.rec(id));
    return id;
  }

  remove(id: number): void {
    this.removed.push(this.items.rec(id));
    this.items.remove(id);
  }

  apply(): void { this.swap(this.removed, this.added); }
  invert(): void { this.swap(this.added, this.removed); }

  /** Takes `out` away and puts `in` back with their ids; if an id is taken, everything goes back as it was and the error goes on. */
  private swap(out: ItemRec[], back: ItemRec[]): void {
    for (const r of out) this.items.remove(r[0]);
    let k = 0;
    try { for (; k < back.length; k++) this.items.add(back[k], back[k][0]); } catch (err) {
      for (let i = 0; i < k; i++) this.items.remove(back[i][0]);
      for (const r of out) this.items.add(r, r[0]);
      throw err;
    }
  }
}
