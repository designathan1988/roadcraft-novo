// Roadcraft's one tree style (`lowPolyTrees.ts`), built as prop meshes: a low-poly heart in shade, a faceted
// trunk and limbs, and foliage cards that face the camera in the vertex shader (their corner offsets ride in the
// `pext` attribute), cut by a leaf-clump texture drawn once at load. Palms are frond strips on the same texture.
// Every vertex: position, normal, pcol (linear colour + finish id), pext (atlas uv, billboard corner in metres).

import * as THREE from 'three/webgpu';
import { stream } from '../core/rng.ts';

/** Finishes shared with propMeshes.ts (PMAT): heart shading as foliage, cards as foliage cut by the leaf atlas. */
export const TREE_MAT = { Leaf: 1, Bark: 6, LeafCard: 26 } as const;

interface Tone { dark: THREE.Color; lit: THREE.Color }
const tone = (dark: number, lit: number): Tone => ({ dark: new THREE.Color(dark), lit: new THREE.Color(lit) });
// seen in the game's light (ACES), darker and a touch bluer than the lawn they stand on (Roadcraft's tones)
const LEAF = tone(0x24401c, 0x4f7a34);
const LEAF_TALL = tone(0x203a1e, 0x46703a);
const NEEDLE = tone(0x22402a, 0x4a7343);
const FROND = tone(0x3e6026, 0x7fa448);
const BARK = tone(0x4a3c2f, 0x7d6853);
const PALM_BARK = tone(0x5a4c3e, 0x948268);
const SHRUB = tone(0x223d1b, 0x4a6e32);
const HEDGE = tone(0x1f3618, 0x42602c);
// Roadcraft 4.0's blooms (lowPolyTrees.ts): the ipê's yellow and pink crowns, the flowering bush's tones
const BLOOM_YELLOW = tone(0xb8892a, 0xe6bd4c);
const BLOOM_PINK = tone(0x9a5078, 0xd88ab0);
const FLOWERS = [tone(0xb9b2a4, 0xe8e2d6), tone(0x9c4a68, 0xd0759a), tone(0x8e2f2f, 0xc4524c)];
const HEART_SHRINK = 0.62;


