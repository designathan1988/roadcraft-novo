// Street names and metric house numbers (Roadcraft: names on the generated city, the number of a house is its
// distance in metres from the start of the street, even on the right and odd on the left, as in Brazil).
// A street is the chain of segments that goes on most straight with the same profile (`roads/build.ts`
// streetChain's rule). Nothing is stored per segment: the generated name is a hash of the street's two ends, so it
// is the same in every session and after loading; only names the player typed are kept (World.streetNames).
// Every query walks one street, never the map.

import type { Command } from '../core/commands.ts';
import type { World } from '../world/world.ts';
import { streetChain } from './build.ts';
import { armOf } from './junction.ts';
import { PROFILE_INFO } from './profiles.ts';
import { SegFlag } from './flags.ts';
import { closestT, type Quad } from './geometry.ts';
import { NO_SEG, type SegId } from '../core/ids.ts';

const PEOPLE = [
  'Santos Dumont', 'Machado de Assis', 'Tiradentes', 'Anita Garibaldi', 'Chiquinha Gonzaga', 'Rui Barbosa', 'Cecília Meireles',
  'Oswaldo Cruz', 'Carlos Gomes', 'Castro Alves', 'Princesa Isabel', 'José Bonifácio', 'Carmen Miranda', 'Villa-Lobos',
  'Cândido Portinari', 'Tarsila do Amaral', 'Monteiro Lobato', 'Clarice Lispector', 'Vital Brazil', 'Pixinguinha',
  'Barão de Mauá', 'Marechal Rondon', 'Dom Pedro II', 'Maria Quitéria', 'Joaquim Nabuco', 'Olavo Bilac', 'Noel Rosa',
  'Carlos Drummond', 'Adoniran Barbosa', 'Nise da Silveira', 'Zumbi dos Palmares', 'Dandara', 'Paulo Freire', 'Bertha Lutz',
];
const PLACES = [
  'das Flores', 'dos Ipês', 'das Palmeiras', 'das Mangueiras', 'dos Jacarandás', 'das Acácias', 'do Sol', 'da Lua',
  'Bahia', 'Pernambuco', 'Paraná', 'Amazonas', 'Goiás', 'Ceará', 'Minas Gerais', 'Sergipe', 'Alagoas', 'Piauí',
  'São João', 'Santa Luzia', 'São Bento', 'Bela Vista', 'Boa Esperança', 'do Comércio', 'da Matriz', 'do Rosário',
  'Sete de Setembro', 'Quinze de Novembro', 'Treze de Maio', 'Primeiro de Maio', 'da Independência', 'da República',
  'dos Andradas', 'dos Bandeirantes', 'das Gaivotas', 'dos Sabiás', 'das Hortênsias', 'das Orquídeas', 'do Cruzeiro',
];

/** Kind of street from its profile: rodovia, avenida or rua. */
function prefix(profile: number): string {
  const p = PROFILE_INFO[profile];
  if (!p) return 'Rua';
  if (p.rail) return 'Ferrovia';
  const pr = p.priority ?? 0;
  return pr >= 4 ? 'Rodovia' : pr >= 2 ? 'Avenida' : 'Rua';
}

function hashName(h: number, profile: number): string {
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  const people = (h & 1) === 0;
  const list = people ? PEOPLE : PLACES;
  const name = list[(h >>> 1) % list.length];
  return `${prefix(profile)} ${name}`;
}

/** One street in order from its start: the segments, which end each one starts at, and their lengths. */
export interface Street { segs: SegId[]; startAt: Array<0 | 1>; lens: number[]; profile: number; key: number }

