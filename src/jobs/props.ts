// Peças da rua e dos lotes (worker): postes, árvores de calçada e de canteiro,
// semáforos, bancos, lixeiras, árvores e arbustos de quintal. Função pura da
// rede em volta da célula e dos prédios dela; cada peça fica na célula onde
// cai, então células vizinhas nunca duplicam.

import { MAP_CELLS, SEA_LEVEL } from '../config.ts';
import { cellId, cellOriginX, cellX } from '../core/grid.ts';
import { Rng, fbm, hash2 } from '../core/rng.ts';
import { arcTable, bez, bezD, tAtLength, type Quad } from '../roads/geometry.ts';
import { NODE_BULB, armOf, bulbRetreat, junctionRetreats } from '../roads/junction.ts';
import { Ctl, Rule } from '../roads/control.ts';
import { SegFlag, furnOf } from '../roads/flags.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { Zone, baseZone } from '../roads/zones.ts';
import { heightAt } from '../world/heights.ts';
import { WATER_MAP_RES, waterAt, waterCoord, waterIndex } from '../world/ground.ts';
import type { BoxColumns, PropColumns, RoadGraph } from './protocol.ts';
import { lotParking, buildBuildingParts } from './buildingGen.ts';

/** Tipos de peça (4 bits; 15 = vaga livre). */
export const PROP = { Tree: 0, Conifer: 1, Bush: 2, Lamp: 3, LampDouble: 4, Signal: 5, Bench: 6, Bin: 7, Wire: 8, Sign: 9, ParkedCar: 10, Furniture: 11, Barrier: 12, Pole: 13, Ground: 14, Person: 15, Oak: 16, Palm: 17 } as const;
/** Types 16..23 belong to the roads/vegetation work, 24..30 to the buildings work (see the shared notes). */
export const PROP_TYPES = 18;
/** Mobiliário (variante da peça Furniture). */
export const FURN = { Hydrant: 0, Postbox: 1, Phone: 2, Drain: 3, Bollard: 4, Planter: 5,
  // peças de fachada dos prédios (sessão prédios; jobs/buildingGen.ts PART): 8..15
  WallAc: 8, RoofAc: 9, Vase: 10, Clothesline: 11, Dish: 12, Vent: 13, Chair: 14, Tank: 15 } as const;
/** Muros e cercas (variante da peça Barrier); a peça vai de z = 0 a 1 e o shader estica. */
export const BARRIER = { Fence: 0, Wall: 1, Hedge: 2, Guardrail: 3, Railing: 4 } as const;
/** Placas (variante da peça Sign). */
export const SIGN = { Speed: 0, Yield: 1, Name: 2, OneWay: 3, Stop: 4, NoParking: 5, NoEntry: 6, Pedestrian: 7, School: 8, Direction: 9, Info: 10 } as const;
/** Altura da cruzeta dos postes (onde passam os fios). */
export const WIRE_Y = 9.25;
/** Tipo do espaço livre no pool (5 bits de tipo). */
export const PROP_FREE = 31;
/** Bits do tipo na palavra extra (o resto é a chave). */
export const TYPE_BITS = 5;

/** Postes ao longo da via: primeiro a 8 m do recuo, depois a cada 32 m (o shader da via usa o mesmo passo). */
export const LAMP_FIRST = 8;
export const LAMP_STEP = 32;

const CURB_H = 0.15;
const p2 = new Float64Array(2), d2 = new Float64Array(2);

class Out {
  data: number[] = [];
  extra: number[] = [];
  private cell: number;
  constructor(cell: number) { this.cell = cell; }
  /** Mesma conta da grade, sobre o valor gravado (float32): a borda nunca vai para as duas células. */
  inCell(x: number, z: number): boolean {
    return cellId(cellX(Math.fround(x)), cellX(Math.fround(z))) === this.cell;
  }
  add(type: number, x: number, y: number, z: number, yaw: number, variant: number, scale: number, key: number): void {
    if (!this.inCell(x, z)) return;
    const a = ((yaw / (Math.PI * 2)) % 1 + 1) % 1;
    const yq = Math.min(4095, Math.round(a * 4096) & 4095);
    const sq = Math.max(0, Math.min(63, Math.round((scale - 0.5) * 42)));
    this.data.push(x, y, z, yq + (variant & 15) * 4096 + sq * 65536);
    this.extra.push(((type & 31) | ((key & 0x07ffffff) << 5)) >>> 0);
  }
  /** Escala crua (6 bits), para peças que usam o campo como comprimento (fios). */
  addRaw(type: number, x: number, y: number, z: number, yaw: number, variant: number, scale6: number, key: number): void {
    this.add(type, x, y, z, yaw, variant, 0.5 + Math.max(0, Math.min(63, scale6)) / 42, key);
  }
}

