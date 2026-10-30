// A building broken for real (Roadcraft 4.0 render/buildings/fracture.ts fractureData), in the worker: the building as
// it is drawn (its shell, panes and every part, laid by the same generator as its cell, jobs/buildingGen.ts) cut into
// Voronoi cells of a jittered grid, each cell a solid fragment: its faces, the wall's thickness behind them in broken
// concrete, and a side along every cut. Parts (a window's frame, a door) go whole to one fragment. The result is one
// buffer in the building material's vertex format (position.w the building's tag, `frag` the fragment's index: the
// ruin's renderer turns each fragment as a rigid body), each fragment's centre, reach and lowest point, and which
// fragments touch (they share a vertex of the original surface): what hangs on nothing falls.

import { octEncode } from '../../../jobs/boxMesh.ts';
import { FIN } from '../../../jobs/buildingFinishes.ts';
import type { MeshBuilder } from '../../../jobs/meshBuilder.ts';

/** A building broken into fragments: non-indexed triangles in the building material's vertex format. */
export interface RuinData {
  /** x, y, z (world), the building's tag / 32767 (as the cell meshes carry it). */
  position: Float32Array;
  normal: Int8Array;
  color: Uint8Array;
  fac: Uint8Array;
  fuv: Int16Array;
  /** Each vertex's fragment (float: one uint16 is not a WebGPU vertex format). */
  frag: Float32Array;
  /** Per fragment: centre x, y, z, reach, lowest y. */
  fragments: Float32Array;
  fragmentCount: number;
  /** Fragments touching fragment i: neighbours[start[i] .. start[i + 1]). */
  start: Int32Array;
  neighbours: Int32Array;
  /** The kit models the attached instances use (part kinds; furniture as 'f:' + kind). */
  kinds: string[];
  /** Per instance ATTACH numbers: kind (index in `kinds`), fragment, x, y, z, cos, sin of its turn, sx, sy, sz, sRGB. */
  attached: Float32Array;
}

/** The parts and furniture laid apart from the shell, as the building's generator gives them (jobs/building40.ts). */
export interface Attached { kinds: string[]; rows: number[] }
/** Numbers per gathered instance (kind, x, y, z, cos, sin, sx, sy, sz, sRGB) and per attached one (+ its fragment). */
export const ATTACHED = 10;
export const ATTACH = 11;

/** A sink gathering the generator's instances (jobs/building40.ts AttachSink) into `into`. */
export function gather(into: Attached): (kind: string, pose: Float32Array, at: number, rgb: number) => void {
  const index = new Map<string, number>();
  return (kind, pose, at, rgb) => {
    let k = index.get(kind);
    if (k === undefined) { k = into.kinds.length; into.kinds.push(kind); index.set(kind, k); }
    into.rows.push(k, pose[at], pose[at + 1], pose[at + 2], pose[at + 3], pose[at + 4], pose[at + 5], pose[at + 6], pose[at + 7], rgb);
  };
}

/** A fragment's edge (4.0 FRAGMENT), the longest triangle edge after subdivision (MAX_EDGE), a wall's thickness (WALL). */
const FRAGMENT = 2.8;
const WALL = 0.28;
/** Fragments a building is cut into at most: a larger building gets larger fragments (4.0 cut every building at 2.8 m). */
const MOST_FRAGMENTS = 480;
/** The grey of broken masonry on the cut faces (4.0 BROKEN 0.46, 0.44, 0.41 linear) as sRGB bytes, in the concrete finish. */
const BROKEN_RGB = (179 << 16) | (176 << 8) | 171;
const BROKEN_MAT = 4 | (FIN.Concrete << 4);
/** A slab's underside: a room's ceiling, plastered (4.0 PARTITION 0xece6da). */
const CEILING_RGB = 0xece6da;
/** A wall's or a floor's inner side: indoor (jobs/buildingGen/materials.ts BMAT.Indoor), out of the sky's light. */
const INNER_MAT = 11 | (FIN.Concrete << 4);
/** Tags of a whole part's vertices (jobs/building40.ts, whole parts): the part's group in the low 15 bits. */
export const PART_GROUP = 0x8000;

