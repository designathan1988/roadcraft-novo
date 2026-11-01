// WebGL 2 fallback for the props: the compute cull and the indirect draws are WebGPU-only, so there each cell near
// the camera gets one instanced mesh per kind (the middle level, or the only one there is). Owned here; PropRenderer
// forwards cells and frames to it.

import * as THREE from 'three/webgpu';
import { CELL_COUNT, cellOriginX } from '../core/grid.ts';
import { MAP_CELLS } from '../config.ts';
import type { PropColumns } from '../shared/contracts/worker.ts';
import { PROP_TYPES, propType } from '../jobs/props.ts';
import { PART_TYPES } from '../jobs/parts40.ts';
import type { PropDef } from './propMeshes.ts';

export class PropFallback {
  private readonly cellMeshes: Array<THREE.Mesh[] | null> = new Array(CELL_COUNT).fill(null);
  private readonly frustum = new THREE.Frustum();
  private readonly box = new THREE.Box3();
  private readonly pv = new THREE.Matrix4();
  private readonly group: THREE.Group;
  private readonly defs: PropDef[];
  private readonly material: THREE.MeshStandardNodeMaterial;

  constructor(group: THREE.Group, defs: PropDef[], material: THREE.MeshStandardNodeMaterial) {
    this.group = group;
    this.defs = defs;
    this.material = material;
  }

  /** One hidden instance at load: its shader compiles before play. */
  warm(): void {
    this.setCell(0, { count: 1, data: new Float32Array([0, -5000, 0, 0]), extra: new Uint32Array([0]) });
    for (const m of this.cellMeshes[0] ?? []) this.group.children.push(m);
    this.cellMeshes[0] = null;
  }

  /** One instanced mesh per kind in the cell (the middle level, or the only one there is). */
  setCell(c: number, p: PropColumns | null): void {
    const old = this.cellMeshes[c];
    if (old) for (const m of old) m.geometry.dispose();
    this.cellMeshes[c] = null;
    if (!p || p.count === 0) return;
    const meshes: THREE.Mesh[] = [];
    for (let t = 0; t < PROP_TYPES; t++) {
      const def = this.defs[t];
      // a part's level 1 is its far model
      const base = PART_TYPES.includes(t) ? def.lods[0] : def.lods[1] ?? def.lods[0];
      if (!base) continue;
      let n = 0;
      for (let i = 0; i < p.count; i++) if (propType(p.extra[i]) === t) n++;
      if (n === 0) continue;
      const pose = new Float32Array(n * 4), key = new Float32Array(n);
      let k = 0;
      for (let i = 0; i < p.count; i++) {
        if (propType(p.extra[i]) !== t) continue;
        pose.set(p.data.subarray(i * 4, i * 4 + 4), k * 4);
        key[k] = p.extra[i];
        k++;
      }
      const g = new THREE.InstancedBufferGeometry();
      for (const name of ['position', 'normal', 'pcol', 'pext']) g.setAttribute(name, base.attributes[name]);
      g.setAttribute('ipose', new THREE.InstancedBufferAttribute(pose, 4));
      g.setAttribute('ikey', new THREE.InstancedBufferAttribute(key, 1));
      g.instanceCount = n;
      const mesh = new THREE.Mesh(g, this.material);
      mesh.frustumCulled = false;
      (mesh as { parent: THREE.Object3D | null }).parent = this.group;
      meshes.push(mesh);
    }
    this.cellMeshes[c] = meshes;
  }

  /** The cells near and in view. */
  update(camera: THREE.Camera, camPos: THREE.Vector3, pixelScale: number): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    const out = this.group.children;
    out.length = 0;
    const R = 420 * pixelScale;
    const c0x = Math.floor((camPos.x - R + MAP_CELLS * 128) / 256), c1x = Math.floor((camPos.x + R + MAP_CELLS * 128) / 256);
    const c0z = Math.floor((camPos.z - R + MAP_CELLS * 128) / 256), c1z = Math.floor((camPos.z + R + MAP_CELLS * 128) / 256);
    for (let cz = Math.max(0, c0z); cz <= Math.min(MAP_CELLS - 1, c1z); cz++) {
      for (let cx = Math.max(0, c0x); cx <= Math.min(MAP_CELLS - 1, c1x); cx++) {
        const list = this.cellMeshes[cz * MAP_CELLS + cx];
        if (!list) continue;
        const x0 = cellOriginX(cx), z0 = cellOriginX(cz);
        this.box.min.set(x0 - 8, -100, z0 - 8);
        this.box.max.set(x0 + 264, 600, z0 + 264);
        if (!this.frustum.intersectsBox(this.box)) continue;
        for (const m of list) out.push(m);
      }
    }
  }
}
