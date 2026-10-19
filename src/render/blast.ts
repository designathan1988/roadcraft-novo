// Explosion and collapse: a flash (a sphere that grows and fades) and, for each building hit, a
// block of its size that sinks into the ground in a few seconds. Page effects only; the world
// (building turns to rubble) changes by command. Short-lived objects, no per-frame state when idle.

import * as THREE from 'three/webgpu';

interface Falling { mesh: THREE.Mesh; t: number; h: number; y0: number }

export class Blast {
  readonly group = new THREE.Group();
  private flash: THREE.Mesh;
  private flashT = 9;
  private falling: Falling[] = [];
  private box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private wallMat = new THREE.MeshStandardNodeMaterial({ color: 0xb8b0a2, roughness: 0.9 });
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd28a, transparent: true, depthWrite: false });

  constructor() {
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.flashMat);
    this.flash.visible = false;
    this.group.add(this.flash);
  }

  /** A flash at (x, y, z) with the explosion's radius. */
  boom(x: number, y: number, z: number, r: number): void {
    this.flash.position.set(x, y + 2, z);
    this.flash.scale.setScalar(r * 0.3);
    this.flash.userData.r = r;
    this.flashT = 0;
    this.flash.visible = true;
  }

  /** A building collapsing: a w × d × h block, turned, sinking. */
  collapse(x: number, y: number, z: number, w: number, d: number, h: number, rot: number): void {
    const m = new THREE.Mesh(this.box, this.wallMat);
    m.position.set(x, y, z);
    m.rotation.y = rot;
    m.scale.set(w * 0.9, h, d * 0.9);
    this.group.add(m);
    this.falling.push({ mesh: m, t: 0, h, y0: y });
  }

  update(dt: number): void {
    if (this.flash.visible) {
      this.flashT += dt;
      const k = this.flashT / 0.6;
      const r = (this.flash.userData.r as number) ?? 10;
      this.flash.scale.setScalar(r * (0.3 + k * 0.9));
      this.flashMat.opacity = Math.max(0, 1 - k);
      if (k >= 1) this.flash.visible = false;
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      // falls accelerating, tilts a little and vanishes into the ground
      const k = Math.min(1, (f.t / 2.4) ** 2);
      f.mesh.scale.y = Math.max(0.01, f.h * (1 - k));
      f.mesh.rotation.z = 0.06 * k;
      if (k >= 1) { this.group.remove(f.mesh); f.mesh.dispose(); this.falling.splice(i, 1); }
    }
  }

  /** Sample meshes (they compile at load). */
  warmup(): THREE.Object3D[] {
    const a = new THREE.Mesh(this.box, this.wallMat); a.position.y = -5000;
    const b = new THREE.Mesh(this.flash.geometry, this.flashMat); b.position.y = -5000;
    return [a, b];
  }
}
