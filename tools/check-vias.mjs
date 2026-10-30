// Road and lot tools checked in the real game (the machine's GPU), one scenario per Electron session with a user data
// folder of its own (never the game's). What a Node test cannot reach: the pointer handlers, the hint bar, the
// inspector's buttons. Usage: npx vite build && node tools/check-vias.mjs [scenario...]   (exit code 1 if anything fails)
import { checksOf, pick, report, scenarioFolder, session, wrap } from './checks/run.mjs';

// Page helpers shared by every scenario: results are printed as "CHECK OK|FAILED name" and the run ends with "CHECK END".
const PRELUDE = `
const R = window.__roadcraft, a = R.actions, w = R.world;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
const road = (ax, az, bx, bz) => { const r = a.road(ax, az, bx, bz); if (r !== 'ok') throw new Error('road refused: ' + r); };
const canvas = document.querySelector('canvas');
const pointer = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
// a real pointer gesture over world points (the camera must see them)
const at = (x, z) => { const p = R.camera.toScreen(x, a.ground(x, z), z); if (!p) throw new Error('point behind the camera'); return p; };
const frames = (n) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });
const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
w.unlimited = false; w.money = 1e9;
`;

const SCENARIOS = {
  // D4 (a tool that throws on release leaves no drag behind; the next move does not pan the camera) is checked in
  // test/input.test.ts: the fault is injected there into the input module itself, since the game publishes no part to
  // replace (plan P5).
  // D39: while aiming a road the hint bar shows what it will cost
  'road-preview-price': `
    await R.camera.view(1600, 1510, 0, 60, 400);
    R.tools.set('road');
    R.tools.click(1500, 1500);
    // the cursor over the road's end, as the player aims it (the frame hovers the tool under the pointer)
    const p = at(1700, 1520);
    pointer('pointermove', p.x, p.y);
    await frames(3);
    const text = document.querySelector('.v2-hintbar')?.textContent ?? '';
    check('the hint shows the price of the road being aimed', /R\\$\\s?[0-9]/.test(text || ''), 'hint: ' + text);
    key('Escape');
  `,
  // D42: joining two roads from the inspector settles like every edit (the street name follows the joined road)
  'inspector-join': `
    road(1550, 1500, 1600, 1500);
    road(1600, 1500, 1650, 1500);
    const n = w.roads.nearestNode(1600, 1500, 1);
    const west = w.roads.nearestSeg(1575, 1500, 3)[0], east = w.roads.nearestSeg(1625, 1500, 3)[0];
    w.streetNames.set(west, 'Rua da Prova'); w.streetNames.set(east, 'Rua da Prova');
    R.tools.set('inspect');
    R.tools.inspect(1600, 1500);
    await wait(300);
    const label = window.__roadcraft.t('inspector.joinAligned');
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
    await R.camera.view(1530, 1515, 0, 60, 250);
    R.tools.set('building');
    R.ui.lotMode('delete');
    // the stroke as the player drags it: down on the first lot, through the second, up on the third
    for (const [type, x] of [['pointerdown', 1502], ['pointermove', 1516], ['pointermove', 1530], ['pointermove', 1544], ['pointerup', 1558]]) { const p = at(x, 1520); pointer(type, p.x, p.y); }
    check('the stroke deleted the three lots', ids.every((i) => !w.buildings.alive[i]), 'alive: ' + ids.map((i) => w.buildings.alive[i]));
    R.history.undo();
    check('one undo brings the three back', ids.every((i) => w.buildings.alive[i]), 'alive: ' + ids.map((i) => w.buildings.alive[i]));
  `,
  // Roadcraft 4.0 ui/inspector.ts:421-426: a node whose roads meet too sharply says it cannot be built, with the angle
  'inspector-impossible': `
    const net = w.roads, n = (x, z) => net.addNode({ x, z, y: a.ground(x, z) });
    const A = n(1500, 1500), B = n(1700, 1500), C = n(1700, 1553);
    net.addSeg({ a: A, b: B, cx: 1600, cz: 1500, profile: 0, flags: 0, zl: 0, zr: 0 });
    net.addSeg({ a: A, b: C, cx: 1600, cz: 1526.5, profile: 0, flags: 0, zl: 0, zr: 0 });
    check('the node is impossible (15° between its roads)', w.impossible.angleAt(A) >= 0, 'angle ' + w.impossible.angleAt(A));
    R.tools.set('inspect');
    R.tools.inspect(1500, 1500);
    await wait(300);
    const warn = document.querySelector('.inspector .inspect-warning');
    check('the node inspector says it cannot be built, with the angle', !!warn && /15/.test(warn.textContent), 'warning: ' + (warn && warn.textContent));
    road(1400, 1800, 1600, 1800); road(1500, 1700, 1500, 1900);
    R.tools.inspect(1500, 1800);
    await wait(300);
    check('a right-angle junction has no such warning', !document.querySelector('.inspector .inspect-warning'), 'warning shown');
  `,
  // Roadcraft 4.0 ui/roads/connectorPanel.ts:40-167: the lane connectors as a plan, by mouse and by keyboard
  'junction-plan': `
    road(1400, 1500, 1600, 1500); road(1500, 1400, 1500, 1600);
    const n = w.roads.nearestNode(1500, 1500, 1);
    R.tools.set('inspect');
    R.tools.inspect(1500, 1500);
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
    R.tools.set('inspect');
    R.tools.inspect(1540, 1500);
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
    R.history.undo();
    check('undo brings the street back', w.roads.segs.cols.profile[w.roads.nearestSeg(1540, 1500, 3)[0]] === 0, 'profile ' + w.roads.segs.cols.profile[w.roads.nearestSeg(1540, 1500, 3)[0]]);
  `,
  // Roadcraft 4.0 ui/v2/shell.ts:1244-1314: lanes, width, parking of the next road; Upgrade with class cards
  'road-options': `
    R.tools.set('road');
    await wait(300);
    const rows = () => [...document.querySelectorAll('.v2-orow, .orow, [class*="orow"]')];
    const click = (text) => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.title || x.textContent || '').trim() === text); if (!b) throw new Error('no button ' + text); b.click(); };
    click('4 faixas');
    await wait(100);
    click('Vagas paralelas nos dois lados');
    await wait(100);
    const rt = R.tools.options().road;
    check('the options vary the road in hand', rt.lanes === 4 && rt.parking === 'parallel' && rt.profile !== rt.base, JSON.stringify({ lanes: rt.lanes, parking: rt.parking }) + ' profile ' + rt.profile + ' base ' + rt.base);
    R.tools.click(1500, 1500); R.tools.click(1600, 1500); key('Escape');
    const s = w.roads.nearestSeg(1550, 1500, 3);
    const strips = s ? w.roads.segs.cols.profile[s[0]] : -1;
    check('the road is drawn with 4 lanes and parking on both kerbs', s && strips === rt.profile, 'segment profile ' + strips + ', tool ' + rt.profile);
    R.tools.set('upgrade');
    await wait(300);
    const cards = [...document.querySelectorAll('.v2-card.wide')].map((c) => c.getAttribute('aria-label'));
    check('Upgrade shows a card for each road class', cards.length >= 5 && cards.includes('Avenida'), 'cards ' + cards);
  `,
  // B50: a street name typed in the inspector can be taken away (an empty name gives the generated one back)
  'street-name-clear': `
    road(1500, 1500, 1700, 1500);
    const s = w.roads.nearestSeg(1550, 1500, 3)[0];
    R.tools.set('inspect');
    R.tools.inspect(1550, 1500);
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
    R.history.undo();
    check('undo brings the typed name back', w.streetNames.get(s) === 'Rua Digitada', 'name ' + w.streetNames.get(s));
  `,
  // the language switched while the game runs (Roadcraft 4.0 ui/roads/catalogPanel.ts:73): cards and editor made again
  'catalog-language': `
    R.tools.set('road');
    await wait(300);
    // as the player: pick a card, open its section editor (Customise…), type a name, then switch the language
    const card = document.querySelector('.rc-catalog .rc-card');
    card.click(); await wait(100);
    document.querySelector('.rc-catalog .rc-card.on .rc-custom.edit').click(); await wait(200);
    const openEditor = () => document.querySelector('.section-editor:not(.hidden)');
    const oldEditor = openEditor();
    const strips = (e) => (e ? e.querySelectorAll('.rp-cards > *').length : -1);
    const stripsBefore = strips(oldEditor);
    const field = oldEditor.querySelector('input.rp-field');
    field.value = 'Minha Rua'; field.dispatchEvent(new Event('input', { bubbles: true }));
    R.setLang('en'); await wait(300);
    check('the cards are made again', !card.isConnected && !!document.querySelector('.rc-catalog .rc-card'), 'old card still in place');
    check('the section editor is made again in its place', !oldEditor.isConnected && !!openEditor(), 'editor not replaced');
    const now = openEditor(), name = now && now.querySelector('input.rp-field').value;
    check('an open edit stays open with its profile and name', name === 'Minha Rua' && strips(now) === stripsBefore, JSON.stringify({ name, strips: strips(now), before: stripsBefore }));
    R.setLang('pt-BR');
  `,
  // B49: deleting a road model the player used in this session takes its card out of "Mine"
  'catalog-delete-template': `
    localStorage.removeItem('cidade.modelosDeVia');
    R.tools.set('road');
    await wait(300);
    // as the player: Customise a card, name it, Enter saves it as a model of their own, then the Mine tab
    const pickCard = document.querySelector('.rc-catalog .rc-card');
    pickCard.click(); await wait(100);
    document.querySelector('.rc-catalog .rc-card.on .rc-custom.edit').click(); await wait(200);
    const field = document.querySelector('.section-editor:not(.hidden) input.rp-field');
    field.value = 'Modelo Teste'; field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    await wait(200);
    document.querySelector('.rc-catalog [data-category=meus]').click(); await wait(200);
    const cat = { grid: document.querySelector('.rc-catalog'), tabs: document.querySelector('.rc-catalog') };
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

const { names, unknown } = pick(SCENARIOS);
let failed = unknown;
for (const name of names) {
  const own = scenarioFolder('roadcraft-vias-', name);
  failed += report(name, checksOf(await session({ query: '?empty&hour=11&workers=3', script: wrap(PRELUDE, SCENARIOS[name]), own: own.dir })));
  own.done();
}
console.log(failed ? `road check: ${failed} FAILED` : 'road check: ok');
process.exit(failed ? 1 : 0);
