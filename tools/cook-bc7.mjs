// Cooks the surfaces into BC7 with their whole mip chain: public/cooked/bc7/<name>.bc7. An RGBA8 texel takes 4 bytes, a BC7
// one 1: about 98 MB of surfaces with mips become about 25. Decoded in a worker at load, the RGBA8 files also cost the page's
// memory and the GPU's mip pass. The originals stay: an adapter without BC reads them.
// File: three u32 (size, layers, raw bytes), then the zstd of every level, largest first, all layers of a level together.
// Usage: node tools/cook-bc7.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { read } from 'three/examples/jsm/libs/ktx-parse.module.js';
import { COOKED_FILES, packFinishes, FINISH_SIZE } from '../src/jobs/buildingFinishes.ts';
import { encodeBc7Block } from './bc7.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public', 'cooked', 'surfaces'), out = path.join(root, 'public', 'cooked', 'bc7');
fs.mkdirSync(out, { recursive: true });

function level0(file) {
  const c = read(new Uint8Array(fs.readFileSync(path.join(src, file))));
  const l = c.levels[0];
  const data = c.supercompressionScheme === 2 ? new Uint8Array(zlib.zstdDecompressSync(l.levelData)) : l.levelData;
  return { data, size: c.pixelWidth, layers: Math.max(1, c.layerCount) };
}

const toLinear = new Float64Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const toSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));

/** The next level of one layer, averaged 2 x 2: colour in light when `srgb` (what the GPU's mip pass did on an sRGB texture). */
function halve(img, size, srgb) {
  const n = size >> 1, next = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const o = (y * n + x) * 4;
    const a = (y * 2 * size + x * 2) * 4, b = a + 4, c = a + size * 4, d = c + 4;
    for (let k = 0; k < 4; k++) {
      if (srgb && k < 3) next[o + k] = toSrgb((toLinear[img[a + k]] + toLinear[img[b + k]] + toLinear[img[c + k]] + toLinear[img[d + k]]) / 4);
      else next[o + k] = (img[a + k] + img[b + k] + img[c + k] + img[d + k] + 2) >> 2;
    }
  }
  return next;
}

/** BC7 of one image; an image under 4 px repeats its edge to fill the block. */
function encodeImage(img, size, into, at) {
  const blocks = Math.ceil(size / 4), px = new Uint8Array(64);
  for (let by = 0; by < blocks; by++) for (let bx = 0; bx < blocks; bx++) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const sx = Math.min(size - 1, bx * 4 + x), sy = Math.min(size - 1, by * 4 + y), s = (sy * size + sx) * 4, d = (y * 4 + x) * 4;
      px[d] = img[s]; px[d + 1] = img[s + 1]; px[d + 2] = img[s + 2]; px[d + 3] = img[s + 3];
    }
    encodeBc7Block(px, into, at);
    at += 16;
  }
  return at;
}

function cook(name, { data, size, layers }, srgb) {
  const levels = Math.log2(size) + 1;
  let raw = 0;
  for (let l = 0; l < levels; l++) raw += Math.ceil(Math.max(1, size >> l) / 4) ** 2 * 16 * layers;
  const bytes = new Uint8Array(raw);
  let at = 0;
  const per = size * size * 4;
  const chain = Array.from({ length: layers }, (_, k) => data.subarray(k * per, (k + 1) * per));
  for (let l = 0, s = size; l < levels; l++, s = Math.max(1, s >> 1)) {
    for (let k = 0; k < layers; k++) at = encodeImage(chain[k], s, bytes, at);
    if (s > 1) for (let k = 0; k < layers; k++) chain[k] = halve(chain[k], s, srgb);
  }
  if (at !== raw) throw new Error(`${name}: wrote ${at} of ${raw}`);
  const packed = zlib.zstdCompressSync(bytes);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(size, 0); head.writeUInt32LE(layers, 4); head.writeUInt32LE(raw, 8);
  fs.writeFileSync(path.join(out, `${name}.bc7`), Buffer.concat([head, packed]));
  console.log(`${name}: ${size}² x ${layers}, ${(raw / 1e6).toFixed(1)} MB, file ${(packed.length / 1e6).toFixed(1)} MB`);
}

const t0 = Date.now();
for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.ktx2') && !n.startsWith('building-finishes'))) cook(f.replace(/\.ktx2$/, ''), level0(f), false);
const map = level0(COOKED_FILES.map), normal = level0(COOKED_FILES.normal), rough = level0(COOKED_FILES.rough);
const packed = packFinishes(map.data, normal.data, rough.data);
const layers = packed.albedo.length / (FINISH_SIZE * FINISH_SIZE * 4);
cook('building-finishes.albedo', { data: packed.albedo, size: FINISH_SIZE, layers }, true);
cook('building-finishes.normal', { data: packed.normal, size: FINISH_SIZE, layers }, false);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
