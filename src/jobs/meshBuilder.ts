// Acumulador de malha nos workers: arrays que crescem, triângulos orientados
// pela normal desejada (nunca erra o lado), empacotamento compacto no fim.

import { octEncode } from './boxMesh.ts';
import type { PackedMesh } from './protocol.ts';

export class MeshBuilder {
  pos = new Float32Array(3 * 4096);
  nrm = new Float32Array(3 * 4096);
  col = new Uint32Array(4096); // 0xRRGGBB
  mat = new Uint8Array(4096);
  /** Valor livre por vértice (vai em position.w): o perfil, nas vias. */
  tag = new Uint16Array(4096);
  curTag = 0;
  extra: Float32Array | null;
  /** Fachada (estilo, semente, tipo, largura da coluna) e coordenadas na parede (u em colunas, h em m). */
  fac: Uint8Array | null;
  fuv: Float32Array | null;
  /** Valores correntes usados por vert() quando a fachada está ligada. */
  curFac = [0, 0, 0, 0];
  curBase = 0;
  curU = 0;
  idx = new Uint32Array(6 * 4096);
  v = 0;
  t = 0;
  private hasExtra: boolean;

  constructor(withExtra = false, withFacade = false) {
    this.hasExtra = withExtra;
    this.extra = withExtra ? new Float32Array(4 * 4096) : null;
    this.fac = withFacade ? new Uint8Array(4 * 4096) : null;
    this.fuv = withFacade ? new Float32Array(2 * 4096) : null;
  }

