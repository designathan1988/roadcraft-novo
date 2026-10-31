/// <reference types="node" />
// Textures: the cooked KTX2 files' headers (KTX 2.0 spec section 3: vkFormat, size, layers, levels, supercompression)
// and every texture the code makes, with its GPU size as the code uploads it (format, mips, layers). The code-made
// list is transcribed from the creation sites (file:line in `site`); the KTX2 rows are read from the files.
// Writes data/textures.json.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { FINISH_COUNT, FINISH_SIZE } from '../../../src/jobs/buildingFinishes.ts';
import { HEIGHT_TILE_RES, MAP_TILES } from '../../../src/config.ts';
import { WATER_TILE_RES } from '../../../src/world/ground.ts';
import { PAINT_COARSE } from '../../../src/jobs/roadPaint.ts';
import { MAX_PROFILES, TABLE_W } from '../../../src/roads/profiles.ts';

const root = new URL('../../../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true });

const VK: Record<number, string> = { 37: 'R8G8B8A8_UNORM', 43: 'R8G8B8A8_SRGB', 145: 'BC7_UNORM', 146: 'BC7_SRGB', 0: 'UNDEFINED (Basis)' };
const SC: Record<number, string> = { 0: 'none', 1: 'BasisLZ', 2: 'Zstandard', 3: 'ZLIB' };
const ktx = [] as unknown[];
const dir = root + 'public/cooked/surfaces/';
for (const f of readdirSync(dir).filter((n) => n.endsWith('.ktx2'))) {
  const b = readFileSync(dir + f), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const vk = dv.getUint32(12, true), w = dv.getUint32(20, true), h = dv.getUint32(24, true), layers = dv.getUint32(32, true), levels = dv.getUint32(40, true), sc = dv.getUint32(44, true);
  const L = Math.max(1, layers);
  // the game uploads the decoded base level as RGBA8 (render/cookedSurfaces.ts tex(): DataTexture RGBA8, generateMipmaps)
  const gpu = w * h * L * 4 * 4 / 3;
  ktx.push({ file: f, vkFormat: VK[vk] ?? vk, width: w, height: h, layers: L, levels, supercompression: SC[sc] ?? sc, fileKB: Math.round(statSync(dir + f).size / 1024), gpuMB: +(gpu / 1048576).toFixed(2), bc7MB: +(gpu / 4 / 1048576).toFixed(2) });
}

const MB = (b: number) => +(b / 1048576).toFixed(2);
const mips = 4 / 3;
const T = MAP_TILES * MAP_TILES;
const code = [
  { name: 'building finishes albedo (13 layers)', site: 'src/render/city.ts:30-42 finishArray', size: `${FINISH_SIZE}x${FINISH_SIZE}x${FINISH_COUNT}`, format: 'RGBA8 sRGB, mips, aniso 8', bytes: FINISH_SIZE ** 2 * FINISH_COUNT * 4 * mips },
  { name: 'building finishes normal+metal (13 layers)', site: 'src/render/city.ts:30-42', size: `${FINISH_SIZE}x${FINISH_SIZE}x${FINISH_COUNT}`, format: 'RGBA8, mips', bytes: FINISH_SIZE ** 2 * FINISH_COUNT * 4 * mips },
  { name: 'wall noise', site: 'src/render/city.ts:62-81', size: '128x128', format: 'RGBA8 (B, A unused), mips', bytes: 128 * 128 * 4 * mips },
  { name: 'terrain heights (one layer per tile)', site: 'src/render/terrain.ts:152-158', size: `${HEIGHT_TILE_RES}x${HEIGHT_TILE_RES}x${T}`, format: 'R32F, no mips', bytes: HEIGHT_TILE_RES ** 2 * T * 4 },
  { name: 'road paint fine (per tile)', site: 'src/render/terrain.ts:160-171', size: `${HEIGHT_TILE_RES}x${HEIGHT_TILE_RES}x${T}`, format: 'RGBA8, no mips', bytes: HEIGHT_TILE_RES ** 2 * T * 4 },
  { name: 'road paint coarse (per tile)', site: 'src/render/terrain.ts:172', size: `${PAINT_COARSE}x${PAINT_COARSE}x${T}`, format: 'RGBA8', bytes: PAINT_COARSE ** 2 * T * 4 },
  { name: 'painted ground', site: 'src/render/terrain.ts:173-179', size: `${WATER_TILE_RES}x${WATER_TILE_RES}x${T}`, format: 'RGBA8, nearest', bytes: WATER_TILE_RES ** 2 * T * 4 },
  { name: 'water level', site: 'src/render/terrain.ts:180-186', size: `${WATER_TILE_RES}x${WATER_TILE_RES}x${T}`, format: 'R32F', bytes: WATER_TILE_RES ** 2 * T * 4 },
  { name: 'ecology', site: 'src/render/terrain.ts:188-195', size: `${WATER_TILE_RES}x${WATER_TILE_RES}x${T}`, format: 'RGBA8', bytes: WATER_TILE_RES ** 2 * T * 4 },
  { name: 'grass / asphalt / footway bake', site: 'src/render/surfaceBake.ts:56-151', size: '3 x 512x512', format: 'RGBA8, mips', bytes: 3 * 512 * 512 * 4 * mips },
  { name: 'rock albedo + normal', site: 'src/render/surfaceBake.ts:191-223', size: '2 x 512x512', format: 'RGBA8, mips', bytes: 2 * 512 * 512 * 4 * mips },
  { name: 'water normals, terrain noise', site: 'src/render/surfaceBake.ts:160-237', size: '2 x 256x256', format: 'RGBA8, mips', bytes: 2 * 256 * 256 * 4 * mips },
  { name: 'traffic occupancy', site: 'src/render/roads.ts:40-46 (OCCUPANCY_SEGS 1<<17 x 4 B)', size: '512x256', format: 'RGBA8', bytes: 512 * 256 * 4 },
  { name: 'lane arrows', site: 'src/render/roads.ts:47', size: '512x256', format: 'RG32F', bytes: 512 * 256 * 8 },
  { name: 'road profile table', site: 'src/render/roads.ts:152', size: `${TABLE_W}x${MAX_PROFILES}`, format: 'RGBA32F', bytes: TABLE_W * MAX_PROFILES * 16 },
  { name: 'signal states', site: 'src/render/props.ts:150 (signalsSab 1<<17)', size: '512x256', format: 'R8, re-uploaded every 250 ms', bytes: 512 * 256 },
  { name: 'sign atlas', site: 'src/render/propMeshes.ts:181-260', size: '1024x384', format: 'canvas RGBA8 (+mips if three generates)', bytes: 1024 * 384 * 4 * mips },
  { name: 'leaf atlas', site: 'src/render/treeMeshes.ts:290-320', size: '512x256', format: 'canvas RGBA8, mips', bytes: 512 * 256 * 4 * mips },
  { name: 'tree impostor colour atlas', site: 'src/render/impostor.ts:73-77, 80-81 (SIZE 128, IMP_G 8, IMP_TYPES 6)', size: '6144x1024', format: 'RGBA8 render target + mips', bytes: 6144 * 1024 * 4 * mips },
  { name: 'tree impostor normal atlas', site: 'src/render/impostor.ts:73-77', size: '6144x1024', format: 'RGBA8 render target + mips', bytes: 6144 * 1024 * 4 * mips },
  { name: 'impostor depth buffers (2, kept with the targets)', site: 'src/render/impostor.ts:74 depthBuffer: true; props.ts:488 keeps impRT', size: '2 x 6144x1024', format: 'depth24/32 (backend picks)', bytes: 2 * 6144 * 1024 * 4 },
  { name: 'street-name text signs', site: 'src/render/textSigns.ts:39-50', size: '512x128 each', format: 'canvas RGBA8, per sign', bytes: 512 * 128 * 4 * mips },
  { name: 'blast crater / soot decals', site: 'src/features/demolition/blast/marks.ts:111-198', size: '2 x 512x512 + 128x128', format: 'canvas RGBA8', bytes: (2 * 512 * 512 + 128 * 128) * 4 * mips },
  { name: 'particles emitters', site: 'src/render/particles.ts:52 (MAX_EMIT 512)', size: '512x1', format: 'RGBA32F', bytes: 512 * 16 },
  { name: 'cloud shadow table', site: 'src/render/cloudShadow.ts:16 (MAX_CLOUDS 24)', size: '24x2', format: 'RGBA32F', bytes: 24 * 2 * 16 },
  { name: 'sun shadow cascades', site: 'src/render/post.ts:73-80 (mapSize 2048, 3 cascades)', size: '3 x 2048x2048', format: 'depth (32-bit assumed)', bytes: 3 * 2048 * 2048 * 4 },
  { name: 'people palettes (storage buffer, not a texture)', site: 'src/render/people/crowd.ts:103; people.json layout.palette', size: '22528 frames x 23 bones x 12 floats', format: 'f32 storage', bytes: 6217728 * 4 },
  { name: 'people vertices + attributes + index (storage)', site: 'src/render/people/crowd.ts:100-102', size: '89188 vertices, 451935 indices', format: 'f32x4 + u32x4 + u32', bytes: 89188 * 16 * 2 + 451935 * 4 },
  { name: 'props pool (storage)', site: 'src/render/props.ts:33-36, 70-71, 142-145 (CAP 1<<20)', size: '1,048,576 instances', format: 'vec4 f32 pose + u32 extra + 2M u32 visible list', bytes: (1 << 20) * 16 + (1 << 20) * 4 + (1 << 21) * 4 },
];
const total = code.reduce((s, c) => s + c.bytes, 0) + (ktx as Array<{ gpuMB: number }>).reduce((s, k) => s + k.gpuMB * 1048576, 0);
writeFileSync(out + 'data/textures.json', JSON.stringify({ ktx, code: code.map((c) => ({ ...c, MB: MB(c.bytes) })), totalMB: MB(total) }, null, 1));
for (const k of ktx as Array<Record<string, unknown>>) console.log(Object.values(k).join(' | '));
for (const c of code) console.log(c.name, '|', c.size, '|', c.format, '|', MB(c.bytes), 'MB');
console.log('total MB', MB(total));
