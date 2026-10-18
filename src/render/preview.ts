// Pré-visualização de vias: uma fita de vértices fixos, posicionada inteira no
// vertex shader a partir da curva (uniforms). Nenhuma malha montada na CPU.
// Mais um anel para o ponto de encaixe e para a rotatória.

import * as THREE from 'three/webgpu';
import type { Quad } from '../roads/geometry.ts';
import { T, type Node } from './tsl.ts';
import { colorOnly } from './post.ts';

const { Fn, attribute, uniform, uniformArray, vec2, vec3, vec4, float, int, mix, normalize, fract, abs, smoothstep, floor } = T;

const N = 64;

export class RoadPreview {
  readonly mesh: THREE.Mesh;
  readonly marker: THREE.Mesh;
  readonly circle: THREE.Mesh;
  private p0: Node = uniform(new THREE.Vector2());
  private pc: Node = uniform(new THREE.Vector2());
  private p1: Node = uniform(new THREE.Vector2());
  private half: Node = uniform(8);
  private color: Node = uniform(new THREE.Color(0x4cd28a));
  private heights: Node;
  private hv: number[] = new Array(N + 1).fill(0);

  constructor() {
    const g = new THREE.BufferGeometry();
    const tv = new Float32Array((N + 1) * 2 * 2);
    for (let i = 0; i <= N; i++) {
      tv[i * 4] = i / N; tv[i * 4 + 1] = -1;
      tv[i * 4 + 2] = i / N; tv[i * 4 + 3] = 1;
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3));
    g.setAttribute('pv', new THREE.BufferAttribute(tv, 2));
    const idx: number[] = [];
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    g.setIndex(idx);
    this.heights = uniformArray(this.hv, 'float');

    const m = new THREE.MeshBasicNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    const pv = attribute('pv', 'vec2');
    const pos = Fn(() => {
      const t = pv.x, s = float(1).sub(t);
      const p = this.p0.mul(s.mul(s)).add(this.pc.mul(s.mul(t).mul(2))).add(this.p1.mul(t.mul(t)));
      const d = this.pc.sub(this.p0).mul(s.mul(2)).add(this.p1.sub(this.pc).mul(t.mul(2)));
      const dn = normalize(d.add(vec2(1e-6, 0)));
      const left = vec2(dn.y, dn.x.negate());
      const xz = p.add(left.mul(pv.y).mul(this.half));
      const i = int(floor(t.mul(N).add(0.5)));
      const y = this.heights.element(i).add(0.35);
      return vec3(xz.x, y, xz.y);
    });
    m.positionNode = pos();
    // transparente: não mexe na velocidade (o TRAA lê a do chão atrás)
    colorOnly(m);
    // faixas diagonais para ler como "planejado"
    const stripe = smoothstep(0.35, 0.5, abs(fract(pv.x.mul(N / 2).add(pv.y.mul(0.5))).sub(0.5)));
    const edge = smoothstep(0.82, 0.95, abs(pv.y));
    m.colorNode = vec4(mix(this.color, vec3(1), edge.mul(0.6)), mix(float(0.32), float(0.55), stripe).add(edge.mul(0.35)));
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;

    const mm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false });
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32).rotateX(-Math.PI / 2), mm);
    this.marker.visible = false;
    this.marker.renderOrder = 11;
    this.marker.frustumCulled = false;
    const cm = new THREE.MeshBasicMaterial({ color: 0x4cd28a, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
    this.circle = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.15, 96).rotateX(-Math.PI / 2), cm);
    this.circle.visible = false;
    this.circle.renderOrder = 10;
    this.circle.frustumCulled = false;
  }

  /** Mostra a curva com alturas (at, y) reamostradas. */
  show(q: Quad, half: number, at: ArrayLike<number>, y: ArrayLike<number>, ok: boolean, tint?: number): void {
    this.p0.value.set(q.x0, q.z0);
    this.pc.value.set(q.cx, q.cz);
    this.p1.value.set(q.x1, q.z1);
    this.half.value = half;
    this.color.value.setHex(tint ?? (ok ? 0x4cd28a : 0xe2564b));
    const n = at.length, len = at[n - 1] || 1;
    for (let i = 0; i <= N; i++) {
      // amostra pelo parâmetro aproximado por comprimento
      const s = len * i / N;
      let k = Math.min(n - 2, Math.max(0, Math.floor(s / len * (n - 1))));
      while (k < n - 2 && at[k + 1] < s) k++;
      const f = (s - at[k]) / Math.max(1e-6, at[k + 1] - at[k]);
      this.hv[i] = n === 1 ? y[0] : y[k] + (y[k + 1] - y[k]) * Math.min(1, Math.max(0, f));
    }
    this.heights.array = this.hv;
    this.mesh.visible = true;
  }

  hide(): void { this.mesh.visible = false; }

  showMarker(x: number, y: number, z: number, size: number, kind: 'node' | 'seg' | 'free'): void {
    this.marker.position.set(x, y + 0.4, z);
    this.marker.scale.setScalar(size);
    (this.marker.material as THREE.MeshBasicMaterial).color.setHex(kind === 'node' ? 0xffd34e : kind === 'seg' ? 0x7fd0ff : 0xffffff);
    this.marker.visible = true;
  }

  showCircle(x: number, y: number, z: number, r: number, ok: boolean): void {
    this.circle.position.set(x, y + 0.5, z);
    this.circle.scale.setScalar(r);
    (this.circle.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x4cd28a : 0xe2564b);
    this.circle.visible = true;
  }

  hideAll(): void { this.mesh.visible = false; this.marker.visible = false; this.circle.visible = false; }
}
