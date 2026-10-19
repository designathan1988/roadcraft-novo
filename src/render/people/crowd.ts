// The people on screen: MakeHuman bodies cooked offline (`tools/cook-people.mjs`), skinned on the GPU from bone
// palettes, one draw call per level of detail for every variation at once.
//
// Vertex pulling: the index, the vertices and the palettes live in storage buffers; each instance draws the padded
// triangle count of its level (the variations' shorter lists end in degenerate triangles). Per person the CPU only
// reads the pose and writes four vec4s; animation time, frame blending, skinning and colours are in the shader.
//
// Levels by height on screen: full mesh above ~60 px, a simplified one down to 15 px, a coarse one down to 3 px,
// nothing below. Shadows only from level 0 (within ~40 m at 1080p, inside the vehicles' 90 m), cast with the cheaper
// level-1 mesh: each level-0 person also gets a shadow-only level-1 instance (its own shadow position node).

import * as THREE from 'three/webgpu';
import { T, withPrevious, type Node } from '../tsl.ts';
import { rainU } from '../weather.ts';
import { CLIP, CLIP_PROP, REGION, checkCooked, type CookedPeople } from './format.ts';
import { hash32, pickLook, type LookChoice } from './looks.ts';
import { MOTO_PELVIS, aboard, seatsOf } from './occupants.ts';
import { PeopleCreator, creatorCatalog, type PlacedPerson } from './creator.ts';

const {
  Fn, attribute, storage, uniformArray, vertexIndex, uint, float, int, vec3, vec4, cos, sin, floor, fract, mod, min, max,
  select, mix, normalize, transformNormalToView, varyingProperty, unpackUnorm4x8, unpackUnorm2x16, sRGBTransferEOTF,
  interleavedGradientNoise, screenCoordinate, vec2, time, abs, dot, clamp,
} = T;

/** Person height on screen (px) above which level 0 is drawn, with a dithered band above it. */
const LOD0_PX = 60;
const LOD1_PX = 15;
const LOD_BAND_PX = 10;
const LOD2_BAND_PX = 4;
/** Shadows only this near, as the vehicles'. */
const SHADOW_NEAR = 90;
/** Below this nothing is drawn. */
const MIN_PX = 3;
const CAP = [2048, 8192, 16384];

/** Clothing colours a passer-by may be tinted to (sRGB). */
const CLOTHES = [0x1d2433, 0x2b2b2e, 0x6d7177, 0xe6e4df, 0x3b5a8a, 0x7d2a2a, 0x2f5a3b, 0xb79c74, 0x5a3d6e, 0xcf7a2c, 0x8a8f5a, 0x9a3c5a, 0x2d6f7a, 0xd8c9a3, 0x4a4f8c, 0xc23b32];
const HAIR = [0x16110d, 0x2a1b12, 0x4a2f1c, 0x6b4426, 0x1a1a1a, 0x8a5a2b, 0xb08850, 0x3b2a20];
const GREY = [0xb9b6b0, 0x9b9893, 0xd8d6d0, 0x7e7b76];
const PROPS = [0x161618, 0xece9e2, 0x8a6a4a, 0xd8d4c8, 0x1b2a4a, 0x7a1f2b, 0x2c4a2c, 0x111111];