export const ruinTransfer = (r: RuinData): ArrayBuffer[] =>
  [r.position, r.normal, r.color, r.fac, r.fuv, r.frag, r.fragments, r.start, r.neighbours, r.attached].map((a) => a.buffer as ArrayBuffer);

// a triangle corner while cutting: position, normal, colour (0..255), facade u and h
const STRIDE = 11;

interface Tri { v: Float64Array; mat: number; f0: number; f1: number; f2: number; f3: number; group: number; solid: boolean }

/**
 * Splits a triangle along its longest edge until every edge is under `max` (4.0 subdivide), but only while it crosses
 * a cell's border (`whole`: its corners and middle in one cell): a wall's face inside a fragment stays one triangle.
 */
function subdivide(v: Float64Array, max: number, out: Float64Array[], whole: (t: Float64Array) => boolean): void {
  const stack = [v];
  while (stack.length) {
    const t = stack.pop()!;
    const d = (i: number, j: number) => Math.hypot(t[i * STRIDE] - t[j * STRIDE], t[i * STRIDE + 1] - t[j * STRIDE + 1], t[i * STRIDE + 2] - t[j * STRIDE + 2]);
    const e0 = d(0, 1), e1 = d(1, 2), e2 = d(2, 0);
    const longest = e0 >= e1 && e0 >= e2 ? 0 : e1 >= e2 ? 1 : 2;
    if (Math.max(e0, e1, e2) <= max || out.length > 200_000 || whole(t)) { out.push(t); continue; }
    const i = longest, j = (longest + 1) % 3, k = (longest + 2) % 3;
    const a = new Float64Array(STRIDE * 3), b = new Float64Array(STRIDE * 3);
    for (let s = 0; s < STRIDE; s++) {
      const mid = (t[i * STRIDE + s] + t[j * STRIDE + s]) / 2;
      a[s] = t[i * STRIDE + s]; a[STRIDE + s] = mid; a[2 * STRIDE + s] = t[k * STRIDE + s];
      b[s] = mid; b[STRIDE + s] = t[j * STRIDE + s]; b[2 * STRIDE + s] = t[k * STRIDE + s];
    }
    stack.push(a, b);
  }
}

/** The building's triangles as the cut takes them. */
function trianglesOf(mb: MeshBuilder): { tris: Tri[]; area: number } {
  const tris: Tri[] = [];
  let area = 0;
  const P = mb.pos, N = mb.nrm, C = mb.col, F = mb.fac!, U = mb.fuv!;
  for (let t = 0; t < mb.t; t += 3) {
    const v = new Float64Array(STRIDE * 3);
    for (let q = 0; q < 3; q++) {
      const i = mb.idx[t + q], o = q * STRIDE;
      v[o] = P[i * 3]; v[o + 1] = P[i * 3 + 1]; v[o + 2] = P[i * 3 + 2];
      v[o + 3] = N[i * 3]; v[o + 4] = N[i * 3 + 1]; v[o + 5] = N[i * 3 + 2];
      v[o + 6] = (C[i] >> 16) & 255; v[o + 7] = (C[i] >> 8) & 255; v[o + 8] = C[i] & 255;
      v[o + 9] = U[i * 2]; v[o + 10] = U[i * 2 + 1];
    }
    const i0 = mb.idx[t], tag = mb.tag[i0];
    const group = tag & PART_GROUP ? tag & 0x7fff : -1;
    const ex = v[STRIDE] - v[0], ey = v[STRIDE + 1] - v[1], ez = v[STRIDE + 2] - v[2];
    const fx = v[2 * STRIDE] - v[0], fy = v[2 * STRIDE + 1] - v[1], fz = v[2 * STRIDE + 2] - v[2];
    area += Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx) / 2;
    tris.push({ v, mat: mb.mat[i0], f0: F[i0 * 4], f1: F[i0 * 4 + 1], f2: F[i0 * 4 + 2], f3: F[i0 * 4 + 3], group, solid: group < 0 });
  }
  return { tris, area };
}

