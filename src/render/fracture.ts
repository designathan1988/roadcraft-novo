// A building's real shell and interior, cut into Voronoi fragments: the integers are plain arrays so the whole pass
// runs in a Web Worker. The reference is the 4.0 fracture: fragments round a 2.8 m cell, each one's cut faces, floor
// slabs and interior walls included, and the pieces keep their neighbours for the unsupported collapse.
import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';

const FRAGMENT = 3.6;
const MAX_EDGE = 2.4;
const STRIDE = 12;

export interface FractureInput {
  position: Float32Array;
  normal: Float32Array;
  /** 0xRRGGBB per vertex. */
  colour: Uint32Array;
  index: Uint32Array;
  seed: number;
}

export interface Fragment {
  centre: [number, number, number];
  radius: number;
  low: number;
  neighbours: number[];
}

export interface StillData {
  position: Float32Array; normal: Float32Array; colour: Float32Array;
  slots: Int32Array[];
  fragments: Fragment[];
}

interface Tri { v: number[]; group: number }

const linear = (hex: number): number[] => {
  const f = (c: number): number => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
};

function lerp(a: number[], ai: number, b: number[], bi: number, out: number[]): void {
  for (let k = 0; k < STRIDE; k++) out.push((a[ai + k]! + b[bi + k]!) / 2);
}

/** Splits a triangle along its longest edge until every edge is below `max`; keeps the vertex colours and normals. */
function subdivide(v: number[], max: number, out: number[][]): void {
  const stack = [v];
  while (stack.length) {
    const t = stack.pop()!;
    const d = (i: number, j: number): number => Math.hypot(t[i * STRIDE]! - t[j * STRIDE]!, t[i * STRIDE + 1]! - t[j * STRIDE + 1]!, t[i * STRIDE + 2]! - t[j * STRIDE + 2]!);
    const e = [d(0, 1), d(1, 2), d(2, 0)], longest = e.indexOf(Math.max(...e));
    if (e[longest]! <= max || out.length > 120_000) { out.push(t); continue; }
    const i = longest, j = (longest + 1) % 3, k = (longest + 2) % 3, mid: number[] = [];
    lerp(t, i * STRIDE, t, j * STRIDE, mid);
    const vi = t.slice(i * STRIDE, i * STRIDE + STRIDE), vj = t.slice(j * STRIDE, j * STRIDE + STRIDE), vk = t.slice(k * STRIDE, k * STRIDE + STRIDE);
    stack.push([...vi, ...mid, ...vk], [...mid, ...vj, ...vk]);
  }
}

