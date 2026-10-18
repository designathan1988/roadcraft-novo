// Quanto do centro os lotes cobrem (fora do npm test, um núcleo só, sem GPU).
// Uso: node scripts/lotes.ts [mapa=16] [raio=600]
// Gera a malha viária da cidade, monta os lotes das células em volta do centro como o crescimento faz e
// mede a área dos lotes contra a área das quadras (célula menos o leito das vias).

const arg = (i: number, d: number) => { const v = Number(process.argv[2 + i]); return Number.isFinite(v) && process.argv[2 + i] !== undefined ? v : d; };
const MAPA = arg(0, 16), RAIO = arg(1, 600);
(globalThis as { name?: string }).name = `mapa=${MAPA}`;

const { generateCity } = await import('../src/jobs/cityGen.ts');
const { World } = await import('../src/world/world.ts');
const { buildLots } = await import('../src/jobs/lots.ts');
const { CELL_SIZE, MAP_CELLS } = await import('../src/config.ts');
const { cellOriginX, cellId } = await import('../src/core/grid.ts');
const { PROFILE_INFO } = await import('../src/roads/profiles.ts');

const city = generateCity(1);
const w = new World();
w.heights.fill(20); // chão plano acima do mar (o relevo não muda a cobertura no centro)
const ids: number[] = [];
for (let i = 0; i < city.nodes.length; i += 3) ids.push(w.roads.addNode({ x: city.nodes[i], z: city.nodes[i + 1], y: city.nodes[i + 2] }));
const nc = w.roads.nodes.cols;
for (let k = 0; k < city.segs.length; k += 5) {
  const a = ids[city.segs[k]], b = ids[city.segs[k + 1]];
  try { w.roads.addSeg({ a, b, cx: (nc.x[a] + nc.x[b]) / 2, cz: (nc.z[a] + nc.z[b]) / 2, profile: city.segs[k + 2], flags: 0, zl: city.segs[k + 3], zr: city.segs[k + 4] }); } catch { /* igual ao jogo */ }
}
const cx = city.centers[0], cz = city.centers[1];
const net = w.roads, sc = net.segs.cols;
let lotArea = 0, roadArea = 0, cells = 0, lots = 0;
for (let j = 0; j < MAP_CELLS; j++) for (let i = 0; i < MAP_CELLS; i++) {
  const x0 = cellOriginX(i), z0 = cellOriginX(j);
  if (Math.hypot(x0 + CELL_SIZE / 2 - cx, z0 + CELL_SIZE / 2 - cz) > RAIO) continue;
  const segs: number[] = [];
  net.forSegsNear(x0 - 160, z0 - 160, x0 + CELL_SIZE + 160, z0 + CELL_SIZE + 160, (s) => segs.push(s));
  if (!segs.length) continue;
  const l = buildLots(w.heights, net.gather(segs, []), cellId(i, j));
  cells++; lots += l.count;
  for (let k = 0; k < l.count; k++) lotArea += l.w[k] * l.d[k];
  // leito das vias dentro da célula (aproximado pelo meio do trecho)
  for (const s of segs) {
    const mx = (nc.x[sc.a[s]] + nc.x[sc.b[s]]) / 2, mz = (nc.z[sc.a[s]] + nc.z[sc.b[s]]) / 2;
    if (mx < x0 || mx >= x0 + CELL_SIZE || mz < z0 || mz >= z0 + CELL_SIZE) continue;
    roadArea += sc.len[s] * PROFILE_INFO[sc.profile[s]].right * 2;
  }
}
const area = cells * CELL_SIZE * CELL_SIZE;
console.log(`centro ${RAIO} m: ${cells} células, ${lots} lotes; lotes cobrem ${(lotArea / (area - roadArea) * 100).toFixed(0)}% da área fora das vias (vias ${(roadArea / area * 100).toFixed(0)}%)`);
