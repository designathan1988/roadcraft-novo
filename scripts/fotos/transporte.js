// Foto do transporte: ferrovia cruzando ruas (passagem de nível) com uma linha de trem; espera a cancela descer com o
// trem chegando e aponta a câmera para o cruzamento (carros parados na rua, trem passando). Também uma linha de ônibus
// de ida e volta: as paradas da volta ficam do outro lado da rua.
(async () => {
  const g = __cidade.game, a = g.api, w = g.world, net = w.roads, X = 1500, Z = 1500;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  w.unlimited = true;
  a.road(X - 700, Z, X + 700, Z, 'Ferrovia dupla');
  for (const dx of [-350, 0, 350]) a.road(X + dx, Z - 300, X + dx, Z + 300, 'Rua local');
  a.road(X - 350, Z + 200, X + 350, Z + 200, 'Rua local');
  a.zone(X, Z + 250, 300, 1); a.zone(X, Z - 200, 300, 2);
  await a.grow();
  a.line(1, [X - 650, Z, X + 650, Z], 2);
  a.line(0, [X - 300, Z + 209, X - 100, Z + 209, X + 100, Z + 209, X + 300, Z + 209], 3);
  const sig = new Uint8Array(g.signalsSab);
  const node = net.nearestNode(X, Z, 5);
  let down = false;
  let probe = null;
  for (let k = 0; k < 240 && !down; k++) { await wait(500); probe = await a.manoeuvres(); down = (sig[node] & 128) !== 0 || probe.crossings.length > 0; }
  const st = g.simStats?.lines ?? [];
  console.log('RESULTADO transporte ' + JSON.stringify({ cancelaDesceu: down, no: node, fechadas: probe?.crossings, trens: probe?.trains, linhas: st.map((l) => ({ id: l.id, veiculos: l.buses, esperando: l.waiting, porHora: l.perHour })) }));
  if (down) { if (!g.paused) g.togglePause(); }
  const at = probe?.crossings?.length ? probe.crossings[0] : node; await g.view(net.nodes.cols.x[at], net.nodes.cols.z[at], 35, 50, 110, 11);
})()
