// Road profiles: the cross-section, from the right edge (negative u) to the
// left (positive u), looking in the a → b direction. Right-hand traffic.
// The registry grows in game (profiles made in the editor): the page registers them and
// sends the list to the workers; a segment stores only the id (Uint8).

import { ROAD_TUNING } from './tuning.ts';

export type StripKind = 'sidewalk' | 'curb' | 'parking' | 'bike' | 'lane' | 'median' | 'shoulder' | 'barrier';

/** A lane's turn arrows (bits); 0 = automatic by position. */
export const TurnBit = { Left: 1, Straight: 2, Right: 4 } as const;
/** Carriageway surface. */
export const Surface = { Asphalt: 0, Concrete: 1, Cobble: 2, Ballast: 3 } as const;
/** Sidewalk and median paving. */
export const Paving = { Concrete: 0, Pavers: 1, Stone: 2, Grass: 3 } as const;
export type Centre = 'dashed' | 'solid' | 'double';
export type Category = 'ruas' | 'avenidas' | 'rodovias' | 'especiais' | 'trilhos' | 'meus';

export interface Strip {
  kind: StripKind;
  width: number;
  /** For lanes: +1 goes from a to b, -1 from b to a. */
  dir?: 1 | -1;
  /** Bus-only lane. */
  bus?: boolean;
  /** Arrows (TurnBit); 0/absent = automatic. */
  turns?: number;
  /** Solid line to the left of this lane (towards the neighbour in the same direction): no lane change. */
  solid?: boolean;
  /** Sidewalk/median paving (Paving). */
  pave?: number;
  /** Sidewalk level with the carriageway (shared street) or a painted-only median. */
  flush?: boolean;
  /** Rail track (trains and metro only). */
  rail?: boolean;
}

/** Painted line type. */
export const Line = { None: 0, Solid: 1, Dashed: 2, Double: 3 } as const;
/** Line colour. */
export const LineColor = { White: 0, Yellow: 1 } as const;

export interface MarkLine { u: number; kind: number; color: number; width: number }

export interface Profile {
  id: number;
  name: string;
  strips: Strip[];
  oneWay: boolean;
  /** Part of a roundabout (no crosswalk on the ring itself). */
  ring?: boolean;
  /** Speed (km/h), for traffic. */
  speed: number;
  /** Right of way at junctions (0 = local street … 5 = highway). */
  priority?: number;
  /** Carriageway surface (Surface). */
  surface?: number;
  /** Line between the two directions when the lanes touch. */
  centre?: Centre;
  category?: Category;
  /** Made by the player (goes into the save). */
  custom?: boolean;
}

export interface LaneInfo { u: number; w: number; bus: boolean; turns: number; rail: boolean }

export interface ProfileInfo extends Profile {
  /** Edges of each strip (start and end u). */
  edges: Array<{ u0: number; u1: number; strip: Strip }>;
  /** Total half-width (to the sidewalk edge) on both sides. */
  right: number; left: number;
  /** Asphalt half-width (lanes, parking, bike lane) on both sides. */
  asphaltRight: number; asphaltLeft: number;
  lines: MarkLine[];
  lanesFwd: number; lanesBack: number;
  /** Lanes per direction, index 0 = the rightmost in that direction. */
  fwd: LaneInfo[]; back: LaneInfo[];
  /** u of the middle of the sidewalk on each side (NaN = no sidewalk). */
  walkRight: number; walkLeft: number;
  walk: boolean;
  /** Rail line (trains only). */
  rail: boolean;
  /** Cost per metre (R$). */
  cost: number;
}

