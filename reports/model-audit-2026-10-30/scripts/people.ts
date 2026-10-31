/// <reference types="node" />
// The cooked people (public/cooked/people/people.{json,bin}, render/people/format.ts): per variation and level, the
// triangles of its own range and the padded count every instance draws (maxTris: render/people/crowd.ts draws
// maxTris[lod] per instance and collapses the rest); unique vertices referenced per level; the bind-pose sheet.
// Writes data/people.json and sheets/people-levels.png.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { grid } from './raster.ts';

const root = new URL('../../../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true }); mkdirSync(out + 'sheets', { recursive: true });
const meta = JSON.parse(readFileSync(root + 'public/cooked/people/people.json', 'utf8'));
const bin = readFileSync(root + 'public/cooked/people/people.bin');
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const L = meta.layout;
const vpos = new Float32Array(buf, L.vpos.byteOffset, L.vpos.count);
const vattr = new Uint32Array(buf, L.vattr.byteOffset, L.vattr.count);
const index = new Uint32Array(buf, L.index.byteOffset, L.index.count);
const rows: unknown[] = [];
const thumbs: Parameters<typeof grid>[2] = [];
meta.variations.forEach((v: { lod: Array<[number, number]>; sex: string; band: string; outfit: string; height: number }, vi: number) => {
  const lv = v.lod.map(([first, n]: [number, number], l: number) => {
    const used = new Set<number>();
    let held = 0;
    for (let k = 0; k < n * 3; k++) used.add(index[first + k]);
    // triangles of the held things (region >= 8: phone, cup, bag, paper, umbrella, helmet), drawn by every instance
    for (let t = 0; t < n; t++) if (((vattr[index[first + t * 3] * 4 + 1] >>> 24) & 255) >= 8) held++;
    return { level: l, triangles: n, padded: meta.maxTris[l], wasted: meta.maxTris[l] - n, vertices: used.size, heldPropTris: held };
  });
  rows.push({ variation: vi, sex: v.sex, band: v.band, outfit: v.outfit, height: v.height, levels: lv });
  if (vi < 4) v.lod.forEach(([first, n]: [number, number], l: number) => {
    const pos = new Float32Array(n * 9), col = new Float32Array(n * 9);
    for (let k = 0; k < n * 3; k++) {
      const i = index[first + k];
      pos[k * 3] = vpos[i * 4]; pos[k * 3 + 1] = vpos[i * 4 + 1]; pos[k * 3 + 2] = vpos[i * 4 + 2];
      const region = (vattr[i * 4 + 1] >>> 24) & 255, c = [0.85, 0.3, 0.45, 0.35, 0.2, 0.5, 0.9][region] ?? 0.6;
      col[k * 3] = c; col[k * 3 + 1] = c * 0.9; col[k * 3 + 2] = c * 0.8;
    }
    thumbs.push({ name: `${v.sex} ${v.band} L${l}`, caption: `${n}T (DRAWS ${meta.maxTris[l]})`, f: { pos, index: null, col } });
  });
});
const heldMean = [0, 1, 2].map((l) => (rows as Array<{ levels: Array<{ heldPropTris: number }> }>).reduce((s, r) => s + r.levels[l].heldPropTris, 0) / rows.length);
const mean = [0, 1, 2].map((l) => (rows as Array<{ levels: Array<{ triangles: number }> }>).reduce((s, r) => s + r.levels[l].triangles, 0) / rows.length);
writeFileSync(out + 'data/people.json', JSON.stringify({ maxTris: meta.maxTris, meanTris: mean, heldPropTrisMean: heldMean, vertices: meta.vertices, bones: meta.bones.length, paletteFrames: meta.paletteFrames, bytes: meta.bytes, layout: L, rows }, null, 1));
grid(out + 'sheets/people-levels.png', 'COOKED PEOPLE, 4 OF 32 VARIATIONS, LEVELS 0-2 (BIND POSE; GREY BY REGION, NOT THE GAME SHADING)', thumbs, 6, 220);
console.log('maxTris', meta.maxTris, 'mean', mean.map((x) => x.toFixed(0)), 'held', heldMean);
