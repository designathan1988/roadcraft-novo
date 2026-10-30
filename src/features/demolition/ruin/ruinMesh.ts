// How ruins are drawn. Every fragment of every ruin has one row in a single pose buffer (its rest centre, where it is,
// how it is turned, and last frame's place and turn for the anti-aliasing's motion): the shells are drawn by the
// buildings' own material (render/city.ts) moved by that row in the vertex shader, so one shader serves every ruin and
// is compiled at load. The parts and furniture attached to the fragments are instances of the kit's models in one
// BatchedMesh (one draw for all of them), their matrices rewritten on the CPU only while their fragment moves.

import * as THREE from 'three/webgpu';
import { T, type Node } from '../../../render/tsl.ts';
import { createBuildingMaterial } from '../../../render/city.ts';
import { partGeometries, createFurnitureGeometries } from '../../../r40/api.ts';
import { partBase } from '../../../jobs/building40.ts';
import type { RuinData } from './fracture.ts';

/** Ruins at once, fragments in all, attached instances in all. */
export const MAX_RUINS = 32;
export const MAX_FRAGMENTS = MAX_RUINS * 512;
const MAX_ATTACHED = 16384;
/** vec4 rows per fragment: rest centre, place, turn, last place, last turn. */
const ROWS = 5;

const { storage, attribute, uniform, varyingProperty, int, cross } = T;

/** v turned by the unit quaternion q. */
const rotate = (q: Node, v: Node): Node => {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
};

export class RuinDraw {
  readonly group = new THREE.Group();
  /** ROWS × 4 numbers per fragment (see ROWS). */
  readonly poses = new Float32Array(MAX_FRAGMENTS * ROWS * 4);
  private poseAttr = new THREE.StorageBufferAttribute(this.poses, 4);
  private shellMat: THREE.Material;
  private shells: THREE.Mesh[] = [];
  private empty = new THREE.BufferGeometry();
  readonly attached: THREE.BatchedMesh;
  /** A kind's model in the batch (part kinds; furniture as 'f:' + kind). */
  private model = new Map<string, number>();
  private base = new Map<string, number>();
  private lo = Infinity;
  private hi = -1;

