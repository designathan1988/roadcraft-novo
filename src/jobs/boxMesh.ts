// Monta a malha compacta de um conjunto de caixas (prédios genéricos).
// Roda no worker. Vértice: posição snorm16×4, normal octaédrica snorm8×4, cor+material unorm8×4.

import { heightAt } from '../world/heights.ts';
import type { BoxColumns, PackedMesh } from './protocol.ts';

/** Normal unitária → octaédrico em [-1, 1]². */
export function octEncode(x: number, y: number, z: number, out: Float32Array): void {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let ex = x / l1, ey = y / l1;
  if (z < 0) {
    const ox = (1 - Math.abs(ey)) * (ex >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(ex)) * (ey >= 0 ? 1 : -1);
    ex = ox; ey = oy;
  }
  out[0] = ex; out[1] = ey;
}

export const MAT_WALL = 0;
export const MAT_ROOF = 1;

const oct = new Float32Array(2);

export function buildBoxMesh(heights: Float32Array, b: BoxColumns, originX: number, originZ: number, extent: number): PackedMesh | null {
  const n = b.count;
  if (n === 0) return null;
  const vCount = n * 20;
  const position = new Int16Array(vCount * 4);
  const normal = new Int8Array(vCount * 4);
  const color = new Uint8Array(vCount * 4);
  const index = vCount <= 65536 ? new Uint16Array(n * 30) : new Uint32Array(n * 30);

  // bases primeiro, para escolher a origem Y
  const base = new Float32Array(n), top = new Float32Array(n);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(b.rot[i]), s = Math.sin(b.rot[i]);
    const hw = b.w[i] / 2, hd = b.d[i] / 2;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 5; k++) {
      const lx = k === 4 ? 0 : (k & 1 ? hw : -hw), lz = k === 4 ? 0 : (k & 2 ? hd : -hd);
      const g = heightAt(heights, b.x[i] + lx * c - lz * s, b.z[i] + lx * s + lz * c);
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    base[i] = lo - 1.5; // fundação enterrada
    top[i] = hi + b.h[i];
    if (base[i] < minY) minY = base[i];
    if (top[i] > maxY) maxY = top[i];
  }
  const originY = Math.floor(minY);
  const inv = 32767 / extent;
  const q = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * inv)));

  let v = 0, t = 0;
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, rgb: number, mat: number) => {
    const p = v * 4;
    position[p] = q(x - originX); position[p + 1] = q(y - originY); position[p + 2] = q(z - originZ); position[p + 3] = 0;
    octEncode(nx, ny, nz, oct);
    normal[p] = Math.round(oct[0] * 127); normal[p + 1] = Math.round(oct[1] * 127);
    color[p] = (rgb >> 16) & 255; color[p + 1] = (rgb >> 8) & 255; color[p + 2] = rgb & 255; color[p + 3] = mat;
    v++;
  };
  const quad = () => {
    const a = v - 4;
    index[t++] = a; index[t++] = a + 1; index[t++] = a + 2;
    index[t++] = a; index[t++] = a + 2; index[t++] = a + 3;
  };

  for (let i = 0; i < n; i++) {
    const c = Math.cos(b.rot[i]), s = Math.sin(b.rot[i]);
    const hw = b.w[i] / 2, hd = b.d[i] / 2;
    const cx = b.x[i], cz = b.z[i];
    const y0 = base[i], y1 = top[i];
    // cantos no plano (ordem anti-horária vista de cima: -x-z, +x-z, +x+z, -x+z)
    const px = [-hw, hw, hw, -hw], pz = [-hd, -hd, hd, hd];
    const wx = new Array<number>(4), wz = new Array<number>(4);
    for (let k = 0; k < 4; k++) { wx[k] = cx + px[k] * c - pz[k] * s; wz[k] = cz + px[k] * s + pz[k] * c; }
    const col = b.color[i];
    const roof = shade(col, 0.82);
    // paredes
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) & 3;
      const ex = wx[k2] - wx[k], ez = wz[k2] - wz[k];
      const len = Math.hypot(ex, ez);
      const nx = ez / len, nz = -ex / len; // normal para fora
      put(wx[k2], y0, wz[k2], nx, 0, nz, col, MAT_WALL);
      put(wx[k], y0, wz[k], nx, 0, nz, col, MAT_WALL);
      put(wx[k], y1, wz[k], nx, 0, nz, col, MAT_WALL);
      put(wx[k2], y1, wz[k2], nx, 0, nz, col, MAT_WALL);
      quad();
    }
    // telhado
    put(wx[0], y1, wz[0], 0, 1, 0, roof, MAT_ROOF);
    put(wx[3], y1, wz[3], 0, 1, 0, roof, MAT_ROOF);
    put(wx[2], y1, wz[2], 0, 1, 0, roof, MAT_ROOF);
    put(wx[1], y1, wz[1], 0, 1, 0, roof, MAT_ROOF);
    quad();
  }

  return {
    originX, originY, originZ, scale: extent, vertexCount: v,
    position, normal, color, index,
    minY: minY - originY, maxY: maxY - originY,
  };
}

function shade(rgb: number, k: number): number {
  const r = Math.round(((rgb >> 16) & 255) * k), g = Math.round(((rgb >> 8) & 255) * k), b = Math.round((rgb & 255) * k);
  return (r << 16) | (g << 8) | b;
}
