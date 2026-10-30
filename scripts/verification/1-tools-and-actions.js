(async () => {
  const g = __cidade.game, a = g.api, w = g.world;
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
  const segs = () => w.roads.segs.size, blds = () => w.buildings.size, items = () => w.items.size;
  const X = 1500, Z = 1500;
  const fp = (...arrays) => { let h = 0; for (const a of arrays) for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + Math.round(a[i] * 1000)) | 0; return h; };
  const fpTable = (t) => fp(...Object.values(t.cols));
  // the tools are checked with unlimited money (the prices would empty the cash halfway); the economy has its own
  // check, with the cash on only there
  w.unlimited = true;
  // a road the script needs: refused, it becomes a console error (the running check fails with the reason)
  const road = (...x) => { const r = a.road(...x); if (r !== 'ok') console.error('road refused: ' + r); return r; };

  // ---------------- interface: each tool and a click on the map
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
  for (const t of TOOLS) await check(`tool ${t} (button and click on the map)`, async () => {
    g.setTool(t);
    if (g.tool !== t) return `the tool did not become active (${g.tool})`;
    clickAt(0.45, 0.55); await wait(60); clickAt(0.55, 0.6); await wait(60);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    await wait(30);
  });
  // undo what the clicks did
  while (g.commands.undo()) { /* everything back */ }
  g.setTool('camera');

  // ---------------- roads
  await check('straight road', () => { const s = segs(); const r = a.road(X - 200, Z, X + 200, Z, 'Avenida'); return r === 'ok' && segs() > s ? true : `road=${r}`; });
  await check('crossing road (junction)', () => { const s = segs(); const r = a.road(X, Z - 200, X, Z + 200, 'Rua local'); return r === 'ok' && segs() > s + 1 ? true : `road=${r} segs ${s}->${segs()}`; });
  await check('undo and redo', () => { const s = segs(); g.commands.undo(); const u = segs(); g.commands.redo(); return u < s && segs() === s ? true : `${s} -> ${u} -> ${segs()}`; });
  await check('split road', () => { const s = segs(); const r = a.edit('split', X + 130, Z); return r === 'ok' && segs() === s + 1 ? true : r; });
  await check('reverse road (one way)', () => { road(X - 200, Z - 500, X + 200, Z - 500, 'Mão única, 2 faixas'); const sg = w.roads.nearestSeg(X + 50, Z - 500, 10)[0]; const a0 = w.roads.segs.cols.a[sg]; const r = a.edit('reverse', X + 50, Z - 500); const s2 = w.roads.nearestSeg(X + 50, Z - 500, 10)[0]; return r === 'ok' && w.roads.segs.cols.b[s2] === a0 ? true : r; });
  await check('duplicate road', () => { const r = a.edit('duplicate', X - 100, Z); return r === 'ok' || r; });
  await check('move node', () => { const r = a.edit('move', X + 100, Z, X + 110, Z + 5); return r === 'ok' || r; });
  await check('join at the node', () => { const r = a.edit('join', X + 110, Z + 5); return r === 'ok' || r === 'recusado' || r; });
  await check('zebra crossing mid-block', () => a.crossing(X, Z + 120, 9) === 'ok' || 'refused');
  await check('crossing with a signal', () => a.crossing(X, Z - 120, 10) === 'ok' || 'refused');
  await check('U-turn in the median', () => { road(X - 200, Z + 400, X + 200, Z + 400, 'Avenida com ciclovia'); const r = a.uturn(X + 50, Z + 400); return r === 'ok' || r; });
  await check('signal at the junction', () => { a.junction(X, Z, 1); const n = w.roads.nearestNode(X, Z, 20); return w.roads.junctions.get(n)?.ctl === 1 || 'control not stored'; });

  // ---------------- zones, growth, lots, creator
  await check('zone and grow buildings', async () => { const b = blds(); a.zone(X, Z, 150, 2); a.zone(X, Z, 150, 1); await a.grow(); await wait(500); return blds() > b ? true : `buildings ${b} -> ${blds()}`; });
  await check('drawn lot', () => { const id = a.lot(X + 300, Z + 20, X + 330, Z + 20, X + 330, Z + 50, 1, 4); return id >= 0 || 'no lot'; });
  await check('building creator applies a design', () => {
    const id = g.selected; if (id < 0) return 'nothing selected';
    g.applyDesign({ shape: 1, roof: 2, finish: 1, gear: 1, setback: 1, wall: 0xaa5533, windows: 2, wing: 3 }, 6);
    return (w.buildings.cols.color[id] >>> 31) === 1 || 'design not stored';
  });

  // ---------------- transit
  await check('bus line', () => { const n = g.transit.lines.length; a.line(0, [X - 150, Z, X + 150, Z, X, Z + 150], 3); return g.transit.lines.length > n || 'line not made'; });

  // ---------------- street and nature
  await check('street item (bench)', () => { const n = items(); a.item(X + 40, Z + 15, 6); return items() > n || 'item not placed'; });
  await check('ground elements', () => { const n = items(); a.elements(31, X - 300, Z - 300); return items() > n || 'no elements'; });
  await check('paint the ground', () => { const f0 = fp(w.ground32); a.paint(X - 300, Z + 300, 30, 2); return fp(w.ground32) !== f0 || 'the ground did not change'; });
  await check('forest', () => { const f0 = fp(w.ground32); a.paint(X + 300, Z - 300, 40, 0, 'forest', 1); return fp(w.ground32) !== f0 || 'the forest did not reach the ground'; });
  for (const m of ['raise', 'lower', 'smooth', 'flatten', 'mesa', 'canyon', 'escarpment', 'sugarloaf', 'gully'])
    // the first mode raises a bump, so smoothing and flattening after it have relief to work on
    await check(`terrain: ${m}`, () => { const f0 = fp(w.heights); a.terrain(m, X - 600, Z - 600, 60, 0.4); return fp(w.heights) !== f0 || 'the heights did not change'; });
  await check('river', () => { const f0 = fp(w.water); a.river([[X - 700, Z + 700], [X - 400, Z + 760], [X - 100, Z + 820]], 14); return fp(w.water) !== f0 || 'no new water'; });
  await check('biome', () => { a.biome(2); const b2 = w.biome; a.biome(0); return (b2 === 2 && w.biome === 0) || `biome ${b2}, then ${w.biome}`; });

  // ---------------- weather, sky, camera
  await check('lightning', () => { g.weather.bolt.visible = false; a.strike(); return g.weather.bolt.visible || 'no bolt shown'; });
  await check('follow a vehicle', async () => { await wait(2000); const on = a.follow(); const off = a.follow(); return (on === true && off === false) || `follow ${on}, then ${off}`; });
  await check('night and day', async () => { await g.view(X, Z, 30, 40, 300, 22); await wait(500); const h1 = g.hour; await g.view(X, Z, 30, 40, 300, 11); return (Math.round(h1) === 22 && Math.round(g.hour) === 11) || `hours ${h1} and ${g.hour}`; });

  // ---------------- people and actions
  await check('standing person (people creator)', () => {
    // with the cooked people loaded the click goes through their creator (a group, one undo step); without them, a street item
    const cr = g.vehicles.people.creator, n = items(), k = cr ? cr.size : 0;
    g.personSpec = { color: 3, height: 7, walk: false, count: 2 }; g.personOptions = { count: 2, mode: 'stand' };
    g.placePerson(X + 20, Z + 30);
    if (cr) { if (cr.size !== k + 1) return 'group not placed'; g.commands.undo(); return cr.size === k || 'undo did not remove the group'; }
    return items() >= n + 2 || 'person not placed';
  });
  await check('people walking', () => {
    // the walking group goes through the people creator (one group, one undo step), as the standing one above
    const cr = g.vehicles.people.creator; if (!cr) return 'no people creator';
    const k = cr.size; g.personSpec = { color: 5, height: 7, walk: true, count: 5 }; g.personOptions = { count: 5, mode: 'walk' };
    g.placePerson(X + 20, Z + 30); return cr.size === k + 1 || 'walking group not placed';
  });
  await check('pistol', async () => {
    // the shot goes to the simulation and its answer comes back (onHit clears hitKind)
    g.shoot(X + 20, Z + 30); if (g.hitKind !== 'pistol') return 'the shot did not go out';
    for (let k = 0; k < 40 && g.hitKind !== null; k++) await wait(50);
    return g.hitKind === null || 'the simulation did not answer the shot';
  });
  await check('bomb opens the building, then brings it down', async () => {
    // as Roadcraft 4.0 (bomb/ANALISE.md): a weak bomb breaks the building into its ruin and leaves it standing; a strong
    // one on the ruin brings it down
    const col = w.buildings.cols; let id = -1;
    w.buildingIndex.query(X - 200, Z - 200, X + 200, Z + 200, (b) => { if (id < 0 && col.floors[b] > 0) id = b; });
    if (id < 0) return 'no building to try';
    const x = col.x[id], z = col.z[id], seed = col.seed[id];
    const standing = () => { let s = false; w.buildingIndex.query(x - 1, z - 1, x + 1, z + 1, (b) => { if (col.floors[b] > 0 && col.seed[b] === seed) s = true; }); return s; };
    const force = g.bombForce;
    // seen from straight above, the pointer's ray goes into this building first (the bomb lands on the first one)
    await g.view(x, z, 0, 85, 80, 11);
    g.bombForce = 5; g.bomb(x, z);
    for (let k = 0; k < 80 && !w.ruined.has(id); k++) await wait(100);
    if (!w.ruined.has(id)) { g.bombForce = force; return 'the ruin was not ready in 8 s'; }
    if (!standing()) { g.bombForce = force; return 'force 5 brought the building down at once'; }
    g.bombForce = 50; g.bomb(x, z);
    for (let k = 0; k < 50 && standing(); k++) await wait(100);
    g.bombForce = force;
    return !standing() || 'force 50 did not bring the ruin down';
  });

  // ---------------- save, open, export
  await check('save and open keep the city', async () => {
    const s = segs(), b = blds(), i = items();
    await g.saving.save(); await wait(500);
    await g.saving.load(); await wait(1500);
    return segs() === s && blds() === b && items() === i ? true : `roads ${s}/${segs()} buildings ${b}/${blds()} items ${i}/${items()}`;
  });
  await check('export and open a file', async () => { const blob = await a.packMap(); if (!blob || !blob.size) return 'empty package'; await a.openMap(blob); await wait(1500); return segs() > 0 || 'opened empty'; });

  // ---------------- undo everything
  // opening the map above cleared the history: two edits to undo, then everything undone
  await check('undo everything without error', () => { road(X - 200, Z + 1400, X + 200, Z + 1400, 'Rua local'); a.item(X - 60, Z + 1412, 6); let n = 0; while (g.commands.undo() && n < 500) n++; return (n > 0 && !g.commands.canUndo) || `undid ${n}, undo left: ${g.commands.canUndo}`; });

  console.log('VERIFICATION ' + JSON.stringify({ ok: res.filter((r) => r.startsWith('OK')).length, failed: res.filter((r) => r.startsWith('FAILED')).length }));
})()