/** Cuts the triangles in `input` into solid Voronoi fragments. */
export function fractureData(input: FractureInput): StillData {
  const tris: Tri[] = [];
  for (let t = 0; t < input.index.length; t += 3) {
    const v: number[] = [];
    for (let q = 0; q < 3; q++) {
      const i = input.index[t + q]!;
      const c = linear(input.colour[i]!);
      v.push(input.position[i * 3]!, input.position[i * 3 + 1]!, input.position[i * 3 + 2]!,
        input.normal[i * 3]!, input.normal[i * 3 + 1]!, input.normal[i * 3 + 2]!, c[0]!, c[1]!, c[2]!, 0, 0, 0);
    }
    for (const p of (() => { const out: number[][] = []; subdivide(v, MAX_EDGE, out); return out; })()) tris.push({ v: p, group: -1 });
  }
  if (!tris.length) return { position: new Float32Array(), normal: new Float32Array(), colour: new Float32Array(), slots: [], fragments: [] };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (const t of tris) for (let q = 0; q < 3; q++) {
    minX = Math.min(minX, t.v[q * STRIDE]!); minY = Math.min(minY, t.v[q * STRIDE + 1]!); minZ = Math.min(minZ, t.v[q * STRIDE + 2]!);
  }
  let s = input.seed >>> 0 || 1;
  const rand = (): number => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 4_294_967_296; };
  const jitter = new Map<string, number[]>();
  const seedOf = (i: number, j: number, k: number): number[] => {
    const key = `${i},${j},${k}`;
    let p = jitter.get(key);
    if (!p) { p = [minX + (i + 0.15 + rand() * 0.7) * FRAGMENT, minY + (j + 0.15 + rand() * 0.7) * FRAGMENT, minZ + (k + 0.15 + rand() * 0.7) * FRAGMENT]; jitter.set(key, p); }
    return p;
  };
  const cellOf = (x: number, y: number, z: number): string => {
    const i0 = Math.floor((x - minX) / FRAGMENT), j0 = Math.floor((y - minY) / FRAGMENT), k0 = Math.floor((z - minZ) / FRAGMENT);
    let best = '', bd = Infinity;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const p = seedOf(i0 + di, j0 + dj, k0 + dk), d = (p[0]! - x) ** 2 + (p[1]! - y) ** 2 + (p[2]! - z) ** 2;
      if (d < bd) { bd = d; best = `${i0 + di},${j0 + dj},${k0 + dk}`; }
    }
    return best;
  };
  const cells = new Map<string, Tri[]>();
  for (const t of tris) {
    const cx = (t.v[0]! + t.v[STRIDE]! + t.v[2 * STRIDE]!) / 3, cy = (t.v[1]! + t.v[STRIDE + 1]! + t.v[2 * STRIDE + 1]!) / 3, cz = (t.v[2]! + t.v[STRIDE + 2]! + t.v[2 * STRIDE + 2]!) / 3;
    const cell = cellOf(cx, cy, cz), list = cells.get(cell);
    if (list) list.push(t); else cells.set(cell, [t]);
  }
  const keys = [...cells.keys()], vkey = (x: number, y: number, z: number): string => `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
  const vertexCells = new Map<string, Set<number>>();
  const pos: number[][] = [], nor: number[][] = [], col: number[][] = [], slots: number[][] = [], frags: Fragment[] = [];
  keys.forEach((cell, fi) => {
    const list = cells.get(cell)!;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const t of list) for (let q = 0; q < 3; q++) { cx += t.v[q * STRIDE]!; cy += t.v[q * STRIDE + 1]!; cz += t.v[q * STRIDE + 2]!; n++; }
    cx /= n; cy /= n; cz /= n;
    let radius = 0, low = Infinity;
    const start = (pos[fi] ??= []).length / 3;
    for (const t of list) {
      for (let q = 0; q < 3; q++) {
        const o = q * STRIDE, x = t.v[o]!, y = t.v[o + 1]!, z = t.v[o + 2]!;
        pos[fi]!.push(x - cx, y - cy, z - cz); nor[fi] ??= []; col[fi] ??= [];
        nor[fi]!.push(t.v[o + 3]!, t.v[o + 4]!, t.v[o + 5]!); col[fi]!.push(t.v[o + 6]!, t.v[o + 7]!, t.v[o + 8]!);
        radius = Math.max(radius, Math.hypot(x - cx, y - cy, z - cz)); low = Math.min(low, y);
        const key = vkey(x, y, z), set = vertexCells.get(key) ?? new Set<number>();
        set.add(fi); vertexCells.set(key, set);
      }
    }
    slots[fi] = [start, pos[fi]!.length / 3 - start];
    frags[fi] = { centre: [cx, cy, cz], radius, low, neighbours: [] };
  });
  const links = frags.map(() => new Set<number>());
  for (const set of vertexCells.values()) {
    if (set.size < 2) continue;
    const ids = [...set];
    for (const a of ids) for (const b of ids) if (a !== b) links[a]!.add(b);
  }
  links.forEach((set, i) => frags[i]!.neighbours.push(...set));
  let total = 0;
  for (const p of pos) total += p.length / 3;
  const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), colour = new Float32Array(total * 3);
  let at = 0;
  frags.forEach((_, i) => {
    position.set(pos[i]!, at * 3); normal.set(nor[i]!, at * 3); colour.set(col[i]!, at * 3);
    slots[i] = [at, pos[i]!.length / 3];
    at += pos[i]!.length / 3;
  });
  return { position, normal, colour, slots: slots.map((s) => Int32Array.from(s)), fragments: frags };
}

/** A fragment's own geometry, relative to its centre, while it is in the air. */
export function fragmentGeometry(data: StillData, index: number): BufferGeometry {
  const [start, count] = data.slots[index]!;
  const [cx, cy, cz] = data.fragments[index]!.centre;
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3), colour = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const i = start + k;
    position[k * 3] = data.position[i * 3]! - cx; position[k * 3 + 1] = data.position[i * 3 + 1]! - cy; position[k * 3 + 2] = data.position[i * 3 + 2]! - cz;
    normal[k * 3] = data.normal[i * 3]!; normal[k * 3 + 1] = data.normal[i * 3 + 1]!; normal[k * 3 + 2] = data.normal[i * 3 + 2]!;
    colour[k * 3] = data.colour[i * 3]!; colour[k * 3 + 1] = data.colour[i * 3 + 1]!; colour[k * 3 + 2] = data.colour[i * 3 + 2]!;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3)); g.setAttribute('normal', new BufferAttribute(normal, 3)); g.setAttribute('color', new BufferAttribute(colour, 3));
  g.boundingSphere = new Sphere(new Vector3(), data.fragments[index]!.radius);
  return g;
}
