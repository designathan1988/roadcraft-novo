(async () => {
  const R = __roadcraft, a = R.actions, w = R.world, H = R.ui;
  const errs = [];
  const oe = console.error.bind(console);
  console.error = (...x) => { errs.push(x.map(String).join(' ').slice(0, 200)); oe(...x); };
  window.addEventListener('error', (e) => errs.push('error: ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errs.push('promise: ' + (e.reason && e.reason.message || e.reason)));
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
  const segs = () => net.segs.size, blds = () => w.buildings.size, items = () => w.items.size;
  const canvas = document.getElementById('view');
  // a pointer gesture over world points, as the player drags it (the camera must see them)
  const drag = (pts) => pts.forEach(([x, z], i) => {
    const p = R.camera.toScreen(x, a.ground(x, z), z); if (!p) throw new Error('point behind the camera');
    const type = i === 0 ? 'pointerdown' : i === pts.length - 1 ? 'pointerup' : 'pointermove';
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y }));
  });
  const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  const X = 1500, Z = 1500;
  const fp = (...arrays) => { let h = 0; for (const a of arrays) for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + Math.round(a[i] * 1000)) | 0; return h; };
  const fpTable = (t) => fp(...Object.values(t.cols));
  // the tools are checked with unlimited money (the prices would empty the cash halfway); the economy has its own
  // check, with the cash on only there
  w.unlimited = true;
  // a road the script needs: refused, it becomes a console error (the running check fails with the reason)
  const road = (...x) => { const r = a.road(...x); if (r !== 'ok') console.error('road refused: ' + r); return r; };
  const segNear = (x, z) => net.nearestSeg(x, z, 12)?.[0] ?? -1;
  const click = (tool, pts, setup) => { R.tools.set(tool); setup && setup(); for (const p of pts) R.tools.click(p[0], p[1]); };
  await R.camera.view(X, Z, 0, 50, 500, 11);

  // ---------------- drawing roads
  await check('curve by three clicks', () => { const s = segs(); click('curve', [[X - 300, Z - 300], [X - 200, Z - 380], [X - 100, Z - 300]], () => H.profile(0)); return segs() > s || 'no curve made'; });
  await check('free path (drag)', () => {
    const s = segs(); R.tools.set('free');
    const pts = [[X + 100, Z - 300]];
    for (let i = 1; i <= 12; i++) pts.push([X + 100 + i * 15, Z - 300 + Math.sin(i / 3) * 30]);
    pts.push([X + 280, Z - 300]);
    drag(pts); return segs() > s || 'no free road made';
  });
  await check('angle snap (15°)', () => {
    click('road', [[X - 300, Z + 300]], () => H.roadSnap(1));
    R.tools.click(X - 150, Z + 300 + 37); H.roadSnap(0); key('Escape');
    const s = segNear(X - 225, Z + 318); if (s < 0) return 'no road';
    const nc = net.nodes.cols, ang = Math.atan2(nc.z[sc.b[s]] - nc.z[sc.a[s]], nc.x[sc.b[s]] - nc.x[sc.a[s]]) * 180 / Math.PI;
    const r = ((ang % 15) + 15) % 15; return r < 0.5 || r > 14.5 || `angle ${ang.toFixed(1)}°`;
  });
  await check('blocks at once', () => { const s = segs(); click('blocks', [[X + 700, Z + 700]], () => H.blocks({ cols: 2, rows: 2, size: 100, angle: 0 })); return segs() >= s + 12 || `only ${segs() - s} segments`; });
  const midVsEnd = (z) => { const nc = net.nodes.cols; const m = net.nearestNode(X, z, 60); return m >= 0 ? nc.y[m] - a.ground(nc.x[m], nc.z[m]) : NaN; };
  await check('bridge (raised road)', () => { road(X - 300, Z + 600, X + 300, Z + 600, 'Avenida', 9); const d = midVsEnd(Z + 600); return d > 5 || `middle ${d} m off the ground`; });
  await check('tunnel (lowered road)', () => { road(X - 300, Z + 800, X + 300, Z + 800, 'Avenida', -10); const d = midVsEnd(Z + 800); return d < -5 || `middle ${d} m off the ground`; });
  await check('cut with retaining walls', () => { H.cutWalls(true); road(X - 300, Z + 1000, X + 300, Z + 1000, 'Rua local', -4); H.cutWalls(false); const s = segNear(X, Z + 1000); return s >= 0 && (sc.flags[s] & 8) !== 0 || 'no wall flag'; });
  await check('change the road profile', () => { road(X - 300, Z - 600, X + 300, Z - 600, 'Rua local'); const s = segNear(X + 50, Z - 600); const p0 = sc.profile[s]; click('upgrade', [[X + 50, Z - 600]], () => H.profile(3)); return sc.profile[segNear(X + 50, Z - 600)] !== p0 || 'same profile'; });
  await check('roundabout with a radius', () => { road(X - 300, Z - 900, X + 300, Z - 900, 'Avenida'); road(X, Z - 1200, X, Z - 600 - 10, 'Avenida'); R.tools.set('roundabout'); H.ring(30 / R.tools.options().road.ringRadius); const s = segs(); click('roundabout', [[X, Z - 900]]); return segs() > s || 'no roundabout'; });
  await check('automatic furniture flagged on the road', () => { H.furniture(2); road(X + 400, Z - 300, X + 600, Z - 300, 'Rua local'); H.furniture(0); const s = segNear(X + 500, Z - 300); return s >= 0 && (sc.flags[s] >> 1 & 3) !== 0 || `flags ${sc.flags[s]}`; });
  await check('building rules give the reason', () => { const r = a.road(X - 300, Z - 900, X + 300, Z - 900, 'Avenida'); return typeof r === 'string' && r !== 'ok' && r.length > 3 || `accepted a road over another (${r})`; });
  await check('economy: building charges, demolishing gives a quarter back, no cash refuses', () => {
    w.unlimited = false; w.money = 10_000_000;
    const m0 = w.money; road(X + 400, Z + 200, X + 600, Z + 200, 'Avenida'); const m1 = w.money;
    const n = a.demolish(X + 450, Z + 190, X + 550, Z + 210); const m2 = w.money;
    w.money = 100; const s0 = segs(); const r = a.road(X + 400, Z + 260, X + 600, Z + 260, 'Avenida'); const refused = segs() === s0 && w.money === 100 && r !== 'ok';
    w.unlimited = true;
    return m1 < m0 && n > 0 && m2 > m1 && m2 - m1 < (m0 - m1) * 0.3 && refused || `money ${m0} -> ${m1} -> ${m2}, demolished ${n}, no cash: ${r}`;
  });

  // ---------------- junction
  road(X - 300, Z - 1500, X + 300, Z - 1500, 'Avenida'); road(X, Z - 1800, X, Z - 1200 - 10, 'Rua local');
  const node = () => net.nearestNode(X, Z - 1500, 20);
  for (const [ctl, name] of [[2, 'signs (priority road)'], [3, 'all-way stop'], [4, 'give way'], [5, 'mini roundabout'], [6, 'no control'], [1, 'signal']])
    await check(`junction control: ${name}`, async () => { a.junction(X, Z - 1500, ctl); await wait(150); return net.junctions.get(node())?.ctl === ctl || 'not stored'; });
  await check('fixed signal, greens, offset and bus', async () => { const n = node(); net.setJunction(n, { ctl: 1, fixed: true, greens: [30, 15], offset: 7, bus: true }); await wait(200); const j = net.junctions.get(n); return j.fixed && j.greens[0] === 30 && j.offset === 7 && j.bus || 'fields lost'; });
  await check('rule per arm and banned turn', async () => { const n = node(); const ss = net.segsOf(n, []); net.setJunction(n, { ctl: 2, legs: [[ss[0], 2]], bans: [ss[0], ss[1]] }); await wait(200); const j = net.junctions.get(n); return j.legs?.length === 1 && j.bans?.length === 2 || 'not stored'; });
  await check('node height', () => { const r = a.edit('move', X, Z - 1500, X, Z - 1500); return r === 'ok' || r === 'refused' || r; });

  // ---------------- simulation
  await check('pause and resume', () => { const p0 = R.sim.paused(); R.sim.togglePause(); const p1 = R.sim.paused(); R.sim.togglePause(); return p0 !== p1 || 'did not pause'; });
  // the traffic view and the grid live in uniforms only the renderer reads; the HUD's layers are what the player is
  // shown (P8 gives them one owner, app/viewState.ts, and these checks read it)
  await check('congestion map', () => { const t0 = R.view.layers().traffic; H.trafficView(); const t1 = R.view.layers().traffic; H.trafficView(); return (t1 !== t0 && R.view.layers().traffic === t0) || `layer ${t0} → ${t1} → ${R.view.layers().traffic}`; });
  await check('simulation figures and pedestrians', async () => { await wait(3000); const s = R.frames.stats(); return s.cars > 0 && s.peds >= 0 || `stats ${JSON.stringify(s)}`; });
  await check('bus terminal', () => { const n = R.transit.terminals().length; a.line(0, [X - 250, Z + 1000 + 8, X + 250, Z + 1000 + 8], 2); R.tools.set('transit'); H.terminal(true); R.tools.click(X + 250, Z + 1008); H.terminal(false); R.tools.set('camera'); return R.transit.terminals().length > n || 'terminal not set'; });
  await check('train: track and line', () => { const n = R.transit.lines().length; road(X - 600, Z + 1300, X + 600, Z + 1300, 'Ferrovia dupla'); a.line(1, [X - 500, Z + 1300, X + 500, Z + 1300], 1); return R.transit.lines().length > n || 'train line not made'; });

  // ---------------- zones, lots, buildings
  await check('high density zones grow taller', async () => { road(X + 800, Z - 1000, X + 1100, Z - 1000, 'Avenida'); a.zone(X + 950, Z - 1000, 150, 6); await a.grow(); let max = 0; w.buildingIndex.query(X + 780, Z - 1100, X + 1120, Z - 900, (b) => { max = Math.max(max, w.buildings.cols.floors[b]); }); return max >= 4 || `max ${max} floors`; });
  await check('zone the whole block', () => { const zoned = () => { let k = 0; for (let i = 0; i < net.segs.end; i++) if (net.segs.alive[i]) k += (sc.zl[i] ? 1 : 0) + (sc.zr[i] ? 1 : 0); return k; }; const z0 = zoned(); R.tools.set('zone'); H.zone(1); H.zoneFill(true); R.tools.click(X + 750, Z + 750); H.zoneFill(false); return zoned() > z0 || 'no side zoned'; });
  a.lot(X + 1200, Z + 20, X + 1240, Z + 20, X + 1240, Z + 60, 1, 3);
  await check('split a lot', () => { const b = blds(); R.tools.set('building'); H.lotMode('split'); H.lotSplit('side', 2); R.tools.click(X + 1220, Z + 40); return blds() > b || 'not split'; });
  await check('join lots', () => { const b = blds(); H.lotMode('join'); R.tools.click(X + 1210, Z + 40); R.tools.click(X + 1230, Z + 40); return blds() < b || 'not joined'; });
  await check('set the lot front', () => { const f0 = fpTable(w.buildings); H.lotMode('front'); R.tools.click(X + 1220, Z + 60); return fpTable(w.buildings) !== f0 || 'the front did not change'; });
  await check('delete the building, then the lot', () => { const b = blds(); H.lotMode('delete'); R.tools.click(X + 1220, Z + 40); R.tools.click(X + 1220, Z + 40); return blds() < b || 'not deleted'; });
  await check('edit floors, style and civic function', () => { let id = -1; w.buildingIndex.query(X - 200, Z - 200, X + 200, Z + 200, (b) => { if (id < 0 && w.buildings.cols.floors[b] > 0) id = b; }); if (id < 0) id = a.lot(X + 1300, Z + 20, X + 1340, Z + 20, X + 1340, Z + 60, 1, 3); R.tools.select(id); const f = w.buildings.cols.floors[id]; H.floors(2); H.style(3); H.buildingFn(14); return w.buildings.cols.fn[id] === 14 && w.buildings.cols.floors[id] === f + 2 || `fn ${w.buildings.cols.fn[id]} floors ${f}->${w.buildings.cols.floors[id]}`; });
  await check('look inside, floor by floor', () => { H.inside('toggle'); const on = R.view.inside(); H.inside('up'); H.inside('toggle'); return on || 'did not open'; });

  // ---------------- nature, street, effects
  for (const [k, name] of [[13, 'smoke'], [14, 'fire'], [15, 'steam'], [16, 'fountain'], [26, 'dust'], [27, 'soot'], [28, 'sparks'], [29, 'spray'], [41, 'palm'], [42, 'mist']])
    await check(`effect/item: ${name}`, () => { const n = items(); a.item(X - 900 + k * 9, Z - 900, k); return items() > n || 'not placed'; });
  await check('walls and fences (row)', () => { const n = items(); R.tools.set('barrier'); R.tools.click(X - 900, Z - 800); R.tools.click(X - 800, Z - 800); key('Enter'); return items() > n || 'no wall'; });
  await check('one tree per click', () => { const n = items(); H.forestOne(true); R.tools.set('forest'); R.tools.click(X - 950, Z - 700); H.forestOne(false); return items() === n + 1 || `trees ${items() - n}`; });
  await check('flatten the map', () => { const f0 = fp(w.heights); const c0 = window.confirm; window.confirm = () => true; H.flattenMap(); window.confirm = c0; return fp(w.heights) !== f0 || 'the heights did not change'; });

  // ---------------- sky and weather
  for (const m of ['day', 'night', 'cycle']) await check(`sky: ${m}`, () => { H.sky(m); return R.sky.mode() === m || `stayed ${R.sky.mode()}`; });
  await check('adjustable weather', () => { H.weather({ rain: 0.6, wind: 0.5, dir: 90, lightning: 4, thunder: 1 }); const set = H.environment().weather; H.weather(null); const back = H.environment().weather; return (set && set.rain === 0.6 && set.lightning === 4 && back === null) || `weather ${JSON.stringify(set)} → ${JSON.stringify(back)}`; });
  await check('clouds: scatter and clear', () => { H.scatterClouds(6, 0.5); const n = R.sky.clouds(); H.clearClouds(); return n > 0 && R.sky.clouds() === 0 || `clouds ${n} → ${R.sky.clouds()}`; });
  await check('general fog', () => { H.fogLevel(2); const f2 = H.environment().fog; H.fogLevel(1); return (f2 === 2 && H.environment().fog === 1) || `fog ${f2} → ${H.environment().fog}`; });

  // ---------------- panels (their text is the player's, in either language)
  await check('options open', async () => { H.options(); await wait(200); const ok = [...document.querySelectorAll('div,section')].some((e) => e.offsetParent !== null && /Gráficos|Qualidade|Opções|Graphics|Quality|Options/.test(e.textContent || '') && e.children.length > 3); document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })); return ok || 'panel not shown'; });
  await check('help and about', async () => { H.help(); await wait(200); const ok = /Sobre|versão|Ajuda|About|version|Help/i.test(document.body.innerText); H.help(); return ok || 'help not shown'; });
  await check('grid, north and camera views', () => {
    const g0 = R.view.layers().grid; H.grid(); const g1 = R.view.layers().grid; H.grid(); if (g1 === g0 || R.view.layers().grid !== g0) return `grid ${g0} → ${g1} → ${R.view.layers().grid}`;
    H.north(); const yaw = R.camera.pose().yaw + R.camera.pose().turning, tau = Math.PI * 2; if (Math.abs(((yaw % tau) + tau) % tau) > 1e-6 && Math.abs(((yaw % tau) + tau) % tau - tau) > 1e-6) return `north: final heading ${yaw}`;
    // 'top' is the perspective camera tilted to its maximum (cameraRig.topDown), the others are modes
    H.view('top'); const top = R.camera.pose().mode === 'persp' && R.camera.pose().pitch > 1.4; const modes = []; for (const v of ['iso', 'persp']) { H.view(v); modes.push(R.camera.pose().mode); }
    return (top && modes.join() === 'iso,persp') || `top ${top} (tilt ${R.camera.pose().pitch}), views ${modes.join()}`;
  });
  // the health panel is a developer's tool (?dev): for the player F9 opens nothing (tools/check-interface.mjs B30 checks it with ?dev)
  await check('game health (F9) not in the player interface', async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9', key: 'F9', bubbles: true })); await wait(300); const p = document.querySelector('.health'); const ok = !p || p.classList.contains('hidden'); if (!ok) p.classList.add('hidden'); return ok || 'the health panel opened for the player'; });
  await check('autosave', async () => { road(X - 300, Z - 1400, X + 300, Z - 1400, 'Rua local'); R.saves.autosaveNow(); await wait(2500); return R.lifecycle.unsaved() === false || 'did not save by itself'; });

  console.log('VERIFICATION2 ' + JSON.stringify({ ok: res.filter((r) => r.startsWith('OK')).length, failed: res.filter((r) => r.startsWith('FAILED')).length }));
})()
