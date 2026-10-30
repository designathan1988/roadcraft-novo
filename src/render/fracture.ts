// A building's real shell and interior, cut into Voronoi fragments: the integers are plain arrays so the whole pass
// runs in a Web Worker. The reference is the 4.0 fracture: fragments round a 2.8 m cell, each one's cut faces, floor
// slabs and interior walls included, and the pieces keep their neighbours for the unsupported collapse.
import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';

const FRAGMENT = 3.6;
const MAX_EDGE = 2.4;
const WALL = 0.28;
const BROKEN = [0.46, 0.44, 0.41] as const;
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
  const keys = [...cells.keys()];
  const vertexCells = new Map<string, Set<number>>();
  const pos: number[][] = [], nor: number[][] = [], col: number[][] = [], slots: number[][] = [], frags: Fragment[] = [];
  keys.forEach((cell, fi) => {
    const list = cells.get(cell)!;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const t of list) for (let q = 0; q < 3; q++) { cx += t.v[q * STRIDE]!; cy += t.v[q * STRIDE + 1]!; cz += t.v[q * STRIDE + 2]!; n++; }
    cx /= n; cy /= n; cz /= n;
    let radius = 0, low = Infinity;
    const start = (pos[fi] ??= []).length / 3;
    const p = pos[fi]!, nn = (nor[fi] ??= []), cc = (col[fi] ??= []);
    const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: readonly number[]): void => {
      p.push(x - cx, y - cy, z - cz); nn.push(nx, ny, nz); cc.push(c[0]!, c[1]!, c[2]!);
      radius = Math.max(radius, Math.hypot(x - cx, y - cy, z - cz)); low = Math.min(low, y);
    };
    const vkey = (x: number, y: number, z: number): string => `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
    // Every front triangle, plus the cut faces that make the fragments solid masonry instead of paper sheets.
    const edges = new Map<string, number>();
    for (const t of list) for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
      const a = vkey(t.v[i * STRIDE]!, t.v[i * STRIDE + 1]!, t.v[i * STRIDE + 2]!);
      const b = vkey(t.v[j * STRIDE]!, t.v[j * STRIDE + 1]!, t.v[j * STRIDE + 2]!);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    for (const t of list) {
      const v = t.v;
      for (let q = 0; q < 3; q++) {
        const o = q * STRIDE, x = v[o]!, y = v[o + 1]!, z = v[o + 2]!;
        push(x, y, z, v[o + 3]!, v[o + 4]!, v[o + 5]!, [v[o + 6]!, v[o + 7]!, v[o + 8]!]);
        const key = vkey(x, y, z), set = vertexCells.get(key) ?? new Set<number>();
        set.add(fi); vertexCells.set(key, set);
      }
      // The back of the shell, in broken masonry.
      const back = (q: number): [number, number, number] => [v[q * STRIDE]! - v[q * STRIDE + 3]! * WALL, v[q * STRIDE + 1]! - v[q * STRIDE + 4]! * WALL, v[q * STRIDE + 2]! - v[q * STRIDE + 5]! * WALL];
      for (const q of [0, 2, 1]) { const b = back(q); push(b[0], b[1], b[2], -v[q * STRIDE + 3]!, -v[q * STRIDE + 4]!, -v[q * STRIDE + 5]!, BROKEN); }
      // A side along every edge used by this fragment only (the cuts between fragments).
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
        const a = vkey(v[i * STRIDE]!, v[i * STRIDE + 1]!, v[i * STRIDE + 2]!);
        const b = vkey(v[j * STRIDE]!, v[j * STRIDE + 1]!, v[j * STRIDE + 2]!);
        if ((edges.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0) !== 1) continue;
        const pi = [v[i * STRIDE]!, v[i * STRIDE + 1]!, v[i * STRIDE + 2]!], pj = [v[j * STRIDE]!, v[j * STRIDE + 1]!, v[j * STRIDE + 2]!];
        const bi = back(i), bj = back(j);
        const ex = pj[0]! - pi[0]!, ey = pj[1]! - pi[1]!, ez = pj[2]! - pi[2]!;
        const sx = ey * v[5]! - ez * v[4]!, sy = ez * v[3]! - ex * v[5]!, sz = ex * v[4]! - ey * v[3]!;
        const sl = Math.hypot(sx, sy, sz) || 1, sn = [sx / sl, sy / sl, sz / sl] as const;
        push(pi[0]!, pi[1]!, pi[2]!, sn[0], sn[1], sn[2], BROKEN); push(bi[0], bi[1], bi[2], sn[0], sn[1], sn[2], BROKEN); push(pj[0]!, pj[1]!, pj[2]!, sn[0], sn[1], sn[2], BROKEN);
        push(pj[0]!, pj[1]!, pj[2]!, sn[0], sn[1], sn[2], BROKEN); push(bi[0], bi[1], bi[2], sn[0], sn[1], sn[2], BROKEN); push(bj[0], bj[1], bj[2], sn[0], sn[1], sn[2], BROKEN);
      }
    }
    slots[fi] = [start, p.length / 3 - start];
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
