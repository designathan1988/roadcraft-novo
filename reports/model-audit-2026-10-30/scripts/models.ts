/// <reference types="node" />
// models.md: one table of every model piece and level measured by the other scripts (the reference format of
// lab/roadcraft/reports/model-audit/models.md), sorted by triangles. Reads data/*.json only.
import { readFileSync, writeFileSync } from 'node:fs';

const out = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const j = (f: string) => JSON.parse(readFileSync(out + 'data/' + f, 'utf8'));
interface Row { model: string; piece: string; level: string; tris: number; verts: number; weld: number | string; degenerate: number | string; indexed: string; bpv: number | string; drawn: string; how: string }
const rows: Row[] = [];
const props = j('props.json');
for (const r of props.rows) r.levels.forEach((l: Record<string, number> | null) => {
  if (!l) return;
  rows.push({ model: `Props pool/${r.typeName}`, piece: r.variants.length === 16 ? 'all variants' : `variants ${r.variants.join(',')}`, level: `L${l.level}`, tris: l.triangles, verts: l.vertices, weld: l.weldable, degenerate: l.degenerate, indexed: l.indexed ? 'yes' : 'no', bpv: l.bytesPerVertex, drawn: `${l.from}-${l.to} m`, how: 'GPU-culled indirect draw per kind x level' });
});
for (const k of props.kit) rows.push({ model: 'R40 kit (source)', piece: k.kind, level: 'unit', tris: k.triangles, verts: k.vertices, weld: k.weldable, degenerate: k.degenerate, indexed: k.indexed ? 'yes' : 'no', bpv: k.bytesPerVertex, drawn: k.pooled ? `pool type ${k.pooled[0]}/${k.pooled[1]}` : 'into the shell', how: 'source model' });
const veh = j('vehicles.json');
for (const r of veh.rows) rows.push({ model: `Vehicles/${r.group}`, piece: r.name, level: r.group.startsWith('mid') ? 'mid' : 'near', tris: r.triangles, verts: r.vertices, weld: r.weldable, degenerate: r.degenerate, indexed: r.indexed ? 'yes' : 'no', bpv: r.bytesPerVertex, drawn: r.range, how: `instanced, cap ${r.cap}${r.castShadow ? ', shadow' : ''}${r.doubleSide ? ', double-sided' : ''}` });
const ppl = j('people.json');
ppl.rows.slice(0, 32).forEach((r: { variation: number; sex: string; band: string; levels: Array<{ level: number; triangles: number; padded: number; vertices: number }> }) => r.levels.forEach((l) => rows.push({ model: `People/cooked ${r.variation}`, piece: `${r.sex} ${r.band}`, level: `L${l.level}`, tris: l.triangles, verts: l.vertices, weld: '-', degenerate: '-', indexed: 'pulled', bpv: 32, drawn: ['>60 px', '15-60 px', '3-15 px'][l.level], how: `vertex pulling, draws ${l.padded} per instance` })));
const b = j('buildings.json');
for (const c of b.catalogue) for (const [lvl, key, drawn] of [['L0', 'L0', '0-700 m (cell)'], ['L1', 'L1', '700-1800 m (cell)'], ['L2', 'L2', '1800-4200 m (tile)'], ['L3', 'L3', '>4200 m (plate)'], ['detail', 'detail', '0-150 m (cell)']] as const) {
  if (!c[key]) continue;
  rows.push({ model: `Buildings/${c.kind}`, piece: `${c.floors} fl ${c.w}x${c.d} m (x${c.count} in city)`, level: lvl, tris: c[key], verts: c[key + 'v'] ?? '-', weld: lvl === 'L0' ? c.weldable0 : '-', degenerate: lvl === 'L0' ? c.degenerate0 : '-', indexed: 'yes', bpv: 24, drawn, how: 'merged into the cell/tile/plate mesh' });
}
const roads = j('roads.json');
for (const q of roads.quality) rows.push({ model: 'Roads', piece: q.tile !== undefined ? `tile ${q.tile} (heaviest)` : `cell ${q.cell} (heaviest)`, level: q.tile !== undefined ? 'tile lod1' : `lod${q.lod}`, tris: q.triangles, verts: q.vertices, weld: q.weldable, degenerate: q.degenerate, indexed: 'yes', bpv: 32, drawn: q.tile !== undefined ? '1400-5500 m' : q.lod === 0 ? '0-600 m' : '600-1400 m', how: 'one mesh per cell/tile' });
for (const r of j('ruins.json')) rows.push({ model: 'Demolition/ruin', piece: r.name, level: 'fractured', tris: r.ruinTriangles, verts: r.ruinVertices, weld: r.weldable, degenerate: '-', indexed: 'no', bpv: 36, drawn: 'any distance', how: '1 mesh per ruin, shadow' });
rows.push({ model: 'Terrain', piece: 'CDLOD patch 32x32', level: 'all', tris: 2048, verts: 1089, weld: 0, degenerate: 0, indexed: 'yes', bpv: 12, drawn: 'quadtree, 4 m to 64 m spacing', how: '1 instanced draw, up to 4096 patches' });
rows.push({ model: 'Terrain', piece: 'shadow copy patch 16x16', level: 'shadow', tris: 512, verts: 289, weld: 0, degenerate: 0, indexed: 'yes', bpv: 12, drawn: 'to 1600 m', how: 'instanced, up to 1024' });
rows.push({ model: 'Terrain', piece: 'grass tuft (7 blades)', level: '-', tris: 7, verts: 21, weld: 0, degenerate: 0, indexed: 'no', bpv: 28, drawn: '160x160 grid, eye < 140 m', how: '1 instanced draw, 25,600 tufts' });
rows.push({ model: 'Water', piece: 'tile grid 128x128 (8 m)', level: 'near', tris: 32768, verts: 16641, weld: 0, degenerate: 0, indexed: 'yes (u32)', bpv: 12, drawn: '< 1500 m', how: 'instanced per water tile' });
rows.push({ model: 'Water', piece: 'tile grid 32x32 (32 m)', level: 'far', tris: 2048, verts: 1089, weld: 0, degenerate: 0, indexed: 'yes (u32)', bpv: 12, drawn: '> 1500 m', how: 'instanced per water tile' });
rows.sort((p, q) => q.tris - p.tris);
const md = [
  `# Every model the game builds (${rows.length} pieces and levels)`,
  '',
  'Generated by `scripts/models.ts` from `data/*.json`. Triangles and vertices are the mesh as uploaded (props: after',
  '`part()` flattens them; vehicles: the batch base mesh). "Weldable" = vertices identical in every attribute to another',
  'vertex (what an index would remove). Trees: cards are expanded in the vertex shader, so their object-space cards are',
  'collapsed points and show as degenerate here by construction (not a defect). Buildings: one building of each kind,',
  'laid alone (the cell plan of its neighbours can change the landmark pick).',
  '',
  '| Model | Piece | Level | Triangles | Vertices | Weldable vertices | Degenerate triangles | Indexed | B/vertex | Drawn | How |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.model} | ${r.piece} | ${r.level} | ${r.tris.toLocaleString('en-US')} | ${typeof r.verts === 'number' ? r.verts.toLocaleString('en-US') : r.verts} | ${r.weld} | ${r.degenerate} | ${r.indexed} | ${r.bpv} | ${r.drawn} | ${r.how} |`),
  '',
];
writeFileSync(out + 'models.md', md.join('\n'));
console.log(rows.length, 'rows');