function noise3(x: number, y: number, z: number, seed: number): number {
  const hash = (i: number, j: number, k: number): number => {
    let h = Math.imul(i, 374_761_393) ^ Math.imul(j, 668_265_263) ^ Math.imul(k, 1_274_126_177) ^ Math.imul(seed, 2_246_822_519);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (k: number) => lerp(lerp(hash(xi, yi, k), hash(xi + 1, yi, k), sx), lerp(hash(xi, yi + 1, k), hash(xi + 1, yi + 1, k), sx), sy);
  return lerp(plane(zi), plane(zi + 1), sz);
}

type Occlusion = (p: THREE.Vector3) => number;
/** A tone chosen by position (the ipê's bloom over its green under-crown, a bush's flowers). */
type ToneAt = (p: THREE.Vector3) => Tone;
const OPEN: Occlusion = () => 1;
const crownShade = (bottom: number, top: number, radius: number): Occlusion => (p) => {
  const h = Math.min(1, Math.max(0, (p.y - bottom) / Math.max(1e-6, top - bottom)));
  const out = Math.min(1, Math.hypot(p.x, p.z) / Math.max(1e-6, radius));
  return (0.62 + 0.38 * h) * (0.85 + 0.15 * out);
};

/**
 * Flat triangles (each face its own normal and shade) and billboard cards, all in model units (scaled at the end).
 * The vertices go straight into flat arrays and the leaf points (where the cards hang) into typed columns: nothing is
 * allocated per triangle or per point while a model is built.
 */
class Builder {
  private pos: number[] = []; private nrm: number[] = []; private col: number[] = []; private ext: number[] = [];
  /** The leaf points: position, normal (3 each), the tone, the height up the crown (0..1) and the card size factor. */
  private leafP: number[] = []; private leafN: number[] = []; private leafTone: Tone[] = []; private leafH: number[] = []; private leafS: number[] = [];
  readonly rng: () => number;
  private readonly a = new THREE.Vector3(); private readonly b = new THREE.Vector3(); private readonly c3 = new THREE.Vector3();
  private readonly n = new THREE.Vector3(); private readonly e = new THREE.Vector3(); private readonly c = new THREE.Vector3();
  constructor(seed: number) { this.rng = stream(seed); }

  /** How many leaf points there are (a model with none gets no cards). */
  get leafCount(): number { return this.leafTone.length; }
  /** A leaf point laid by hand: where a card may hang, its normal (unit), tone, height up the crown and card size factor. */
  leaf(x: number, y: number, z: number, nx: number, ny: number, nz: number, tone: Tone, height: number, size = 1): void {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.leafP.push(x, y, z); this.leafN.push(nx / l, ny / l, nz / l); this.leafTone.push(tone); this.leafH.push(height); this.leafS.push(size);
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, mat: number, u = 0, v = 0, cx = 0, cy = 0): void {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.col.push(r, g, b, mat / 255); this.ext.push(u, v, cx, cy);
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, tt: Tone | ToneAt, mat: number, occ: Occlusion = OPEN, jitter = 0.15): void {
    this.n.subVectors(b, a).cross(this.e.subVectors(c, a)).normalize();
    this.c.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const t = typeof tt === 'function' ? tt(this.c) : tt;
    const k = Math.min(1, Math.max(0, 0.42 + 0.45 * this.n.y + (this.rng() - 0.5) * jitter));
    const l = occ(this.c);
    const r = (t.dark.r + (t.lit.r - t.dark.r) * k) * l, g = (t.dark.g + (t.lit.g - t.dark.g) * k) * l, bl = (t.dark.b + (t.lit.b - t.dark.b) * k) * l;
    this.vert(a.x, a.y, a.z, this.n.x, this.n.y, this.n.z, r, g, bl, mat);
    this.vert(b.x, b.y, b.z, this.n.x, this.n.y, this.n.z, r, g, bl, mat);
    this.vert(c.x, c.y, c.z, this.n.x, this.n.y, this.n.z, r, g, bl, mat);
  }

  /** `geo`'s triangles placed by `m`, each shaded on its own; `geo` is used up. */
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, t: Tone | ToneAt, mat: number, occ: Occlusion = OPEN, jitter = 0.15): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(m);
    const p = g.getAttribute('position');
    for (let i = 0; i + 2 < p.count; i += 3) {
      this.tri(this.a.fromBufferAttribute(p, i), this.b.fromBufferAttribute(p, i + 1), this.c3.fromBufferAttribute(p, i + 2), t, mat, occ, jitter);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
  }

  /** A lumpy crown mass; its heart drawn shrunk and in shade, every third vertex a place for a card. */
  mass(at: THREE.Vector3, radius: number, squash: THREE.Vector3, t: Tone | ToneAt, seed: number, rough: number, occ: Occlusion, detail = 1, floor = -Infinity): void {
    const solid = new THREE.IcosahedronGeometry(1, detail);
    const position = solid.getAttribute('position');
    const p = this.a, n = this.b;
    const top = radius * squash.y;
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const big = noise3(p.x * 1.1 + seed * 3.1, p.y * 1.1, p.z * 1.1, seed);
      const small = noise3(p.x * 2.6, p.y * 2.6 + seed * 1.7, p.z * 2.6, seed + 17);
      p.multiplyScalar(radius * (1 + big * rough + small * rough * 0.3)).multiply(squash).add(at);
      // a floor flattens what hangs below it (a bush sits on the ground)
      if (p.y < floor) p.y = floor + (p.y - floor) * 0.2;
      position.setXYZ(i, p.x, p.y, p.z);
      if (i % 3 === 0) {
        n.subVectors(p, at).normalize();
        this.leafP.push(p.x, p.y, p.z); this.leafN.push(n.x, n.y, n.z);
        this.leafTone.push(typeof t === 'function' ? t(p) : t);
        this.leafH.push(Math.min(1, Math.max(0, (p.y - (at.y - top)) / Math.max(1e-6, 2 * top))));
        this.leafS.push(1);
      }
    }
    const shrink = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z).multiply(new THREE.Matrix4().makeScale(HEART_SHRINK, HEART_SHRINK, HEART_SHRINK))
      .multiply(new THREE.Matrix4().makeTranslation(-at.x, -at.y, -at.z));
    this.add(solid, shrink, t, TREE_MAT.Leaf, (c) => occ(c) * 0.5);
  }

  /** A palm frond: a strip along the spine, uv on the frond half of the atlas. */
  frond(spine: THREE.Vector3[], side: THREE.Vector3, width: number, fold: number, t: Tone, occ: Occlusion): void {
    const rows: Array<{ p: THREE.Vector3[]; n: THREE.Vector3[]; c: [number, number, number] }> = [];
    const along = new THREE.Vector3(), up = new THREE.Vector3();
    for (let i = 0; i < spine.length; i++) {
      const p = spine[i];
      along.subVectors(spine[Math.min(spine.length - 1, i + 1)], spine[Math.max(0, i - 1)]).normalize();
      up.crossVectors(side, along).normalize();
      if (up.y < 0) up.negate();
      const drop = new THREE.Vector3(0, -width * fold, 0);
      const k = Math.min(1, Math.max(0, 0.5 + 0.3 * up.y + (this.rng() - 0.5) * 0.1)) * occ(p);
      const tip = (s: number) => up.clone().addScaledVector(side, s * 0.45).normalize();
      rows.push({
        p: [p.clone().addScaledVector(side, -width).add(drop), p.clone(), p.clone().addScaledVector(side, width).add(drop)],
        n: [tip(-1), up.clone(), tip(1)],
        c: [t.dark.r + (t.lit.r - t.dark.r) * k, t.dark.g + (t.lit.g - t.dark.g) * k, t.dark.b + (t.lit.b - t.dark.b) * k],
      });
    }
    const corner = (row: number, col: number) => {
      const r = rows[row], p = r.p[col], q = r.n[col];
      this.vert(p.x, p.y, p.z, q.x, q.y, q.z, r.c[0], r.c[1], r.c[2], TREE_MAT.LeafCard, 0.5 + col * 0.25, row / (rows.length - 1));
    };
    for (let i = 0; i + 1 < rows.length; i++) for (const col of [0, 1]) {
      corner(i, col); corner(i, col + 1); corner(i + 1, col + 1);
      corner(i, col); corner(i + 1, col + 1); corner(i + 1, col);
    }
  }

  /** The geometry, with `count` cards of `size` on the leaf points; scaled so the tree is `height` m tall. */
  finish(count: number, size: number, height: number): THREE.BufferGeometry {
    let top = 0, bottom = Infinity;
    for (let i = 1; i < this.pos.length; i += 3) { top = Math.max(top, this.pos[i]); bottom = Math.min(bottom, this.pos[i]); }
    // the cards: which leaf point, its size and its centre (pushed out along the point's normal), drawn once the
    // model's scale is known (the top rises with the highest card)
    const leaves = this.leafCount, cards = leaves ? count : 0;
    const at = new Int32Array(cards), sz = new Float64Array(cards), cx = new Float64Array(cards * 3);
    for (let k = 0; k < cards; k++) {
      const i = Math.floor(this.rng() * leaves);
      const s = size * this.leafS[i] * (0.75 + this.rng() * 0.5), out = s * (0.1 + this.rng() * 0.2);
      at[k] = i; sz[k] = s;
      cx[k * 3] = this.leafP[i * 3] + this.leafN[i * 3] * out;
      cx[k * 3 + 1] = this.leafP[i * 3 + 1] + this.leafN[i * 3 + 1] * out;
      cx[k * 3 + 2] = this.leafP[i * 3 + 2] + this.leafN[i * 3 + 2] * out;
      top = Math.max(top, cx[k * 3 + 1] + s * 0.45);
    }
    const k = height / Math.max(1e-6, top - Math.min(0, bottom));
    for (let q = 0; q < cards; q++) {
      const i = at[q], s = sz[q];
      const roll = this.rng() * Math.PI * 2, cr = Math.cos(roll), sr = Math.sin(roll);
      const k0 = Math.min(1, 0.45 + 0.55 * this.leafH[i]) * (0.88 + this.rng() * 0.24);
      const t = this.leafTone[i];
      const r = t.dark.r + (t.lit.r - t.dark.r) * k0, g = t.dark.g + (t.lit.g - t.dark.g) * k0, b = t.dark.b + (t.lit.b - t.dark.b) * k0;
      const nx = this.leafN[i * 3], ny = this.leafN[i * 3 + 1] * 0.8 + 0.2, nz = this.leafN[i * 3 + 2], nl = Math.hypot(nx, ny, nz) || 1;
      const x = cx[q * 3], y = cx[q * 3 + 1], z = cx[q * 3 + 2];
      // the corners' offsets are in metres already (scaled by k); the centre is scaled below with everything else
      const corner = (u: number, w: number): void => {
        const ou = (u - 0.5) * s * k, ow = (w - 0.5) * s * k;
        this.vert(x, y, z, nx / nl, ny / nl, nz / nl, r, g, b, TREE_MAT.LeafCard, u * 0.5, w, ou * cr - ow * sr, ou * sr + ow * cr);
      };
      corner(0, 0); corner(1, 0); corner(1, 1);
      corner(0, 0); corner(1, 1); corner(0, 1);
    }
    for (let i = 0; i < this.pos.length; i++) this.pos[i] *= k;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('pcol', new THREE.BufferAttribute(new Float32Array(this.col), 4));
    g.setAttribute('pext', new THREE.BufferAttribute(new Float32Array(this.ext), 4));
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
function along(from: THREE.Vector3, to: THREE.Vector3): THREE.Matrix4 {
  const dir = new THREE.Vector3().subVectors(to, from);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  return new THREE.Matrix4().compose(new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1))
    .multiply(new THREE.Matrix4().makeScale(1, dir.length(), 1));
}
const trunk = (b: Builder, top: THREE.Vector3, r0: number, r1: number, t: Tone, sides = 6) =>
  b.add(new THREE.CylinderGeometry(r1, r0, 1, sides, 1, true), along(new THREE.Vector3(), top), t, TREE_MAT.Bark, OPEN, 0.1);