/** The fragments of a building laid in `mb` (`seed` the building's). Null when it has nothing to break. */
export function fractureBuilding(mb: MeshBuilder, seed: number, tag: number, attached: Attached): RuinData | null {
  const { tris: whole, area } = trianglesOf(mb);
  if (!whole.length) return null;
  // the cut's size: 4.0's 2.8 m fragments, larger for a building that would make more than MOST_FRAGMENTS of them
  // (fragments cover the surface: about area / size² of them), and triangles split to half a fragment
  const size = Math.max(FRAGMENT, Math.sqrt(area / MOST_FRAGMENTS));
  const maxEdge = size / 2;
  // ---- Voronoi cells: a jittered grid of seeds (4.0's), keyed by integer
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (const t of whole) for (let q = 0; q < 3; q++) {
    minX = Math.min(minX, t.v[q * STRIDE]); minY = Math.min(minY, t.v[q * STRIDE + 1]); minZ = Math.min(minZ, t.v[q * STRIDE + 2]);
  }
  minX -= size; minY -= size; minZ -= size;
  let s = seed >>> 0 || 1;
  const rand = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 4_294_967_296; };
  const key = (i: number, j: number, k: number) => ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  const seeds = new Map<number, Float64Array>();
  const seedOf = (i: number, j: number, k: number): Float64Array => {
    const kk = key(i, j, k);
    let p = seeds.get(kk);
    if (!p) {
      p = Float64Array.of(minX + (i + 0.15 + rand() * 0.7) * size, minY + (j + 0.15 + rand() * 0.7) * size, minZ + (k + 0.15 + rand() * 0.7) * size);
      seeds.set(kk, p);
    }
    return p;
  };
  const cellOf = (x: number, y: number, z: number): number => {
    const i0 = Math.floor((x - minX) / size), j0 = Math.floor((y - minY) / size), k0 = Math.floor((z - minZ) / size);
    let best = 0, bd = Infinity;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const p = seedOf(i0 + di, j0 + dj, k0 + dk);
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2;
      if (d < bd) { bd = d; best = key(i0 + di, j0 + dj, k0 + dk); }
    }
    return best;
  };
  const oneCell = (t: Float64Array): boolean => {
    const c = cellOf((t[0] + t[STRIDE] + t[2 * STRIDE]) / 3, (t[1] + t[STRIDE + 1] + t[2 * STRIDE + 1]) / 3, (t[2] + t[STRIDE + 2] + t[2 * STRIDE + 2]) / 3);
    for (let q = 0; q < 3; q++) if (cellOf(t[q * STRIDE], t[q * STRIDE + 1], t[q * STRIDE + 2]) !== c) return false;
    return true;
  };
  const tris: Tri[] = [];
  const split: Float64Array[] = [];
  for (const t of whole) {
    if (!t.solid) { tris.push(t); continue; }
    split.length = 0;
    subdivide(t.v, maxEdge, split, oneCell);
    for (const v of split) tris.push({ ...t, v });
  }
  // a part goes whole to the cell of its first triangle's centre
  const groupCell = new Map<number, number>();
  const cells = new Map<number, Tri[]>();
  for (const t of tris) {
    const cx = (t.v[0] + t.v[STRIDE] + t.v[2 * STRIDE]) / 3, cy = (t.v[1] + t.v[STRIDE + 1] + t.v[2 * STRIDE + 1]) / 3, cz = (t.v[2] + t.v[STRIDE + 2] + t.v[2 * STRIDE + 2]) / 3;
    let cell: number;
    if (t.group >= 0) {
      cell = groupCell.get(t.group) ?? cellOf(cx, cy, cz);
      groupCell.set(t.group, cell);
    } else cell = cellOf(cx, cy, cz);
    const list = cells.get(cell);
    if (list) list.push(t); else cells.set(cell, [t]);
  }
  // ---- each cell to a solid fragment: its faces, their back in broken concrete, a side along every cut edge
  const out = new Writer(tag / 32767);
  const fragOfCell = new Map<number, number>();
  // the cells each vertex of the original surface ends up in: two fragments sharing one are joined
  const vertexCells = new Map<string, number[]>();
  const frags: number[] = [];
  const vkey = (v: Float64Array, q: number) => `${Math.round(v[q * STRIDE] * 200)},${Math.round(v[q * STRIDE + 1] * 200)},${Math.round(v[q * STRIDE + 2] * 200)}`;
  const back: number[] = [0, 0, 0];
  let fi = 0;
  for (const [cell, list] of cells) {
    fragOfCell.set(cell, fi);
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const t of list) for (let q = 0; q < 3; q++) { cx += t.v[q * STRIDE]; cy += t.v[q * STRIDE + 1]; cz += t.v[q * STRIDE + 2]; n++; }
    cx /= n; cy /= n; cz /= n;
    const first = out.n;
    // the cut edges: used once within the fragment among the faces of one material
    const edges = new Map<string, number>();
    const ek = (t: Tri, i: number, j: number) => { const a = vkey(t.v, i), b = vkey(t.v, j); return `${t.mat}|${a < b ? a + '|' + b : b + '|' + a}`; };
    for (const t of list) if (t.solid) for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) { const k = ek(t, i, j); edges.set(k, (edges.get(k) ?? 0) + 1); }
    for (const t of list) {
      const v = t.v;
      for (let q = 0; q < 3; q++) {
        out.vert(v, q, fi, t.mat, t.f0, t.f1, t.f2, t.f3);
        const k = vkey(v, q), cs = vertexCells.get(k);
        if (!cs) vertexCells.set(k, [fi]); else if (cs[cs.length - 1] !== fi && !cs.includes(fi)) cs.push(fi);
      }
      if (!t.solid) continue;
      // the wall's thickness: its back face (wound the other way), in broken masonry
      const nx = -v[3], ny = -v[4], nz = -v[5];
      const backOf = (q: number) => { back[0] = v[q * STRIDE] - v[q * STRIDE + 3] * WALL; back[1] = v[q * STRIDE + 1] - v[q * STRIDE + 4] * WALL; back[2] = v[q * STRIDE + 2] - v[q * STRIDE + 5] * WALL; return back; };
      const backRgb = v[4] > 0.7 ? CEILING_RGB : BROKEN_RGB;
      for (const q of [0, 2, 1]) { const b = backOf(q); out.plain(b[0], b[1], b[2], nx, ny, nz, fi, INNER_MAT, backRgb); }
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        if (edges.get(ek(t, i, j)) !== 1) continue;
        const pix = v[i * STRIDE], piy = v[i * STRIDE + 1], piz = v[i * STRIDE + 2];
        const pjx = v[j * STRIDE], pjy = v[j * STRIDE + 1], pjz = v[j * STRIDE + 2];
        const bi = backOf(i).slice(), bj = backOf(j).slice();
        const ex = pjx - pix, ey = pjy - piy, ez = pjz - piz;
        let sx = ey * v[5] - ez * v[4], sy = ez * v[3] - ex * v[5], sz = ex * v[4] - ey * v[3];
        const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
        out.plain(pix, piy, piz, sx, sy, sz, fi); out.plain(bi[0], bi[1], bi[2], sx, sy, sz, fi); out.plain(pjx, pjy, pjz, sx, sy, sz, fi);
        out.plain(pjx, pjy, pjz, sx, sy, sz, fi); out.plain(bi[0], bi[1], bi[2], sx, sy, sz, fi); out.plain(bj[0], bj[1], bj[2], sx, sy, sz, fi);
      }
    }
    // its reach round its centre and its lowest point
    let reach = 0, low = Infinity;
    for (let k = first; k < out.n; k++) {
      const x = out.pos[k * 4], y = out.pos[k * 4 + 1], z = out.pos[k * 4 + 2];
      reach = Math.max(reach, Math.hypot(x - cx, y - cy, z - cz)); low = Math.min(low, y);
    }
    frags.push(cx, cy, cz, reach, low);
    fi++;
  }
  // the joins, as lists per fragment
  const links: Array<Set<number>> = Array.from({ length: fi }, () => new Set<number>());
  for (const cs of vertexCells.values()) if (cs.length > 1) for (const a of cs) for (const b of cs) if (a !== b) links[a].add(b);
  const start = new Int32Array(fi + 1);
  for (let i = 0; i < fi; i++) start[i + 1] = start[i] + links[i].size;
  const neighbours = new Int32Array(start[fi]);
  for (let i = 0; i < fi; i++) neighbours.set([...links[i]], start[i]);
  // the attached parts and furniture: each to the fragment of its cell, or the nearest one (a cell of furniture alone)
  const A = attached.rows, att = new Float32Array((A.length / ATTACHED) * ATTACH);
  for (let r = 0, k = 0; r < A.length; r += ATTACHED, k += ATTACH) {
    const x = A[r + 1], y = A[r + 2], z = A[r + 3];
    let f = fragOfCell.get(cellOf(x, y, z));
    if (f === undefined) {
      let bd = Infinity;
      for (let i = 0; i < fi; i++) {
        const d = (frags[i * 5] - x) ** 2 + (frags[i * 5 + 1] - y) ** 2 + (frags[i * 5 + 2] - z) ** 2;
        if (d < bd) { bd = d; f = i; }
      }
    }
    att[k] = A[r]; att[k + 1] = f ?? 0;
    for (let j = 1; j < ATTACHED; j++) att[k + 1 + j] = A[r + j];
  }
  return { ...out.done(), fragments: Float32Array.from(frags), fragmentCount: fi, start, neighbours, kinds: attached.kinds, attached: att };
}