/** Itens postos pelo jogador: objetos (z1 = altura) e trechos de muro em peças de até 3 m. */
function placeItems(heights: Float32Array, a: Float32Array, out: Out): void {
  const OBJ: Record<number, [number, number]> = {
    0: [PROP.Tree, 0], 1: [PROP.Bush, 0], 2: [PROP.Bench, 0], 3: [PROP.Bin, 0], 4: [PROP.Lamp, 0],
    5: [PROP.Furniture, FURN.Hydrant], 6: [PROP.Furniture, FURN.Postbox], 7: [PROP.Furniture, FURN.Phone], 8: [PROP.Furniture, FURN.Drain],
    9: [PROP.Furniture, FURN.Bollard], 10: [PROP.Furniture, FURN.Planter], 12: [PROP.Conifer, 0],
  };
  for (let k = 0; k + 5 < a.length; k += 6) {
    const x0 = a[k], z0 = a[k + 1], x1 = a[k + 2], z1 = a[k + 3], type = a[k + 4], variant = a[k + 5];
    if (type === 25) {
      // linha de postes com fios: poste a cada ≤ 35 m e vão de fios entre eles
      const L = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.ceil(L / 35));
      const yaw = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2; // cruzeta atravessada à linha
      let prev: [number, number, number] | null = null;
      for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n, y = heightAt(heights, x, z);
        // luz: variante 1 = em postes alternados, 2 = em todos (poste aceso = o poste com luminária das vias)
        const lit = variant === 2 || (variant === 1 && i % 2 === 0);
        if (lit) out.add(PROP.Lamp, x, y, z, yaw - Math.PI / 2, 0, 1, 0);
        else out.add(PROP.Pole, x, y, z, yaw, 0, 1, 0);
        if (prev) {
          const [px, py, pz] = prev;
          const dy = Math.max(-4, Math.min(3.5, Math.round((y - py) * 2) / 2));
          out.addRaw(PROP.Wire, px, py, pz, Math.atan2(x - px, z - pz), Math.round(dy * 2) + 8, Math.round(Math.hypot(x - px, z - pz)), 0);
        }
        prev = [x, y, z];
      }
      continue;
    }
    if (type === 43) {
      // pessoa do criador: cor da roupa (4 bits baixos) e altura (4 bits altos)
      out.add(PROP.Person, x0, z1 !== 0 ? z1 : heightAt(heights, x0, z0), z0, x1, variant & 15, 0.86 + (variant >> 4) * 0.02, 0);
      continue;
    }
    if (type === 41) { out.add(PROP.Ground, x0, z1 !== 0 ? z1 : heightAt(heights, x0, z0), z0, x1, 11, 1, 0); continue; }
    if (type >= 30 && type <= 40) {
      // elemento do chão: variante = tipo, escala na variante do item (0..15 → 0,6..1,6)
      out.add(PROP.Ground, x0, heightAt(heights, x0, z0), z0, x1, type - 30, 0.6 + variant / 15, 0);
      continue;
    }
    if (type >= 20 && type <= 25) {
      const L = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.ceil(L / 3));
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      for (let i = 0; i < n; i++) {
        const xa = x0 + (x1 - x0) * i / n, za = z0 + (z1 - z0) * i / n;
        const xb = x0 + (x1 - x0) * (i + 1) / n, zb = z0 + (z1 - z0) * (i + 1) / n;
        const ya = heightAt(heights, xa, za), yb = heightAt(heights, xb, zb);
        // escala crua = comprimento em decímetros; chave = desnível (5 cm) + 512
        const span = Math.min(63, Math.round(L / n * 10));
        out.addRaw(PROP.Barrier, xa, ya, za, yaw, type - 20, span, Math.max(0, Math.min(1023, Math.round((yb - ya) * 20) + 512)));
      }
      continue;
    }
    if (type === 11) { out.add(PROP.Sign, x0, z1, z0, x1, variant, 1, 0); continue; }
    const m = OBJ[type];
    if (!m) continue;
    const y = z1 !== 0 ? z1 : heightAt(heights, x0, z0);
    out.add(m[0], x0, y, z0, x1, m[1] || variant, 1, 0);
  }
}

/** Escala guardada em 6 bits: 0,5 a 2,0. */
export function propScale(q: number): number { return 0.5 + q / 42; }

/** Trees by biome: [base chance, share of shrubs, share of cypresses, scale, share of palms]. */
const BIOME_TREES: Array<[number, number, number, number, number]> = [
  [0.18, 0.15, 0.27, 1, 0.02], // no ecosystem
  [0.1, 0.45, 0.02, 0.7, 0.04], // cerrado: low and crooked, much shrub
  [0.3, 0.12, 0.08, 1.15, 0.1], // Atlantic forest
  [0.42, 0.08, 0.02, 1.4, 0.12], // Amazon
  [0.06, 0.6, 0.0, 0.6, 0.03], // caatinga
  [0.03, 0.3, 0.1, 0.9, 0], // pampa
  [0.12, 0.3, 0.02, 1.0, 0.1], // pantanal
];