function limbs(b: Builder, from: THREE.Vector3, count: number, reach: number, rise: number, r0: number): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + b.rng() * 0.7;
    const to = new THREE.Vector3(from.x + Math.cos(a) * reach * (0.8 + b.rng() * 0.3), from.y + rise * (0.8 + b.rng() * 0.4), from.z + Math.sin(a) * reach * (0.8 + b.rng() * 0.3));
    b.add(new THREE.CylinderGeometry(r0 * 0.45, r0, 1, 5, 1, true), along(from, to), BARK, TREE_MAT.Bark, OPEN, 0.1);
  }
}

/** Level of detail of a tree: 0 near (cards dense, limbs), 1 mid (coarse heart, fewer and larger cards). */
export type TreeLod = 0 | 1;
const cards = (lod: TreeLod, n: number, s: number): [number, number] => (lod === 0 ? [n, s] : [Math.round(n * 0.35), s * 1.55]);

/** The mixed broadleaf: a tall, narrow crown of cards on a clear stem (~9 m). */
export function mixedTree(lod: TreeLod, seed = 11): THREE.BufferGeometry {
  const b = new Builder(seed);
  const top = new THREE.Vector3((b.rng() - 0.5) * 0.03, 0.4, (b.rng() - 0.5) * 0.03);
  trunk(b, top, 0.05, 0.032, BARK);
  if (lod === 0) limbs(b, new THREE.Vector3(top.x, top.y - 0.05, top.z), 2, 0.1, 0.16, 0.02);
  b.mass(new THREE.Vector3(top.x, 0.66, top.z), 0.14, new THREE.Vector3(1, 1.7, 1), LEAF_TALL, seed, 0.2, crownShade(0.26, 1.0, 0.24), lod === 0 ? 1 : 0);
  return b.finish(...cards(lod, 34, 0.34), 9);
}