/** The ruin's vertices in the building material's packed format, growing as it is written. */
class Writer {
  n = 0;
  pos = new Float32Array(4 * 8192);
  nrm = new Int8Array(4 * 8192);
  col = new Uint8Array(4 * 8192);
  fac = new Uint8Array(4 * 8192);
  fuv = new Int16Array(2 * 8192);
  frag = new Float32Array(8192);
  private oct = new Float32Array(2);
  private tag: number;
  constructor(tag: number) { this.tag = tag; }

  private grow(): void {
    if (this.n < this.pos.length / 4) return;
    const g = <A extends Float32Array | Int8Array | Uint8Array | Int16Array>(a: A): A => { const b = new (a.constructor as new (n: number) => A)(a.length * 2); b.set(a); return b; };
    this.pos = g(this.pos); this.nrm = g(this.nrm); this.col = g(this.col); this.fac = g(this.fac); this.fuv = g(this.fuv); this.frag = g(this.frag);
  }

  private base(x: number, y: number, z: number, nx: number, ny: number, nz: number, frag: number): number {
    this.grow();
    const i = this.n++;
    this.pos[i * 4] = x; this.pos[i * 4 + 1] = y; this.pos[i * 4 + 2] = z; this.pos[i * 4 + 3] = this.tag;
    this.frag[i] = frag;
    const l = Math.hypot(nx, ny, nz) || 1;
    octEncode(nx / l, ny / l, nz / l, this.oct);
    this.nrm[i * 4] = Math.round(this.oct[0] * 127); this.nrm[i * 4 + 1] = Math.round(this.oct[1] * 127);
    return i;
  }