const sw = (w = 3, pave: number = Paving.Concrete): Strip => ({ kind: 'sidewalk', width: w, pave });
const curb: Strip = { kind: 'curb', width: 0.2 };
const park: Strip = { kind: 'parking', width: 2.3 };
const bike = (w = 1.6): Strip => ({ kind: 'bike', width: w });
const lane = (dir: 1 | -1, w = 3.2, extra: Partial<Strip> = {}): Strip => ({ kind: 'lane', width: w, dir, ...extra });
const median = (w: number, pave: number = Paving.Grass): Strip => ({ kind: 'median', width: w, pave });
const shoulder = (w: number): Strip => ({ kind: 'shoulder', width: w });
const barrier = (w: number): Strip => ({ kind: 'barrier', width: w });
/** n lanes in one direction, from right to left as seen by someone driving in it. */
const lanes = (dir: 1 | -1, n: number, w: number, bus: 'outer' | 'inner' | null = null): Strip[] => {
  const out: Strip[] = [];
  for (let i = 0; i < n; i++) out.push(lane(dir, w, bus && n > 1 && ((bus === 'outer' && i === 0) || (bus === 'inner' && i === n - 1)) ? { bus: true } : {}));
  return dir === 1 ? out : out.reverse();
};
/** Symmetric two-way street: sidewalk, [edge], lanes b→a… a→b, [edge], sidewalk (list from right to left). */
const two = (walk: number, n: number, w: number, o: { edge?: Strip; med?: Strip; bus?: 'outer' | 'inner'; pave?: number; flush?: boolean } = {}): Strip[] => {
  const s: Strip[] = [];
  const walkStrip = { ...sw(walk, o.pave ?? Paving.Concrete), ...(o.flush ? { flush: true } : {}) };
  s.push(walkStrip);
  if (!o.flush) s.push(curb);
  if (o.edge) s.push(o.edge);
  s.push(...lanes(1, n, w, o.bus ?? null));
  if (o.med) { s.push(curb, o.med, curb); }
  s.push(...lanes(-1, n, w, o.bus ?? null));
  if (o.edge) s.push(o.edge);
  if (!o.flush) s.push(curb);
  s.push(walkStrip);
  return s;
};
const one = (walk: number, n: number, w: number, o: { right?: Strip; left?: Strip } = {}): Strip[] => [
  sw(walk), curb, ...(o.right ? [o.right] : []), ...lanes(1, n, w), ...(o.left ? [o.left] : []), curb, sw(walk),
];