  private growV(n: number): void {
    if (this.v + n <= this.col.length) return;
    let cap = this.col.length;
    while (cap < this.v + n) cap *= 2;
    const g = <T extends Float32Array | Uint32Array | Uint16Array | Uint8Array>(a: T, k: number): T => {
      const b = new (a.constructor as new (n: number) => T)(cap * k); b.set(a); return b;
    };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 3); this.col = g(this.col, 1); this.mat = g(this.mat, 1); this.tag = g(this.tag, 1);
    if (this.extra) this.extra = g(this.extra, 4);
    if (this.fac) this.fac = g(this.fac, 4);
    if (this.fuv) this.fuv = g(this.fuv, 2);
  }

  private growT(n: number): void {
    if (this.t + n <= this.idx.length) return;
    let cap = this.idx.length;
    while (cap < this.t + n) cap *= 2;
    const b = new Uint32Array(cap); b.set(this.idx); this.idx = b;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, rgb: number, mat: number,
    e0 = 0, e1 = 0, e2 = 0, e3 = 0): number {
    this.growV(1);
    const i = this.v++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nrm[i * 3] = nx / l; this.nrm[i * 3 + 1] = ny / l; this.nrm[i * 3 + 2] = nz / l;
    this.col[i] = rgb; this.mat[i] = mat; this.tag[i] = this.curTag;
    if (this.extra) { this.extra[i * 4] = e0; this.extra[i * 4 + 1] = e1; this.extra[i * 4 + 2] = e2; this.extra[i * 4 + 3] = e3; }
    if (this.fac && this.fuv) {
      const f = this.curFac;
      this.fac[i * 4] = f[0]; this.fac[i * 4 + 1] = f[1]; this.fac[i * 4 + 2] = f[2]; this.fac[i * 4 + 3] = f[3];
      this.fuv[i * 2] = this.curU;
      this.fuv[i * 2 + 1] = y - this.curBase;
    }
    return i;
  }

  /** Triângulo virado para o lado de (nx, ny, nz). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const p = this.pos;
    const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
    const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    if (cx * cx + cy * cy + cz * cz < 1e-12) return; // degenerado
    this.growT(3);
    if (cx * nx + cy * ny + cz * nz >= 0) { this.idx[this.t++] = a; this.idx[this.t++] = b; this.idx[this.t++] = c; }
    else { this.idx[this.t++] = a; this.idx[this.t++] = c; this.idx[this.t++] = b; }
  }

  /** Quadrilátero a-b-c-d (em ordem ao redor) virado para n. */
  quad(a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }

  /** Caixa alinhada a uma direção (dx, dz) no plano: pilares, muretas, portais. */
  box(cx: number, cz: number, y0: number, y1: number, dx: number, dz: number, halfLen: number, halfWid: number, rgb: number, mat: number, bottom = false): void {
    const lx = dz, lz = -dx; // esquerda
    const corners: Array<[number, number]> = [
      [cx - dx * halfLen - lx * halfWid, cz - dz * halfLen - lz * halfWid],
      [cx + dx * halfLen - lx * halfWid, cz + dz * halfLen - lz * halfWid],
      [cx + dx * halfLen + lx * halfWid, cz + dz * halfLen + lz * halfWid],
      [cx - dx * halfLen + lx * halfWid, cz - dz * halfLen + lz * halfWid],
    ];
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) & 3];
      const mx = (ax + bx) / 2 - cx, mz = (az + bz) / 2 - cz;
      const a = this.vert(ax, y0, az, mx, 0, mz, rgb, mat), b = this.vert(bx, y0, bz, mx, 0, mz, rgb, mat);
      const c = this.vert(bx, y1, bz, mx, 0, mz, rgb, mat), d = this.vert(ax, y1, az, mx, 0, mz, rgb, mat);
      this.quad(a, b, c, d, mx, 0, mz);
    }
    const t = corners.map(([x, z]) => this.vert(x, y1, z, 0, 1, 0, rgb, mat));
    this.quad(t[0], t[1], t[2], t[3], 0, 1, 0);
    if (bottom) {
      const b = corners.map(([x, z]) => this.vert(x, y0, z, 0, -1, 0, rgb, mat));
      this.quad(b[0], b[1], b[2], b[3], 0, -1, 0);
    }
  }

  /** Empacota relativo à origem; escala = extensão (snorm16). */
  pack(originX: number, originZ: number, extent: number): PackedMesh | null {
    const n = this.v;
    if (n === 0 || this.t === 0) return null;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { const y = this.pos[i * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const originY = Math.floor(minY);
    const inv = 32767 / extent;
    const q = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * inv)));
    const position = new Int16Array(n * 4), normal = new Int8Array(n * 4), color = new Uint8Array(n * 4);
    const oct = new Float32Array(2);
    for (let i = 0; i < n; i++) {
      position[i * 4] = q(this.pos[i * 3] - originX);
      position[i * 4 + 1] = q(this.pos[i * 3 + 1] - originY);
      position[i * 4 + 2] = q(this.pos[i * 3 + 2] - originZ);
      position[i * 4 + 3] = this.tag[i];

      octEncode(this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2], oct);
      normal[i * 4] = Math.round(oct[0] * 127); normal[i * 4 + 1] = Math.round(oct[1] * 127);
      const c = this.col[i];
      color[i * 4] = (c >> 16) & 255; color[i * 4 + 1] = (c >> 8) & 255; color[i * 4 + 2] = c & 255; color[i * 4 + 3] = this.mat[i];
    }
    const index = n <= 65536 ? new Uint16Array(this.t) : new Uint32Array(this.t);
    index.set(this.idx.subarray(0, this.t));
    return {
      originX, originY, originZ, scale: extent, vertexCount: n,
      position, normal, color, index,
      extra: this.hasExtra && this.extra ? this.extra.slice(0, n * 4) : undefined,
      fac: this.fac ? this.fac.slice(0, n * 4) : undefined,
      fuv: this.fuv ? packFuv(this.fuv, n) : undefined,
      minY: minY - originY, maxY: maxY - originY,
    };
  }
}

/** u e h da fachada em snorm16 (escala 512 m). */
function packFuv(f: Float32Array, n: number): Int16Array {
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n * 2; i++) out[i] = Math.max(-32767, Math.min(32767, Math.round(f[i] / 512 * 32767)));
  return out;
}
