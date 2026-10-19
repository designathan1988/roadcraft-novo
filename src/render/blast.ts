// Explosão e desabamento: clarão (esfera que cresce e some) e, para cada prédio atingido, um
// bloco do tamanho dele que afunda no chão em poucos segundos. Só efeitos na página; o mundo
// (prédio vira entulho) muda por comando. Objetos de vida curta, sem estado no quadro quando parados.

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

  /** Clarão em (x, y, z) com o raio da explosão. */
  boom(x: number, y: number, z: number, r: number): void {
    this.flash.position.set(x, y + 2, z);
    this.flash.scale.setScalar(r * 0.3);
    this.flash.userData.r = r;
    this.flashT = 0;
    this.flash.visible = true;
  }

  /** Um prédio que desaba: bloco w × d × h girado, afundando. */
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
      // cai acelerando, inclina um pouco e some no chão
      const k = Math.min(1, (f.t / 2.4) ** 2);
      f.mesh.scale.y = Math.max(0.01, f.h * (1 - k));
      f.mesh.rotation.z = 0.06 * k;
      if (k >= 1) { this.group.remove(f.mesh); f.mesh.dispose(); this.falling.splice(i, 1); }
    }
  }

  /** Malhas de amostra (compilam na carga). */
  warmup(): THREE.Object3D[] {
    const a = new THREE.Mesh(this.box, this.wallMat); a.position.y = -5000;
    const b = new THREE.Mesh(this.flash.geometry, this.flashMat); b.position.y = -5000;
    return [a, b];
  }
}
