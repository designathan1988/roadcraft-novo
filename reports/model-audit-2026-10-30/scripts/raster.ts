/// <reference types="node" />
// A small software rasteriser for the contact sheets: flat-shaded triangles with a z-buffer (vertex colours when the
// model has them), a wireframe panel, a 5x7 bitmap font for the captions, and a PNG writer (node:zlib). Nothing here
// claims to look like the game's shading: it shows the shape and the triangle density only.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import type { Flat } from './geom.ts';

export class Image {
  readonly w: number; readonly h: number; readonly rgb: Uint8Array;
  constructor(w: number, h: number, bg = 0xffffff) {
    this.w = w; this.h = h; this.rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { this.rgb[i * 3] = bg >> 16; this.rgb[i * 3 + 1] = (bg >> 8) & 255; this.rgb[i * 3 + 2] = bg & 255; }
  }
  set(x: number, y: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3; this.rgb[o] = r; this.rgb[o + 1] = g; this.rgb[o + 2] = b;
  }
  fill(x0: number, y0: number, w: number, h: number, c: number): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c >> 16, (c >> 8) & 255, c & 255);
  }
  blit(src: Image, ox: number, oy: number): void {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const o = (y * src.w + x) * 3; this.set(ox + x, oy + y, src.rgb[o], src.rgb[o + 1], src.rgb[o + 2]); }
  }
  png(path: string): void {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) { raw[y * (this.w * 3 + 1)] = 0; Buffer.from(this.rgb.buffer, y * this.w * 3, this.w * 3).copy(raw, y * (this.w * 3 + 1) + 1); }
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
  }
}

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b: Buffer): number { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return c ^ -1; }

// 5x7 font: each glyph 7 rows of 5 bits (MSB left)
const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
  '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0], '-': [0, 0, 0, 31, 0, 0, 0],
  '/': [1, 1, 2, 4, 8, 16, 16], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '%': [24, 25, 2, 4, 8, 19, 3],
  '=': [0, 0, 31, 0, 31, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0], '#': [10, 10, 31, 10, 31, 10, 10], '_': [0, 0, 0, 0, 0, 0, 31],
  '>': [8, 4, 2, 1, 2, 4, 8], '<': [2, 4, 8, 16, 8, 4, 2], ' ': [0, 0, 0, 0, 0, 0, 0], "'": [4, 4, 8, 0, 0, 0, 0],
};
export function text(img: Image, x: number, y: number, s: string, c = 0x222222, scale = 2): void {
  let cx = x;
  for (const ch of s.toUpperCase()) {
    const g = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (g[r] & (16 >> b)) img.fill(cx + b * scale, y + r * scale, scale, scale, c);
    cx += 6 * scale;
  }
}

export interface View { yaw: number; pitch: number }

/**
 * Renders a model into w x h: orthographic, turned by yaw (about y) and pitched (about x), fitted to its box. `wire`:
 * the triangle edges in dark lines instead of shading.
 */
