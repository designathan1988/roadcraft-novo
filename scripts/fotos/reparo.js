// Foto do reparo de mapas antigos: uma ponta solta dentro de outra via (como num salvamento velho, sem encaixe)
// vira cruzamento ao abrir (aviso "Mapa reparado"). A quarentena está em quarentena.js.
(async () => {
  const g = __cidade.game, a = g.api, w = g.world, net = w.roads, X = 1500, Z = 1500;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  a.road(X - 200, Z, X + 200, Z, 'Rua local');
  const c = net.addNode({ x: X + 20, z: Z + 90, y: a.ground(X + 20, Z + 90) }), d = net.addNode({ x: X + 20, z: Z + 1, y: a.ground(X + 20, Z) });
  net.addSeg({ a: c, b: d, cx: X + 20, cz: Z + 45, profile: 0, flags: 0 });
  const before = net.nodes.cols.deg[d];
  await g.saving.save(); await wait(500);
  await g.saving.load(); await wait(1500);
  const n = net.nearestNode(X + 20, Z, 3);
  const repaired = { pontaAntes: before, noNovo: n, grauDepois: n >= 0 ? net.nodes.cols.deg[n] : -1 };
  console.log('RESULTADO reparo ' + JSON.stringify({ ...repaired, vias: net.segs.size }));
  await g.view(X + 20, Z, 20, 55, 160, 11);
})()
