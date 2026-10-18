// Foto da economia das vias (roadcraft): avenida no chão, a mesma avenida elevada em ponte (2,5×), demolir devolve 25 %,
// sem saldo a obra é recusada. Uso: node tools/shot.mjs <png> "?vazio&hora=11&cam=1500,1500,30,45,520" "$(cat scripts/fotos/economia.js)"
(async () => {
  const g = __cidade.game, a = g.api, w = g.world, X = 1500, Z = 1500;
  const m0 = w.money;
  a.road(X - 250, Z - 80, X + 250, Z - 80, 'Avenida');
  const m1 = w.money;
  a.road(X - 250, Z + 80, X + 250, Z + 80, 'Avenida', 9);
  const m2 = w.money;
  const n = a.demolish(X - 60, Z - 95, X + 60, Z - 65);
  const m3 = w.money;
  w.money = 1000;
  const r = a.road(X - 250, Z + 220, X + 250, Z + 220, 'Avenida');
  const intact = w.money === 1000;
  w.money = m3;
  console.log('RESULTADO economia ' + JSON.stringify({ inicio: m0, chao: m0 - m1, ponte: m1 - m2, devolvido: m3 - m2, demolidos: n, semSaldo: r, saldoIntacto: intact }));
  await g.view(X, Z, 30, 45, 560, 11);
})()