/** Built-in profiles. The first 7 keep the ids of old saves. */
const BUILTIN: Array<Omit<Profile, 'id'>> = [
  { name: 'Rua local', speed: 40, oneWay: false, priority: 0, category: 'ruas', centre: 'dashed',
    strips: [sw(2.6), curb, lane(1, 3.1), lane(-1, 3.1), curb, sw(2.6)] },
  { name: 'Rua com estacionamento', speed: 40, oneWay: false, priority: 1, category: 'ruas',
    strips: [sw(2.4), curb, park, lane(1, 3.0), lane(-1, 3.0), park, curb, sw(2.4)] },
  { name: 'Mão única com estacionamento', speed: 50, oneWay: true, priority: 1, category: 'ruas',
    strips: [sw(3), curb, park, lane(1), lane(1), curb, sw(3)] },
  { name: 'Avenida', speed: 60, oneWay: false, priority: 2, category: 'avenidas',
    strips: [sw(3.5), curb, lane(1), lane(1), curb, median(3), curb, lane(-1), lane(-1), curb, sw(3.5)] },
  { name: 'Avenida com ciclovia', speed: 60, oneWay: false, priority: 3, category: 'avenidas',
    strips: [sw(4), curb, bike(1.6), lane(1, 3.3), lane(1, 3.3), lane(1, 3.3), curb, median(4),
      curb, lane(-1, 3.3), lane(-1, 3.3), lane(-1, 3.3), bike(1.6), curb, sw(4)] },
  { name: 'Via expressa', speed: 90, oneWay: false, priority: 4, category: 'rodovias',
    strips: [barrier(0.5), shoulder(2.5), lane(1, 3.6), lane(1, 3.6), shoulder(1), barrier(0.8), shoulder(1),
      lane(-1, 3.6), lane(-1, 3.6), shoulder(2.5), barrier(0.5)] },
  { name: 'Rotatória', speed: 30, oneWay: true, ring: true, priority: 3, category: 'especiais',
    strips: [sw(3), curb, lane(1, 4), lane(1, 4), curb, median(1.5)] },
  // streets
  { name: 'Rua urbana', speed: 50, oneWay: false, priority: 1, category: 'ruas', strips: two(2.5, 1, 3.3) },
  { name: 'Mão única, 1 faixa', speed: 30, oneWay: true, priority: 0, category: 'ruas', strips: one(2, 1, 3.2) },
  { name: 'Mão única, 2 faixas', speed: 40, oneWay: true, priority: 1, category: 'ruas', strips: one(2, 2, 3) },
  { name: 'Estacionamento de um lado', speed: 40, oneWay: false, priority: 1, category: 'ruas',
    strips: [sw(2.2), curb, park, lane(1, 3), lane(-1, 3), curb, sw(2.2)] },
  { name: 'Rua com ciclofaixa', speed: 40, oneWay: false, priority: 1, category: 'ruas', strips: two(2.2, 1, 3, { edge: bike(1.8) }) },
  { name: 'Rua com canteiro central', speed: 40, oneWay: false, priority: 1, category: 'ruas', strips: two(3, 1, 3.2, { med: median(2) }) },
  { name: 'Calçadas largas', speed: 30, oneWay: false, priority: 0, category: 'ruas', centre: 'dashed', strips: two(4.5, 1, 3, { pave: Paving.Pavers }) },
  { name: 'Rua estreita', speed: 30, oneWay: false, priority: 0, category: 'ruas', centre: 'dashed', strips: two(1.4, 1, 2.8) },
  { name: 'Rua compartilhada', speed: 20, oneWay: false, priority: 0, category: 'ruas', surface: Surface.Cobble, centre: 'dashed',
    strips: two(3, 1, 3, { flush: true, pave: Paving.Stone }) },
  { name: 'Rua de paralelepípedo', speed: 30, oneWay: false, priority: 0, category: 'ruas', surface: Surface.Cobble, centre: 'dashed',
    strips: two(2, 1, 3) },
  // avenues
  { name: 'Avenida 4 faixas', speed: 60, oneWay: false, priority: 2, category: 'avenidas', strips: two(3, 2, 3.2) },
  { name: 'Avenida 6 faixas com canteiro', speed: 60, oneWay: false, priority: 3, category: 'avenidas', strips: two(3.5, 3, 3.3, { med: median(3) }) },
  { name: 'Avenida com estacionamento', speed: 50, oneWay: false, priority: 2, category: 'avenidas', strips: two(3, 2, 3.2, { edge: park }) },
  { name: 'Faixa de ônibus lateral', speed: 60, oneWay: false, priority: 3, category: 'avenidas', strips: two(3.5, 2, 3.4, { med: median(2), bus: 'outer' }) },
  { name: 'Corredor de ônibus central', speed: 60, oneWay: false, priority: 3, category: 'avenidas',
    strips: two(3.5, 3, 3.4, { med: median(2, Paving.Concrete), bus: 'inner' }) },
  { name: 'Avenida mão única, 3 faixas', speed: 60, oneWay: true, priority: 2, category: 'avenidas', strips: one(3, 3, 3.3) },
  { name: 'Avenida mão única, 4 faixas', speed: 60, oneWay: true, priority: 3, category: 'avenidas', strips: one(3.5, 4, 3.3) },
  { name: 'Bulevar', speed: 60, oneWay: false, priority: 3, category: 'avenidas', strips: two(4, 2, 3.3, { med: median(6), pave: Paving.Pavers }) },
  // highways
  { name: 'Rodovia 6 faixas', speed: 110, oneWay: false, priority: 5, category: 'rodovias',
    strips: [barrier(0.5), shoulder(3), ...lanes(1, 3, 3.7), shoulder(1), barrier(0.8), shoulder(1), ...lanes(-1, 3, 3.7), shoulder(3), barrier(0.5)] },
  { name: 'Rodovia mão única, 2 faixas', speed: 100, oneWay: true, priority: 5, category: 'rodovias',
    strips: [barrier(0.5), shoulder(2.5), ...lanes(1, 2, 3.6), shoulder(1), barrier(0.5)] },
  { name: 'Rodovia mão única, 3 faixas', speed: 110, oneWay: true, priority: 5, category: 'rodovias',
    strips: [barrier(0.5), shoulder(2.5), ...lanes(1, 3, 3.6), shoulder(1), barrier(0.5)] },
  { name: 'Pista dupla, 2 faixas', speed: 80, oneWay: false, priority: 4, category: 'rodovias',
    strips: [shoulder(2), lane(1, 3.6), shoulder(0.6), barrier(0.8), shoulder(0.6), lane(-1, 3.6), shoulder(2)] },
  { name: 'Estrada simples', speed: 80, oneWay: false, priority: 3, category: 'rodovias', centre: 'dashed',
    strips: [shoulder(1.5), lane(1, 3.5), lane(-1, 3.5), shoulder(1.5)] },
  // special
  { name: 'Alça de acesso', speed: 60, oneWay: true, priority: 4, category: 'especiais',
    strips: [barrier(0.5), shoulder(1.5), lane(1, 4), shoulder(1), barrier(0.5)] },
  { name: 'Alça de acesso, 2 faixas', speed: 60, oneWay: true, priority: 4, category: 'especiais',
    strips: [barrier(0.5), shoulder(1.5), ...lanes(1, 2, 3.6), shoulder(1), barrier(0.5)] },
  { name: 'Estrada rural de paralelepípedo', speed: 40, oneWay: false, priority: 0, category: 'especiais', surface: Surface.Cobble, centre: 'dashed',
    strips: [shoulder(0.8), lane(1, 3), lane(-1, 3), shoulder(0.8)] },
  { name: 'Estrada de concreto', speed: 60, oneWay: false, priority: 1, category: 'especiais', surface: Surface.Concrete, strips: two(2, 1, 3.8) },
  // rails (trains and metro; for metro, build below ground with Page Down)
  { name: 'Ferrovia dupla', speed: 90, oneWay: false, priority: 6, category: 'trilhos', surface: Surface.Ballast,
    strips: [shoulder(1.6), lane(1, 4.3, { rail: true }), lane(-1, 4.3, { rail: true }), shoulder(1.6)] },
  { name: 'Ferrovia simples', speed: 80, oneWay: true, priority: 6, category: 'trilhos', surface: Surface.Ballast,
    strips: [shoulder(1.6), lane(1, 4.3, { rail: true }), shoulder(1.6)] },
  { name: 'Metrô (duplo)', speed: 80, oneWay: false, priority: 6, category: 'trilhos', surface: Surface.Ballast,
    strips: [shoulder(0.8), lane(1, 4.0, { rail: true }), lane(-1, 4.0, { rail: true }), shoulder(0.8)] },
];