/** The oak (shade tree): a broad crown of cards over a lumpy heart on a short, stout trunk (~8 m). */
export function oakTree(lod: TreeLod, seed = 23): THREE.BufferGeometry {
  const b = new Builder(seed);
  const top = new THREE.Vector3((b.rng() - 0.5) * 0.04, 0.42, (b.rng() - 0.5) * 0.04);
  trunk(b, top, 0.062, 0.04, BARK);
  if (lod === 0) limbs(b, new THREE.Vector3(top.x, top.y - 0.06, top.z), 3, 0.16, 0.16, 0.024);
  const shade = crownShade(0.3, 0.98, 0.34);
  b.mass(new THREE.Vector3(top.x, 0.62, top.z), 0.19, new THREE.Vector3(1.05, 0.9, 1.05), LEAF, seed, 0.22, shade, lod === 0 ? 1 : 0);
  const a = b.rng() * Math.PI * 2;
  b.mass(new THREE.Vector3(top.x + Math.cos(a) * 0.13, 0.64, top.z + Math.sin(a) * 0.13), 0.13, new THREE.Vector3(1, 0.88, 1), LEAF, seed + 5, 0.2, shade, lod === 0 ? 1 : 0);
  return b.finish(...cards(lod, 40, 0.44), 8);
}

