// Packs the 38 Roadcraft 4.0 lot projects (data/lots-roadcraft/*.json, project units of 0.4 m) whole into
// src/world/catalogData.json: every volume, storey, side fill, single bay, face geometry, outline and element, with no
// field dropped and every number stored exactly (the packer stops if one does not fit): volume lengths in int16 at
// 1/160 unit, element lengths (some in thirds) and outlines in float32. Only ids, counters and the
// save time are left out. The format is src/world/catalogFormat.ts (decodeCatalog reads it back).
// Run: node data/lots-roadcraft/pack.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAT_BAYS, CAT_DENSITIES, CAT_ELEMENTS, CAT_FINISHES, CAT_FUNCTIONS, CAT_PATTERNS, CAT_Q, CAT_ROOFS, CAT_SURFACES, CAT_USES, GEOM_FIELDS,
  VOL_MATERIAL, VOL_OUTLINE, VOL_PATTERN,
} from '../../src/world/catalogFormat.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(here, '../../src/world/catalogData.json');
const bytes = [];
const fail = (msg) => { throw new Error(`pack: ${msg}`); };
const u8 = (v, what) => { if (!Number.isInteger(v) || v < 0 || v > 255) fail(`${what} = ${v} is not a byte`); bytes.push(v); };
const u16 = (v, what) => { if (!Number.isInteger(v) || v < 0 || v > 65535) fail(`${what} = ${v}`); bytes.push(v & 255, v >> 8); };
const len = (v, what) => {
  const q = Math.round(v * CAT_Q);
  if (Math.abs(q - v * CAT_Q) > 1e-6 * CAT_Q || q < -32768 || q > 32767) fail(`${what} = ${v} does not fit 1/${CAT_Q} unit in int16`);
  bytes.push(q & 255, (q >> 8) & 255);
};
const f32 = (v, what = 'value') => { const f = new Float32Array([v]); if (Math.abs(f[0] - v) > 1e-5 * Math.max(1, Math.abs(v))) fail(`${what} = ${v} does not fit float32`); bytes.push(...new Uint8Array(f.buffer)); };
const idx = (list, name, what) => { const k = list.indexOf(name); if (k < 0) fail(`${what}: unknown "${name}"`); return k; };
const mat = (m, what) => { u8(idx(CAT_FINISHES, m.finish, what), what); const c = m.colour; if (!Number.isInteger(c) || c < 0 || c > 0xffffff) fail(`${what} colour ${c}`); bytes.push(c & 255, (c >> 8) & 255, (c >> 16) & 255); };
const known = (o, keys, what) => { for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${what}: field "${k}" would be lost`); };

const files = fs.readdirSync(here).filter((f) => f.endsWith('.json')).sort();
const names = [];
u8(files.length, 'projects');
for (const file of files) {
  const j = JSON.parse(fs.readFileSync(path.join(here, file), 'utf8'));
  const b = j.body, name = file.replace(/\.json$/, '');
  names.push(name);
  known(j, ['name', 'use', 'density', 'savedAt', 'body'], name);
  known(b, ['schema', 'use', 'function', 'module', 'groundHeight', 'storeyHeight', 'palette', 'materials', 'volumes', 'nextElementId', 'cores', 'nextVolumeId', 'blueprint', 'elements', 'lotPlan'], name);
  if (b.schema !== 2 || (b.cores ?? []).length || b.blueprint !== `signature:${name}`) fail(`${name}: schema, cores or blueprint not as expected`);
  u8(idx(CAT_USES, j.use, name), 'use'); u8(idx(CAT_USES, b.use, name), 'body use'); u8(idx(CAT_FUNCTIONS, b.function, name), 'function'); u8(idx(CAT_DENSITIES, j.density, name), 'density');
  len(b.module, 'module'); len(b.groundHeight, 'groundHeight'); len(b.storeyHeight, 'storeyHeight');
  u8(b.palette, 'palette'); u8(b.lotPlan ?? 255, 'lotPlan');
  known(b.materials, ['wall', 'trim', 'roof'], `${name} materials`);
  for (const k of ['wall', 'trim', 'roof']) mat(b.materials[k], `${name} ${k}`);
  u16(b.volumes.length, 'volumes');
  for (const v of b.volumes) {
    const what = `${name} volume ${v.id}`;
    known(v, ['id', 'x', 'y', 'w', 'd', 'base', 'roof', 'storeys', 'materials', 'facadeGeometry', 'facadePattern', 'outline', 'open'], what);
    len(v.x, what); len(v.y, what); len(v.w, what); len(v.d, what); u8(v.base, what); u8(idx(CAT_ROOFS, v.roof, what), what);
    u8(v.open ? idx(CAT_SURFACES, v.open, what) + 1 : 0, what);
    if (v.materials) known(v.materials, ['wall'], `${what} materials`);
    const flags = (v.materials?.wall ? VOL_MATERIAL : 0) | (v.outline ? VOL_OUTLINE : 0) | (v.facadePattern ? VOL_PATTERN : 0);
    u8(flags, what);
    if (v.materials?.wall) mat(v.materials.wall, what);
    if (v.facadePattern) u8(idx(CAT_PATTERNS, v.facadePattern, what), what);
    if (v.outline) { u8(v.outline.length, what); for (const p of v.outline) { known(p, ['x', 'y'], what); f32(p.x); f32(p.y); } }
    const geo = v.facadeGeometry ?? {};
    let faces = 0;
    for (const f of Object.keys(geo)) { const k = Number(f); if (!(k >= 0 && k < 4)) fail(`${what}: face ${f}`); faces |= 1 << k; }
    u8(faces, what);
    for (let f = 0; f < 4; f++) {
      const g = geo[f];
      if (!g) continue;
      known(g, GEOM_FIELDS, `${what} face ${f}`);
      let fields = 0;
      GEOM_FIELDS.forEach((k, i) => { if (g[k] !== undefined) fields |= 1 << i; });
      u8(fields, what);
      if (g.bays !== undefined) u8(g.bays, what);
      for (const k of ['windowWidth', 'windowHeight']) if (g[k] !== undefined) { const q = Math.round(g[k] * 100); if (Math.abs(q - g[k] * 100) > 1e-6) fail(`${what} ${k} ${g[k]}`); u8(q, what); }
      for (const k of ['sill', 'pierWidth', 'pierDepth']) if (g[k] !== undefined) len(g[k], `${what} ${k}`);
      if (g.pierEvery !== undefined) u8(g.pierEvery, what);
    }
    u8(v.storeys.length, what);
    for (const s of v.storeys) {
      known(s, ['facade'], `${what} storey`);
      known(s.facade, ['fill', 'sides', 'bays'], `${what} facade`);
      u8(idx(CAT_BAYS, s.facade.fill, what), what);
      let mask = 0;
      const sides = s.facade.sides ?? {};
      for (const f of Object.keys(sides)) { const k = Number(f); if (!(k >= 0 && k < 4)) fail(`${what}: side ${f}`); mask |= 1 << k; }
      u8(mask, what);
      for (let f = 0; f < 4; f++) if (mask & (1 << f)) u8(idx(CAT_BAYS, sides[f], what), what);
      const bays = Object.entries(s.facade.bays ?? {});
      u8(bays.length, what);
      for (const [key, comp] of bays) { const [f, i] = key.split(':').map(Number); u8(f, what); u8(i, what); u8(idx(CAT_BAYS, comp, what), what); }
    }
  }
  const els = b.elements ?? [];
  u16(els.length, 'elements');
  for (const e of els) {
    const what = `${name} element ${e.id}`;
    known(e, ['id', 'kind', 'x', 'y', 'facing', 'w', 'd', 'z', 'h', 'material'], what);
    u8(idx(CAT_ELEMENTS, e.kind, what), what); f32(e.x, what); f32(e.y, what); u8(e.facing, what);
    f32(e.w, what); f32(e.d, what); f32(e.z, what); f32(e.h, what);
    u8(e.material ? 1 : 0, what);
    if (e.material) mat(e.material, what);
  }
}
const b64 = Buffer.from(Uint8Array.from(bytes)).toString('base64');
// Generated data, not code: the page and the workers import it as JSON.
fs.writeFileSync(outPath, JSON.stringify({ names, bytes: b64 }));
console.log(`${files.length} projects, ${bytes.length} bytes -> ${outPath}`);
