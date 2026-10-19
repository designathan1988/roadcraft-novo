// Road and lot tools checked in the real game (the machine's GPU), one scenario per Electron session with a user data
// folder of its own (never the game's). What a Node test cannot reach: the pointer handlers, the hint bar, the
// inspector's buttons. Usage: npx vite build && node tools/check-vias.mjs [scenario...]   (exit code 1 if anything fails)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Page helpers shared by every scenario: results are printed as "CHECK OK|FAILED name" and the run ends with "CHECK END".
const PRELUDE = `
const g = window.__cidade.game, a = g.api, w = g.world;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
const road = (ax, az, bx, bz) => { const r = a.road(ax, az, bx, bz); if (r !== 'ok') throw new Error('road refused: ' + r); };
const canvas = document.querySelector('canvas');
const pointer = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
w.unlimited = false; w.money = 1e9;
`;

const SCENARIOS = {
  // D4: a tool that throws on release leaves no drag behind (the next move does not pan the camera)
  'tool-error-ends-drag': `
    g.setTool('road');
    const rt = g.roadTool, click = rt.click.bind(rt);
    rt.click = () => { throw new Error('broken on purpose'); };
    const r = canvas.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    pointer('pointerdown', x, y); pointer('pointerup', x, y);
    check('the drag ended after the tool threw', g.drag === 'none', 'drag=' + g.drag);
    const before = JSON.stringify(g.rig.state());
    pointer('pointermove', x + 120, y + 60);
    check('the next move does not pan the camera', JSON.stringify(g.rig.state()) === before, 'the camera moved');
    rt.click = click;
  `,
  // D39: while aiming a road the hint bar shows what it will cost
  'road-preview-price': `
    g.setTool('road');
    const rt = g.roadTool;
    rt.click({ x: 1500, y: 10, z: 1500 });
    rt.hover({ x: 1700, y: 10, z: 1520 });
    const hint = document.querySelector('.hint, #hint, [class*="hint"]');
    const text = g.hud.hint ? g.hud.hint.textContent : hint ? hint.textContent : '';
    check('the hint shows the price of the road being aimed', /R\\$\\s?[0-9]/.test(text || ''), 'hint: ' + text);
    rt.cancel();
  `,
  // D42: joining two roads from the inspector settles like every edit (the street name follows the joined road)
  'inspector-join': `
    road(1550, 1500, 1600, 1500);
    road(1600, 1500, 1650, 1500);
    const n = w.roads.nearestNode(1600, 1500, 1);
    const west = w.roads.nearestSeg(1575, 1500, 3)[0], east = w.roads.nearestSeg(1625, 1500, 3)[0];
    w.streetNames.set(west, 'Rua da Prova'); w.streetNames.set(east, 'Rua da Prova');
    g.setTool('inspect');
    g.inspector.pick(1600, 1500);
    await wait(300);
    const label = window.__cidade.t ? window.__cidade.t('inspector.joinAligned') : null;
    const btn = [...document.querySelectorAll('button')].find((b) => label ? b.textContent === label : /unir|join/i.test(b.textContent || ''));
    check('the inspector shows the join button', !!btn, 'no button');
    if (btn) btn.click();
    await wait(300);
    const s = w.roads.nearestSeg(1600, 1500, 3);
    check('the two roads are one', s && w.roads.segs.size === 1, 'segments ' + w.roads.segs.size);
    check('the joined road keeps the street name', s && w.streetNames.get(s[0]) === 'Rua da Prova', 'name ' + (s && w.streetNames.get(s[0])));
    check('no node is left at the join', w.roads.nearestNode(1600, 1500, 1) < 0 || w.roads.nodes.alive[n] === 0, 'node still there');
    const stale = [...w.streetNames.keys()].filter((id) => !w.roads.segs.alive[id]);
    check('no street name is left on a removed segment', stale.length === 0, 'names on removed segments ' + stale);
  `,
  // lots: a delete stroke over three lots in one undo step
  'lot-delete-stroke': `
    const ids = [1510, 1530, 1550].map((x, i) => w.addBuilding({ x, z: 1515, w: 20, d: 30, h: 0, rot: 0, color: 0, seed: i + 1, zone: 1, floors: 0, style: 1 }));
    g.setTool('building');
    g.setLotMode('delete');
    g.drag = 'lots'; g.lotStroke = [[1502, 1520], [1558, 1520]];
    const r = canvas.getBoundingClientRect();
    pointer('pointerup', r.left + 5, r.top + 5);
    check('the stroke deleted the three lots', ids.every((i) => !w.buildings.alive[i]), 'alive: ' + ids.map((i) => w.buildings.alive[i]));
    g.commands.undo();
    check('one undo brings the three back', ids.every((i) => w.buildings.alive[i]), 'alive: ' + ids.map((i) => w.buildings.alive[i]));
  `,
  // Roadcraft 4.0 ui/inspector.ts:421-426: a node whose roads meet too sharply says it cannot be built, with the angle
  'inspector-impossible': `
    const net = w.roads, n = (x, z) => net.addNode({ x, z, y: a.ground(x, z) });
    const A = n(1500, 1500), B = n(1700, 1500), C = n(1700, 1553);
    net.addSeg({ a: A, b: B, cx: 1600, cz: 1500, profile: 0, flags: 0, zl: 0, zr: 0 });
    net.addSeg({ a: A, b: C, cx: 1600, cz: 1526.5, profile: 0, flags: 0, zl: 0, zr: 0 });
    check('the node is impossible (15° between its roads)', w.impossible.angleAt(A) >= 0, 'angle ' + w.impossible.angleAt(A));
    g.setTool('inspect');
    g.inspector.pick(1500, 1500);
    await wait(300);
    const warn = document.querySelector('.inspector .inspect-warning');
    check('the node inspector says it cannot be built, with the angle', !!warn && /15/.test(warn.textContent), 'warning: ' + (warn && warn.textContent));
    road(1400, 1800, 1600, 1800); road(1500, 1700, 1500, 1900);
    g.inspector.pick(1500, 1800);
    await wait(300);
    check('a right-angle junction has no such warning', !document.querySelector('.inspector .inspect-warning'), 'warning shown');
  `,
  // Roadcraft 4.0 ui/roads/connectorPanel.ts:40-167: the lane connectors as a plan, by mouse and by keyboard
  'junction-plan': `
    road(1400, 1500, 1600, 1500); road(1500, 1400, 1500, 1600);
    const n = w.roads.nearestNode(1500, 1500, 1);
    g.setTool('inspect');
    g.inspector.pick(1500, 1500);
    await wait(300);
    const ins = () => [...document.querySelectorAll('.inspector .cn-end.in')], outs = () => [...document.querySelectorAll('.inspector .cn-end.out')];
    check('the plan shows lanes coming in and roads going out', ins().length >= 4 && outs().length === 4, 'in ' + ins().length + ', out ' + outs().length);
    ins()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(200);
    const lit = document.querySelectorAll('.inspector .cn-link.on').length;
    check('a lane picked lights where it goes', lit >= 1, 'lit links ' + lit);
    const litOut = document.querySelector('.inspector .cn-end.out.on');
    litOut.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(200);
    const spec = w.roads.junctions.get(n);
    check('clicking a road it goes to unlinks it (a custom connection, undoable)', !!spec && !!spec.lanes && spec.lanes.length === 1, JSON.stringify(spec));
    const end = document.querySelector('.inspector .cn-end.out:not(.on)');
    end.focus();
    end.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(200);
    const spec2 = w.roads.junctions.get(n);
    check('Enter on a focused end links it back', spec2 && spec2.lanes && spec2.lanes[0][2].length === lit, JSON.stringify(spec2 && spec2.lanes));
    const moves = document.querySelectorAll('.inspector .rp-move').length;
    check('a movement chip per pair of roads, named by the turn', moves === 12 && /esquerda|left|direita|right|frente|through/.test(document.querySelector('.inspector .rp-move').textContent), 'chips ' + moves);
  `,
  // Roadcraft 4.0 ui/roads/profileEditor.ts: opened from a road, template cards, palette, keys, problems, apply
  'profile-editor': `
    road(1500, 1500, 1580, 1500);
    const s = w.roads.nearestSeg(1540, 1500, 3)[0];
    g.setTool('inspect');
    g.inspector.pick(1540, 1500);
    await wait(300);
    const open = [...document.querySelectorAll('.inspector button')].find((b) => /Editar perfil|Edit profile/.test(b.textContent));
    check('the road panel opens the editor', !!open, 'no button');
    open.click();
    await wait(300);
    const ed = document.querySelector('.section-editor');
    check('opened from a road: template cards and an Apply button', ed.querySelectorAll('.rp-card').length > 10 && !!ed.querySelector('[data-action="apply"]'), 'cards ' + ed.querySelectorAll('.rp-card').length);
    ed.querySelector('[data-palette="laneForward"]').click();
    await wait(100);
    check('an unbalanced road shows its problem and cannot be applied', ed.querySelectorAll('.rp-issue').length > 0 && ed.querySelector('[data-action="apply"]').disabled, 'issues ' + ed.querySelectorAll('.rp-issue').length);
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await wait(100);
    check('Delete removes the picked strip and the road is whole again', ed.querySelectorAll('.rp-issue').length === 0 && !ed.querySelector('[data-action="apply"]').disabled, 'issues ' + ed.querySelectorAll('.rp-issue').length);
    const card = [...ed.querySelectorAll('.rp-card-main')].find((b) => /Avenida$|Avenue$/.test(b.textContent));
    card.click();
    await wait(100);
    ed.querySelector('[data-action="apply"]').click();
    await wait(300);
    const now = w.roads.nearestSeg(1540, 1500, 3)[0];
    check('Apply gives the road the avenue section (one undo step)', w.roads.segs.cols.profile[now] !== 0 && ed.classList.contains('hidden'), 'profile ' + w.roads.segs.cols.profile[now]);
    g.commands.undo();
    check('undo brings the street back', w.roads.segs.cols.profile[w.roads.nearestSeg(1540, 1500, 3)[0]] === 0, 'profile ' + w.roads.segs.cols.profile[w.roads.nearestSeg(1540, 1500, 3)[0]]);
  `,
  // B50: a street name typed in the inspector can be taken away (an empty name gives the generated one back)
  'street-name-clear': `
    road(1500, 1500, 1700, 1500);
    const s = w.roads.nearestSeg(1550, 1500, 3)[0];
    g.setTool('inspect');
    g.inspector.pick(1550, 1500);
    await wait(300);
    const field = () => document.querySelector('.inspector input.v2-search');
    const generated = field().placeholder;
    field().value = 'Rua Digitada'; field().dispatchEvent(new Event('change'));
    await wait(200);
    check('a typed name names the street', w.streetNames.get(s) === 'Rua Digitada', 'name ' + w.streetNames.get(s));
    field().value = ''; field().dispatchEvent(new Event('change'));
    await wait(200);
    check('an empty name takes the typed name away', !w.streetNames.has(s), 'name ' + w.streetNames.get(s));
    const title = document.querySelector('.inspector h3');
    check('the generated name is back', title && title.textContent.split(' · ')[0] === generated, 'title ' + (title && title.textContent) + ', generated ' + generated);
    g.commands.undo();
    check('undo brings the typed name back', w.streetNames.get(s) === 'Rua Digitada', 'name ' + w.streetNames.get(s));
  `,
  // the language switched while the game runs (Roadcraft 4.0 ui/roads/catalogPanel.ts:73): cards and editor made again
  'catalog-language': `
    g.setTool('road');
    await wait(300);
    const cat = g.hud.catalog;
    const card = cat.grid.querySelector('.rc-card');
    cat.editor.open(window.__cidade.game.world && cat.editor ? { name: 'Rua local', speed: 40, oneWay: false, priority: 0, category: 'ruas',
      strips: [{ kind: 'sidewalk', width: 3 }, { kind: 'curb', width: 0.2 }, { kind: 'lane', width: 3.2, dir: 1 }, { kind: 'lane', width: 3.2, dir: -1 }, { kind: 'curb', width: 0.2 }, { kind: 'sidewalk', width: 3 }] } : null);
    const before = cat.editor.state();
    before.name = 'Minha Rua'; cat.editor.restore(before);
    const oldEditor = cat.editor.el;
    cat.languageChanged();
    check('the cards are made again', card && !card.isConnected && !!cat.grid.querySelector('.rc-card'), 'old card still in place');
    check('the section editor is made again in its place', !oldEditor.isConnected && cat.editor.el.isConnected, 'editor not replaced');
    const after = cat.editor.state();
    check('an open edit stays open with its profile and name', after && after.name === 'Minha Rua' && after.def.strips.length === 6, JSON.stringify(after && { name: after.name, strips: after.def.strips.length }));
  `,
  // B49: deleting a road model the player used in this session takes its card out of "Mine"
  'catalog-delete-template': `
    localStorage.removeItem('cidade.modelosDeVia');
    const cat = g.hud.catalog;
    const def = { name: 'Modelo Teste', speed: 40, oneWay: false, priority: 0, category: 'meus', custom: true,
      strips: [{ kind: 'sidewalk', width: 3 }, { kind: 'curb', width: 0.2 }, { kind: 'lane', width: 3.2, dir: 1 }, { kind: 'lane', width: 3.2, dir: -1 }, { kind: 'curb', width: 0.2 }, { kind: 'sidewalk', width: 3 }] };
    cat.fromEditor(def, true);
    cat.cat = 'meus'; cat.built = ''; cat.build();
    const names = () => [...cat.grid.querySelectorAll('.rc-name')].map((e) => e.textContent);
    check('the saved model has a card', names().includes('Modelo Teste'), 'cards: ' + names());
    const card = [...cat.grid.querySelectorAll('.rc-card')].find((c) => c.querySelector('.rc-name').textContent === 'Modelo Teste');
    const del = card && [...card.querySelectorAll('button.rc-custom')].find((b) => b.style.color.includes('danger'));
    check('its card has a delete button', !!del, 'no button');
    if (del) del.click();
    check('the model is gone from the browser', !(JSON.parse(localStorage.getItem('cidade.modelosDeVia') || '[]')).some((p) => p.name === 'Modelo Teste'), 'still stored');
    check('the deleted model leaves the catalogue', !names().includes('Modelo Teste'), 'cards: ' + names());
    const tab = cat.tabs.querySelector('[data-category=meus] em');
    check('the Mine tab counts the cards it shows', tab && tab.textContent === String(names().length), 'tab ' + (tab && tab.textContent) + ', cards ' + names().length);
  `,
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(SCENARIOS);
let failed = 0;
for (const name of names) {
  const body = SCENARIOS[name];
  if (!body) { console.log(`unknown scenario ${name}`); failed++; continue; }
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-vias-'));
  const script = `(async()=>{${PRELUDE}\ntry {${body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
  const lines = await new Promise((resolve) => {
    const out = [];
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(own, 'shot.png'), '?vazio&hora=11&workers=3', script],
      { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: '300' } });
    p.stdout.on('data', (d) => out.push(...String(d).split('\n')));
    p.on('exit', () => resolve(out));
  });
  const got = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
  if (!got.includes('END')) got.push('FAILED the session did not finish (hung or crashed) after: ' + (got[got.length - 1] ?? 'nothing'));
  const checks = got.filter((c) => c !== 'END');
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  failed += bad.length;
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
  for (const c of bad) console.log('  ' + c);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `road check: ${failed} FAILED` : 'road check: ok');
process.exit(failed ? 1 : 0);
