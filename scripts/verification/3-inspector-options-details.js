(async () => {
  const R = __roadcraft, a = R.actions, w = R.world, H = R.ui;
  const errs = [];
  const oe = console.error.bind(console);
  console.error = (...x) => { errs.push(x.map(String).join(' ').slice(0, 200)); oe(...x); };
  window.addEventListener('error', (e) => errs.push('error: ' + (e.message || e.error)));
  const res = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = async (name, fn) => {
    const e0 = errs.length;
    try {
      const r = await fn();
      if (r !== true && r !== undefined) res.push(`FAILED ${name}: ${r}`);
      else if (errs.length > e0) res.push(`FAILED ${name}: console error: ${errs.slice(e0).join(' | ')}`);
      else res.push(`OK ${name}`);
    } catch (e) { res.push(`FAILED ${name}: ${e && e.message || e}`); }
    console.log('VERIFY ' + res[res.length - 1]); // at once: if the script hangs, the last line says where
  };
  const net = w.roads, sc = net.segs.cols;
  const canvas = document.getElementById('view');
  const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  // a pointer gesture over world points, as the player drags it (the camera must see them)
  const drag = (pts) => pts.forEach(([x, z], i) => {
    const p = R.camera.toScreen(x, a.ground(x, z), z); if (!p) throw new Error('point behind the camera');
    const type = i === 0 ? 'pointerdown' : i === pts.length - 1 ? 'pointerup' : 'pointermove';
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y }));
  });
  const P = (x, z) => ({ x, y: a.ground(x, z), z });
  const X = 1500, Z = 1500;
  // the tools are checked with unlimited money (the prices would empty the cash halfway); the economy has its own
  // check, with the cash on only there
  w.unlimited = true;
  // a road the script needs: refused, it becomes a console error (the running check fails with the reason)
  const road = (...x) => { const r = a.road(...x); if (r !== 'ok') console.error('road refused: ' + r); return r; };
  await R.camera.view(X, Z, 0, 50, 400, 11);
  road(X - 300, Z, X + 300, Z, 'Avenida'); road(X, Z - 300, X, Z + 300, 'Rua com estacionamento');
  const seg = net.nearestSeg(X + 150, Z, 10)[0];

  // the interface text is the player's (in the game's language: pt-BR by default); the checks accept either language
  await check('eyedropper takes the road profile', () => { R.tools.set('road'); R.tools.click(X + 150, Z, { alt: true }); const id = R.tools.options().road.profile; return id === sc.profile[seg] || `took ${id}, the road is ${sc.profile[seg]}`; });
  await check('profile catalog opens and chooses', async () => { R.tools.set('road'); await wait(200); const open = !!document.querySelector('.rc-catalog')?.isConnected; const cards = [...document.querySelectorAll('.rc-catalog .rc-card')]; const card = cards[Math.min(3, cards.length - 1)]; if (!card) return 'no card'; const p0 = R.tools.options().road.profile; card.querySelector('.rc-card-main').click(); await wait(100); const now = document.querySelector('.rc-catalog .rc-card.on'); const chosen = now && now.querySelector('.rc-card-main').title === card.querySelector('.rc-card-main').title; return (open && chosen && R.tools.options().road.profile !== -1) || `open ${open}, chosen ${chosen}, profile ${p0} → ${R.tools.options().road.profile}`; });
  await check('cross-section editor opens', async () => { R.tools.set('road'); await wait(200); const card = document.querySelector('.rc-catalog .rc-card'); card.querySelector('.rc-card-main').click(); await wait(100); const btn = document.querySelector('.rc-catalog .rc-card.on .rc-custom.edit'); if (!btn) return 'no customize button'; btn.click(); await wait(100); const open = !!document.querySelector('.section-editor:not(.hidden)'); R.tools.set('camera'); return open || 'editor did not open'; });
  await check('road inspector with live data', async () => { R.tools.set('inspect'); R.tools.inspect(X + 150, Z); await wait(1500); const t = document.body.innerText; key('Escape'); return /veíc|km\/h|vazão|fila|vehic|flow|queue/i.test(t) || 'no live data'; });
  await check('parking per side', () => { const s2 = net.nearestSeg(X, Z + 150, 10)[0]; const nc = net.nodes.cols; const mx = (nc.x[sc.a[s2]] + nc.x[sc.b[s2]]) / 2, mz = (nc.z[sc.a[s2]] + nc.z[sc.b[s2]]) / 2; R.tools.set('inspect'); R.tools.inspect(mx, mz); const labels = [...document.querySelectorAll('select')].map((e) => e.getAttribute('aria-label')); const sel = [...document.querySelectorAll('select')].find((e) => /à direita|right/i.test(e.getAttribute('aria-label') || '') && e.offsetParent); const p0 = sc.profile[s2]; if (sel) { sel.value = sel.value === '1' ? '0' : '1'; sel.dispatchEvent(new Event('change', { bubbles: true })); } const p1 = sc.profile[net.nearestSeg(mx, mz, 10)[0]]; key('Escape'); return !!sel && p1 !== p0 || (sel ? 'same profile' : 'no parking select; selects: ' + labels.join(' | ')); });
  await check('lane connections by hand', async () => { const n = net.nearestNode(X, Z, 20); const ss = net.segsOf(n, []); net.setJunction(n, { ctl: 1, lanes: [[ss[0], 0, [ss[1]]]] }); await wait(300); return (net.junctions.get(n)?.lanes?.length ?? 0) === 1 || 'not stored'; });
  // the road paint is the map's, chosen in the main menu as an undoable edit (Roadcraft 4.0 setMarkingStyle)
  await check('road paint style', async () => { const seen = []; document.querySelector('[data-pop=menu]').click(); await wait(100); for (const p of ['us', 'eu', 'classic', 'br']) { const row = document.querySelector(`.v2-pop .v2-orow[aria-label="${R.t('menu.paint')}"]`); [...row.querySelectorAll('.v2-choice')].find((b) => b.textContent === R.t(`paint.${p}`)).click(); await wait(50); seen.push(R.world.look.paint); } R.history.undo(); const undone = R.world.look.paint; R.history.redo(); key('Escape'); return (seen.join() === 'us,eu,classic,br' && undone === 'classic' && R.world.look.paint === 'br') || `styles ${seen.join()}, undo ${undone}, redo ${R.world.look.paint}`; });
  await check('furniture from the menu (full/basic/none)', async () => { const seen = []; for (const f of [1, 2, 0]) { await R.options.apply({ furniture: f }); seen.push(R.tools.options().road.furniture); } return seen.join() === '1,2,0' || `the road tool's furniture ${seen.join()}`; });
  await check('demand and traffic and people share', async () => {
    // the demand goes to the simulation every 2 s (game.ts demandSent): a message with the new values must go out
    const t0 = R.sim.demandSentAt(); await R.options.apply({ demand: 'peak', traffic: 0.5, people: 0.5 }); const st = R.options.get(); const taken = st.demand === 'peak' && st.traffic === 0.5 && st.people === 0.5;
    await wait(2500); const sent = R.sim.demandSentAt() > t0;
    await R.options.apply({ demand: 'normal', traffic: 1, people: 1 }); return (taken && sent) || `option taken ${taken}, sent ${sent}`;
  });
  await check('road keys can be changed', async () => {
    // the new key raises the road being drawn (4 m a press, game.ts toolKey)
    const u0 = R.options.get().roadUp, d0 = R.options.get().roadDown; await R.options.apply({ roadUp: 'KeyU', roadDown: 'KeyJ' }); R.tools.set('road');
    const e0 = R.tools.options().road.elevation; key('KeyU'); const e1 = R.tools.options().road.elevation; const took = e1 !== e0;
    H.elevation(e0 - e1); await R.options.apply({ roadUp: u0, roadDown: d0 }); R.tools.set('camera');
    return (took && e1 === e0 + 4) || `new key: ${took}, height ${e0} → ${e1}`;
  });
  await check('move a lot corner', async () => { const id = a.lot(X + 400, Z + 40, X + 440, Z + 40, X + 440, Z + 80, 1, 2); if (id < 0) return 'no lot'; await R.camera.view(X + 420, Z + 60, 0, 70, 150); const shape = () => JSON.stringify(Object.values(w.buildings.cols).map((c) => c[id])); const before = shape(); R.tools.set('building'); H.lotMode('corner'); drag([[X + 440, Z + 40], [X + 443, Z + 43], [X + 446, Z + 46]]); await wait(100); return shape() !== before || 'the corner did not move'; });
  await check('zone colours on the map', () => { H.zone(2); R.tools.set('zone'); const ok = R.tools.options().zone.zone === 2 && R.tools.current() === 'zone'; R.tools.set('camera'); return (ok && R.tools.current() === 'camera') || `zone ${R.tools.options().zone.zone}, tool ${R.tools.current()}`; });
  await check('poles with wires and lights', () => { const n = w.items.size; H.poleLights(1); a.item(X + 60, Z + 12, 4); a.item(X + 90, Z + 12, 4); return w.items.size > n || 'no pole'; });
  await check('water: waves, foam, current', () => { H.water({ waves: 0.8, foam: 0.6, current: 0.5 }); const w1 = H.environment().water; H.water({ waves: 0.3, foam: 0.3, current: 0.2 }); const w2 = H.environment().water; return (w1.waves === 0.8 && w1.foam === 0.6 && w1.current === 0.5 && w2.waves === 0.3) || `water ${JSON.stringify(w1)} → ${JSON.stringify(w2)}`; });
  await check('planting on the sidewalk', () => { const n = w.items.size; a.item(X - 60, Z + 12, 10); return w.items.size > n || 'no plant'; });
  await check('English language', async () => {
    // the language menu's own action (R.setLang): the interface is written again in English, then back
    const before = document.body.innerText.includes('Câmera'); R.setLang('en'); await wait(300); const en = document.body.innerText.includes('Camera') && !document.body.innerText.includes('Câmera');
    R.setLang('pt-BR'); await wait(300); const back = document.body.innerText.includes('Câmera');
    return (before && en && back) || `Portuguese ${before}, English ${en}, back ${back}`;
  });
  await check('new map', async () => { const c0 = window.confirm; window.confirm = () => true; H.newMap(); window.confirm = c0; for (let k = 0; k < 60 && (w.roads.segs.size || w.buildings.size); k++) await wait(100); return (w.roads.segs.size === 0 && w.buildings.size === 0) || `left ${w.roads.segs.size} roads and ${w.buildings.size} buildings`; });

  console.log('VERIFICATION3 ' + JSON.stringify({ ok: res.filter((r) => r.startsWith('OK')).length, failed: res.filter((r) => r.startsWith('FAILED')).length }));
})()
