// Fotos das manobras (Reeds-Shepp, perto da câmera): bairro de ruas com vagas e galpões; espera a simulação e
// aponta a câmera para uma manobra em andamento. MANOBRA = 3 caminhão de ré na doca, 1 carro entrando na vaga,
// 2 saindo da vaga, 4 parado no meio-fio deixando passageiro. Uso com CIDADE_SEQ para várias fotos na sessão.
(async () => {
  const g = __cidade.game, a = g.api, w = g.world, X = 1500, Z = 1500;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (g.paused) g.togglePause();
  if (!w.roads.segs.size) {
    for (let i = 0; i < 4; i++) { a.road(X - 240, Z - 240 + i * 160, X + 240, Z - 240 + i * 160, 'Rua com estacionamento'); a.road(X - 240 + i * 160, Z - 240, X - 240 + i * 160, Z + 240, 'Rua com estacionamento'); }
    a.zone(X - 80, Z, 260, 1); a.zone(X + 80, Z + 80, 140, 2);
    await a.grow();
    // galpões com a frente para a rua (a doca fica no portão)
    for (const [x0, z0] of [[X - 200, Z - 232], [X - 40, Z - 232], [X + 120, Z - 232]]) a.lot(x0, z0, x0 + 60, z0, x0 + 60, z0 + 60, 3, 2);
    g.select(-1);
    await g.view(X, Z, 20, 50, 380, 11);
  }
  const want = Number(globalThis.MANOBRA ?? 3);
  let hit = null, info = null;
  for (let k = 0; k < 120 && !hit; k++) {
    await wait(1000);
    info = await a.manoeuvres();
    for (let i = 0; i < info.list.length; i += 4) if (info.list[i + 2] === want && info.list[i + 3] > 0.15 && info.list[i + 3] < 0.85) { hit = [info.list[i], info.list[i + 1]]; break; }
  }
  console.log('RESULTADO manobras ' + JSON.stringify({ quer: want, achou: hit, planejadas: info?.planned, meioFio: info?.kerbStops, docas: info?.docked, emAndamento: (info?.list.length ?? 0) / 4 }));
  if (hit) { if (!g.paused) g.togglePause(); await g.view(hit[0], hit[1], 30, 62, 55, 11); }
})()
