(async () => {
  const g = __cidade.game, a = g.api, w = g.world, H = g.hudActions;
  const errs = [];
  const oe = console.error.bind(console);
  console.error = (...x) => { errs.push(x.map(String).join(' ').slice(0, 200)); oe(...x); };
  window.addEventListener('error', (e) => errs.push('erro: ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errs.push('promessa: ' + (e.reason && e.reason.message || e.reason)));
  const res = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = async (name, fn) => {
    const e0 = errs.length;
    try {
      const r = await fn();
      if (r !== true && r !== undefined) res.push(`FALHOU ${name}: ${r}`);
      else if (errs.length > e0) res.push(`FALHOU ${name}: erro no console: ${errs.slice(e0).join(' | ')}`);
      else res.push(`OK ${name}`);
    } catch (e) { res.push(`FALHOU ${name}: ${e && e.message || e}`); }
    console.log('VER ' + res[res.length - 1]); // na hora: se o roteiro travar, a última linha diz onde
  };
  const net = w.roads, sc = net.segs.cols;
  const segs = () => net.segs.size, blds = () => w.buildings.size, items = () => w.items.size;
  const P = (x, z) => ({ x, y: 0, z });
  const rt = g.roadTool;
  const X = 1500, Z = 1500;
  // as ferramentas são verificadas em modo livre (o caixa dos preços do Roadcraft acaba no meio do roteiro); a economia
  // tem a verificação própria, com o caixa ligado só nela
  w.unlimited = true;
  // via que o roteiro precisa: recusada vira erro no console (a verificação em curso falha com o motivo)
  const road = (...x) => { const r = a.road(...x); if (r !== 'ok') console.error('via recusada: ' + r); return r; };
  const segNear = (x, z) => net.nearestSeg(x, z, 12)?.[0] ?? -1;
  const click = (tool, pts, setup) => { g.setTool(tool); rt.setMode(tool); setup && setup(); for (const p of pts) { rt.hover(P(p[0], p[1])); rt.click(P(p[0], p[1])); } };
  await g.view(X, Z, 0, 50, 500, 11);

  // ---------------- traçado
  await check('curva por três cliques', () => { const s = segs(); click('curve', [[X - 300, Z - 300], [X - 200, Z - 380], [X - 100, Z - 300]], () => rt.setProfile(0)); return segs() > s || 'curva não saiu'; });
  await check('traçado livre (arrastar)', () => {
    const s = segs(); g.setTool('free'); rt.setMode('free');
    if (!rt.freeBegin(P(X + 100, Z - 300))) return 'não começou';
    for (let i = 1; i <= 12; i++) rt.freeMove(P(X + 100 + i * 15, Z - 300 + Math.sin(i / 3) * 30));
    rt.freeEnd(P(X + 280, Z - 300)); return segs() > s || 'livre não saiu';
  });
  await check('encaixe de ângulo (15°)', () => {
    click('road', [[X - 300, Z + 300]], () => { rt.snapMode = 1; });
    rt.click(P(X - 150, Z + 300 + 37)); rt.snapMode = 0;
    const s = segNear(X - 225, Z + 318); if (s < 0) return 'sem via';
    const nc = net.nodes.cols, ang = Math.atan2(nc.z[sc.b[s]] - nc.z[sc.a[s]], nc.x[sc.b[s]] - nc.x[sc.a[s]]) * 180 / Math.PI;
    const r = ((ang % 15) + 15) % 15; return r < 0.5 || r > 14.5 || `ângulo ${ang.toFixed(1)}°`;
  });
  await check('quarteirões de uma vez', () => { const s = segs(); click('blocks', [[X + 700, Z + 700]], () => { rt.blocks = { cols: 2, rows: 2, size: 100, angle: 0 }; }); return segs() >= s + 12 || `só ${segs() - s} trechos`; });
  const midVsEnd = (z) => { const nc = net.nodes.cols; const m = net.nearestNode(X, z, 60); return m >= 0 ? nc.y[m] - a.ground(nc.x[m], nc.z[m]) : NaN; };
  await check('ponte (via elevada)', () => { road(X - 300, Z + 600, X + 300, Z + 600, 'Avenida', 9); const d = midVsEnd(Z + 600); return d > 5 || `meio a ${d} m do chão`; });
  await check('túnel (via rebaixada)', () => { road(X - 300, Z + 800, X + 300, Z + 800, 'Avenida', -10); const d = midVsEnd(Z + 800); return d < -5 || `meio a ${d} m do chão`; });
  await check('corte com muro de arrimo', () => { rt.cutWalls = true; road(X - 300, Z + 1000, X + 300, Z + 1000, 'Rua local', -4); rt.cutWalls = false; const s = segNear(X, Z + 1000); return s >= 0 && (sc.flags[s] & 8) !== 0 || 'sem marca de muro'; });
  await check('trocar perfil da via', () => { road(X - 300, Z - 600, X + 300, Z - 600, 'Rua local'); const s = segNear(X + 50, Z - 600); const p0 = sc.profile[s]; click('upgrade', [[X + 50, Z - 600]], () => rt.setProfile(3)); return sc.profile[segNear(X + 50, Z - 600)] !== p0 || 'perfil igual'; });
  await check('rotatória com raio', () => { road(X - 300, Z - 900, X + 300, Z - 900, 'Avenida'); road(X, Z - 1200, X, Z - 600 - 10, 'Avenida'); rt.ringRadius = 30; const s = segs(); click('roundabout', [[X, Z - 900]]); return segs() > s || 'sem rotatória'; });
  await check('mobiliário automático marcado na via', () => { rt.furniture = 2; road(X + 400, Z - 300, X + 600, Z - 300, 'Rua local'); rt.furniture = 0; const s = segNear(X + 500, Z - 300); return s >= 0 && (sc.flags[s] >> 1 & 3) !== 0 || `flags ${sc.flags[s]}`; });
  await check('regras de construção dão o motivo', () => { const r = a.road(X - 300, Z - 900, X + 300, Z - 900, 'Avenida'); return typeof r === 'string' && r !== 'ok' && r.length > 3 || `aceitou uma via em cima de outra (${r})`; });
  await check('economia: construir cobra, demolir devolve um quarto, sem saldo recusa', () => {
    w.unlimited = false; w.money = 10_000_000;
    const m0 = w.money; road(X + 400, Z + 200, X + 600, Z + 200, 'Avenida'); const m1 = w.money;
    const n = a.demolish(X + 450, Z + 190, X + 550, Z + 210); const m2 = w.money;
    w.money = 100; const s0 = segs(); const r = a.road(X + 400, Z + 260, X + 600, Z + 260, 'Avenida'); const refused = segs() === s0 && w.money === 100 && r !== 'ok';
    w.unlimited = true;
    return m1 < m0 && n > 0 && m2 > m1 && m2 - m1 < (m0 - m1) * 0.3 && refused || `dinheiro ${m0} -> ${m1} -> ${m2}, demolidos ${n}, sem saldo: ${r}`;
  });

  // ---------------- cruzamento
  road(X - 300, Z - 1500, X + 300, Z - 1500, 'Avenida'); road(X, Z - 1800, X, Z - 1200 - 10, 'Rua local');
  const node = () => net.nearestNode(X, Z - 1500, 20);
  for (const [ctl, nome] of [[2, 'placas (preferencial)'], [3, 'pare em todos'], [4, 'dar preferência'], [5, 'minirrotatória'], [6, 'sem controle'], [1, 'semáforo']])
    await check(`controle do cruzamento: ${nome}`, async () => { a.junction(X, Z - 1500, ctl); await wait(150); return net.junctions.get(node())?.ctl === ctl || 'não gravou'; });
  await check('semáforo fixo, verdes, defasagem e ônibus', async () => { const n = node(); net.setJunction(n, { ctl: 1, fixed: true, greens: [30, 15], offset: 7, bus: true }); await wait(200); const j = net.junctions.get(n); return j.fixed && j.greens[0] === 30 && j.offset === 7 && j.bus || 'campos perdidos'; });
  await check('regra por braço e movimento proibido', async () => { const n = node(); const ss = net.segsOf(n, []); net.setJunction(n, { ctl: 2, legs: [[ss[0], 2]], bans: [ss[0], ss[1]] }); await wait(200); const j = net.junctions.get(n); return j.legs?.length === 1 && j.bans?.length === 2 || 'não gravou'; });
  await check('altura do nó', () => { const n = node(); const y0 = net.nodes.cols.y[n]; const r = a.edit('move', X, Z - 1500, X, Z - 1500); return r === 'ok' || r === 'recusado' || r; });

  // ---------------- simulação
  await check('pausar e voltar', () => { const p0 = g.paused; g.togglePause(); const p1 = g.paused; g.togglePause(); return p0 !== p1 || 'não pausou'; });
  await check('mapa de congestionamento', () => { H.trafficView(); H.trafficView(); return true; });
  await check('métricas e pedestres da simulação', async () => { await wait(3000); const s = g.stats(); return s.cars > 0 && s.peds >= 0 || `stats ${JSON.stringify(s)}`; });
  await check('terminal de ônibus', () => { const n = g.transit.terminals.length; a.line(0, [X - 250, Z + 1000 + 8, X + 250, Z + 1000 + 8], 2); g.clickTransit(P(X + 250, Z + 1008)); return true; });
  await check('trem: trilho e linha', () => { const n = g.transit.lines.length; road(X - 600, Z + 1300, X + 600, Z + 1300, 'Ferrovia dupla'); a.line(1, [X - 500, Z + 1300, X + 500, Z + 1300], 1); return g.transit.lines.length > n || 'linha de trem não criada'; });

  // ---------------- zonas, lotes, prédios
  await check('zonas de densidade alta crescem mais alto', async () => { road(X + 800, Z - 1000, X + 1100, Z - 1000, 'Avenida'); a.zone(X + 950, Z - 1000, 150, 6); await a.grow(); let max = 0; w.buildingIndex.query(X + 780, Z - 1100, X + 1120, Z - 900, (b) => { max = Math.max(max, w.buildings.cols.floors[b]); }); return max >= 4 || `máx ${max} andares`; });
  await check('zonear a quadra inteira', () => { g.setTool('zone'); H.zoneFill(true); g.zoneTool.zone = 1; const r = g.zoneTool.fillBlock(X + 750, Z + 750); H.zoneFill(false); return r === 'ok' || r; });
  const lot = a.lot(X + 1200, Z + 20, X + 1240, Z + 20, X + 1240, Z + 60, 1, 3);
  await check('dividir lote', () => { const b = blds(); g.setTool('building'); H.lotMode('split'); H.lotSplit('side', 2); g.clickLotTool(P(X + 1220, Z + 40)); return blds() > b || 'não dividiu'; });
  await check('juntar lotes', () => { const b = blds(); H.lotMode('join'); g.clickLotTool(P(X + 1210, Z + 40)); g.clickLotTool(P(X + 1230, Z + 40)); return blds() < b || 'não juntou'; });
  await check('definir frente do lote', () => { H.lotMode('front'); g.clickLotTool(P(X + 1220, Z + 60)); return true; });
  await check('apagar construção e depois o lote', () => { const b = blds(); H.lotMode('delete'); g.clickLotTool(P(X + 1220, Z + 40)); g.clickLotTool(P(X + 1220, Z + 40)); return blds() < b || 'não apagou'; });
  await check('editar andares, estilo e função cívica', () => { let id = -1; w.buildingIndex.query(X - 200, Z - 200, X + 200, Z + 200, (b) => { if (id < 0 && w.buildings.cols.floors[b] > 0) id = b; }); if (id < 0) id = a.lot(X + 1300, Z + 20, X + 1340, Z + 20, X + 1340, Z + 60, 1, 3); g.select(id); const f = w.buildings.cols.floors[id]; g.editSelected(2); g.editSelected(0, 3); g.editSelected(0, undefined, 14); return w.buildings.cols.fn[id] === 14 && w.buildings.cols.floors[id] === f + 2 || `fn ${w.buildings.cols.fn[id]} andares ${f}->${w.buildings.cols.floors[id]}`; });
  await check('ver por dentro, andar por andar', () => { g.insideCmd('toggle'); const on = g.inside.on; g.insideCmd('up'); g.insideCmd('toggle'); return on || 'não abriu'; });

  // ---------------- natureza, rua, efeitos
  for (const [k, nome] of [[13, 'fumaça'], [14, 'fogo'], [15, 'vapor'], [16, 'chafariz'], [26, 'poeira'], [27, 'fuligem'], [28, 'faíscas'], [29, 'borrifo'], [41, 'palmeira'], [42, 'névoa']])
    await check(`efeito/item: ${nome}`, () => { const n = items(); a.item(X - 900 + k * 9, Z - 900, k); return items() > n || 'não entrou'; });
  await check('muros e cercas (linha)', () => { const n = items(); g.setTool('barrier'); g.itemTool.setMode('barrier'); g.itemTool.row(X - 900, Z - 800, X - 800, Z - 800); return items() > n || 'sem muro'; });
  await check('árvore uma por clique', () => { const n = items(); g.plantTree(X - 950, Z - 700); return items() >= n || 'sem árvore'; });
  await check('aplainar o mapa', () => { const c0 = window.confirm; window.confirm = () => true; H.flattenMap(); window.confirm = c0; return true; });

  // ---------------- céu e clima
  for (const m of ['dia', 'noite', 'ciclo']) await check(`céu: ${m}`, () => { H.sky(m); return g.skyMode === m || `ficou ${g.skyMode}`; });
  await check('clima ajustável', () => { H.weather({ rain: 0.6, wind: 0.5, dir: 90, lightning: 4, thunder: 1 }); H.weather(null); return true; });
  await check('nuvens: espalhar e apagar', () => { H.scatterClouds(6, 0.5); const n = g.clouds.length; H.clearClouds(); return n > 0 && g.clouds.length === 0 || `nuvens ${n}`; });
  await check('neblina geral', () => { H.fogLevel(2); H.fogLevel(1); return true; });

  // ---------------- painéis
  const visible = (sel) => [...document.querySelectorAll(sel)].some((e) => e.offsetParent !== null);
  await check('opções abrem', async () => { H.options(); await wait(200); const ok = [...document.querySelectorAll('div,section')].some((e) => e.offsetParent !== null && /Gráficos|Qualidade|Opções/.test(e.textContent || '') && e.children.length > 3); document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })); return ok || 'painel não apareceu'; });
  await check('ajuda e sobre', async () => { H.help(); await wait(200); const ok = /Sobre|versão|Ajuda/i.test(document.body.innerText); H.help(); return ok || 'ajuda não apareceu'; });
  await check('grade, norte e vistas da câmera', () => { H.grid(); H.grid(); H.north(); H.view('top'); H.view('iso'); H.view('persp'); return true; });
  await check('saúde do jogo (F9)', async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9', key: 'F9', bubbles: true })); await wait(300); const ok = /quadro|ms|memória/i.test(document.body.innerText); window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9', key: 'F9', bubbles: true })); return ok || 'painel F9 não apareceu'; });
  await check('salvamento automático', async () => { g.unsaved = true; g.autosaveAt = 0; await wait(2500); return g.unsaved === false || 'não salvou sozinho'; });

  console.log('VERIFICAÇÃO2 ' + JSON.stringify({ ok: res.filter((r) => r.startsWith('OK')).length, falhas: res.filter((r) => r.startsWith('FALHOU')).length }));
})()
