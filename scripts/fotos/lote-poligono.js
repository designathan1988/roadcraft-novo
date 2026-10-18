// Foto do lote em polígono: 5 cliques (pentágono), um lote dividido por uma linha e um lote com o lado curvado.
// O contorno de cada lote é marcado com muro pelo roteiro (a mureta seguindo o polígono é da sessão de prédios).
(async () => {
  const g = __cidade.game, a = g.api, w = g.world, X = 1500, Z = 1500;
  a.road(X - 200, Z - 40, X + 200, Z - 40, 'Rua local');
  const outline = () => {
    const col = w.buildings.cols;
    for (let id = 0; id < w.buildings.end; id++) {
      if (!w.buildings.alive[id]) continue;
      const o = w.lotOutline(id), c = Math.cos(col.rot[id]), s = Math.sin(col.rot[id]);
      const P = (k) => [col.x[id] + o[k] * c + o[k + 1] * s, col.z[id] - o[k] * s + o[k + 1] * c];
      for (let k = 0; k < o.length; k += 2) { const p = P(k), q = P((k + 2) % o.length); w.items.add([p[0], p[1], q[0], q[1], 21, 0]); }
    }
  };
  const pent = a.lotPoly([X - 150, Z - 25, X - 110, Z - 25, X - 100, Z + 5, X - 130, Z + 30, X - 158, Z + 8], 1);
  const sq = a.lotPoly([X - 40, Z - 25, X + 10, Z - 25, X + 10, Z + 25, X - 40, Z + 25], 2);
  a.lotLine(X - 25, Z - 35, X - 5, Z + 35);
  const cv = a.lotPoly([X + 60, Z - 25, X + 110, Z - 25, X + 110, Z + 20, X + 60, Z + 20], 1);
  a.lotCurve(X + 85, Z + 19, X + 85, Z + 32);
  outline();
  console.log('RESULTADO lotes ' + JSON.stringify({ pentagono: pent, cantos: [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]).map((i) => w.buildings.cols.shapeN[i]), lotes: w.buildings.size }));
  await g.view(X - 20, Z + 5, 0, 62, 210, 11);
})()