export const RING_PROFILE = 6;
/** A segment stores its profile in one byte. */
export const MAX_PROFILES = 256;
/** Painted lines and lanes per profile in the shader table. */
export const MAX_LINES = 8;
export const BUILTIN_COUNT = BUILTIN.length;

const ASPHALT: ReadonlySet<StripKind> = new Set(['lane', 'parking', 'bike', 'shoulder']);

export const PROFILES: Profile[] = [];
export const PROFILE_INFO: ProfileInfo[] = [];
const byKey = new Map<string, number>();
/** Changes with every registered profile (the shader and traffic tables are rebuilt). */
export let profileRevision = 0;
const listeners: Array<(id: number) => void> = [];
export function onProfileAdded(fn: (id: number) => void): void { listeners.push(fn); }

/** What defines the profile (the name is not part of it). */
export function profileKey(p: Omit<Profile, 'id' | 'name' | 'category' | 'custom'> & { name?: string }): string {
  return JSON.stringify([p.strips.map((s) => [s.kind, Math.round(s.width * 100), s.dir ?? 0, s.bus ? 1 : 0, s.turns ?? 0, s.solid ? 1 : 0, s.pave ?? 0, s.flush ? 1 : 0, s.rail ? 1 : 0]),
    p.oneWay, p.ring ?? false, p.speed, p.priority ?? 0, p.surface ?? 0, p.centre ?? 'double']);
}

/** Fixes what the editor left crooked (one-way is always a → b). */
export function normalize(p: Omit<Profile, 'id'>): Omit<Profile, 'id'> {
  const strips = p.strips.map((s) => ({ ...s, width: Math.max(0.1, Math.min(20, s.width)) }));
  const dirs = new Set(strips.filter((s) => s.kind === 'lane').map((s) => s.dir ?? 1));
  const oneWay = dirs.size === 1;
  if (oneWay) for (const s of strips) if (s.kind === 'lane') s.dir = 1;
  return { ...p, strips, oneWay };
}

/** Registers (or finds) the profile; returns the id, or -1 if the registry is full. */
export function registerProfile(def: Omit<Profile, 'id'>, fixedId?: number): number {
  const p = normalize(def);
  const key = profileKey(p);
  const have = byKey.get(key);
  if (have !== undefined && fixedId === undefined) return have;
  const id = fixedId ?? PROFILES.length;
  if (id >= MAX_PROFILES) return -1;
  const full: Profile = { ...p, id };
  PROFILES[id] = full;
  PROFILE_INFO[id] = derive(full);
  byKey.set(key, id);
  profileRevision++;
  for (const fn of listeners) fn(id);
  return id;
}

/**
 * The same profile with (or without) parking on one side: `right` = the right-hand side going from a to b
 * (start of the strip list). Returns the profile id (registered if new) or -1.
 */