/** The street through segment s0, ordered from the end with the smaller (x, z), with a key from its two ends. */
export function streetOf(world: World, s0: SegId): Street {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const prof = sc.profile[s0], oneWay = PROFILE_INFO[prof]?.oneWay ?? false;
  const q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  const list: SegId[] = [];
  const seen = new Set([s0]);
  /** Walks from segment s leaving by its end `end`; returns [segment, end it is entered by] in order. */
  const walk = (s: SegId, end: 0 | 1): Array<[SegId, 0 | 1]> => {
    const out: Array<[SegId, 0 | 1]> = [];
    for (let guard = 0; guard < 4000; guard++) {
      const n = end === 1 ? sc.b[s] : sc.a[s];
      const here = armOf(net.quad(s, q), prof, end);
      const hx = -here.dx, hz = -here.dz;
      let best = NO_SEG, bestDot = Math.cos(35 * Math.PI / 180), bestEnd: 0 | 1 = 0;
      for (const t of net.segsOf(n, list)) {
        if (seen.has(t) || sc.profile[t] !== prof || (sc.flags[t] & SegFlag.Ring)) continue;
        const tEnd: 0 | 1 = sc.a[t] === n ? 0 : 1;
        if (oneWay && tEnd !== (end === 1 ? 0 : 1)) continue;
        const arm = armOf(net.quad(t, q), prof, tEnd);
        const d = arm.dx * hx + arm.dz * hz;
        if (d > bestDot) { bestDot = d; best = t; bestEnd = tEnd; }
      }
      if (best < 0) break;
      seen.add(best); out.push([best, bestEnd]);
      s = best; end = bestEnd === 0 ? 1 : 0;
    }
    return out;
  };
  const fwd = walk(s0, 1), back = walk(s0, 0);
  // in order: the backward part reversed (each entered by its other end), s0 entered by a, then forward
  const segs: SegId[] = [], startAt: Array<0 | 1> = [];
  for (let i = back.length - 1; i >= 0; i--) { segs.push(back[i][0]); startAt.push(back[i][1] === 0 ? 1 : 0); }
  segs.push(s0); startAt.push(0);
  for (const [t, e] of fwd) { segs.push(t); startAt.push(e); }
  const first = startAt[0] === 0 ? sc.a[segs[0]] : sc.b[segs[0]];
  const lastI = segs.length - 1, last = startAt[lastI] === 0 ? sc.b[segs[lastI]] : sc.a[segs[lastI]];
  // start at the end with the smaller x (then z), so the numbering does not depend on where the player clicked
  const swap = !oneWay && (nc.x[last] < nc.x[first] - 0.5 || (Math.abs(nc.x[last] - nc.x[first]) <= 0.5 && nc.z[last] < nc.z[first]));
  if (swap) { segs.reverse(); startAt.reverse(); for (let i = 0; i < startAt.length; i++) startAt[i] = startAt[i] === 0 ? 1 : 0; }
  const a = swap ? last : first, b = swap ? first : last;
  const key = (Math.imul(Math.round(nc.x[a]) | 0, 73856093) ^ Math.imul(Math.round(nc.z[a]) | 0, 19349663) ^ Math.imul(Math.round(nc.x[b]) | 0, 83492791) ^ Math.imul(Math.round(nc.z[b]) | 0, 2654435761)) >>> 0;
  return { segs, startAt, lens: segs.map((s) => sc.len[s]), profile: prof, key };
}

/** Name of the street through segment s: the one the player typed, or the generated one. */
export function streetName(world: World, s: SegId, street?: Street): string {
  const own = world.streetNames.get(s);
  if (own) return own;
  const st = street ?? streetOf(world, s);
  for (const t of st.segs) { const n = world.streetNames.get(t); if (n) return n; }
  return hashName(st.key, st.profile);
}

/**
 * Names the whole street of segment `seg` as one undo step. An empty name takes the typed names away, so the
 * generated name shows again (Roadcraft 4.0 world/roads/streetNames.ts:61: a plate without text names nothing).
 * The street is the chain the tools follow and the one streetName reads; `changed` runs after each change.
 */
export function nameStreetCommand(world: World, seg: SegId, name: string, changed: () => void): Command {
  const segs = [...new Set([...streetChain(world, seg), ...streetOf(world, seg).segs])];
  const before = segs.map((x) => world.streetNames.get(x));
  const text = name.trim();
  return {
    label: 'nome da rua',
    apply: () => { for (const x of segs) { if (text) world.streetNames.set(x, text); else world.streetNames.delete(x); } changed(); },
    invert: () => { segs.forEach((x, i) => { const b = before[i]; if (b === undefined) world.streetNames.delete(x); else world.streetNames.set(x, b); }); changed(); },
  };
}

export interface Address { seg: number; name: string; number: number; side: 'left' | 'right'; along: number }

/**
 * Address of the point (x, z) on the street nearest it within `radius`: the street's name and the metric number
 * (metres from the start of the street, rounded; even on the right, odd on the left walking from the start).
 */
export function addressAt(world: World, x: number, z: number, radius = 60): Address | null {
  const net = world.roads, sc = net.segs.cols;
  const near = net.nearestSeg(x, z, radius, (s) => !PROFILE_INFO[sc.profile[s]]?.rail);
  if (!near) return null;
  const [s, t] = near;
  const st = streetOf(world, s);
  const i = st.segs.indexOf(s);
  let along = 0;
  for (let k = 0; k < i; k++) along += st.lens[k];
  const q = net.quad(s);
  const [tt] = closestT(q, x, z);
  const forward = st.startAt[i] === 0;
  along += (forward ? tt : 1 - tt) * st.lens[i];
  void t;
  // side: cross product of the walking direction and the point
  const p0 = forward ? [q.x0, q.z0] : [q.x1, q.z1], p1 = forward ? [q.x1, q.z1] : [q.x0, q.z0];
  const cross = (p1[0] - p0[0]) * (z - p0[1]) - (p1[1] - p0[1]) * (x - p0[0]);
  // x right, z "down" on the map seen from above with yaw 0: positive cross = to the right of the walk
  const side: 'left' | 'right' = cross > 0 ? 'right' : 'left';
  let number = Math.max(1, Math.round(along));
  if ((number % 2 === 0) !== (side === 'right')) number += 1;
  return { seg: s, name: streetName(world, s, st), number, side, along };
}