/** The cypress: a thin dark core under needle-green cards in a narrow cone (~10 m). */
export function cypressTree(lod: TreeLod, seed = 37): THREE.BufferGeometry {
  const b = new Builder(seed);
  trunk(b, new THREE.Vector3(0, 0.2, 0), 0.034, 0.024, BARK);
  const base = 0.16, height = 0.8, core = 0.045, crown = 0.16;
  const shade: Occlusion = (p) => (0.66 + 0.34 * Math.min(1, Math.max(0, (p.y - base) / height))) * 0.5;
  b.add(new THREE.ConeGeometry(core, height, 6, 1, true), new THREE.Matrix4().makeTranslation(0, base + height / 2, 0), NEEDLE, TREE_MAT.Leaf, shade, 0.12);
  for (let i = 0; i < 120; i++) {
    const t = Math.pow(b.rng(), 1.3);
    const y = base + 0.03 + t * height * 0.9;
    const r = (crown * (1 - t) + 0.02) * (0.55 + 0.45 * b.rng());
    const a = b.rng() * Math.PI * 2;
    b.leaf(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(a), 0.35, Math.sin(a), NEEDLE, t, 1 - 0.6 * t);
  }
  return b.finish(...cards(lod, 70, 0.3), 10);
}

/** The palm: a slender, leaning ringed trunk, a crownshaft and arching frond strips (~10 m). */
export function palmTree(lod: TreeLod, seed = 41): THREE.BufferGeometry {
  const b = new Builder(seed);
  const lean = 0.16, turn = b.rng() * Math.PI * 2;
  const leanDir = new THREE.Vector3(Math.cos(turn), 0, Math.sin(turn));
  const at = (t: number) => new THREE.Vector3(0, 0.8 * t, 0).addScaledVector(leanDir, lean * t * t);
  const rings = lod === 0 ? 5 : 2;
  for (let s = 0; s < rings; s++) {
    const r = 0.036 * (1 - 0.3 * (s / rings));
    b.add(new THREE.CylinderGeometry(r * 0.95, r * 1.02, 1, lod === 0 ? 8 : 5, 1, true), along(at(s / rings), at((s + 1.02) / rings)), PALM_BARK, TREE_MAT.Bark, OPEN, 0.06);
  }
  const crown = at(1);
  b.add(new THREE.IcosahedronGeometry(0.024, lod === 0 ? 1 : 0), new THREE.Matrix4().makeScale(1, 1.6, 1).premultiply(new THREE.Matrix4().makeTranslation(crown.x, crown.y - 0.012, crown.z)), PALM_BARK, TREE_MAT.Bark, () => 0.8, 0.1);
  const shade: Occlusion = (p) => 0.7 + 0.3 * Math.min(1, Math.max(0, (p.y - crown.y + 0.25) / 0.35));
  const fronds = lod === 0 ? 10 : 7, steps = lod === 0 ? 6 : 3;
  for (let k = 0; k < fronds; k++) {
    const young = k >= fronds - 2;
    const a = (k / fronds) * Math.PI * 2 * (young ? 2.7 : 1) + b.rng() * 0.4;
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    const length = (young ? 0.32 : 0.46) + b.rng() * 0.08;
    const lift = young ? 1.05 + b.rng() * 0.2 : 0.35 + b.rng() * 0.35;
    const bend = young ? 0.7 : 1.5 + b.rng() * 0.4;
    const spine = [crown.clone()];
    for (let i = 1; i <= steps; i++) {
      const angle = lift - (i / steps) * bend;
      spine.push(spine[i - 1].clone().add(new THREE.Vector3().addScaledVector(out, Math.cos(angle)).setY(Math.sin(angle)).multiplyScalar(length / steps)));
    }
    b.frond(spine, side, length * 0.14, young ? 0.35 : 0.7, FROND, shade);
  }
  return b.finish(0, 0, 10);
}

