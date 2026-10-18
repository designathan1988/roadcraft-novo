// Foto do crescimento do Roadcraft: rua zoneada crescendo devagar (2 prédios/s); o próximo lote é o livre mais
// perto do último, então a rua enche em sequência a partir do primeiro; no máximo 3 andares acima do vizinho.
(async () => {
  const g = __cidade.game, a = g.api, w = g.world, X = 1500, Z = 1500;
  a.road(X - 300, Z, X + 300, Z, 'Rua local');
  g.growth.rate = 2;
  a.zone(X - 150, Z, 170, 6); a.zone(X + 150, Z, 170, 6);
  await new Promise((r) => setTimeout(r, 7000));
  g.growth.rate = 0;
  const col = w.buildings.cols, ids = [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]);
  console.log('RESULTADO crescimento ' + JSON.stringify({ predios: ids.length, ordem: ids.map((i) => [Math.round(col.x[i] - X), Math.round(col.z[i] - Z), col.floors[i]]) }));
  await g.view(X, Z, 15, 40, 330, 11);
})()
