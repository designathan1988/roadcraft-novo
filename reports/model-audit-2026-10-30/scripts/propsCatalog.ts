/// <reference types="node" />
// Every prop kind the props pool draws (render/propMeshes.ts buildPropDefs/buildPropKinds), per level: vertices,
// triangles, bytes, welding potential, size, level distances; plus the 4.0 building part models (r40 kit.ts
// partGeometries) as they are before the pool flattens them. Writes data/props.json and sheets/props-*.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildPropDefs, buildPropKinds } from '../../../src/render/propMeshes.ts';
import { PROP, PROP_TYPES } from '../../../src/jobs/props.ts';
import { POOL_PARTS } from '../../../src/jobs/parts40.ts';
import { partGeometries } from '../../../src/r40/api.ts';
import { geoStats, flatOfThree, pxPerMetre, type Geo } from './geom.ts';
import { grid, sheet } from './raster.ts';

const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(out + 'data', { recursive: true }); mkdirSync(out + 'sheets', { recursive: true });

const NAMES: Record<number, string> = {};
for (const [k, v] of Object.entries(PROP)) NAMES[v as number] = k;
const defs = buildPropDefs();
const { kinds, kindOf } = buildPropKinds(defs);
const subOf = new Map<number, number>();
const rows: unknown[] = [];
const thumbs: Array<{ name: string; caption: string; f: ReturnType<typeof flatOfThree> }> = [];
kinds.forEach((k, ki) => {
  const sub = subOf.get(k.type) ?? 0; subOf.set(k.type, sub + 1);
  const variants: number[] = [];
  for (let v = 0; v < 16; v++) if (kindOf[k.type * 16 + v] === ki) variants.push(v);
  const levels = k.lods.map((g, l) => {
    if (!g) return null;
    const s = geoStats(g as unknown as Geo);
    const size = Math.max(s.bbox[3] - s.bbox[0], s.bbox[4] - s.bbox[1], s.bbox[5] - s.bbox[2]);
    const start = l === 0 ? 0 : k.dist[l - 1];
    // the level's largest screen size: at its nearest distance (1080p, 45 deg)
    const px = start > 0 ? size * pxPerMetre(start) : Infinity;
    return { level: l, from: start, to: k.dist[l], ...s, sizeM: +size.toFixed(2), maxPx: Number.isFinite(px) ? +px.toFixed(1) : null, trisPerMaxPx: Number.isFinite(px) ? +(s.triangles / Math.max(1, px * px)).toFixed(3) : null };
  });
  const name = `${NAMES[k.type] ?? 'type' + k.type}${subOf.get(k.type)! > 1 || variants.length < 16 ? '#' + sub : ''}`;
  rows.push({ kind: ki, type: k.type, typeName: NAMES[k.type] ?? `type${k.type}`, sub, variants, radius: +k.radius.toFixed(2), dist: k.dist, levels });
  const g0 = k.lods.find((g) => g);
  if (g0) {
    const L = levels.filter(Boolean) as Array<{ level: number; triangles: number }>;
    thumbs.push({ name, caption: L.map((x) => `L${x.level} ${x.triangles}T`).join(' '), f: flatOfThree(g0 as unknown as Geo) });
  }
});

// the 4.0 kit's unit models (before the pool's part() flattens them to 56-byte non-indexed vertices)
const models = partGeometries() as unknown as Record<string, Geo>;
const kit = Object.entries(models).map(([kind, g]) => ({ kind, pooled: kind in POOL_PARTS ? POOL_PARTS[kind] : null, ...geoStats(g) }));

writeFileSync(out + 'data/props.json', JSON.stringify({ propTypes: PROP_TYPES, kinds: kinds.length, rows, kit }, null, 1));

// sheets: all kinds' first level in grids; trees and cars as single sheets per level
for (let i = 0; i < thumbs.length; i += 30) grid(out + `sheets/props-kinds-${1 + i / 30}.png`, `PROPS POOL KINDS ${i + 1}-${Math.min(thumbs.length, i + 30)} (FIRST LEVEL DRAWN; T = TRIANGLES PER LEVEL)`, thumbs.slice(i, i + 30), 6, 200);
grid(out + 'sheets/kit40-parts.png', 'ROADCRAFT 4.0 KIT PART MODELS (R40 KIT.TS PARTGEOMETRIES), UNIT SIZE', kit.map((k) => ({ name: k.kind, caption: `${k.triangles}T ${k.vertices}V ${k.indexed ? 'IDX' : 'NOIDX'}`, f: flatOfThree(models[k.kind]) })), 6, 200);
const one = (type: number, alt: number, label: string) => {
  const d = alt === 0 ? defs[type] : defs[type].alts![alt - 1];
  d.lods.forEach((g, l) => {
    if (!g) return;
    const s = geoStats(g as unknown as Geo);
    sheet(out + `sheets/prop-${label}-L${l}.png`, `${label} level ${l} (to ${d.dist[l]} m)`, [`${s.triangles} triangles, ${s.vertices} vertices (${s.indexed ? 'indexed' : 'not indexed'}), ${s.bytesPerVertex} B/vertex, ${(s.bytes / 1024).toFixed(1)} KB`, `weldable vertices ${s.weldable} (${(100 * s.weldable / Math.max(1, s.vertices)).toFixed(0)}%), tiny triangles ${s.tiny}, degenerate ${s.degenerate}`], flatOfThree(g as unknown as Geo));
  });
};
one(PROP.Tree, 0, 'mixed-tree'); one(PROP.Tree, 1, 'ipe-yellow'); one(PROP.Oak, 0, 'oak'); one(PROP.Conifer, 0, 'cypress'); one(PROP.Palm, 0, 'palm');
one(PROP.Bush, 0, 'shrub'); one(PROP.ParkedCar, 0, 'parked-sedan'); one(PROP.Lamp, 0, 'lamp'); one(PROP.Signal, 0, 'signal'); one(PROP.Ground, 0, 'ground-clutter');
one(PROP.Person, 0, 'creator-person');
console.log(`kinds ${kinds.length}, kit models ${kit.length}`);