/** O que o chão diz às peças: pintura/floresta, água e bioma. */
export interface PropEnv { ground?: Uint32Array; water?: Float32Array; biome?: number }

export function buildProps(heights: Float32Array, g: RoadGraph, b: BoxColumns, cell: number, items?: Float32Array, env?: PropEnv): PropColumns {
  const out = new Out(cell);
  if (items) placeItems(heights, items, out);

  const quads: Quad[] = [], tables: Float64Array[] = [], lens: number[] = [];
  for (let s = 0; s < g.segCount; s++) {
    const q: Quad = { x0: g.nx[g.sa[s]], z0: g.nz[g.sa[s]], cx: g.scx[s], cz: g.scz[s], x1: g.nx[g.sb[s]], z1: g.nz[g.sb[s]] };
    quads.push(q);
    const t = arcTable(q, 24);
    tables.push(t);
    lens.push(t[t.length - 1]);
  }
  const retreat = new Float64Array(g.segCount * 2);
  const arms: Array<Array<{ s: number; end: 0 | 1 }>> = Array.from({ length: g.nodeCount }, () => []);
  for (let s = 0; s < g.segCount; s++) { arms[g.sa[s]].push({ s, end: 0 }); arms[g.sb[s]].push({ s, end: 1 }); }
  const tmp = new Float64Array(16);
  const order: number[] = [];
  const deg = new Int32Array(g.nodeCount);
  for (let n = 0; n < g.nodeCount; n++) {
    const list = arms[n];
    deg[n] = list.length;
    if (list.length === 1 && g.nctl[n] === NODE_BULB) retreat[list[0].s * 2 + list[0].end] = bulbRetreat(armOf(quads[list[0].s], g.sprofile[list[0].s], list[0].end), lens[list[0].s]);
    if (list.length < 2) continue;
    junctionRetreats(list.map((r) => armOf(quads[r.s], g.sprofile[r.s], r.end)), list.map((r) => lens[r.s]), tmp, order);
    list.forEach((r, i) => { retreat[r.s * 2 + r.end] = tmp[i]; });
    // semáforos: um por braço, na esquina à direita de quem chega (mesma ordem dos braços da simulação)
    const ring = list.some((r) => (g.sflags[r.s] & SegFlag.Ring) !== 0);
    // placas de pare e dê a preferência nos braços que não têm a preferência
    if (list.length >= 3 && !ring && g.nctl[n] !== Ctl.Signal) {
      list.forEach((r, i) => {
        const rule = r.end === 0 ? g.srule[r.s] & 7 : (g.srule[r.s] >> 3) & 7;
        if (rule !== Rule.Stop && rule !== Rule.Yield) return;
        const info = PROFILE_INFO[g.sprofile[r.s]];
        const at = r.end === 0 ? tmp[i] + 1.2 : lens[r.s] - tmp[i] - 1.2;
        const t = tAtLength(tables[r.s], Math.max(0, Math.min(lens[r.s], at)));
        bez(quads[r.s], t, p2); bezD(quads[r.s], t, d2);
        const l = Math.hypot(d2[0], d2[1]) || 1;
        const tx = d2[0] / l, tz = d2[1] / l;
        const u = r.end === 0 ? info.left - 0.4 : -(info.right - 0.4);
        const yaw = r.end === 0 ? Math.atan2(tx, tz) : Math.atan2(-tx, -tz);
        out.add(PROP.Sign, p2[0] + tz * u, yAt(g, r.s, lens[r.s], at) + CURB_H, p2[1] - tx * u, yaw, rule === Rule.Stop ? SIGN.Stop : SIGN.Yield, 1, 0);
      });
    }
    if ((list.length >= 3 && !ring && g.nctl[n] === Ctl.Signal) || (list.length === 2 && g.nctl[n] === Ctl.PedSignal)) {
      order.forEach((i, armIdx) => {
        const { s, end } = list[i];
        const info = PROFILE_INFO[g.sprofile[s]];
        const at = end === 0 ? tmp[i] + 0.6 : lens[s] - tmp[i] - 0.6;
        const t = tAtLength(tables[s], Math.max(0, Math.min(lens[s], at)));
        bez(quads[s], t, p2); bezD(quads[s], t, d2);
        const l = Math.hypot(d2[0], d2[1]) || 1;
        const tx = d2[0] / l, tz = d2[1] / l;
        const lx = tz, lz = -tx;
        // quem chega pelo braço anda para o nó: à direita dele fica u+ (ponta a) ou u− (ponta b)
        const u = end === 0 ? info.left - 0.7 : -(info.right - 0.7);
        const x = p2[0] + lx * u, z = p2[1] + lz * u;
        const yaw = end === 0 ? Math.atan2(tx, tz) : Math.atan2(-tx, -tz);
        const y = yAt(g, s, lens[s], at) + CURB_H;
        out.add(PROP.Signal, x, y, z, yaw, 0, 1, g.nid[n] * 8 + armIdx);
      });
    }
    // placa com o nome da rua numa esquina de cada cruzamento
    if (list.length >= 3) {
      const { s, end } = list[order[0]];
      const info = PROFILE_INFO[g.sprofile[s]];
      const at = end === 0 ? tmp[order[0]] + 0.4 : lens[s] - tmp[order[0]] - 0.4;
      const t = tAtLength(tables[s], Math.max(0, Math.min(lens[s], at)));
      bez(quads[s], t, p2); bezD(quads[s], t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      const tx = d2[0] / l, tz = d2[1] / l;
      const u = end === 0 ? -(info.right - 0.5) : info.left - 0.5;
      if (Number.isFinite(u)) out.add(PROP.Sign, p2[0] + tz * u, yAt(g, s, lens[s], at) + CURB_H, p2[1] - tx * u, Math.atan2(tx, tz), SIGN.Name, 1, 0);
    }
    // rotatória: "dê a preferência" em cada entrada
    if (ring) {
      list.forEach((r, i) => {
        if ((g.sflags[r.s] & SegFlag.Ring) !== 0) return;
        const info = PROFILE_INFO[g.sprofile[r.s]];
        const at = r.end === 0 ? tmp[i] + 2 : lens[r.s] - tmp[i] - 2;
        const t = tAtLength(tables[r.s], Math.max(0, Math.min(lens[r.s], at)));
        bez(quads[r.s], t, p2); bezD(quads[r.s], t, d2);
        const l = Math.hypot(d2[0], d2[1]) || 1;
        const tx = d2[0] / l, tz = d2[1] / l;
        const u = r.end === 0 ? info.left - 0.4 : -(info.right - 0.4);
        const yaw = r.end === 0 ? Math.atan2(tx, tz) : Math.atan2(-tx, -tz);
        out.add(PROP.Sign, p2[0] + tz * u, yAt(g, r.s, lens[r.s], at) + CURB_H, p2[1] - tx * u, yaw, SIGN.Yield, 1, 0);
      });
    }
  }

  for (let s = 0; s < g.segCount; s++) {
    const info = PROFILE_INFO[g.sprofile[s]];
    const s0 = retreat[s * 2], s1 = lens[s] - retreat[s * 2 + 1];
    if (s1 - s0 < 4) continue;
    const ring = (g.sflags[s] & SegFlag.Ring) !== 0;
    const furn = furnOf(g.sflags[s]);
    if (furn === 2) continue; // via sem mobiliário: nada na calçada
    bez(quads[s], 0.5, p2);
    const rng = new Rng(hash2(Math.round(p2[0] * 4), Math.round(p2[1] * 4), 911));
    const median = info.edges.find((e) => e.strip.kind === 'median' || e.strip.kind === 'barrier' && Math.abs((e.u0 + e.u1) / 2) < 1);
    const swR = info.edges[0].strip.kind === 'sidewalk' ? info.edges[0] : null;
    const last = info.edges[info.edges.length - 1];
    const swL = last.strip.kind === 'sidewalk' ? last : null;

    const frame = (v: number) => {
      const t = tAtLength(tables[s], v);
      bez(quads[s], t, p2); bezD(quads[s], t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      return { px: p2[0], pz: p2[1], tx: d2[0] / l, tz: d2[1] / l, y: yAt(g, s, lens[s], v) };
    };
    const onGround = (x: number, z: number, y: number) => {
      const gy = heightAt(heights, x, z);
      return gy - y < 3 && y - gy < 1.2 && gy > SEA_LEVEL + 0.3;
    };
    const lampVs: number[] = [];
    let prevPole: [number, number, number] | null = null;
    // postes
    for (let v = s0 + LAMP_FIRST, k = 0; v < s1 - 2; v += LAMP_STEP, k++) {
      lampVs.push(v);
      const f = frame(v);
      const lx = f.tz, lz = -f.tx;
      if (median && (median.u1 - median.u0) >= 1.2) {
        const u = (median.u0 + median.u1) / 2;
        const x = f.px + lx * u, z = f.pz + lz * u;
        out.add(PROP.LampDouble, x, f.y + CURB_H, z, Math.atan2(lx, lz), 0, 1, k);
        continue;
      }
      // sem canteiro: poste de concreto com luminária e fiação, sempre do mesmo lado (direito, se houver calçada)
      const right = !!swR;
      const e = right ? swR : swL;
      if (!e) continue;
      const u = right ? e.u0 + 0.5 : e.u1 - 0.5;
      const x = f.px + lx * u, z = f.pz + lz * u;
      // o braço aponta para a via
      const ax = right ? lx : -lx, az = right ? lz : -lz;
      const y = f.y + CURB_H;
      out.add(PROP.Lamp, x, y, z, Math.atan2(ax, az), 0, 1, k);
      // vão de fios do poste anterior até este (fica na célula do poste anterior)
      if (prevPole && !ring) {
        const [px, py, pz] = prevPole;
        const L = Math.hypot(x - px, z - pz);
        if (L > 4 && L < 63) {
          const dy = Math.max(-4, Math.min(3.5, Math.round((y - py) * 2) / 2));
          out.addRaw(PROP.Wire, px, py, pz, Math.atan2(x - px, z - pz), Math.round(dy * 2) + 8, Math.round(L), k);
        }
      }
      prevPole = [x, y, z];
    }
    const nearLamp = (v: number) => lampVs.some((lv) => Math.abs(lv - v) < 3.5);
    // velocidade em todo trecho de mais de 60 m (como as placas derivadas do roadcraft: 14 m depois da boca do
    // cruzamento, para quem sai dele) e mão única
    if (!ring && s1 - s0 > 40) {
      const kind = info.oneWay ? SIGN.OneWay : s1 - s0 > 60 && info.speed > 0 ? SIGN.Speed : -1;
      if (kind >= 0) {
        const put = (v: number, forward: boolean) => {
          const f = frame(v);
          const lx = f.tz, lz = -f.tx;
          const e = forward ? info.edges[0] : info.edges[info.edges.length - 1];
          const u = forward ? e.u0 + 0.4 : e.u1 - 0.4;
          const yaw = forward ? Math.atan2(-f.tx, -f.tz) : Math.atan2(f.tx, f.tz);
          out.add(PROP.Sign, f.px + lx * u, f.y + CURB_H, f.pz + lz * u, yaw, kind, 1, info.speed);
        };
        put(s0 + 14, true);
        if (!info.oneWay) put(s1 - 14, false);
      }
    }
    // carros estacionados nas faixas de estacionamento (longe das esquinas)
    if (!ring) {
      for (const e of info.edges) {
        if (e.strip.kind !== 'parking') continue;
        const u = (e.u0 + e.u1) / 2;
        const leftSide = u > 0;
        for (let v = s0 + 9 + rng.range(0, 3); v < s1 - 9; v += rng.range(5.6, 6.6)) {
          if (rng.next() < 0.38) continue;
          const f = frame(v);
          const lx = f.tz, lz = -f.tx;
          const x = f.px + lx * u, z = f.pz + lz * u;
          // estaciona no sentido do tráfego daquele lado
          const yaw = leftSide ? Math.atan2(-f.tx, -f.tz) : Math.atan2(f.tx, f.tz);
          out.add(PROP.ParkedCar, x, f.y, z, yaw + rng.range(-0.03, 0.03), rng.int(0, 16), 1, rng.nextU32());
        }
      }
    }
    const zoneOf = (side: number) => baseZone(side === 0 ? g.szl[s] : g.szr[s]);
    // automatic street furniture (Roadcraft's "complete / basic / none"): basic = hydrants only (infrastructure);
    // complete = also postboxes and phones on commercial streets, planters and bins by the crossings, benches on
    // residential streets. Hydrants by the curb before the first street tree; the rest against the buildings.
    if (!ring) {
      for (const [e, side] of [[swR, 1], [swL, 0]] as const) {
        if (!e || e.u1 - e.u0 < 1.8) continue;
        const zone = zoneOf(side);
        const lx0 = (v: number) => frame(v);
        const kerbU = side === 1 ? e.u1 - 0.45 : e.u0 + 0.45;
        const wallU = side === 1 ? e.u0 + 0.55 : e.u1 - 0.55;
        const put = (type: number, variant: number, v: number, u: number, face: boolean) => {
          if (v <= s0 + 2 || v >= s1 - 2 || nearLamp(v)) return;
          const f = lx0(v);
          const lx = f.tz, lz = -f.tx;
          const x = f.px + lx * u, z = f.pz + lz * u;
          if (!onGround(x, z, f.y)) return;
          const yaw = face ? (side === 1 ? Math.atan2(lx, lz) : Math.atan2(-lx, -lz)) : Math.atan2(f.tx, f.tz);
          out.add(type, x, f.y + CURB_H, z, yaw, variant, 1, rng.nextU32());
        };
        // hydrant: one side of the street, about every 90 m (both levels)
        if (side === 1 && s1 - s0 > 20) for (let v = s0 + 9; v < s1 - 6; v += 90) put(PROP.Furniture, FURN.Hydrant, v, kerbU, true);
        if (furn !== 0) continue;
        const commercial = zone === Zone.Commercial || zone === Zone.Mixed;
        if (commercial && s1 - s0 > 50) {
          put(PROP.Furniture, FURN.Postbox, s0 + 24 + rng.range(0, 6), wallU, true);
          if (side === 0) put(PROP.Furniture, FURN.Phone, s1 - 26 - rng.range(0, 6), wallU, true);
          // planters flanking the crossing at each end
          put(PROP.Furniture, FURN.Planter, s0 + 5.5, wallU, false);
          put(PROP.Furniture, FURN.Planter, s1 - 5.5, wallU, false);
        }
        if (zone === Zone.Residential && s1 - s0 > 70 && e.u1 - e.u0 >= 2.3) {
          const v = (s0 + s1) / 2 + rng.range(-8, 8);
          put(PROP.Bench, 0, v, wallU, true);
          put(PROP.Bin, 0, v + 2.2, wallU, true);
        }
        // a bin by the crossing on every street of the complete level
        if (zone !== Zone.Industrial && s1 - s0 > 24) put(PROP.Bin, 0, s0 + 3.2, wallU, true);
      }
    }
    // árvores de calçada (largas o bastante) e de canteiro; básico = só postes e placas
    for (const [e, side] of [[swR, 1], [swL, 0]] as const) {
      if (!e || ring || furn === 1 || e.u1 - e.u0 < 2.3) continue;
      const zone = zoneOf(side);
      if (zone === Zone.Industrial) continue;
      const step = zone === Zone.Residential ? 10 : 12;
      for (let v = s0 + 14 + (side === 0 ? 5 : 0); v < s1 - 6; v += step) {
        if (nearLamp(v) || rng.next() < 0.15) continue;
        const f = frame(v);
        const lx = f.tz, lz = -f.tx;
        const u = side === 1 ? e.u1 - 0.9 : e.u0 + 0.9; // perto do meio-fio
        const x = f.px + lx * u, z = f.pz + lz * u;
        if (!onGround(x, z, f.y)) continue;
        // street trees: the mixed broadleaf, a third of them oaks (shade trees)
        out.add(rng.next() < 0.33 ? PROP.Oak : PROP.Tree, x, f.y + CURB_H, z, rng.next() * 6.283, rng.int(0, 4), rng.range(0.75, 1.2), rng.nextU32());
      }
      // bancos e lixeiras na calçada do comércio
      if (zone === Zone.Commercial || zone === Zone.Mixed) {
        for (let v = s0 + 20 + rng.range(0, 10); v < s1 - 10; v += rng.range(28, 46)) {
          if (nearLamp(v)) continue;
          const f = frame(v);
          const lx = f.tz, lz = -f.tx;
          const u = side === 1 ? e.u0 + 0.6 : e.u1 - 0.6; // junto aos prédios
          const x = f.px + lx * u, z = f.pz + lz * u;
          if (!onGround(x, z, f.y)) continue;
          const face = side === 1 ? Math.atan2(lx, lz) : Math.atan2(-lx, -lz); // banco olha para a rua
          out.add(PROP.Bench, x, f.y + CURB_H, z, face, rng.int(0, 2), 1, rng.nextU32());
          const f2 = frame(Math.min(s1 - 1, v + 2.4));
          const x2 = f2.px + lx * u, z2 = f2.pz + lz * u;
          out.add(PROP.Bin, x2, f2.y + CURB_H, z2, face, 0, 1, rng.nextU32());
        }
      }
    }
    if (furn === 0 && median && median.strip.kind === 'median' && median.u1 - median.u0 >= 2.5) {
      for (let v = s0 + 9; v < s1 - 9; v += 9) {
        if (nearLamp(v)) continue;
        const f = frame(v);
        const lx = f.tz, lz = -f.tx;
        const u = (median.u0 + median.u1) / 2;
        const x = f.px + lx * u, z = f.pz + lz * u;
        if (!onGround(x, z, f.y)) continue;
        // medians: palms on the wide avenues (Brazilian style), cypresses and broadleaves elsewhere
        const pick = rng.next();
        const kind = median.u1 - median.u0 >= 4 && pick < 0.45 ? PROP.Palm : pick < 0.6 ? PROP.Conifer : PROP.Tree;
        out.add(kind, x, f.y + CURB_H, z, rng.next() * 6.283, rng.int(0, 4), rng.range(0.8, 1.15), rng.nextU32());
      }
    }
  }

  // carros nas vagas dos estacionamentos dos lotes (mesma conta do gerador de prédios)
  for (let i = 0; i < b.count; i++) {
    const rows = lotParking(b, i);
    if (!rows.length) continue;
    const r = new Rng((b.seed[i] * 2654435761 + 77) >>> 0);
    const c = Math.cos(b.rot[i]), sn = Math.sin(b.rot[i]);
    // lotação do estacionamento: cada lote tem a sua (de quase vazio a cheio)
    const fill = r.range(0.35, 0.9);
    for (let k = 0; k + 3 < rows.length; k += 4) {
      const ax = rows[k], az = rows[k + 1], bx = rows[k + 2], bz = rows[k + 3];
      const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
      const n = Math.floor(L / 2.5);
      for (let j = 0; j < n; j++) {
        if (r.next() > fill) continue;
        const s0 = j * 2.5 + (L - n * 2.5) / 2 + 1.25 + r.range(-0.12, 0.12);
        const o = r.range(-0.2, 0.2);
        const lx = ax + tx * s0 - tz * o, lz = az + tz * s0 + tx * o;
        const x = b.x[i] + lx * c + lz * sn, z = b.z[i] - lx * sn + lz * c;
        // o carro fica de frente ou de ré na vaga (perpendicular à fileira)
        const dx = -tz * c + tx * sn, dz = tz * sn + tx * c;
        const yaw = Math.atan2(dx, dz) + (r.next() < 0.5 ? Math.PI : 0) + r.range(-0.05, 0.05);
        out.add(PROP.ParkedCar, x, heightAt(heights, x, z) + 0.22, z, yaw, r.int(0, 16), 1, r.nextU32());
      }
    }
  }

  // quintais: árvores no fundo das casas, arbustos na frente dos prédios
  for (let i = 0; i < b.count; i++) {
    const zone = b.zone[i];
    if (zone !== Zone.Residential && zone !== Zone.Mixed) continue;
    const r = new Rng((b.seed[i] * 2246822519) >>> 0);
    const c = Math.cos(b.rot[i]), sn = Math.sin(b.rot[i]);
    const W = b.w[i], D = b.d[i];
    const at = (lx: number, lz: number): [number, number] => [b.x[i] + lx * c + lz * sn, b.z[i] - lx * sn + lz * c];
    const house = zone === Zone.Residential && b.floors[i] <= 3;
    if (house && D > 26) {
      const n = r.int(1, 4);
      for (let k = 0; k < n; k++) {
        const [x, z] = at(r.range(-W / 2 + 2.5, W / 2 - 2.5), -D / 2 + r.range(2.2, 3.6));
        const y = heightAt(heights, x, z);
        if (y < SEA_LEVEL + 0.3) continue;
        const pick = r.next();
        out.add(pick < 0.3 ? PROP.Conifer : pick < 0.65 ? PROP.Oak : PROP.Tree, x, y, z, r.next() * 6.283, r.int(0, 4), r.range(0.6, 1.0), r.nextU32());
      }
    }
    // arbustos junto à frente
    const n = house ? r.int(1, 4) : r.int(2, 6);
    for (let k = 0; k < n; k++) {
      const [x, z] = at(r.range(-W / 2 + 1, W / 2 - 1), D / 2 - r.range(0.7, 1.4));
      const y = heightAt(heights, x, z);
      if (y < SEA_LEVEL + 0.3) continue;
      out.add(PROP.Bush, x, y, z, r.next() * 6.283, r.int(0, 4), r.range(0.7, 1.3), r.nextU32());
    }
  }

  // miolo de quadra e terreno vazio: árvores e arbustos onde não há via nem prédio
  {
    const RES = 2, W = 128;
    const x0 = cellOriginX(cell % MAP_CELLS), z0 = cellOriginX((cell / MAP_CELLS) | 0);
    const busy = new Uint8Array(W * W);
    const mark = (x: number, z: number, r: number) => {
      const i0 = Math.max(0, Math.floor((x - r - x0) / RES)), i1 = Math.min(W - 1, Math.floor((x + r - x0) / RES));
      const j0 = Math.max(0, Math.floor((z - r - z0) / RES)), j1 = Math.min(W - 1, Math.floor((z + r - z0) / RES));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) busy[j * W + i] = 1;
    };
    for (let s = 0; s < g.segCount; s++) {
      const info = PROFILE_INFO[g.sprofile[s]];
      const half = Math.max(info.left, info.right) + 2;
      const n = Math.max(2, Math.ceil(lens[s] / 2) + 1);
      for (let i = 0; i < n; i++) {
        bez(quads[s], tAtLength(tables[s], (lens[s] * i) / (n - 1)), p2);
        if (p2[0] < x0 - half || p2[0] > x0 + 256 + half || p2[1] < z0 - half || p2[1] > z0 + 256 + half) continue;
        mark(p2[0], p2[1], half);
      }
    }
    for (let n = 0; n < g.nodeCount; n++) if (deg[n] >= 3) mark(g.nx[n], g.nz[n], 22);
    for (let i = 0; i < b.count; i++) {
      // lote inteiro ocupado (prédio, quintal, muros)
      const c = Math.cos(b.rot[i]), sn = Math.sin(b.rot[i]);
      const W2 = b.w[i] / 2 + 0.5, D2 = b.d[i] / 2 + 0.5;
      for (let a = -W2; a <= W2; a += RES) for (let d = -D2; d <= D2; d += RES) mark(b.x[i] + a * c + d * sn, b.z[i] - a * sn + d * c, 1);
    }
    const rng = new Rng(hash2(Math.round(x0), Math.round(z0), 5151));
    const free = (x: number, z: number) => {
      for (const [dx, dz] of [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) {
        const i = Math.floor((x + dx - x0) / RES), j = Math.floor((z + dz - z0) / RES);
        if (i < 0 || j < 0 || i >= W || j >= W || busy[j * W + i]) return false;
      }
      return true;
    };
    // bioma: [chance base, arbusto, pinheiro, escala]
    const B = BIOME_TREES[env?.biome ?? 0] ?? BIOME_TREES[0];
    for (let z = z0 + 3; z < z0 + 256; z += 6) {
      for (let x = x0 + 3; x < x0 + 256; x += 6) {
        const px = x + rng.range(-2.5, 2.5), pz = z + rng.range(-2.5, 2.5);
        // floresta plantada (canal B do chão) adensa; clareira (canal A) tira; água não tem árvore
        let forest = 0, clear = 0, species = 0;
        if (env?.ground) {
          const v = env.ground[waterIndex(Math.max(0, Math.min(WATER_MAP_RES - 1, Math.floor(waterCoord(px)))), Math.max(0, Math.min(WATER_MAP_RES - 1, Math.floor(waterCoord(pz)))))];
          forest = ((v >> 16) & 255) / 255;
          const a = (v >>> 24) & 255;
          // A até 3 com floresta = espécie plantada; acima = clareira
          if (forest > 0 && a <= 3) species = a; else clear = a / 255;
        }
        const keep = ((B[0] + 0.4 * Math.max(0, fbm(px / 260, pz / 260, 4242, 2) + 0.35)) * 0.45 * (1 - clear) + forest * 0.9) * (1 - clear);
        if (rng.next() > keep || !free(px, pz)) continue;
        const y = heightAt(heights, px, pz);
        if (y < SEA_LEVEL + 0.6) continue;
        if (env?.water && waterAt(env.water, px, pz) > y - 0.3) continue;
        const r = rng.next();
        if (species === 1 && forest > 0.2) { out.add(PROP.Tree, px, y, pz, rng.next() * 6.283, rng.int(0, 4), rng.range(0.8, 1.3) * B[3], rng.nextU32()); continue; }
        if (species === 2 && forest > 0.2) { out.add(PROP.Conifer, px, y, pz, rng.next() * 6.283, rng.int(0, 4), rng.range(0.8, 1.4) * B[3], rng.nextU32()); continue; }
        if (species === 3 && forest > 0.2) { out.add(PROP.Palm, px, y, pz, rng.next() * 6.283, rng.int(0, 4), rng.range(0.8, 1.2), rng.nextU32()); continue; }
        if (r < B[1]) out.add(PROP.Bush, px, y, pz, rng.next() * 6.283, rng.int(0, 4), rng.range(0.8, 1.5), rng.nextU32());
        else out.add(r < B[1] + B[2] ? PROP.Conifer : r < B[1] + B[2] + B[4] ? PROP.Palm : (rng.next() < 0.4 ? PROP.Oak : PROP.Tree), px, y, pz, rng.next() * 6.283, rng.int(0, 4), rng.range(0.7, 1.3) * B[3], rng.nextU32());
      }
    }
  }

  // peças de fachada dos prédios (sessão prédios): ar-condicionado, vasos, varais, antenas, exaustores, caixas d'água
  buildBuildingParts(heights, b, (v, x, y, z, yaw, s) => out.add(PROP.Furniture, x, y, z, yaw, v, s, 0));

  const count = out.extra.length;
  return { count, data: new Float32Array(out.data), extra: new Uint32Array(out.extra) };
}

function yAt(g: RoadGraph, s: number, len: number, v: number): number {
  const ya = g.ny[g.sa[s]], yb = g.ny[g.sb[s]];
  return ya + (yb - ya) * (len > 0 ? Math.max(0, Math.min(1, v / len)) : 0);
}