  constructor() {
    for (let f = 0; f < MAX_FRAGMENTS; f++) this.poses[(f * ROWS + 2) * 4 + 3] = this.poses[(f * ROWS + 4) * 4 + 3] = 1;
    const pose = storage(this.poseAttr, 'vec4', MAX_FRAGMENTS * ROWS).toReadOnly();
    const fragBase = uniform(0).onObjectUpdate(({ object }: { object: { userData: { fragBase?: number } } }) => object.userData.fragBase ?? 0);
    const row = (k: number) => pose.element(int(attribute('frag', 'float').add(fragBase)).mul(ROWS).add(k));
    const vQ = varyingProperty('vec4', 'vRuinQ'), vRest = varyingProperty('vec3', 'vRuinRest');
    const restOf = attribute('position', 'vec4').xyz;
    this.shellMat = createBuildingMaterial({
      place: (rest: Node) => {
        vQ.assign(row(2));
        vRest.assign(rest);
        return rotate(row(2), rest.sub(row(0).xyz)).add(row(1).xyz);
      },
      turn: (n: Node) => rotate(vQ, n),
      surface: vRest,
      prev: rotate(row(4), restOf.sub(row(0).xyz)).add(row(3).xyz),
    });
    for (let k = 0; k < MAX_RUINS; k++) {
      const m = new THREE.Mesh(this.empty, this.shellMat);
      m.name = 'ruin';
      m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; m.visible = false;
      m.userData.fragBase = k * 512;
      this.shells.push(m);
      this.group.add(m);
    }
    // the kit's models, every one with the same attributes (position, normal, colour) and an index, as a batch needs
    const models: Array<[string, THREE.BufferGeometry, number]> = [];
    for (const [kind, g] of Object.entries(partGeometries())) if (g) models.push([kind, g as THREE.BufferGeometry, partBase(kind)]);
    for (const [kind, g] of Object.entries(createFurnitureGeometries())) models.push(['f:' + kind, g as THREE.BufferGeometry, 0xffffff]);
    const plain = models.map(([kind, g, base]) => [kind, uniformModel(g), base] as const);
    let verts = 0, idx = 0;
    for (const [, g] of plain) { verts += g.getAttribute('position').count; idx += g.index!.count; }
    this.attached = new THREE.BatchedMesh(MAX_ATTACHED, verts, idx, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 }));
    this.attached.name = 'ruin-parts';
    this.attached.frustumCulled = false; this.attached.castShadow = true; this.attached.receiveShadow = true;
    this.attached.sortObjects = false; this.attached.perObjectFrustumCulled = false;
    for (const [kind, g, base] of plain) { this.model.set(kind, this.attached.addGeometry(g)); this.base.set(kind, base); }
    this.group.add(this.attached);
  }

  /** Ruin slot `k` drawn from `r` (its fragments' rows written by the caller). */
  show(k: number, r: RuinData): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.position, 4));
    g.setAttribute('nrm', new THREE.BufferAttribute(r.normal, 4, true));
    g.setAttribute('col', new THREE.BufferAttribute(r.color, 4, true));
    g.setAttribute('fac', new THREE.BufferAttribute(r.fac, 4, true));
    g.setAttribute('fuv', new THREE.BufferAttribute(r.fuv, 2, true));
    g.setAttribute('frag', new THREE.BufferAttribute(r.frag, 1));
    const m = this.shells[k];
    if (m.geometry !== this.empty) m.geometry.dispose();
    m.geometry = g;
    m.visible = true;
  }

  /** Slot `k` no longer drawn; its geometry freed. */
  hide(k: number): void {
    const m = this.shells[k];
    if (m.geometry !== this.empty) m.geometry.dispose();
    m.geometry = this.empty;
    m.visible = false;
  }

  /** An instance of `kind`, tinted `rgb` (sRGB) over the kind's own colour; -1 when the batch is full or the kind unknown. */
  addAttached(kind: string, rgb: number): number {
    const model = this.model.get(kind);
    if (model === undefined || this.attached.instanceCount >= MAX_ATTACHED) return -1;
    const id = this.attached.addInstance(model);
    this.colour.setHex(this.base.get(kind) ?? 0xffffff).multiply(this.tint.setHex(rgb));
    this.attached.setColorAt(id, this.colour);
    return id;
  }
  private colour = new THREE.Color();
  private tint = new THREE.Color();

  removeAttached(id: number): void { if (id >= 0) this.attached.deleteInstance(id); }
  setAttached(id: number, m: THREE.Matrix4): void { if (id >= 0) this.attached.setMatrixAt(id, m); }

  /** Fragment `f`'s rows changed: uploaded with the others at the end of the frame. */
  touched(f: number): void {
    if (f < this.lo) this.lo = f;
    if (f > this.hi) this.hi = f;
  }

  /** The rows touched this frame go up (one range). */
  upload(): void {
    if (this.hi < this.lo) return;
    this.poseAttr.addUpdateRange(this.lo * ROWS * 4, (this.hi - this.lo + 1) * ROWS * 4);
    this.poseAttr.needsUpdate = true;
    this.lo = Infinity; this.hi = -1;
  }

  /** One triangle of shell and one attached instance far under the ground, drawn at load (their pipelines compiled then). */
  warm(on: boolean): void {
    const m = this.shells[0];
    if (on) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -5000, 0, 0, 1, -5000, 0, 0, 0, -5000, 1, 0]), 4));
      g.setAttribute('nrm', new THREE.BufferAttribute(new Int8Array(12), 4, true));
      g.setAttribute('col', new THREE.BufferAttribute(new Uint8Array(12), 4, true));
      g.setAttribute('fac', new THREE.BufferAttribute(new Uint8Array(12), 4, true));
      g.setAttribute('fuv', new THREE.BufferAttribute(new Int16Array(6), 2, true));
      g.setAttribute('frag', new THREE.BufferAttribute(new Float32Array(3), 1));
      m.geometry = g; m.visible = true;
      this.warmId = this.addAttached('f:' + [...this.model.keys()].find((k) => k.startsWith('f:'))?.slice(2), 0xffffff);
      this.setAttached(this.warmId, new THREE.Matrix4().makeTranslation(0, -5000, 0));
    } else {
      this.hide(0);
      this.removeAttached(this.warmId);
      this.warmId = -1;
    }
  }
  private warmId = -1;
}

/** A kit model as a batch takes it: position, normal, colour (white when it has none), indexed. */
function uniformModel(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute('position');
  g.setAttribute('position', pos);
  if (src.getAttribute('normal')) g.setAttribute('normal', src.getAttribute('normal'));
  else { g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3)); g.computeVertexNormals(); }
  g.setAttribute('color', src.getAttribute('color') ?? new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
  g.setIndex(src.index ?? new THREE.BufferAttribute(Uint32Array.from({ length: pos.count }, (_, i) => i), 1));
  return g;
}

export { ROWS as POSE_ROWS };
