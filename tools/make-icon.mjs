// Draws the game's icon (a road crossing a block of the city, at dusk) and writes electron/icon.png (256 px) and
// electron/icon.ico (256, 128, 64, 48, 32, 16 px, PNG inside, as Windows Vista and later read it).
// Usage: node tools/make-icon.mjs   (no dependencies; the result is committed, this only remakes it)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The icon at `n` px: RGBA, drawn at 4x and averaged down (antialiasing). */
function draw(n) {
  const S = 4, W = n * S;
  const px = new Float32Array(W * W * 4);
  const R = W * 0.18; // corner radius
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, R), W - R), cy = Math.min(Math.max(y, R), W - R);
    return Math.hypot(x - cx, y - cy) <= R;
  };
  const mix = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    if (!inRounded(x + 0.5, y + 0.5)) continue;
    const u = x / W, v = y / W;
    // sky: deep blue to warm orange at the horizon
    let r = mix(0.11, 0.98, v ** 2.2), g = mix(0.16, 0.6, v ** 2.2), b = mix(0.33, 0.32, v ** 2.2);
    // skyline: blocks of different heights
    const blocks = [[0.06, 0.2, 0.42], [0.2, 0.34, 0.28], [0.34, 0.46, 0.5], [0.46, 0.6, 0.2], [0.6, 0.72, 0.36], [0.72, 0.84, 0.46], [0.84, 0.95, 0.3]];
    for (const [x0, x1, top] of blocks) {
      if (u >= x0 && u < x1 && v > top && v < 0.72) {
        r = 0.09; g = 0.11; b = 0.17;
        // lit windows on a grid
        const wx = (u - x0) * n / 4, wy = (v - top) * n / 4;
        if (n >= 32 && wx % 1 > 0.35 && wx % 1 < 0.75 && wy % 1 > 0.35 && wy % 1 < 0.75 && ((Math.floor(wx) * 7 + Math.floor(wy) * 3 + Math.floor(x0 * 50)) % 3) !== 0) { r = 1; g = 0.82; b = 0.45; }
      }
    }
    // ground and a road coming to the viewer, with the yellow centre line and white kerbs
    if (v >= 0.72) { r = 0.18; g = 0.42; b = 0.22; }
    const half = mix(0.04, 0.42, (v - 0.62) / 0.38);
    const d = Math.abs(u - 0.5);
    if (v >= 0.62 && d < half) {
      r = 0.2; g = 0.21; b = 0.24;
      if (d > half * 0.9) { r = 0.92; g = 0.92; b = 0.9; }
      const dash = ((v - 0.62) * 22) % 1;
      if (d < half * 0.06 && dash < 0.55) { r = 0.98; g = 0.78; b = 0.15; }
    }
    const o = (y * W + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 1;
  }
  const out = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const acc = [0, 0, 0, 0];
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const o = ((y * S + j) * W + x * S + i) * 4;
      for (let k = 0; k < 3; k++) acc[k] += px[o + k] * px[o + 3];
      acc[3] += px[o + 3];
    }
    const a = acc[3] / (S * S);
    for (let k = 0; k < 3; k++) out[(y * n + x) * 4 + k] = Math.round(255 * (acc[3] ? acc[k] / acc[3] : 0) ** (1 / 1.4));
    out[(y * n + x) * 4 + 3] = Math.round(255 * a);
  }
  return out;
}

function png(n, rgba) {
  const crcT = Array.from({ length: 256 }, (_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) rgba.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [256, 128, 64, 48, 32, 16];
const images = sizes.map((n) => png(n, draw(n)));
fs.writeFileSync(path.join(root, 'electron', 'icon.png'), images[0]);
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((n, i) => {
  const e = 6 + i * 16;
  head[e] = n >= 256 ? 0 : n; head[e + 1] = n >= 256 ? 0 : n; head[e + 2] = 0; head[e + 3] = 0;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(images[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(root, 'electron', 'icon.ico'), Buffer.concat([head, ...images]));
console.log(`electron/icon.png, electron/icon.ico (${sizes.join(', ')} px)`);