export function withParking(id: number, right: boolean, on: boolean): number {
  const p = PROFILES[id];
  if (!p || p.ring) return -1;
  const strips = p.strips.map((s) => ({ ...s }));
  const order = right ? strips : strips.slice().reverse();
  // the parking strip goes right after the sidewalk and curb on that side
  let k = 0;
  while (k < order.length && (order[k].kind === 'sidewalk' || order[k].kind === 'curb')) k++;
  const has = order[k]?.kind === 'parking';
  if (has === on) return id;
  if (on) order.splice(k, 0, { kind: 'parking', width: 2.3 }); else order.splice(k, 1);
  const list = right ? order : order.reverse();
  return registerProfile({ ...p, strips: list, name: `${p.name.replace(/ \(vagas.*\)$/, '')} (vagas ajustadas)`, custom: true, category: p.category });
}

/** Profiles made by the player (for the save and the workers). */
export function customProfiles(): Profile[] { return PROFILES.filter((p) => p && p.custom); }

/** Restores the player's profiles as they were (map load, worker message). */
export function setCustomProfiles(list: Profile[]): void {
  // go back to the built-ins only and register again under the same ids
  for (let i = BUILTIN_COUNT; i < PROFILES.length; i++) {
    const p = PROFILES[i];
    if (p) byKey.delete(profileKey(p));
  }
  PROFILES.length = BUILTIN_COUNT; PROFILE_INFO.length = BUILTIN_COUNT;
  for (const p of list) {
    if (p.id < BUILTIN_COUNT || p.id >= MAX_PROFILES) continue;
    // vacant ids in between get a copy of the local street (never used)
    while (PROFILES.length < p.id) { PROFILES.push({ ...PROFILES[0], id: PROFILES.length }); PROFILE_INFO.push(derive(PROFILES[PROFILES.length - 1])); }
    registerProfile({ ...p, custom: true }, p.id);
  }
  profileRevision++;
  for (const fn of listeners) fn(-1);
}

export function profileCount(): number { return PROFILES.length; }

function derive(p: Profile): ProfileInfo {
  const total = p.strips.reduce((s, x) => s + x.width, 0);
  let u = -total / 2;
  const edges = p.strips.map((strip) => { const e = { u0: u, u1: u + strip.width, strip }; u += strip.width; return e; });
  const asph = edges.filter((e) => ASPHALT.has(e.strip.kind) || (e.strip.flush && e.strip.kind !== 'sidewalk'));
  const lines: MarkLine[] = [];
  const centre = p.centre ?? 'double';
  const railP = p.strips.some((x) => x.rail);
  for (let i = 0; i + 1 < edges.length && lines.length < MAX_LINES && !railP; i++) {
    const a = edges[i].strip, b = edges[i + 1].strip;
    const at = edges[i].u1;
    if (a.kind === 'lane' && b.kind === 'lane') {
      if (a.dir !== b.dir) lines.push({ u: at, kind: centre === 'double' ? Line.Double : centre === 'solid' ? Line.Solid : Line.Dashed, color: LineColor.Yellow, width: 0.12 });
      else lines.push({ u: at, kind: (a.dir === 1 ? b.solid : a.solid) || a.bus !== b.bus ? Line.Solid : Line.Dashed, color: LineColor.White, width: a.bus !== b.bus ? 0.2 : 0.12 });
    } else if ((a.kind === 'lane') !== (b.kind === 'lane') && (ASPHALT.has(a.kind) && ASPHALT.has(b.kind))) {
      lines.push({ u: at, kind: Line.Solid, color: LineColor.White, width: 0.15 });
    } else if (a.kind === 'median' && a.flush && i > 0) {
      lines.push({ u: edges[i].u0, kind: Line.Solid, color: LineColor.Yellow, width: 0.12 });
      lines.push({ u: at, kind: Line.Solid, color: LineColor.Yellow, width: 0.12 });
    }
  }
  const fwd: LaneInfo[] = [], back: LaneInfo[] = [];
  for (const e of edges) {
    if (e.strip.kind !== 'lane') continue;
    const li = { u: (e.u0 + e.u1) / 2, w: e.u1 - e.u0, bus: !!e.strip.bus, turns: e.strip.turns ?? 0, rail: !!e.strip.rail };
    (e.strip.dir === -1 ? back : fwd).push(li);
  }
  back.reverse(); // in the b → a direction, right is the larger u
  const r = edges[0], l = edges[edges.length - 1];
  const walkRight = r && r.strip.kind === 'sidewalk' ? (r.u0 + r.u1) / 2 : NaN;
  const walkLeft = l && l.strip.kind === 'sidewalk' ? (l.u0 + l.u1) / 2 : NaN;
  // price per metre at grade (Roadcraft): m² of carriageway, median and footway × price per m² (`roads/tuning.ts`)
  const rail = p.strips.some((x) => x.rail);
  const area = { carriageway: 0, median: 0, footway: 0 };
  for (const e of edges) {
    const k = e.strip.kind, w = e.u1 - e.u0;
    if (k === 'sidewalk' || k === 'curb') area.footway += w;
    else if (k === 'median' || k === 'barrier') area.median += w;
    else area.carriageway += w;
  }
  const ppm = ROAD_TUNING.economy.perSquareMetre;
  const cost = Math.round(area.carriageway * ppm.carriageway + area.median * ppm.median + area.footway * ppm.footway);
  return {
    ...p, edges,
    right: total / 2, left: total / 2,
    asphaltRight: asph.length ? -asph[0].u0 : 0,
    asphaltLeft: asph.length ? asph[asph.length - 1].u1 : 0,
    lines,
    lanesFwd: fwd.length, lanesBack: back.length, fwd, back,
    walkRight, walkLeft, walk: !Number.isNaN(walkRight) || !Number.isNaN(walkLeft),
    rail,
    cost,
  };
}

