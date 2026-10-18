// Foto do desgaste: uma rua crescida, o relógio da cidade anda 25 dias; metade dos prédios é reformada (Shift+clique).
(async () => {
  const g = __cidade.game, a = g.api, w = g.world, X = 1500, Z = 1500;
  a.road(X - 200, Z, X + 200, Z, 'Rua local');
  a.zone(X - 100, Z, 120, 1); a.zone(X + 100, Z, 120, 1);
  await a.grow();
  a.passTime(25 * 1440);
  const col = w.buildings.cols, ids = [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]);
  for (const id of ids) if (col.x[id] < X) a.renovate(col.x[id], col.z[id]);
  console.log('RESULTADO desgaste ' + JSON.stringify({ predios: ids.length, decayEsq: ids.filter((i) => col.x[i] < X).map((i) => col.decay[i]), decayDir: ids.filter((i) => col.x[i] >= X).map((i) => col.decay[i]), mudancas: w.decayChanges }));
  g.setTool('building'); g.select(ids.find((i) => col.x[i] >= X && col.floors[i] > 0) ?? -1); await g.view(X, Z, 20, 35, 260, 11);
})()