/** A shrub: a squat mass under cards (~1.4 m). */
export function shrub(lod: TreeLod, seed = 53): THREE.BufferGeometry {
  const b = new Builder(seed);
  b.mass(new THREE.Vector3(0, 0.42, 0), 0.4, new THREE.Vector3(1.2, 0.85, 1.2), SHRUB, seed, 0.25, crownShade(0, 0.8, 0.5), lod === 0 ? 1 : 0);
  return b.finish(...cards(lod, 26, 0.42), 1.4);
}

/**
 * Leaf atlas, drawn once: left half a clump of leaves (the cards), right half a frond's leaflets (palms). White-ish
 * with shading (it multiplies the vertex tone), alpha = the leaves.
 */
export function buildLeafAtlas(): THREE.Texture {
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const rng = stream(7);
  const leaf = (x: number, y: number, len: number, wid: number, ang: number, shade: number) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    const v = Math.round(150 + 105 * shade);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath(); g.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  };
  // clump: leaves scattered in a disc, lighter toward the top
  for (let i = 0; i < 260; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 104;
    const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
    leaf(x, y, 9 + rng() * 7, 4 + rng() * 2.5, rng() * Math.PI, Math.min(1, Math.max(0, 0.75 - (y - 128) / 260 + (rng() - 0.5) * 0.4)));
  }
  // frond: a rachis down the middle of the right half (v along it), leaflets slanting out to both sides
  g.fillStyle = 'rgb(170,170,150)';
  g.fillRect(256 + 124, 0, 8, H);
  for (let y = 4; y < H; y += 7) {
    const len = 52 * Math.sin(Math.PI * Math.min(1, (y + 20) / (H + 20)));
    for (const s of [-1, 1]) leaf(384 + s * len * 0.55, y + 6, len * 0.55, 3.2, s * 0.35 + Math.PI / 2 * 0 + (s < 0 ? Math.PI : 0) - s * 0.35, 0.55 + rng() * 0.4);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  return t;
}

/**
 * The ipê (Roadcraft 4.0 `lowPolyTrees.ts`): four limbs under a wide, flat crown that blooms above a green
 * under-crown, in yellow or pink (~9 m).
 */
export function ipeTree(lod: TreeLod, bloom: 'yellow' | 'pink', seed = 61): THREE.BufferGeometry {
  const b = new Builder(seed);
  const top = new THREE.Vector3((b.rng() - 0.5) * 0.03, 0.44, (b.rng() - 0.5) * 0.03);
  trunk(b, top, 0.058, 0.036, BARK);
  if (lod === 0) limbs(b, new THREE.Vector3(top.x, top.y - 0.05, top.z), 4, 0.2, 0.14, 0.022);
  const flowers = bloom === 'yellow' ? BLOOM_YELLOW : BLOOM_PINK;
  const toneAt: ToneAt = (p) => (p.y < 0.52 ? LEAF : flowers);
  b.mass(new THREE.Vector3(top.x, 0.62, top.z), 0.2, new THREE.Vector3(1.25, 0.65, 1.25), toneAt, seed, 0.22, crownShade(0.36, 0.86, 0.3), lod === 0 ? 1 : 0);
  return b.finish(...cards(lod, 54, 0.46), 9);
}

/** A flowering bush: a wide, low mass on the ground, flowers on its top (~1.5 m). */
export function floweringBush(lod: TreeLod, seed = 67): THREE.BufferGeometry {
  const b = new Builder(seed);
  const rng = stream(seed + 3);
  const flower = FLOWERS[seed % FLOWERS.length];
  const toneAt: ToneAt = (p) => (p.y > 0.5 && rng() < 0.3 ? flower : SHRUB);
  b.mass(new THREE.Vector3(0, 0.42, 0), 0.36, new THREE.Vector3(1.5, 1, 1.3), toneAt, seed, 0.25, crownShade(0, 0.8, 0.55), lod === 0 ? 1 : 0, 0);
  return b.finish(...cards(lod, 16, 0.62), 1.5);
}

/** A hedge: a long, smooth, dark mass (~1.3 m tall, 2.5 × 1 m across). */
export function hedge(lod: TreeLod, seed = 71): THREE.BufferGeometry {
  const b = new Builder(seed);
  b.mass(new THREE.Vector3(0, 0.46, 0), 0.4, new THREE.Vector3(2, 1, 0.8), HEDGE, seed, 0.08, crownShade(0, 0.9, 0.8), lod === 0 ? 1 : 0, 0);
  return b.finish(...cards(lod, 20, 0.56), 1.3);
}