  /** A face's corner as the building drew it. */
  vert(v: Float64Array, q: number, frag: number, mat: number, f0: number, f1: number, f2: number, f3: number): void {
    const o = q * STRIDE, i = this.base(v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5], frag);
    this.col[i * 4] = Math.round(v[o + 6]); this.col[i * 4 + 1] = Math.round(v[o + 7]); this.col[i * 4 + 2] = Math.round(v[o + 8]); this.col[i * 4 + 3] = mat;
    this.fac[i * 4] = f0; this.fac[i * 4 + 1] = f1; this.fac[i * 4 + 2] = f2; this.fac[i * 4 + 3] = f3;
    this.fuv[i * 2] = Math.max(-32767, Math.min(32767, Math.round(v[o + 9] / 512 * 32767)));
    this.fuv[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(v[o + 10] / 512 * 32767)));
  }

  /** A corner of broken masonry (the back and the cut sides): no facade, the concrete finish. */
  plain(x: number, y: number, z: number, nx: number, ny: number, nz: number, frag: number, mat = BROKEN_MAT, rgb = BROKEN_RGB): void {
    const i = this.base(x, y, z, nx, ny, nz, frag);
    this.col[i * 4] = (rgb >> 16) & 255; this.col[i * 4 + 1] = (rgb >> 8) & 255; this.col[i * 4 + 2] = rgb & 255; this.col[i * 4 + 3] = mat;
  }

  done(): Pick<RuinData, 'position' | 'normal' | 'color' | 'fac' | 'fuv' | 'frag'> {
    const n = this.n;
    return { position: this.pos.slice(0, n * 4), normal: this.nrm.slice(0, n * 4), color: this.col.slice(0, n * 4), fac: this.fac.slice(0, n * 4), fuv: this.fuv.slice(0, n * 2), frag: this.frag.slice(0, n) };
  }
}