for (let i = 0; i < BUILTIN.length; i++) registerProfile(BUILTIN[i], i);

export function halfWidth(profile: number): number { return PROFILE_INFO[profile].right; }

export function isAsphalt(kind: StripKind): boolean { return ASPHALT.has(kind); }

/** Shader table columns per profile: 8 lines, 8 lanes, lamp posts, extra. */
export const TABLE_W = MAX_LINES * 2 + 2;

/**
 * Float RGBA shader table, one row per profile:
 * [0..7] lines (u, width, type, colour); [8..15] lanes (u, direction, width, arrows + 8·bus);
 * [16] lamp posts (has median, right u, left u, median u); [17] (surface, right curb u, left
 * curb u, 0).
 */
export function writeProfileRow(t: Float32Array, id: number): void {
  const p = PROFILE_INFO[id];
  const o = id * TABLE_W * 4;
  t.fill(0, o, o + TABLE_W * 4);
  if (!p) return;
  p.lines.forEach((l, i) => { const k = o + i * 4; t[k] = l.u; t[k + 1] = l.width; t[k + 2] = l.kind; t[k + 3] = l.color; });
  let k = 0;
  for (const e of p.edges) {
    if (e.strip.kind !== 'lane' || k >= MAX_LINES) continue;
    const q = o + (MAX_LINES + k) * 4;
    t[q] = (e.u0 + e.u1) / 2; t[q + 1] = e.strip.dir ?? 1; t[q + 2] = e.u1 - e.u0;
    t[q + 3] = (e.strip.turns ?? 0) + (e.strip.bus ? 8 : 0) + (e.strip.rail ? 16 : 0);
    k++;
  }
  const med = p.edges.find((e) => e.strip.kind === 'median' || (e.strip.kind === 'barrier' && Math.abs((e.u0 + e.u1) / 2) < 1));
  const hasMed = med && med.u1 - med.u0 >= 1.2 ? 1 : 0;
  const right = p.edges[0].strip.kind === 'sidewalk' ? p.edges[0].u0 + 0.5 + 1.9 : 0;
  const lastE = p.edges[p.edges.length - 1];
  const left = lastE.strip.kind === 'sidewalk' ? lastE.u1 - 0.5 - 1.9 : right;
  const q = o + MAX_LINES * 2 * 4;
  t[q] = hasMed; t[q + 1] = right; t[q + 2] = left; t[q + 3] = med ? (med.u0 + med.u1) / 2 : 0;
  t[q + 4] = p.surface ?? 0;
  // [17].y/.z: u of the outer curbs' road-side faces (right, left; ±99 = none): gutter, drains and tactile paving
  const curbs = p.edges.filter((e) => e.strip.kind === 'curb');
  const rc = curbs.find((e) => e.u1 < 0), lc = [...curbs].reverse().find((e) => e.u0 > 0);
  t[q + 5] = rc && rc === curbs[0] ? rc.u1 : -99;
  t[q + 6] = lc && lc === curbs[curbs.length - 1] ? lc.u0 : 99;
}