export function render(f: Flat, w: number, h: number, view: View = { yaw: 0.6, pitch: 0.5 }, wire = false, bg = 0xeef0f2): Image {
  const img = new Image(w, h, bg);
  const n = f.pos.length / 3;
  if (n === 0) return img;
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const P = new Float64Array(n * 3);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = f.pos[i * 3], y = f.pos[i * 3 + 1], z = f.pos[i * 3 + 2];
    const rx = x * cy - z * sy, rz = x * sy + z * cy;
    const py = y * cp - rz * sp, pz = y * sp + rz * cp;
    P[i * 3] = rx; P[i * 3 + 1] = py; P[i * 3 + 2] = pz;
    if (rx < x0) x0 = rx; if (rx > x1) x1 = rx; if (py < y0) y0 = py; if (py > y1) y1 = py;
  }
  const k = Math.min((w - 16) / Math.max(1e-6, x1 - x0), (h - 16) / Math.max(1e-6, y1 - y0));
  const ox = w / 2 - ((x0 + x1) / 2) * k, oy = h / 2 + ((y0 + y1) / 2) * k;
  for (let i = 0; i < n; i++) { P[i * 3] = ox + P[i * 3] * k; P[i * 3 + 1] = oy - P[i * 3 + 1] * k; }
  const idx = f.index ?? Uint32Array.from({ length: n }, (_, i) => i);
  const zb = new Float32Array(w * h).fill(-Infinity);
  const L = [0.35, 0.8, 0.48];
  const ll = Math.hypot(L[0], L[1], L[2]);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    // world normal for the light
    const ex = f.pos[b * 3] - f.pos[a * 3], ey = f.pos[b * 3 + 1] - f.pos[a * 3 + 1], ez = f.pos[b * 3 + 2] - f.pos[a * 3 + 2];
    const gx = f.pos[c * 3] - f.pos[a * 3], gy = f.pos[c * 3 + 1] - f.pos[a * 3 + 1], gz = f.pos[c * 3 + 2] - f.pos[a * 3 + 2];
    let nx = ey * gz - ez * gy, ny = ez * gx - ex * gz, nz = ex * gy - ey * gx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const lit = 0.35 + 0.65 * Math.abs(nx * L[0] + ny * L[1] + nz * L[2]) / ll;
    let r = 0.8, g = 0.8, bb = 0.8;
    if (f.col) { r = (f.col[a * 3] + f.col[b * 3] + f.col[c * 3]) / 3; g = (f.col[a * 3 + 1] + f.col[b * 3 + 1] + f.col[c * 3 + 1]) / 3; bb = (f.col[a * 3 + 2] + f.col[b * 3 + 2] + f.col[c * 3 + 2]) / 3; }
    if (wire) { line(img, P, a, b); line(img, P, b, c); line(img, P, c, a); continue; }
    tri(img, zb, P, a, b, c, Math.min(255, r * lit * 255) | 0, Math.min(255, g * lit * 255) | 0, Math.min(255, bb * lit * 255) | 0);
  }
  return img;
}

function line(img: Image, P: Float64Array, a: number, b: number): void {
  let x0 = P[a * 3], y0 = P[a * 3 + 1];
  const x1 = P[b * 3], y1 = P[b * 3 + 1];
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  const dx = (x1 - x0) / steps, dy = (y1 - y0) / steps;
  for (let s = 0; s <= steps; s++) { img.set(Math.round(x0), Math.round(y0), 30, 45, 60); x0 += dx; y0 += dy; }
}

function tri(img: Image, zb: Float32Array, P: Float64Array, a: number, b: number, c: number, r: number, g: number, bl: number): void {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(img.w - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(img.h - 1, Math.ceil(Math.max(ay, by, cy)));
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
    const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    const z = w0 * az + w1 * bz + w2 * cz;
    const o = y * img.w + x;
    if (z <= zb[o]) continue;
    zb[o] = z; img.set(x, y, r, g, bl);
  }
}

/** One sheet cell: title line, numbers line, shaded and wireframe panels side by side. */
export function sheet(path: string, title: string, lines: string[], f: Flat, view?: View): void {
  const W = 1000, panel = 480, top = 24 + lines.length * 20 + 8;
  const img = new Image(W, top + panel + 10);
  text(img, 10, 8, title, 0x111111, 2);
  lines.forEach((l, i) => text(img, 10, 32 + i * 20, l, 0x444444, 2));
  img.blit(render(f, panel, panel, view, false), 10, top);
  img.blit(render(f, panel, panel, view, true, 0xffffff), 20 + panel, top);
  img.png(path);
}

/** A grid of small shaded thumbnails with captions (for the many small models). */
export function grid(path: string, title: string, items: Array<{ name: string; caption: string; f: Flat; wire?: boolean }>, cols = 6, cell = 220): void {
  const rows = Math.ceil(items.length / cols);
  const img = new Image(cols * cell + 10, 34 + rows * (cell + 44));
  text(img, 10, 8, title, 0x111111, 2);
  items.forEach((it, i) => {
    const x = 5 + (i % cols) * cell, y = 34 + Math.floor(i / cols) * (cell + 44);
    img.blit(render(it.f, cell - 10, cell - 10, undefined, !!it.wire), x + 5, y);
    text(img, x + 5, y + cell - 4, it.name.slice(0, 34), 0x111111, 1);
    text(img, x + 5, y + cell + 8, it.caption.slice(0, 34), 0x555555, 1);
    if (it.caption.length > 34) text(img, x + 5, y + cell + 20, it.caption.slice(34, 68), 0x555555, 1);
  });
  img.png(path);
}
