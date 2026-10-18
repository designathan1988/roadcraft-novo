(async () => {
  const g = __cidade.game, a = g.api, w = g.world;
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
  const segs = () => w.roads.segs.size, blds = () => w.buildings.size, items = () => w.items.size;
  const X = 1500, Z = 1500;
  // as ferramentas são verificadas em modo livre (o caixa dos preços do Roadcraft acaba no meio do roteiro); a economia
  // tem a verificação própria, com o caixa ligado só nela
  w.unlimited = true;
  // via que o roteiro precisa: recusada vira erro no console (a verificação em curso falha com o motivo)
  const road = (...x) => { const r = a.road(...x); if (r !== 'ok') console.error('via recusada: ' + r); return r; };

  // ---------------- interface: cada ferramenta e um clique no mapa
  const c = g.canvas;
  const rect = c.getBoundingClientRect();
  const clickAt = (fx, fy) => {
    const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
    const o = { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', bubbles: true, isPrimary: true };
    c.dispatchEvent(new PointerEvent('pointermove', { ...o, buttons: 0 }));
    c.dispatchEvent(new PointerEvent('pointerdown', o));
    c.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  };
  await g.view(X, Z, 0, 50, 300, 11);
  const TOOLS = ['camera', 'inspect', 'road', 'curve', 'free', 'roundabout', 'upgrade', 'blocks', 'move', 'split', 'bulldoze', 'zone', 'building', 'transit',
    'streetscape', 'barrier', 'raise', 'lower', 'smooth', 'flatten', 'landform', 'river', 'paint', 'elements', 'forest', 'weather', 'sky', 'person', 'pistol', 'bomb'];
  for (const t of TOOLS) await check(`ferramenta ${t} (botão e clique no mapa)`, async () => {
    const btn = [...document.querySelectorAll('#hud button')].find((b) => b.onclick || true);
    g.setTool(t);
    if (g.tool !== t) return `a ferramenta não ficou ativa (${g.tool})`;
    clickAt(0.45, 0.55); await wait(60); clickAt(0.55, 0.6); await wait(60);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    await wait(30);
  });
  // desfaz o que os cliques fizeram
  while (g.commands.undo()) { /* volta tudo */ }
  g.setTool('camera');

  // ---------------- vias
  await check('via reta', () => { const s = segs(); const r = a.road(X - 200, Z, X + 200, Z, 'Avenida'); return r === 'ok' && segs() > s ? true : `road=${r}`; });
  await check('via cruzando (cruzamento)', () => { const s = segs(); const r = a.road(X, Z - 200, X, Z + 200, 'Rua local'); return r === 'ok' && segs() > s + 1 ? true : `road=${r} segs ${s}->${segs()}`; });
  await check('desfazer e refazer', () => { const s = segs(); g.commands.undo(); const u = segs(); g.commands.redo(); return u < s && segs() === s ? true : `${s} -> ${u} -> ${segs()}`; });
  await check('dividir via', () => { const s = segs(); const r = a.edit('split', X + 130, Z); return r === 'ok' && segs() === s + 1 ? true : r; });
  await check('inverter via (mão única)', () => { road(X - 200, Z - 500, X + 200, Z - 500, 'Mão única, 2 faixas'); const sg = w.roads.nearestSeg(X + 50, Z - 500, 10)[0]; const a0 = w.roads.segs.cols.a[sg]; const r = a.edit('reverse', X + 50, Z - 500); const s2 = w.roads.nearestSeg(X + 50, Z - 500, 10)[0]; return r === 'ok' && w.roads.segs.cols.b[s2] === a0 ? true : r; });
  await check('duplicar via', () => { const r = a.edit('duplicate', X - 100, Z); return r === 'ok' || r; });
  await check('mover nó', () => { const r = a.edit('move', X + 100, Z, X + 110, Z + 5); return r === 'ok' || r; });
  await check('unir no nó', () => { const r = a.edit('join', X + 110, Z + 5); return r === 'ok' || r === 'recusado' || r; });
  await check('faixa zebra no meio da quadra', () => a.crossing(X, Z + 120, 9) === 'ok' || 'recusado');
  await check('faixa com semáforo', () => a.crossing(X, Z - 120, 10) === 'ok' || 'recusado');
  await check('retorno no canteiro', () => { road(X - 200, Z + 400, X + 200, Z + 400, 'Avenida com ciclovia'); const r = a.uturn(X + 50, Z + 400); return r === 'ok' || r; });
  await check('semáforo no cruzamento', () => { a.junction(X, Z, 1); const n = w.roads.nearestNode(X, Z, 20); return w.roads.junctions.get(n)?.ctl === 1 || 'controle não gravou'; });

  // ---------------- zonas, crescimento, lotes, criador
  await check('zonear e crescer prédios', async () => { const b = blds(); a.zone(X, Z, 150, 2); a.zone(X, Z, 150, 1); await a.grow(); await wait(500); return blds() > b ? true : `prédios ${b} -> ${blds()}`; });
  await check('lote desenhado', () => { const id = a.lot(X + 300, Z + 20, X + 330, Z + 20, X + 330, Z + 50, 1, 4); return id >= 0 || 'sem lote'; });
  await check('criador de prédios aplica projeto', () => {
    const id = g.selected; if (id < 0) return 'nada selecionado';
    g.applyDesign({ shape: 1, roof: 2, finish: 1, gear: 1, setback: 1, wall: 0xaa5533, windows: 2, wing: 3 }, 6);
    return (w.buildings.cols.color[id] >>> 31) === 1 || 'projeto não gravou';
  });

  // ---------------- transporte
  await check('linha de ônibus', () => { const n = g.transit.lines.length; a.line(0, [X - 150, Z, X + 150, Z, X, Z + 150], 3); return g.transit.lines.length > n || 'linha não criada'; });

  // ---------------- rua e natureza
  await check('item de rua (banco)', () => { const n = items(); a.item(X + 40, Z + 15, 6); return items() > n || 'item não entrou'; });
  await check('elementos do chão', () => { const n = items(); a.elements(31, X - 300, Z - 300); return items() > n || 'sem elementos'; });
  await check('pintar chão', () => { a.paint(X - 300, Z + 300, 30, 2); return true; });
  await check('floresta', () => { a.paint(X + 300, Z - 300, 40, 0, 'forest', 1); return true; });
  for (const m of ['raise', 'lower', 'smooth', 'flatten', 'mesa', 'canyon', 'escarpment', 'sugarloaf', 'gully'])
    await check(`terreno: ${m}`, () => { a.terrain(m, X - 600, Z - 600, 60, 0.4); return true; });
  await check('rio', () => { a.river([[X - 700, Z + 700], [X - 400, Z + 760], [X - 100, Z + 820]], 14); return true; });
  await check('bioma', () => { a.biome(2); a.biome(0); return true; });

  // ---------------- clima, céu, câmera
  await check('raio', () => { a.strike(); return true; });
  await check('seguir veículo', async () => { await wait(2000); a.follow(); a.follow(); return true; });
  await check('noite e dia', async () => { await g.view(X, Z, 30, 40, 300, 22); await wait(500); await g.view(X, Z, 30, 40, 300, 11); return true; });

  // ---------------- pessoas e ações
  await check('pessoa parada', () => { const n = items(); g.personSpec = { color: 3, height: 7, walk: false, count: 2 }; g.placePerson(X + 20, Z + 30); return items() >= n + 2 || 'pessoa não entrou'; });
  await check('pessoas andando', () => { g.personSpec = { color: 5, height: 7, walk: true, count: 5 }; g.placePerson(X + 20, Z + 30); return true; });
  await check('pistola', () => { g.shoot(X + 20, Z + 30); return true; });
  await check('bomba derruba prédio', () => {
    const col = w.buildings.cols; let id = -1;
    w.buildingIndex.query(X - 200, Z - 200, X + 200, Z + 200, (b) => { if (id < 0 && col.floors[b] > 0) id = b; });
    if (id < 0) return 'sem prédio para testar';
    const x = col.x[id], z = col.z[id]; g.bomb(x, z);
    let still = false; w.buildingIndex.query(x - 1, z - 1, x + 1, z + 1, (b) => { if (col.floors[b] > 0 && Math.hypot(col.x[b] - x, col.z[b] - z) < 1) still = true; });
    return !still || 'o prédio continuou de pé';
  });

  // ---------------- salvar, carregar, exportar
  await check('salvar e carregar mantém a cidade', async () => {
    const s = segs(), b = blds(), i = items();
    await g.save(); await wait(500);
    await g.load(); await wait(1500);
    return segs() === s && blds() === b && items() === i ? true : `vias ${s}/${segs()} prédios ${b}/${blds()} itens ${i}/${items()}`;
  });
  await check('exportar e abrir arquivo', async () => { const blob = await a.packMap(); if (!blob || !blob.size) return 'pacote vazio'; await a.openMap(blob); await wait(1500); return segs() > 0 || 'abriu vazio'; });

  // ---------------- desfazer tudo
  await check('desfazer tudo sem erro', () => { let n = 0; while (g.commands.undo() && n < 500) n++; return true; });

  console.log('VERIFICAÇÃO ' + JSON.stringify({ ok: res.filter((r) => r.startsWith('OK')).length, falhas: res.filter((r) => r.startsWith('FALHOU')).length }));
})()
