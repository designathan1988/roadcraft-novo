// Ver por dentro: o prédio escolhido some (o material dos prédios corta pela caixa, uniformes
// abaixo) e no lugar aparece um volume simples até o andar escolhido e o miolo dele: laje, paredes
// de fora vistas por dentro, divisórias das salas, escada, elevador e mesas. Malha pequena, de um prédio.

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';

/** Corte: centro e meia largura/fundo (x, z, w/2, d/2), giro (cos, sen) e altura (sem corte: muito alta). */
export const cutBoxU = T.uniform(new THREE.Vector4(0, 0, 0, 0));
export const cutRotU = T.uniform(new THREE.Vector2(1, 0));
export const cutYU = T.uniform(1e9);

/** Máscara do corte para o material dos prédios: false = fragmento sumido. */
export function cutMask(): ReturnType<typeof T.float> {
  const { positionWorld, abs } = T;
  const dx = positionWorld.x.sub(cutBoxU.x), dz = positionWorld.z.sub(cutBoxU.y);
  const lx = dx.mul(cutRotU.x).sub(dz.mul(cutRotU.y)), lz = dx.mul(cutRotU.y).add(dz.mul(cutRotU.x));
  const inside = abs(lx).lessThan(cutBoxU.z.add(0.8)).and(abs(lz).lessThan(cutBoxU.w.add(0.8)));
  return inside.and(positionWorld.y.greaterThan(cutYU)).not();
}

export class InsideView {
  readonly group = new THREE.Group();
  private mats = {
    slab: new THREE.MeshStandardNodeMaterial({ color: 0xbdb5a6, roughness: 0.9 }),
    wall: new THREE.MeshStandardNodeMaterial({ color: 0xf0ece4, roughness: 0.95 }),
    core: new THREE.MeshStandardNodeMaterial({ color: 0x8f949a, roughness: 0.6 }),
    stair: new THREE.MeshStandardNodeMaterial({ color: 0xc9c2b4, roughness: 0.8 }),
    wood: new THREE.MeshStandardNodeMaterial({ color: 0x8a6a4a, roughness: 0.7 }),
    below: new THREE.MeshStandardNodeMaterial({ color: 0xcfc8bb, roughness: 0.9 }),
  };
  private box = new THREE.BoxGeometry(1, 1, 1);

  constructor() { this.group.visible = false; }

  private add(mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): void {
    const m = new THREE.Mesh(this.box, mat);
    m.position.set(x, y + h / 2, z);
    m.scale.set(w, h, d);
    this.group.add(m);
  }

  /** Mostra o andar `k` do prédio (centro, w × d, giro, base do térreo, pé-direito). */
  show(x: number, z: number, w: number, d: number, rot: number, base: number, k: number, fh: number): void {
    for (const c of [...this.group.children]) this.group.remove(c);
    const y = base + k * fh;
    // até onde o prédio aparece: o teto deste andar some
    cutBoxU.value.set(x, z, w / 2, d / 2);
    cutRotU.value.set(Math.cos(rot), Math.sin(rot));
    // o prédio gerado some inteiro dentro da caixa; o que fica embaixo é um volume simples até o andar
    cutYU.value = -1e9;
    this.group.position.set(x, 0, z);
    this.group.rotation.y = rot;
    const W = Math.max(4, w - 1.2), D = Math.max(4, d - 2.4), zc = 0.6, H = fh - 0.25;
    if (y - base > 0.3) this.add(this.mats.below, 0, base - 1, zc, W, y - base + 0.75, D);
    this.add(this.mats.slab, 0, y - 0.25, zc, W, 0.25, D);
    // paredes de fora (vistas por dentro) e divisórias a cada ~6 m
    const t = 0.25;
    this.add(this.mats.wall, 0, y, zc + D / 2 - t / 2, W, H, t);
    this.add(this.mats.wall, 0, y, zc - D / 2 + t / 2, W, H, t);
    this.add(this.mats.wall, W / 2 - t / 2, y, zc, t, H, D);
    this.add(this.mats.wall, -W / 2 + t / 2, y, zc, t, H, D);
    const nx = Math.max(1, Math.round(W / 6)), nz = Math.max(1, Math.round(D / 7));
    for (let i = 1; i < nx; i++) if (Math.abs(-W / 2 + (i * W) / nx) > 3) this.add(this.mats.wall, -W / 2 + (i * W) / nx, y, zc, 0.12, H, D * 0.42);
    for (let j = 1; j < nz; j++) this.add(this.mats.wall, -W / 4, y, zc - D / 2 + (j * D) / nz, W * 0.35, H, 0.12);
    // circulação: elevador e escada no miolo
    this.add(this.mats.core, 1.4, y, zc, 2.2, H, 2.4);
    for (let s = 0; s < 10; s++) this.add(this.mats.stair, -1.2, y + s * (H / 10), zc - 1.4 + s * 0.28, 1.6, H / 10, 0.3);
    // algumas mesas nas salas
    for (let i = 0; i < nx; i++) {
      const cx = -W / 2 + ((i + 0.5) * W) / nx;
      if (Math.abs(cx) < 3) continue;
      this.add(this.mats.wood, cx, y, zc + D / 4, 1.6, 0.75, 0.8);
      this.add(this.mats.wood, cx, y, zc - D / 4, 1.6, 0.75, 0.8);
    }
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
    cutYU.value = 1e9;
  }

  get on(): boolean { return this.group.visible; }
}
