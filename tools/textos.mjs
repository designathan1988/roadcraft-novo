// Checks the interface's dictionary: every key the code asks for (t('…'), plural('…'), keys in tables) exists
// in Portuguese and in English, and both languages have the same keys.
// Use: node tools/textos.mjs   (exit code 1 when something is missing)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keysOf = (file) => new Set([...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
const pt = new Set([...keysOf('data/textos-roadcraft/pt-BR.ts'), ...keysOf('src/ui/lang/engine.pt-BR.ts')]);
const en = new Set([...keysOf('data/textos-roadcraft/en.ts'), ...keysOf('src/ui/lang/engine.en.ts')]);

const files = [...fs.readdirSync(path.join(root, 'src/ui')).filter((f) => f.endsWith('.ts')).map((f) => `src/ui/${f}`), 'src/main.ts'];
const wanted = new Map();
const want = (k, f) => { if (!wanted.has(k)) wanted.set(k, f); };
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) want(m[1], f);
  for (const m of src.matchAll(/\bplural\('([a-zA-Z0-9_.]+)'/g)) { want(`${m[1]}.one`, f); want(`${m[1]}.other`, f); }
  // keys written as table entries: 'some.key' next to a comma or bracket, with at least one dot and no spaces
  for (const m of src.matchAll(/['"]((?:[a-z][a-zA-Z0-9]*\.)+[a-zA-Z0-9]+)['"]/g)) {
    const k = m[1];
    if (/\.(ts|css|js|png|json)$/.test(k) || /^(cidade|roadcraft)\./.test(k)) continue;
    if (pt.has(k) || en.has(k) || /^(ui|hint|help|v2|tool|zone|sim|camera|menu|paint|quality|catalog|profile|profileEditor|inspector|junction|transit|terrain|el|tree|cloud|fog|weather|water|sign|streetscape|barrier|pole|road|roadFurniture|cutSides|roadKeys|status|sky|inside|builder|building|action|about|compass|health|strike|actions|palette|control|connectors|gfx|atmo|fmt|economy|map)\./.test(k)) want(k, f);
  }
}
// keys built from a template in the code
for (const c of ['roads', 'zones', 'build', 'landscape', 'transit', 'demolish', 'info']) { want(`v2.dock.${c}`, 'hud.ts'); want(`ui.cat.${c}`, 'hud.ts'); }
for (const z of ['residential', 'commercial', 'industrial', 'mixed', 'low', 'medium', 'high']) want(`zone.${z}`, 'drawers.ts');
for (let z = 0; z <= 8; z++) want(`zone.name.${z}`, 'drawers.ts');
for (const tl of ['camera', 'inspect', 'road', 'curve', 'roundabout', 'upgrade', 'blocks', 'free', 'move', 'split', 'bulldoze', 'zone', 'building', 'transit', 'streetscape', 'barrier', 'raise', 'lower', 'smooth', 'flatten', 'paint', 'forest', 'river', 'weather', 'landform', 'elements', 'sky', 'person', 'pistol', 'bomb']) want(`ui.toolName.${tl}`, 'hud.ts');
for (const tb of ['stop', 'terminal', 'trainStation', 'metroStation', 'trainTrack', 'metroTrack']) want(`ui.transit.help.${tb}`, 'drawers.ts');
for (const m of ['bus', 'train', 'metro']) want(`transit.mode.${m}`, 'drawers.ts');
for (const n of ['grass', 'tallGrass', 'scrub', 'fern', 'clover', 'flowers', 'mushrooms', 'stones', 'pebbles', 'gravel', 'leaves', 'smoke', 'fire', 'steam', 'dust', 'soot', 'sparks', 'spray']) want(`el.kind.${n}`, 'drawers.ts');
for (const m of ['lay', 'eraseKind', 'eraseAll']) want(`el.mode.${m}`, 'drawers.ts');
for (const m of ['add', 'move', 'edit', 'remove']) want(`cloud.${m}`, 'drawers.ts');
for (const m of ['none', 'alternate', 'all']) want(`pole.lamps.${m}`, 'drawers.ts');
for (const m of ['complete', 'basic', 'none']) want(`roadFurniture.${m}`, 'drawers.ts');
for (const m of ['br', 'us', 'eu', 'classic']) want(`paint.${m}`, 'hud.ts');
for (const m of ['mesa', 'canyon', 'escarpment', 'sugarloaf']) want(`terrain.${m}`, 'drawers.ts');

for (const k of [...wanted.keys()]) if (wanted.has(`${k}.one`)) wanted.delete(k);
for (const tl of ['zone', 'inspect', 'paint', 'forest', 'elements', 'landform', 'person', 'pistol', 'bomb', 'weather', 'river', 'transit', 'raise', 'lower', 'smooth', 'flatten']) want(`hint.tool.${tl}`, 'hud.ts');
let bad = 0;
for (const [k, f] of [...wanted].sort()) {
  if (pt.has(`${k}.one`) && en.has(`${k}.one`)) continue;
  const miss = [!pt.has(k) && 'pt-BR', !en.has(k) && 'en'].filter(Boolean);
  if (miss.length) { console.log(`falta ${k} (${miss.join(', ')}) — ${f}`); bad++; }
}
for (const k of pt) if (!en.has(k)) { console.log(`só em pt-BR: ${k}`); bad++; }
for (const k of en) if (!pt.has(k)) { console.log(`só em en: ${k}`); bad++; }
console.log(`${wanted.size} chaves pedidas pelo código, ${pt.size} no dicionário; ${bad} problemas`);
process.exit(bad ? 1 : 0);