export class PeopleRenderer {
  readonly group = new THREE.Group();
  /** Cooked and on the GPU: until then (or without WebGPU) the vehicles keep drawing the old figures. */
  ready = false;
  meta: CookedPeople | null = null;
  private meshes: THREE.Mesh[] = [];
  private geos: THREE.InstancedBufferGeometry[] = [];
  private attrs: Array<{ pos: THREE.InstancedBufferAttribute; prev: THREE.InstancedBufferAttribute; info: THREE.InstancedBufferAttribute; anim: THREE.InstancedBufferAttribute }> = [];
  private counts = [0, 0, 0];
  /** px of height per metre at distance 1. */
  private pxScale = 1000;
  private readonly look: LookChoice = { variation: 0, clip: 0, rate: 1, phase: 0, hash: 0 };
  /** The people the player placed (the creator); null until the cooked people load. */
  creator: PeopleCreator | null = null;
  /** What the creator's screen can offer (outfits, colours, modes), once loaded. */
  catalog() { return this.meta ? creatorCatalog(this.meta) : null; }
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly eye = new THREE.Vector3();
  private lastT = 0;
  private readonly visible = (x: number, y: number, z: number, r: number) => { this.sphere.center.set(x, y, z); this.sphere.radius = r; return this.frustum.intersectsSphere(this.sphere); };
  private readonly drawPlaced = (p: PlacedPerson) => {
    const dist = Math.hypot(p.x - this.eye.x, p.y + 1 - this.eye.y, p.z - this.eye.z);
    const l = this.look;
    l.variation = p.variation; l.clip = p.clip; l.hash = p.hash; l.rate = 1; l.phase = ((p.hash >>> 7) & 1023) / 1024;
    this.levels(1.7 * p.scale * this.pxScale / Math.max(0.5, dist), dist, p.x, p.y, p.z, p.yaw, p.px, p.y, p.pz, p.pyaw, l, 1, p.scale, 0);
  };
  /** Instances drawn last frame per level (for `stats`). */
  readonly drawn = [0, 0, 0];

