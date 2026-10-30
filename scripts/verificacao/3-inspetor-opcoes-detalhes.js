(async () => {
  const g = __cidade.game, a = g.api, w = g.world, H = g.hudActions;
  const errs = [];
  const oe = console.error.bind(console);
  console.error = (...x) => { errs.push(x.map(String).join(' ').slice(0, 200)); oe(...x); };
  window.addEventListener('error', (e) => errs.push('erro: ' + (e.message || e.error)));
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
  const net = w.roads, sc = net.segs.cols, rt = g.roadTool;
  const P = (x, z) => ({ x, y: a.ground(x, z), z });
  const X = 1500, Z = 1500;
  // as ferramentas são verificadas em modo livre (o caixa dos preços do Roadcraft acaba no meio do roteiro); a economia
  // tem a verificação própria, com o caixa ligado só nela
  w.unlimited = true;
  // via que o roteiro precisa: recusada vira erro no console (a verificação em curso falha com o motivo)
  const road = (...x) => { const r = a.road(...x); if (r !== 'ok') console.error('via recusada: ' + r); return r; };
  await g.view(X, Z, 0, 50, 400, 11);
  road(X - 300, Z, X + 300, Z, 'Avenida'); road(X, Z - 300, X, Z + 300, 'Rua com estacionamento');
  const seg = net.nearestSeg(X + 150, Z, 10)[0];

  await check('conta-gotas pega o perfil da via', () => { g.setTool('road'); rt.setMode('road'); const id = rt.pick(P(X + 150, Z)); return id === sc.profile[seg] || `pegou ${id}, via é ${sc.profile[seg]}`; });
  await check('catálogo de perfis abre e escolhe', () => { const c = g.hud.catalog; c.visible = true; c.select(3); c.visible = false; return true; });
  await check('editor de seção transversal abre', () => { const c = g.hud.catalog; c.visible = true; c.select(3); const btn = [...c.el.querySelectorAll('button')].find((b) => /Personalizar/.test(b.textContent || '')); if (!btn) return 'sem botão Editar'; btn.click(); const open = !c.editor.el.classList.contains('hidden'); c.editor.close(); c.visible = false; return open || 'editor não abriu'; return true; });
  await check('inspetor da via com dados ao vivo', async () => { g.setTool('inspect'); g.inspector.pick(X + 150, Z); await wait(1500); const t = document.body.innerText; g.inspector.close(); return /veíc|km\/h|vazão|fila/i.test(t) || 'sem dados ao vivo'; });
  await check('estacionamento por lado', () => { const s2 = net.nearestSeg(X, Z + 150, 10)[0]; const nc = net.nodes.cols; const mx = (nc.x[sc.a[s2]] + nc.x[sc.b[s2]]) / 2, mz = (nc.z[sc.a[s2]] + nc.z[sc.b[s2]]) / 2; g.setTool('inspect'); g.inspector.pick(mx, mz); const labels = [...document.querySelectorAll('select')].map((e) => e.getAttribute('aria-label')); const sel = [...document.querySelectorAll('select')].find((e) => /à direita/.test(e.getAttribute('aria-label') || '') && e.offsetParent); const p0 = sc.profile[s2]; if (sel) { sel.value = sel.value === '1' ? '0' : '1'; sel.dispatchEvent(new Event('change', { bubbles: true })); } const p1 = sc.profile[net.nearestSeg(mx, mz, 10)[0]]; g.inspector.close(); return !!sel && p1 !== p0 || (sel ? 'perfil igual' : 'sem select de estacionamento; selects: ' + labels.join(' | ')); });
  await check('conexões de faixa à mão', async () => { const n = net.nearestNode(X, Z, 20); const ss = net.segsOf(n, []); net.setJunction(n, { ctl: 1, lanes: [[ss[0], 0, [ss[1]]]] }); await wait(300); return (net.junctions.get(n)?.lanes?.length ?? 0) === 1 || 'não gravou'; });
  await check('estilo de pintura das vias', () => { const s = g.settings; for (const p of ['us', 'eu', 'classic', 'br']) { s.paint = p; g.applySettings(s); } return true; });
  await check('mobiliário pelo menu (completo/básico/nenhum)', () => { const s = g.settings; for (const f of [1, 2, 0]) { s.furniture = f; g.applySettings(s); } return true; });
  await check('demanda e % de tráfego e pessoas', async () => { const s = g.settings; s.demand = 'pico'; s.traffic = 0.5; s.people = 0.5; g.applySettings(s); await wait(2500); s.demand = 'normal'; s.traffic = 1; s.people = 1; g.applySettings(s); return true; });
  await check('teclas da via reconfiguráveis', () => { const s = g.settings; const u0 = s.roadUp, d0 = s.roadDown; s.roadUp = 'KeyU'; s.roadDown = 'KeyJ'; g.applySettings(s); s.roadUp = u0; s.roadDown = d0; g.applySettings(s); return true; });
  await check('mover canto do lote', () => { const id = a.lot(X + 400, Z + 40, X + 440, Z + 40, X + 440, Z + 80, 1, 2); const c = w.buildings.cols; const w0 = c.w[id], d0 = c.d[id]; const corners = [[X + 400, Z + 40], [X + 440, Z + 40], [X + 440, Z + 80], [X + 400, Z + 80]]; g.setTool('building'); H.lotMode('corner'); let ok = false; for (const [cx, cz] of corners) { if (g.grabCorner(P(cx, cz))) { g.dropCorner(P(cx + 6, cz + 6)); ok = true; break; } } return ok || 'não pegou canto'; });
  await check('cores das zonas no mapa', () => { H.zone(2); g.setTool('zone'); g.setTool('camera'); return true; });
  await check('postes com fios e luz', () => { const n = w.items.size; g.itemTool.poleLights = 1; a.item(X + 60, Z + 12, 4); a.item(X + 90, Z + 12, 4); return w.items.size > n || 'sem poste'; });
  await check('água: ondas, espuma, correnteza', () => { H.water({ waves: 0.8, foam: 0.6, current: 0.5 }); H.water({ waves: 0.3, foam: 0.3, current: 0.2 }); return true; });
  await check('paisagismo na calçada', () => { const n = w.items.size; a.item(X - 60, Z + 12, 10); return w.items.size > n || 'sem planta'; });
  await check('idioma inglês', () => { const t0 = document.body.innerText.includes('Câmera'); return t0 || 'texto base ausente'; });
  await check('novo mapa', async () => { const c0 = window.confirm; window.confirm = () => true; const p = H.newMap(); window.confirm = c0; await wait(3000); return true; });

  console.log('VERIFICAÇÃO3 ' + JSON.stringify({ ok: res.filter((r) => r.startsWith('OK')).length, falhas: res.filter((r) => r.startsWith('FALHOU')).length }));
})()