  /** Fetches the cooked people and builds the two levels; resolves false when they cannot be drawn here. */
  async load(): Promise<boolean> {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (!gpu || !(await gpu.requestAdapter())) return false;
      const [metaRes, binRes] = await Promise.all([fetch('cooked/people/people.json'), fetch('cooked/people/people.bin')]);
      if (!metaRes.ok || !binRes.ok) throw new Error(`cooked people missing (${metaRes.status}, ${binRes.status})`);
      const meta = (await metaRes.json()) as CookedPeople;
      const buf = await binRes.arrayBuffer();
      const problem = checkCooked(meta, buf.byteLength);
      if (problem) throw new Error(problem);
      this.build(meta, buf);
      this.meta = meta;
      this.creator = new PeopleCreator(meta);
      this.ready = true;
      this.warmup();
      return true;
    } catch (e) {
      console.error('[people] the cooked people could not be loaded; drawing the simple figures', e);
      return false;
    }
  }

  private build(meta: CookedPeople, buf: ArrayBuffer): void {
    const L = meta.layout;
    const sb = (arr: Float32Array | Uint32Array, item: number) => new THREE.StorageBufferAttribute(arr, item);
    const vpos = storage(sb(new Float32Array(buf, L.vpos.byteOffset, L.vpos.count), 4), 'vec4', meta.vertices).toReadOnly();
    const vattr = storage(sb(new Uint32Array(buf, L.vattr.byteOffset, L.vattr.count), 4), 'uvec4', meta.vertices).toReadOnly();
    const index = storage(sb(new Uint32Array(buf, L.index.byteOffset, L.index.count), 1), 'uint', L.index.count).toReadOnly();
    const pal = storage(sb(new Float32Array(buf, L.palette.byteOffset, L.palette.count), 4), 'vec4', L.palette.count / 4).toReadOnly();
    const NB = meta.bones.length;
    const varLods = [0, 1, 2].map((l) => uniformArray(meta.variations.map((v) => new THREE.Vector4(v.lod[l][0], v.lod[l][1], 0, 0)), 'vec4'));
    const bandOf = { child: 0, young: 1, adult: 2, senior: 3 } as const;
    const varMeta = uniformArray(meta.variations.map((v) => new THREE.Vector4(v.paletteStart, v.clipSet, bandOf[v.band], v.sex === 'male' ? 1 : 0)), 'vec4');
    const clips = uniformArray(meta.clipSets.flatMap((set) => Array.from({ length: 16 }, (_, i) => {
      const c = set[i];
      return c ? new THREE.Vector4(c.start, c.frames, c.fps, 0) : new THREE.Vector4(0, 1, 1, 0);
    })), 'vec4');
    const clipProp = uniformArray(Array.from({ length: 16 }, (_, i) => CLIP_PROP[i] ?? 0), 'float');
    const colors = (list: number[]) => uniformArray(list.map((c) => new THREE.Color(c)), 'color');
    const clothesU = colors(CLOTHES), hairU = colors(HAIR), greyU = colors(GREY), propU = colors(PROPS);

    for (let lod = 0; lod < 3; lod++) {
      const tris = meta.maxTris[lod];
      const g = new THREE.InstancedBufferGeometry();
      // only its count matters: the vertex shader pulls everything from the storage buffers
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris * 3 * 3), 3));
      const cap = CAP[lod];
      const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
      const a = { pos: mk(), prev: mk(), info: mk(), anim: mk() };
      g.setAttribute('ipos', a.pos); g.setAttribute('iprev', a.prev); g.setAttribute('iinfo', a.info); g.setAttribute('ianim', a.anim);
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      this.attrs.push(a);
      this.geos.push(g);

      const m = new THREE.MeshStandardNodeMaterial();
      const ipos = attribute('ipos', 'vec4'), iprev = attribute('iprev', 'vec4'), info = attribute('iinfo', 'vec4'), anim = attribute('ianim', 'vec4');
      const vN = varyingProperty('vec3', 'vPersonN');
      const vC = varyingProperty('vec3', 'vPersonC');
      const local = varyingProperty('vec3', 'vPersonLocal');
      // info.z: level fade (2 = shadow only); info.w: opacity, + 2 when it casts a shadow
      const position = (shadow: boolean) => Fn(() => {
        const code = uint(info.y);
        const vari = code.bitAnd(uint(63));
        const clip = code.shiftRight(uint(6)).bitAnd(uint(15));
        const vl = varLods[lod].element(vari);
        const start = uint(vl.x), count = uint(vl.y);
        const k = uint(vertexIndex);
        const valid = k.lessThan(count.mul(uint(3)));
        const vi = index.element(start.add(min(k, count.mul(uint(3)).sub(uint(1)))));
        const vp = vpos.element(vi).toVar();
        const va = vattr.element(vi).toVar();
        const region = float(va.y.shiftRight(uint(24)));
        const prop = clipProp.element(int(clip));
        const pass = shadow ? info.w.greaterThan(1.5) : info.z.lessThan(1.5);
        const shown = valid.and(pass).and(region.lessThan(7.5).or(abs(region.sub(prop)).lessThan(0.5)));
        // animation: frame from time, blended with the next
        const vm = varMeta.element(vari);
        const ct = clips.element(int(vm.y.mul(16).add(float(clip))));
        const f = mod(time.mul(ct.z).mul(anim.y).add(anim.x.mul(ct.y)), ct.y);
        const f0 = floor(f), a1 = fract(f);
        const f1 = mod(f0.add(1), ct.y);
        const row0 = uint(vm.x.add(ct.x).add(f0)).mul(uint(NB));
        const row1 = uint(vm.x.add(ct.x).add(f1)).mul(uint(NB));
        const wts = unpackUnorm4x8(va.w);
        const p4 = vec4(vp.xyz, 1);
        const nOct = unpackUnorm2x16(va.x).mul(2).sub(1);
        const n0 = vec3(nOct.x, nOct.y, float(1).sub(abs(nOct.x)).sub(abs(nOct.y))).toVar();
        const tz = max(n0.z.negate(), float(0));
        n0.x.addAssign(select(n0.x.greaterThanEqual(0), tz.negate(), tz));
        n0.y.addAssign(select(n0.y.greaterThanEqual(0), tz.negate(), tz));
        const pos = vec3(0).toVar(), nrm = vec3(0).toVar();
        for (let i = 0; i < 4; i++) {
          const j = va.z.shiftRight(uint(i * 8)).bitAnd(uint(255));
          const w = wts.element(int(i));
          const b0 = row0.add(j).mul(uint(3)), b1 = row1.add(j).mul(uint(3));
          const r0 = mix(pal.element(b0), pal.element(b1), a1);
          const r1 = mix(pal.element(b0.add(uint(1))), pal.element(b1.add(uint(1))), a1);
          const r2 = mix(pal.element(b0.add(uint(2))), pal.element(b1.add(uint(2))), a1);
          pos.addAssign(vec3(dot(r0, p4), dot(r1, p4), dot(r2, p4)).mul(w));
          nrm.addAssign(vec3(dot(r0.xyz, n0), dot(r1.xyz, n0), dot(r2.xyz, n0)).mul(w));
        }
        // feet on the slope: the legs follow the ground's rise along the heading (anim.w), the body stays upright
        const legs = clamp(float(1).sub(pos.y.div(0.9)), 0, 1);
        const sloped = vec3(pos.x, pos.y.add(anim.w.mul(pos.z).mul(legs)), pos.z);
        const p = select(shown, sloped.mul(anim.z), vec3(0));
        local.assign(p);
        const c = cos(ipos.w), s = sin(ipos.w);
        vN.assign(normalize(vec3(nrm.x.mul(c).add(nrm.z.mul(s)), nrm.y, nrm.x.negate().mul(s).add(nrm.z.mul(c)))));
        // colour: the texture's, tinted per person by region
        const tex = sRGBTransferEOTF(unpackUnorm4x8(va.y).xyz);
        const h = uint(info.x);
        const pick = (u: Node, bits: number, n: number) => u.element(int(h.shiftRight(uint(bits)).mod(uint(n))));
        const detail = clamp(vp.w, 0.25, 2.2);
        const tinted = select(h.bitAnd(uint(3)).notEqual(uint(0)), mix(tex, pick(clothesU, 4, CLOTHES.length).mul(detail), 0.85), tex);
        const tintedB = select(h.shiftRight(uint(2)).bitAnd(uint(3)).notEqual(uint(0)), mix(tex, pick(clothesU, 9, CLOTHES.length).mul(detail), 0.85), tex);
        const hairC = select(vm.z.greaterThan(2.5).and(h.shiftRight(uint(14)).bitAnd(uint(3)).notEqual(uint(0))), pick(greyU, 16, GREY.length), pick(hairU, 18, HAIR.length)).mul(clamp(vp.w, 0.45, 1.6));
        const skinC = tex.mul(float(h.shiftRight(uint(21)).bitAnd(uint(7))).mul(0.04).add(0.86));
        const isR = (r: number) => abs(region.sub(r)).lessThan(0.5);
        const propC = pick(propU, 6, PROPS.length).mul(0.8).add(tex.mul(0.2));
        const col = select(isR(REGION.skin), skinC, select(isR(REGION.hair), hairC, select(isR(REGION.top), tinted, select(isR(REGION.bottom), tintedB,
          select(isR(REGION.bag).or(isR(REGION.umbrella)).or(isR(REGION.helmet)), propC, tex)))));
        vC.assign(col);
        return vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.x.negate().mul(s).add(p.z.mul(c))).add(ipos.xyz);
      })();
      m.positionNode = position(false);
      if (lod === 1) m.castShadowPositionNode = position(true);
      const pc = cos(iprev.w), ps = sin(iprev.w);
      withPrevious(m, vec3(local.x.mul(pc).add(local.z.mul(ps)), local.y, local.x.negate().mul(ps).add(local.z.mul(pc))).add(iprev.xyz));
      m.normalNode = transformNormalToView(normalize(vN));
      m.colorNode = vec4(vC, 1);
      m.roughnessNode = float(0.82);
      m.metalnessNode = float(0);
      // levels and appearing by complementary dithering, as the vehicles (no transparency)
      const n = interleavedGradientNoise(screenCoordinate.xy);
      const fade = info.z;
      const lodOk = select(fade.greaterThanEqual(0), n.lessThan(fade), n.greaterThanEqual(fade.negate().sub(1)));
      const alphaOk = info.w.sub(select(info.w.greaterThan(1.5), float(2), float(0))).greaterThan(interleavedGradientNoise(screenCoordinate.xy.add(vec2(23.0, 41.0))));
      m.maskNode = lodOk.and(alphaOk);
      m.maskShadowNode = alphaOk;
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.castShadow = lod === 1;
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Starts a frame: `camera` gives the scale from metres to pixels. */
  begin(camera: THREE.Camera): void {
    this.counts.fill(0);
    const e = (camera as THREE.PerspectiveCamera).projectionMatrix.elements;
    this.pxScale = e[5] * (typeof innerHeight === 'number' ? innerHeight : 1080) / 2;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
  }

  /**
   * One person from the pose buffer (record at `o` of `d`, interpolated `x..yaw`, previous frame `px..pyaw`).
   * `dtMs`: the simulation step, for the speed. Returns false when nothing was drawn (too small on screen).
   */
  push(d: Float32Array, o: number, x: number, y: number, z: number, yaw: number, px: number, py: number, pz: number, pyaw: number, dist: number, dtMs: number, bike: boolean): boolean {
    const m = this.meta!;
    const px1 = 1.7 * this.pxScale / Math.max(0.5, dist);
    if (px1 < MIN_PX) return false;
    const speed = Math.hypot(d[o + 4] - d[o], d[o + 6] - d[o + 2]) / Math.max(1e-3, dtMs / 1000);
    const info = d[o + 8];
    const l = pickLook(info, speed, bike, rainU.value as number, m, this.look, d[o + 10]);
    const alpha = d[o + 9];
    // rise of the ground along the walk (the simulation's heights), for the feet
    const run = Math.hypot(d[o + 4] - d[o], d[o + 6] - d[o + 2]);
    const slope = run > 0.05 && !bike ? Math.max(-0.4, Math.min(0.4, (d[o + 5] - d[o + 1]) / run)) : 0;
    this.levels(px1, dist, x, y, z, yaw, px, py, pz, pyaw, l, alpha, 1, slope);
    return true;
  }

  /**
   * People in closed cabins (cars, buses, trucks) are drawn only when the vehicles can be seen into: the vehicles'
   * glass is opaque today and carries silhouettes; the vehicles' renderer sets this once its glass shows the inside.
   */
  seatedInCabins = false;
  /** Seated people nearer than this (they are small inside a cabin). */
  static readonly OCCUPANT_NEAR = 45;

  /**
   * The people aboard a vehicle of the pose buffer: the motorcycle's rider always, the cabins' driver and
   * passengers (as many as the pose's light bits say) when `seatedInCabins`.
   */
  occupants(kind: number, style: number, x: number, y: number, z: number, yaw: number, px: number, py: number, pz: number, pyaw: number, info: number, lights: number, dist: number): void {
    const m = this.meta!;
    const c = Math.cos(yaw), s = Math.sin(yaw), pc = Math.cos(pyaw), ps = Math.sin(pyaw);
    const at = (lx: number, ly: number, lz: number, seat: number, clip: number, rate: number, phase: number) => {
      const h = hash32((Math.floor(info) >>> 0) * 31 + seat * 7919 + 17);
      let v = h % m.variations.length;
      if (m.variations[v].band === 'child' && seat === 0) v = (v + 4) % m.variations.length;
      const l = this.look;
      l.variation = v; l.clip = clip; l.hash = h & 0xffffff; l.rate = rate; l.phase = phase;
      let ox = lx, oy = ly, oz = lz;
      if (clip === CLIP.sit) { oy -= m.variations[v].sitPelvis[0]; oz -= m.variations[v].sitPelvis[1]; }
      const wx = x + ox * c + oz * s, wz = z - ox * s + oz * c;
      const qx = px + ox * pc + oz * ps, qz = pz - ox * ps + oz * pc;
      this.levels(1.7 * this.pxScale / Math.max(0.5, dist), dist, wx, y + oy, wz, yaw, qx, py + oy, qz, pyaw, l, 1, 1, 0);
    };
    if (kind === 0 && style === 5) {
      // the pedalling pose held still, pedals level: feet on the pegs, hands on the bars, helmet on
      at(MOTO_PELVIS[0], MOTO_PELVIS[1] - 0.93, MOTO_PELVIS[2] + 0.14, 0, CLIP.pedal, 0, 0.25);
      return;
    }
    if (!this.seatedInCabins || dist > PeopleRenderer.OCCUPANT_NEAR) return;
    const seats = seatsOf(kind, style);
    const n = aboard(kind, lights, seats.length);
    for (let i = 0; i < n; i++) {
      const [sx, sy, sz] = seats[i];
      at(sx, sy, sz, i, CLIP.sit, 1, ((hash32(i + 3) >>> 8) & 1023) / 1024);
    }
  }

  /** A person placed directly (seated occupants, the creator's people): `clip` from CLIP. */
  pushPlaced(x: number, y: number, z: number, yaw: number, variation: number, clip: number, hash: number, dist: number, scale = 1, rate = 1): void {
    const px1 = 1.7 * this.pxScale / Math.max(0.5, dist);
    if (px1 < MIN_PX) return;
    const l = this.look;
    l.variation = variation; l.clip = clip; l.hash = hash >>> 0; l.rate = rate; l.phase = ((hash >>> 7) & 1023) / 1024;
    this.levels(px1, dist, x, y, z, yaw, x, y, z, yaw, l, 1, scale, 0);
  }

  /**
   * The levels a person is drawn at for its height on screen: 0 above LOD0_PX, 1 down to LOD1_PX, 2 down to MIN_PX,
   * each crossing over a band by complementary dither (positive fade: noise < f; negative: noise >= -f - 1).
   */
  private levels(px1: number, dist: number, x: number, y: number, z: number, yaw: number, px: number, py: number, pz: number, pyaw: number, l: LookChoice, alpha: number, scale: number, slope: number): void {
    const f0 = Math.min(1, Math.max(0, (px1 - LOD0_PX) / LOD_BAND_PX));
    const f1 = Math.min(1, Math.max(0, (px1 - LOD1_PX) / LOD2_BAND_PX));
    if (f0 > 0) this.write(0, x, y, z, yaw, px, py, pz, pyaw, l, f0, alpha, scale, slope, false);
    // a person fully at level 0 casts with a shadow-only level-1 copy
    if (f0 >= 1) this.write(1, x, y, z, yaw, px, py, pz, pyaw, l, 2, alpha, scale, slope, dist < SHADOW_NEAR);
    else if (f1 > 0) this.write(1, x, y, z, yaw, px, py, pz, pyaw, l, f0 > 0 ? -1 - f0 : f1, alpha, scale, slope, false);
    if (f1 < 1) this.write(2, x, y, z, yaw, px, py, pz, pyaw, l, -1 - f1, alpha * Math.min(1, (px1 - MIN_PX) / 2), scale, slope, false);
  }

  private write(lod: number, x: number, y: number, z: number, yaw: number, px: number, py: number, pz: number, pyaw: number, l: LookChoice, fade: number, alpha: number, scale = 1, slope = 0, cast = false): void {
    const n = this.counts[lod];
    if (n >= CAP[lod]) return;
    const a = this.attrs[lod], o = n * 4;
    const P = a.pos.array as Float32Array, Q = a.prev.array as Float32Array, I = a.info.array as Float32Array, A = a.anim.array as Float32Array;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = yaw;
    Q[o] = px; Q[o + 1] = py; Q[o + 2] = pz; Q[o + 3] = pyaw;
    I[o] = l.hash & 0xffffff; I[o + 1] = l.variation + l.clip * 64; I[o + 2] = fade; I[o + 3] = alpha + (cast ? 2 : 0);
    A[o] = l.phase; A[o + 1] = l.rate; A[o + 2] = scale; A[o + 3] = slope;
    this.counts[lod] = n + 1;
  }

  end(): void {
    if (this.creator?.size) {
      const t = performance.now() / 1000;
      this.creator.forEach(this.eye.x, this.eye.z, 700, t, this.lastT > 0 ? Math.min(0.2, t - this.lastT) : 0, this.visible, this.drawPlaced);
      this.lastT = t;
    }
    for (let lod = 0; lod < this.geos.length; lod++) {
      const n = this.counts[lod];
      this.geos[lod].instanceCount = n;
      this.drawn[lod] = n;
      const a = this.attrs[lod];
      for (const at of [a.pos, a.prev, a.info, a.anim]) { at.clearUpdateRanges(); at.addUpdateRange(0, n * 4); at.needsUpdate = true; }
    }
  }

  /** One hidden instance per level so the shaders compile at load. */
  warmup(): void {
    if (!this.ready) return;
    this.counts.fill(0);
    const l = this.look;
    l.variation = 0; l.clip = CLIP.walk; l.hash = 0; l.rate = 1; l.phase = 0;
    this.write(0, 0, -1000, 0, 0, 0, -1000, 0, 0, l, 1, 1);
    this.write(1, 0, -1000, 0, 0, 0, -1000, 0, 0, l, -1, 1, 1, 0, true);
    this.write(2, 0, -1000, 0, 0, 0, -1000, 0, 0, l, -1, 1);
    this.end();
  }
}
