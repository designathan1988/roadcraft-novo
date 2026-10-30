// The interface checked in the real game (the machine's GPU): each scenario clicks the real buttons and presses the
// real keys (the same events the player makes), then checks what the game did. One Electron session per scenario,
// with a user data folder of its own (never the game's). Results are printed as "CHECK OK|FAILED name".
// Usage: npx vite build && node tools/check-interface.mjs [scenario...]   (exits with code 1 if anything fails)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_RESET, FRESH_SNAPSHOT, checksByScenario, checksOf, eachScenario, pick, report, scenarioFolder, session, sharedScript, wrap } from './checks/run.mjs';

// Page helpers shared by every scenario.
const PRELUDE = `
const R = window.__roadcraft, a = R.actions, w = R.world, A = R.ui;
const errors = [];
const logError = console.error.bind(console);
console.error = (...x) => { errors.push(x.map(String).join(' ').slice(0, 300)); logError(...x); };
window.addEventListener('error', (e) => errors.push('error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { const f = () => (n-- <= 0 ? r() : requestAnimationFrame(f)); f(); });
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
const Q = (s) => document.querySelector(s), QA = (s) => [...document.querySelectorAll(s)];
// the Options dialog as the player sees it (About shares its backdrop and its buttons row; only Options has option rows)
const optionsRoot = () => QA('.v2-dialog-back').find((e) => e.querySelector('.opt-row'));
const optionsOpen = () => { const r = optionsRoot(); return !!r && !r.classList.contains('hidden'); };
const label = (e) => [e.textContent, e.title, e.dataset.tip, e.getAttribute('aria-label')].filter(Boolean).join(' | ');
const byText = (sel, re) => QA(sel).find((e) => new RegExp(re).test(label(e)));
const click = (s) => { const e = typeof s === 'string' ? Q(s) : s; if (!e) throw new Error('nothing to click: ' + s); e.click(); };
// keys go to the focused element (the page when nothing is), as the browser sends them
const key = (code, o = {}) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { code, key: o.key ?? code, bubbles: true, cancelable: true, ...o }));
const keyUp = (code, o = {}) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keyup', { code, key: o.key ?? code, bubbles: true, ...o }));
/** A left click on the map at (x, z): the camera looks straight at the point and the canvas centre is clicked. */
const mapClick = async (x, z, o = {}) => {
  await R.camera.view(x, z, 0, 70, o.dist ?? 140);
  await frames(3);
  const c = document.getElementById('view'), r = c.getBoundingClientRect();
  const p = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', bubbles: true, isPrimary: true, shiftKey: !!o.shift };
  c.dispatchEvent(new PointerEvent('pointermove', { ...p, buttons: 0 }));
  await frames(2);
  c.dispatchEvent(new PointerEvent('pointerdown', p));
  c.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
  await frames(2);
};
const road = (ax, az, bx, bz, profile = 0) => { const r = a.road(ax, az, bx, bz, profile); if (r !== 'ok') throw new Error('road refused: ' + r); };
/** The list of an options row (a themed list or a native select): pick a value, read the value shown. */
const listOf = (re) => { const r = QA('.v2-toolopts .v2-orow').find((x) => re.test(x.getAttribute('aria-label'))); return r && (r.querySelector('.v2-dd') || r.querySelector('select')); };
const choose = async (re, v) => { const l = listOf(re); if (l.tagName === 'SELECT') { l.value = String(v); l.dispatchEvent(new Event('change')); } else { l.click(); await frames(1); Q('.v2-dd-list [data-value="' + v + '"]').click(); } await frames(2); };
const listValue = (re) => { const l = listOf(re); return l ? (l.tagName === 'SELECT' ? l.value : l.dataset.value) : undefined; };
w.unlimited = true;
`;

export { PRELUDE };
export const SCENARIOS = {
  // B16: the road height stepper shows the height the road is drawn at
  'B16-road-height': `
    click('[data-cat=roads]');
    await frames(2);
    const plus = byText('.v2-stepper .v2-icon', '\\\\+$');
    click(plus);
    await frames(2);
    const shown = Q('.v2-stepper-value').textContent;
    const real = R.tools.options().road.elevation;
    check('one + raises the road 4 m', real === 4, 'elevation ' + real);
    check('the stepper shows the height the road is drawn at', shown.includes('4') && !shown.includes('8'), 'shows "' + shown + '" for ' + real + ' m');
  `,
  // B32: the camera panel's "turn left (Q)" and "turn right (E)" turn the way Q and E do
  'B32-turn-buttons': `
    await R.camera.view(0, 0, 0, 40, 300);
    const yaw0 = R.camera.pose().yaw;
    key('KeyQ'); await wait(400); keyUp('KeyQ'); await wait(300);
    const q = R.camera.pose().yaw - yaw0;
    click('[data-pop=camera]');
    await frames(2);
    const y1 = R.camera.pose().yaw;
    // the turn-left button: its name without the key, as Roadcraft 4.0 (v2/shell.ts:759)
    click(byText('.v2-pop .v2-icon', '^Girar à esquerda|^Turn left'));
    await wait(1500);
    const left = R.camera.pose().yaw - y1;
    check('Q turns the camera', Math.abs(q) > 0.1, 'Q turned ' + q.toFixed(3));
    check('the turn-left button turns the same way as Q', Math.sign(left) === Math.sign(q) && Math.abs(left) > 0.1, 'Q ' + q.toFixed(3) + ', button ' + left.toFixed(3));
  `,
  // B31: [ and ] with the zone tool change the zone brush (the radius the panel shows), not the hidden terrain brush
  'B31-zone-radius-keys': `
    click('[data-cat=zones]');
    await frames(2);
    const before = R.tools.options().zone.radius, brush = R.tools.options().brush.radius;
    key('BracketRight');
    await frames(2);
    check('] widens the zone brush', R.tools.options().zone.radius > before, 'zone radius ' + before + ' → ' + R.tools.options().zone.radius + ', terrain brush ' + brush + ' → ' + R.tools.options().brush.radius);
    const slider = QA('.v2-range').find((r) => /Raio|Radius/.test(r.getAttribute('aria-label')));
    check('the radius slider follows', slider && Number(slider.value) === Math.round(R.tools.options().zone.radius), 'slider ' + (slider && slider.value) + ', zone radius ' + R.tools.options().zone.radius);
  `,
  // B4: with a bus line chosen, the Train station tab puts a station on a train line (not a bus stop on the bus line)
  'B4-station-tabs': `
    road(0, 100, 400, 100);
    a.line(0, [200, 108], 1);
    road(0, -100, 400, -100, 'Ferrovia dupla');
    const bus = R.transit.lines()[0];
    click('[data-cat=transit]');
    await frames(2);
    click(byText('.v2-tab', 'Estação de trem|Train station'));
    await frames(2);
    await mapClick(200, -100);
    const train = R.transit.lines().find((l) => (l.mode ?? 0) === 1);
    check('the click makes a train station', !!train && train.stops.length === 2, 'lines: ' + R.transit.lines().map((l) => 'mode ' + (l.mode ?? 0) + ' with ' + l.stops.length / 2 + ' stops').join('; '));
    check('the bus line is left alone', bus.stops.length === 2, 'bus line has ' + bus.stops.length / 2 + ' stops');
  `,
  // B5: after Remove poles, a smoke card places smoke (it does not remove)
  'B5-remove-then-place': `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    click(byText('.v2-card', 'Remover postes|Remove poles')); await frames(2);
    click(byText('.v2-tab', 'Céu|Sky')); await frames(2);
    click(byText('.v2-card', 'Fumaça|Smoke')); await frames(2);
    const n = w.items.size;
    await mapClick(150, 40);
    check('the smoke card places smoke', w.items.size === n + 1, 'items ' + n + ' → ' + w.items.size);
  `,
  // B6: Remove poles removes poles, and leaves walls (and fences, hedges, guardrails) standing
  'B6-remove-poles-only': `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    click(byText('.v2-card', '^Muro|^Wall')); await frames(2);
    await mapClick(100, 60); await mapClick(160, 60); key('Enter'); await frames(2);
    const walls = w.items.size;
    click(byText('.v2-card', 'Construir rede|Build network')); await frames(2);
    await mapClick(100, 200); await mapClick(160, 200); key('Enter'); await frames(2);
    const all = w.items.size;
    check('a wall and a pole line are built', walls > 0 && all > walls, 'items: wall ' + walls + ', with poles ' + all);
    click(byText('.v2-card', 'Remover postes|Remove poles')); await frames(2);
    await mapClick(130, 60);
    check('Remove poles leaves the wall', w.items.size === all, 'items ' + all + ' → ' + w.items.size);
    await mapClick(130, 200);
    check('Remove poles removes the pole line', w.items.size < all, 'items ' + all + ' → ' + w.items.size);
  `,
  // B18: undo brings the building panel back to the building as it is (or to none)
  'B18-undo-building-panel': `
    click('[data-cat=build]'); await frames(2);
    const id = a.lot(100, 100, 130, 100, 115, 130, 1, 3);
    R.tools.select(id); await frames(2);
    click(byText('.v2-stepper .v2-icon', '\\\\+$')); await frames(2);
    const after = Q('.v2-stepper-value').textContent;
    key('KeyZ', { ctrlKey: true }); await frames(2);
    const undone = Q('.v2-stepper-value') && Q('.v2-stepper-value').textContent;
    check('+ adds a floor', after === '4', 'shows ' + after);
    check('undo shows the floors back', undone === String(w.buildings.cols.floors[id]) && undone === '3', 'panel ' + undone + ', building ' + w.buildings.cols.floors[id]);
    // a.lot is two steps (the lot, then its floors)
    for (let k = 0; k < 3 && w.buildings.alive[id]; k++) { key('KeyZ', { ctrlKey: true }); await frames(2); }
    check('undoing the lot leaves no building in the panel', !w.buildings.alive[id] && !Q('.v2-toolopts .v2-stepper-value'), 'alive ' + w.buildings.alive[id] + ', panel stepper ' + (Q('.v2-toolopts .v2-stepper-value') && Q('.v2-toolopts .v2-stepper-value').textContent));
  `,
  // B19: the road furniture choice shows what was chosen, after the game is opened again
  'B19-furniture-after-reload': [`
    click('[data-cat=roads]'); await frames(2);
    click(byText('[data-furniture]', 'Nenhum|None')); await frames(2);
    check('None is chosen', R.options.get().furniture === 2, 'furniture ' + R.options.get().furniture);
  `, `
    click('[data-cat=roads]'); await frames(2);
    const on = Q('[data-furniture].on');
    check('the panel shows None after reopening', on && /Nenhum|None/.test(on.textContent), 'lit: ' + (on && on.textContent) + ', settings ' + R.options.get().furniture);
  `],
  // B20: applying the options keeps what other panels changed since (simulation traffic)
  'B20-options-keep-others': `
    const options = async () => { click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2); };
    await options();
    click(byText('.v2-dialog button', '^Aplicar$|^Apply$')); await wait(1500);
    click('[data-pop=sim]'); await frames(2);
    const r = QA('.v2-pop .v2-range').find((e) => /Tráfego|Traffic/.test(e.getAttribute('aria-label')));
    r.value = '50'; r.dispatchEvent(new Event('input', { bubbles: true })); await frames(2);
    check('the simulation panel sets traffic 50%', R.options.get().traffic === 0.5, 'traffic ' + R.options.get().traffic);
    click('[data-pop=sim]');
    await options();
    click(byText('.v2-dialog button', '^Aplicar$|^Apply$')); await wait(1500);
    check('applying the options keeps traffic 50%', R.options.get().traffic === 0.5, 'traffic ' + R.options.get().traffic);
  `,
  // B21: applying the options keeps the weather set by hand
  'B21-options-keep-weather': `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', 'Céu|Sky')); await frames(2);
    click(byText('.v2-card', '^Clima|^Weather')); await frames(2);
    click(byText('.v2-choice', 'Ajustado aqui|Set here')); await frames(2);
    const rain = QA('.v2-range').find((e) => /Chuva|Rain/.test(e.getAttribute('aria-label')));
    rain.value = '100'; rain.dispatchEvent(new Event('input', { bubbles: true })); await frames(2);
    check('the panel sets rain 100%', R.sky.weather() && R.sky.weather().rain === 1, 'fixed ' + JSON.stringify(R.sky.weather()));
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    click(byText('.v2-dialog button', '^Aplicar$|^Apply$')); await wait(1500);
    check('applying the options keeps rain 100%', R.sky.weather() && R.sky.weather().rain === 1, 'fixed ' + JSON.stringify(R.sky.weather()));
  `,
  // B39: the chosen line's colour and ring have buttons in the transit panel
  'B39-line-colour-loop': `
    road(0, 100, 400, 100);
    a.line(0, [100, 108, 300, 108], 1);
    const l = R.transit.lines()[0], c0 = l.color;
    click('[data-cat=transit]'); await frames(4);
    const sw = QA('.v2-line-colours .v2-swatch').find((b) => !b.classList.contains('on'));
    check('the panel has colour swatches for the line', !!sw, 'no swatch');
    if (sw) { click(sw); await frames(2); }
    check('a swatch changes the line colour', l.color !== c0, 'colour ' + c0 + ' → ' + l.color);
    const ring = byText('.v2-toolopts .v2-choice', 'Circular|Ring');
    check('the panel has the ring choice', !!ring, 'no ring button');
    if (ring) { click(ring); await frames(2); }
    check('the ring choice makes the line a ring', l.loop === true, 'loop ' + l.loop);
    key('KeyZ', { ctrlKey: true }); await frames(2);
    check('undo takes the ring back', !l.loop, 'loop ' + l.loop);
  `,
  // B40: an impossible junction shows a warning in the top bar; its click takes the camera there and inspects it
  'B40-impossible-warning': `
    road(-300, 0, 0, 0);
    road(0, 0, 300, 0);
    road(0, 0, 300, 70);
    const n = A.impossibleNodes();
    check('the junction is impossible (under 25°)', n > 0, 'impossible nodes ' + n);
    await wait(1200);
    const warn = Q('.v2-warn');
    check('the top bar shows the warning with the count', warn && !warn.hidden && warn.textContent.includes(String(n)), 'warning ' + (warn ? (warn.hidden ? 'hidden' : '"' + warn.textContent + '"') : 'missing'));
    await R.camera.view(3000, 3000, 0, 40, 300);
    if (warn) click(warn);
    await wait(1500);
    const d = Math.hypot(R.camera.pose().x, R.camera.pose().z);
    check('its click points the camera at the node', d < 30, 'camera target ' + R.camera.pose().x.toFixed(0) + ', ' + R.camera.pose().z.toFixed(0));
    check('and inspects it', R.tools.current() === 'inspect' && R.tools.inspector().open, 'tool ' + R.tools.current() + ', inspector open ' + R.tools.inspector().open);
    R.history.undo();
    await wait(1200);
    check('the warning goes when the junction is fixed', !Q('.v2-warn') || Q('.v2-warn').hidden, 'count now ' + A.impossibleNodes());
  `,
  // B51: always day (or night) fixes the light, while the clock and the traffic demand go on
  'B51-always-day-clock': { query: '?empty&workers=3', script: `
    R.sky.setHour(8); A.speed(4); // the time of day follows the speed: 4 game hours per real minute
    click('[data-sky=day]'); await frames(2);
    const h0 = R.sky.hour();
    await wait(4000);
    check('the clock goes on with always day', R.sky.hour() > h0 + 0.03, 'hour ' + h0.toFixed(3) + ' → ' + R.sky.hour().toFixed(3));
    const sent = [];
    // the demand message the page sends to the simulation, seen at the boundary (Worker postMessage)
    const W = Worker.prototype, post = W.postMessage;
    W.postMessage = function (m, t) { if (m && m.type === 'demand') sent.push(m.hour); return post.call(this, m, t); };
    await wait(2600);
    W.postMessage = post;
    check('the demand follows the clock, not noon', sent.length > 0 && sent[sent.length - 1] !== 12 && Math.abs(sent[sent.length - 1] - R.sky.hour()) < 1.2, 'demand hour ' + sent + ', clock ' + R.sky.hour().toFixed(2));
  ` },
  // B52: the repair notice opening an old map stays readable next to "City loaded"
  'B52-toasts-stack': `
    const net = w.roads;
    const n = (x, z) => net.addNode({ x, z, y: 10 });
    const P = n(1400, 1500), B = n(1700, 1500), C = n(1550, 1500.5), D = n(1550, 1600);
    net.addSeg({ a: P, b: B, cx: 1550, cz: 1500, profile: 0, flags: 0, zl: 0, zr: 0 });
    net.addSeg({ a: C, b: D, cx: 1550, cz: 1550, profile: 0, flags: 0, zl: 0, zr: 0 });
    for (let t = 0; t < w.saveDirty.length; t++) w.saveDirty[t] = 1;
    await R.saves.save(false);
    await R.saves.load();
    await wait(300);
    const shown = QA('.v2-toast').filter((e) => !e.hidden).map((e) => e.textContent).join(' / ');
    check('the repair notice is still shown', /reparado|repaired/i.test(shown), 'toasts: ' + shown);
    check('and so is "City loaded"', /carregada|loaded/i.test(shown), 'toasts: ' + shown);
  `,
  // B41: the builder's tabs (Models, Facade, Roof, Parts, Colours) light up when the buildings session mounts them
  'B41-builder-tabs': `
    const can = typeof R.panels.registerBuilderTab === 'function';
    check('the interface offers a mount point for builder tabs', can, 'R.panels.registerBuilderTab is ' + typeof R.panels.registerBuilderTab);
    if (can) R.panels.registerBuilderTab('facade', (box, b) => { const p = document.createElement('p'); p.className = 'probe-facade'; p.textContent = 'facade of ' + (b ? b.floors : 'none'); box.append(p); });
    click('[data-cat=build]'); await frames(2);
    const facade = byText('.v2-tab', '^Fachada|^Facade'), roof = byText('.v2-tab', '^Telhado|^Roof');
    check('a mounted tab is enabled', facade && !facade.disabled, 'facade tab ' + (facade ? (facade.disabled ? 'disabled' : 'enabled') : 'missing'));
    check('a tab nobody mounted stays "being built"', roof && roof.disabled, 'roof tab ' + (roof && roof.disabled));
    if (facade && !facade.disabled) { click(facade); await frames(2); }
    check('its click shows the mounted content', !!Q('.probe-facade'), 'no content');
    click(byText('.v2-tab', '^Editar|^Edit')); await frames(2);
    check('Edit goes back to the building panel', !Q('.probe-facade'), 'content still shown');
  `,
  // B57: in English, the game's own hints and toasts are in English
  'B57-english': { query: '?empty&hour=11&workers=3&lang=en', script: `
    click('[data-cat=zones]'); await frames(2);
    const hint = Q('.v2-hintbar').textContent;
    check('the zone hint is in English', /Drag/.test(hint) && !/[ãõçéêáíóúâô]|Arraste/.test(hint), 'hint: ' + hint);
    click('[data-cat=build]'); await frames(2);
    R.tools.select(a.lot(100, 100, 130, 100, 115, 130, 1, 3)); await frames(2);
    click(byText('.v2-toolopts button', '^Renovate')); await frames(2);
    const toasts = QA('.v2-toast').map((e) => e.textContent).join(' / ');
    check('the toast is in English', toasts.length > 0 && !/[ãõçéêáíóúâô]|Nenhuma/.test(toasts), 'toasts: ' + toasts);
  ` },
  // B17: the height and radius selectors follow PageUp/PageDown and [ ]
  'B17-selectors-follow-keys': `
    click('[data-cat=roads]'); await frames(2);
    key('PageUp'); keyUp('PageUp'); await frames(2);
    const h = Q('.v2-toolopts .v2-stepper-value').textContent;
    check('PageUp shows in the height selector', /4/.test(h), 'elevation ' + R.tools.options().road.elevation + ', shows ' + h);
    click(byText('.v2-tab', 'Rotatória|Roundabout')); await frames(2);
    key('BracketRight'); await frames(2);
    // the radius is a slider since the 4.0 drawers: its number and its knob follow ]
    const ring = QA('.v2-toolopts .v2-orow').find((x) => /Raio|Radius/.test(x.getAttribute('aria-label')));
    const r = ring ? ring.querySelector('.v2-range-out').textContent : 'none';
    check('] shows in the roundabout radius', r !== '22 m' && r === R.tools.options().road.ringRadius + ' m' && ring.querySelector('input').value === String(R.tools.options().road.ringRadius), 'shows ' + r + ', radius ' + R.tools.options().road.ringRadius);
  `,
  // B22: the next drawn lot shows the style and function that will be used
  'B22-next-lot-choice': `
    click('[data-cat=build]'); await frames(2);
    await choose(/Estilo|Style/, 2); await choose(/Função|Function/, 3);
    click('[data-cat=roads]'); await frames(2); click('[data-cat=build]'); await frames(2);
    check('the style shown is the one chosen', listValue(/Estilo|Style/) === '2' && R.tools.options().lots.newArch === 2, 'shows ' + listValue(/Estilo|Style/) + ', next ' + R.tools.options().lots.newArch);
    check('the function shown is the one chosen', listValue(/Função|Function/) === '3' && R.tools.options().lots.newFn === 3, 'shows ' + listValue(/Função|Function/) + ', next ' + R.tools.options().lots.newFn);
  `,
  // B23: the water panel shows the values of the map that was opened
  'B23-panels-show-map': `
    A.water({ waves: 0.9, foam: 0.1, current: 2 });
    await R.saves.save(false); A.water({ waves: 0.3, foam: 0.4, current: 0.5 }); await R.saves.load();
    click('[data-cat=landscape]'); await frames(2);
    // the water rows show with the river brush (as Roadcraft 4.0)
    click(byText('.v2-card', '^Rio|^River')); await frames(2);
    const waves = QA('.v2-range').find((e) => /Ondas|Waves/.test(e.getAttribute('aria-label')));
    check('the waves slider shows the map', waves && waves.value === '90', 'slider ' + (waves && waves.value) + ', map ' + R.ui.environment().water.waves);
  `,
  // B24: the decay figure follows the city clock while the panel is open
  'B24-decay-follows-clock': `
    click('[data-cat=build]'); await frames(2);
    const id = a.lot(100, 100, 130, 100, 115, 130, 1, 3); R.tools.select(id); await frames(2);
    const row = () => { const r = QA('.v2-toolopts .v2-orow').find((e) => /Desgaste|Decay/.test(e.getAttribute('aria-label'))); return r ? r.querySelector('.v2-stepper-value').textContent : 'none'; };
    const before = row();
    a.passTime(60 * 24 * 365 * 30); await wait(1200);
    check('the decay row changes with the clock', row() !== before, 'shows ' + before + ' → ' + row() + ', building ' + w.buildings.cols.decay[id] / 10);
  `,
  // B25: the floors selector stops at 60, and "−" on an empty lot builds nothing
  'B25-floors-limits': `
    click('[data-cat=build]'); await frames(2);
    const id = a.lot(100, 100, 130, 100, 115, 130, 1, 60); R.tools.select(id); await frames(2);
    click(byText('.v2-stepper .v2-icon', '\\\\+$')); await frames(2);
    check('+ at 60 floors stays at 60', Q('.v2-toolopts .v2-stepper-value').textContent === '60', 'shows ' + Q('.v2-toolopts .v2-stepper-value').textContent);
    w.editBuilding(id, 0, w.buildings.cols.style[id], 0); R.tools.select(id); await frames(2);
    click(byText('.v2-stepper .v2-icon', '−$|-$')); await frames(2);
    check('− on an empty lot builds nothing', w.buildings.cols.floors[id] === 0, 'floors ' + w.buildings.cols.floors[id]);
  `,
  // B26: dragging a weather slider in automatic mode keeps the slider (the drag goes on)
  'B26-weather-drag': `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', 'Céu|Sky')); await frames(2);
    click(byText('.v2-card', '^Clima|^Weather')); await frames(2);
    const rain = QA('.v2-range').find((e) => /Chuva|Rain/.test(e.getAttribute('aria-label')));
    rain.value = '30'; rain.dispatchEvent(new Event('input', { bubbles: true })); await frames(2);
    check('the slider being dragged stays on the page', rain.isConnected, 'the panel was rebuilt under the drag');
  `,
  // B28: F1 with another menu open lights only the help button
  'B28-help-button-lit': `
    click('[data-pop=menu]'); await frames(2);
    key('F1'); await frames(2);
    check('the menu button goes out', !Q('[data-pop=menu]').classList.contains('on'), 'menu still lit');
    check('the help button is lit', Q('[data-pop=help]').classList.contains('on'), 'help not lit');
  `,
  // B29: a change in passengers per hour does not rebuild the transit panel (a click on it is not lost)
  'B29-transit-panel-steady': `
    road(0, 100, 400, 100); a.line(0, [100, 108, 300, 108], 1);
    click('[data-cat=transit]'); await frames(4);
    const row = Q('.v2-transit-line');
    const l = R.transit.lines()[0];
    // the simulation's own report for the line (every second): wait for two of them, the second may change the figure
    const report = () => (R.sim.stats()?.lines ?? []).find((x) => x.id === l.id);
    let first = null;
    for (let k = 0; k < 120 && !(first = report()); k++) await wait(250);
    const s0 = R.sim.stats();
    for (let k = 0; k < 40 && R.sim.stats() === s0; k++) await wait(100);
    await frames(4);
    const now = report();
    check('the line is reported by the simulation', !!first && !!now, 'no report for the line');
    check('the row stays', row && row.isConnected, 'the panel was rebuilt');
    check('and shows the reported figure', !!now && Q('.v2-transit-line') && Q('.v2-transit-line').textContent.includes(String(now.perHour)), 'row: ' + (Q('.v2-transit-line') && Q('.v2-transit-line').textContent) + ', reported ' + (now && now.perHour));
  `,
  // B33: Esc ends the wall being traced and keeps the tool; Esc drops the first click of a lot line
  'B33-esc-steps-back': `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    click(byText('.v2-card', '^Muro|^Wall')); await frames(2);
    await mapClick(100, 60);
    key('Escape'); await frames(2);
    check('Esc ends the wall and keeps the wall tool', R.tools.current() === 'barrier', 'tool ' + R.tools.current());
    key('Escape'); await frames(2);
    check('a second Esc puts the tool down', R.tools.current() === 'camera', 'tool ' + R.tools.current());
    A.lotLine(); await frames(2);
    await mapClick(100, 100);
    key('Escape'); await frames(2);
    check('Esc drops the first click of the lot line', R.tools.options().lotPoints === 0 && R.tools.current() === 'building', 'points ' + R.tools.options().lotPoints + ', tool ' + R.tools.current());
  `,
  // B36: closing the options while a road key is being captured leaves the next key to the game
  'B36-options-capture': `
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const before = R.options.get().roadUp ?? 'PageUp';
    click(QA('.v2-dialog .v2-btn').find((b) => /Page|Up/.test(b.textContent))); await frames(1);
    click([...optionsRoot().querySelectorAll('button')].find((b) => /^(Fechar|Close)$/.test(b.textContent))); await frames(2);
    const mode = R.camera.pose().mode;
    key('KeyV'); await frames(2);
    check('the next key goes to the game (V changes the view)', R.camera.pose().mode !== mode, 'view stayed ' + mode + ', focus ' + (document.activeElement && document.activeElement.tagName) + ', options open ' + optionsOpen());
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const shown = QA('.v2-dialog .v2-btn').find((b) => /Page|Up|Numpad/.test(b.textContent));
    check('the dialog shows the road key unchanged', shown && /Page Up/.test(shown.textContent), 'shows ' + (shown && shown.textContent));
  `,
  // B37: the game's keys do nothing while the options, About or the start screen are open
  'B37-keys-blocked-by-dialogs': `
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const mode = R.camera.pose().mode;
    key('KeyV'); key('KeyT'); await frames(2);
    check('V does not change the view under the options', R.camera.pose().mode === mode, 'view ' + mode + ' → ' + R.camera.pose().mode);
    check('T does not open a drawer under the options', R.tools.current() === 'camera', 'tool ' + R.tools.current());
    key('Escape'); await frames(2);
    check('Esc closes the options', !optionsOpen(), 'still open');
  `,
  // B44: the rail track tabs show height, snapping and cut sides like the roads do
  'B44-rail-tabs-options': `
    click('[data-cat=transit]'); await frames(2);
    click(byText('.v2-tab', 'Trilho de trem|Train track')); await frames(2);
    const rows = QA('.v2-toolopts .v2-orow').map((e) => e.getAttribute('aria-label')).join(', ');
    check('the train track shows height, snapping and cut', /Altura|Height/.test(rows) && /Encaixe|Snap/.test(rows) && /Corte|Cut/.test(rows), 'rows: ' + rows);
  `,
  // B47: a building put on an empty lot uses the style and function chosen for the next one
  'B47-empty-lot-choice': `
    road(1400, 1500, 1800, 1500); a.zone(1600, 1520, 60, 1); // the map centre is a river
    R.cities.growthRate(0); // nothing grows by itself during the check
    const free = (await R.cities.freeLots())[0] ?? null;
    check('there is an empty lot', !!free, 'no free lot; seg zones ' + w.roads.segs.cols.zl[0] + '/' + w.roads.segs.cols.zr[0] + ', buildings ' + w.buildings.size);
    if (free) {
      click('[data-cat=build]'); await frames(2);
      A.style(4); A.buildingFn(2);
      await mapClick(free[0], free[1]);
      const id = R.tools.selected(), c = w.buildings.cols;
      check('the building uses the chosen style and function', id >= 0 && c.style[id] === 128 + 4 && c.fn[id] === 2, 'id ' + id + ', style ' + c.style[id] + ', fn ' + c.fn[id]);
    }
  `,
  // B45: what the hints promise for a double click happens (inside view of a building; the end of a wall)
  'B45-double-clicks': `
    click('[data-cat=build]'); await frames(2);
    const id = a.lot(1500, 1500, 1530, 1500, 1515, 1530, 1, 4);
    await mapClick(w.buildings.cols.x[id], w.buildings.cols.z[id]);
    document.getElementById('view').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: innerWidth / 2, clientY: innerHeight / 2 })); await frames(4);
    check('a double click on a building shows it inside', R.view.inside() && R.view.insideId() === id, 'inside ' + R.view.inside() + ', building ' + R.view.insideId() + ' (clicked ' + id + ')');
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    click(byText('.v2-card', '^Muro|^Wall')); await frames(2);
    await mapClick(1700, 1600); await mapClick(1760, 1600);
    document.getElementById('view').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: innerWidth / 2, clientY: innerHeight / 2 })); await frames(2);
    check('a double click ends the wall', !R.tools.options().items.wallOpen && R.tools.current() === 'barrier', 'wall still open ' + R.tools.options().items.wallOpen + ', tool ' + R.tools.current());
  `,
  // B48: split by line and curve side show the line from the first click to the cursor
  'B48-lot-line-preview': `
    click('[data-cat=build]'); await frames(2);
    a.lot(1500, 1500, 1540, 1500, 1520, 1540, 1, 2);
    A.lotLine(); await frames(2);
    await mapClick(1490, 1520);
    await R.camera.view(1550, 1520, 0, 70, 140); await frames(2);
    const c = document.getElementById('view'), r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, bubbles: true })); await frames(3);
    check('the line from the first click shows', R.render.preview(), 'no preview');
  `,
  // B53: a photo parameter in the address (?semsombra) is not written into the player's options
  'B53-url-not-saved': { query: '?empty&hour=11&workers=3&noshadows', script: `
    check('the photo parameter applies', R.options.get().shadows === false, 'shadows ' + R.options.get().shadows);
    click('[data-cat=roads]'); await frames(2);
    click(byText('[data-furniture]', 'Básico|Basic')); await frames(2);
    const kept = JSON.parse(localStorage.getItem('roadcraft.settings') || '{}');
    check('the furniture choice is kept', kept.furniture === 1, 'stored ' + JSON.stringify(kept));
    check('the shadows of the address are not kept', kept.shadows !== false, 'stored shadows ' + kept.shadows);
  ` },
  // B54: two fingers apart on a touch screen zoom in
  'B54-pinch-zoom': `
    await R.camera.view(1500, 1500, 0, 50, 400); await frames(4);
    const c = document.getElementById('view'), r = c.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (type, id, x) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    const d0 = R.camera.pose().dist;
    ev('pointerdown', 1, cx - 50); ev('pointerdown', 2, cx + 50);
    for (let k = 1; k <= 10; k++) { ev('pointermove', 1, cx - 50 - k * 15); ev('pointermove', 2, cx + 50 + k * 15); await frames(1); }
    ev('pointerup', 1, cx - 200); ev('pointerup', 2, cx + 200);
    await wait(800);
    check('spreading two fingers zooms in', R.camera.pose().dist < d0 * 0.7, 'distance ' + d0.toFixed(0) + ' → ' + R.camera.pose().dist.toFixed(0));
    const t = R.camera.pose();
    check('and does not drag the map away', Math.hypot(t.x - 1500, t.z - 1500) < 60, 'target ' + t.x.toFixed(0) + ', ' + t.z.toFixed(0));
  `,
  // B55: the sound stops while the game is hidden (minimised); no birds in a city block with no trees
  'B55-sound-hidden-birds': `
    R.audio.start(); await wait(300);
    const ctx = { get state() { return R.audio.state(); } };
    check('the sound runs', ctx && ctx.state === 'running', 'state ' + (ctx && ctx.state));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange')); await wait(400);
    check('hidden, the sound stops', ctx && ctx.state === 'suspended', 'state ' + (ctx && ctx.state));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange')); await wait(400);
    check('shown again, it plays', ctx && ctx.state === 'running', 'state ' + (ctx && ctx.state));
    await R.camera.view(1500, 1500, 0, 50, 120); await wait(1500);
    check('birds in the open country', R.audio.green() > 0.5, 'green ' + R.audio.green());
    // a block of streets and buildings, no trees
    for (let k = 0; k < 5; k++) { road(1400, 1400 + k * 50, 1600, 1400 + k * 50); road(1400 + k * 50, 1400, 1400 + k * 50, 1600); }
    for (let k = 0; k < 4; k++) for (let m = 0; m < 4; m++) a.lot(1405 + k * 50, 1420 + m * 50, 1445 + k * 50, 1420 + m * 50, 1425 + k * 50, 1445 + m * 50, 2, 6);
    await R.camera.view(1500, 1500, 0, 50, 120); await wait(1500);
    check('no birds over a treeless block', typeof R.audio.green() === 'number' && R.audio.green() < 0.2, 'green ' + R.audio.green());
  `,
  // B34: the help (F1) lists every key the game answers, from the key table
  'B34-help-lists-keys': `
    key('F1'); await frames(2);
    const lines = Q('.v2-pop').innerText.split(String.fromCharCode(10)).map((l) => l.trim());
    const want = ['Ctrl + O', 'Ctrl + D', 'Home', 'Shift + Q / E', 'U', 'M', 'X', 'G', 'N', '2', '0', 'K', 'V', 'C', 'P'];
    const missing = want.filter((k) => !lines.includes(k));
    check('every key is listed', missing.length === 0, 'missing ' + missing.join(', '));
    check('no bundle of letters', !lines.includes('1 Z H T O B I'), 'still lists "1 Z H T O B I"');
    const save = lines[lines.indexOf('Ctrl + S') + 1];
    check('Ctrl + S is Save (not Save map, which exports)', /^(Salvar|Save)$/.test(save || ''), 'Ctrl + S says "' + save + '"');
  `,
  // B38: Enter on a button clicked before does not click it again
  'B38-enter-no-reclick': `
    const b = Q('[data-cat=roads]');
    b.focus();
    const e = new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true });
    b.dispatchEvent(e);
    check('Enter does not activate the focused button', e.defaultPrevented, 'the browser would click it again');
    check('the button lets the focus go', document.activeElement !== b, 'still focused');
  `,
  // The 4.0 keys: Ctrl+O opens a map file, Ctrl+D duplicates the inspected road, Home goes back to the opening view,
  // Shift+Q / Shift+E turn a quarter
  'keys-from-4.0': `
    road(1400, 1500, 1700, 1500);
    let picker = 0;
    const click0 = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') picker++; else click0.call(this); };
    key('KeyO', { ctrlKey: true }); await frames(2);
    HTMLInputElement.prototype.click = click0;
    check('Ctrl+O opens the map file picker', picker === 1, 'picker opened ' + picker + ' times');
    click('[data-cat=info]'); await frames(2);
    { const sc = w.roads.segs.cols, nc = w.roads.nodes.cols; const k = w.roads.segs.alive.indexOf(1); R.tools.inspect((nc.x[sc.a[k]] + nc.x[sc.b[k]]) / 2, (nc.z[sc.a[k]] + nc.z[sc.b[k]]) / 2); } await frames(4);
    const segs = w.roads.segs.size;
    key('KeyD', { ctrlKey: true }); await frames(4);
    check('Ctrl+D duplicates the inspected road', w.roads.segs.size > segs, 'segments ' + segs + ' → ' + w.roads.segs.size + ', inspector ' + R.tools.inspector().open + ' seg ' + R.tools.inspector().seg + ', toasts ' + QA('.v2-toast').map((e) => e.textContent).join(' / '));
    key('Escape'); key('Escape'); await frames(2);
    const home = [R.camera.pose().x, R.camera.pose().z, R.camera.pose().dist];
    await R.camera.view(3000, 3000, 30, 40, 200);
    key('Home'); await wait(600);
    check('Home goes back to the opening view', Math.hypot(R.camera.pose().x - home[0], R.camera.pose().z - home[1]) < 5, 'target ' + R.camera.pose().x.toFixed(0) + ', ' + R.camera.pose().z.toFixed(0) + ' (home ' + home[0].toFixed(0) + ', ' + home[1].toFixed(0) + ')');
    const y0 = R.camera.pose().yaw;
    key('KeyQ', { shiftKey: true }); keyUp('KeyQ', { shiftKey: true }); await wait(3000);
    const d = ((R.camera.pose().yaw - y0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    check('Shift+Q turns a quarter', Math.abs(Math.abs(d) - Math.PI / 2) < 0.05, 'turned ' + (d * 180 / Math.PI).toFixed(1) + '°');
  `,
  // B42: the health panel and the worst case are developer tools, out of the player's interface
  'B42-dev-tools-hidden': `
    const hb = byText('.v2-hud button', 'Saúde do jogo|Game health');
    check('no health button in the player top bar', !hb || hb.hidden, 'the health button shows');
    key('F9'); await frames(2);
    check('F9 does nothing for the player', !Q('.health') || Q('.health').classList.contains('hidden'), 'the health panel opened');
    click('[data-pop=menu]'); await frames(2);
    check('no worst case in the menu', !byText('.v2-pop .v2-row', 'pior caso|worst case'), 'the menu has the worst case test');
  `,
  // B30 and the 4.0 panel: for a developer, F9 opens health with World and State tabs, refreshed while open, clear of the inspector
  'B30-health-panel-dev': { query: '?empty&hour=11&workers=3&dev', script: `
    road(1400, 1500, 1700, 1500);
    click('[data-cat=info]'); await frames(2);
    R.tools.inspect(1450, 1500); await frames(4);
    key('F9'); await frames(2);
    const p = Q('.health');
    check('F9 opens the health panel', p && !p.classList.contains('hidden'), 'not open');
    const tabs = QA('.health [data-tab]').map((b) => b.dataset.tab).join(',');
    check('it has Health, World and State tabs', tabs === 'health,world,state', 'tabs ' + tabs);
    const pr = p.getBoundingClientRect(), ir = Q('.v2-side').getBoundingClientRect();
    check('it does not cover the inspector', ir.width === 0 || pr.right <= ir.left || pr.left >= ir.right, 'panel ' + pr.left.toFixed(0) + '-' + pr.right.toFixed(0) + ', inspector ' + ir.left.toFixed(0) + '-' + ir.right.toFixed(0));
    click(Q('.health [data-tab=state]')); await frames(2);
    check('State shows the tool', /inspect/.test(Q('.health-list').textContent), Q('.health-list').textContent.slice(0, 120));
    key('F9'); await frames(2);
    key('F8'); await frames(2);
    check('F8 opens it on the world changes', Q('.health [data-tab=world]').classList.contains('on') && /segments/.test(Q('.health-list').textContent), Q('.health-list').textContent.slice(0, 120));
    road(1400, 1600, 1700, 1600); await wait(1300);
    check('the world tab follows the edits while open', Q('.health-list').textContent.includes('segments · ' + w.roads.segs.size), Q('.health-list').textContent.slice(0, 80));
  ` },
  // B43: the title screen opens again from the menu, with the seed and the map size; generating there uses its seed;
  // "load the last game" with no save comes back to it; the menu's "generate" takes a new seed
  'B43-title-screen': `
    const idle = async () => { for (let k = 0; k < 600 && R.lifecycle.state() !== 'ready'; k++) await wait(200); await wait(300); };
    click('[data-pop=menu]'); await frames(2);
    const row = byText('.v2-pop .v2-row', 'Tela inicial|Title screen');
    check('the menu opens the title screen', !!row, 'no row in the menu');
    if (!row) throw new Error('no title screen row');
    click(row); await frames(2);
    const start = Q('.v2-start');
    check('the title screen shows, with seed and map size', start && !start.classList.contains('hidden') && start.querySelector('input') && start.querySelector('select'), 'title screen ' + (start ? start.className : 'missing'));
    click(byText('.v2-start button', 'Carregar|Load')); await wait(1500); await idle();
    check('loading with no save comes back to the title screen', !Q('.v2-start').classList.contains('hidden'), 'title screen closed on an empty map');
    const seed = start.querySelector('input');
    seed.value = '4321'; seed.dispatchEvent(new Event('input'));
    click(byText('.v2-start button', 'Gerar|Generate')); await wait(500); await idle();
    check('generating from the title screen uses its seed', w.seed === 4321 && w.roads.segs.size > 0, 'seed ' + w.seed + ', segments ' + w.roads.segs.size);
    await R.saves.save(true);
    click('[data-pop=menu]'); await frames(2);
    // the menu's new city over the whole map (Roadcraft 4.0 New world) asks first
    const confirm0 = window.confirm; window.confirm = () => true;
    click(byText('.v2-pop .v2-row', '^Nova cidade|^New city')); await wait(500); await idle();
    window.confirm = confirm0;
    check('the generate of the menu takes a new seed', w.seed !== 4321, 'seed ' + w.seed);
  `,
  // As the 4.0 (main.ts sky: 'day'): a game opens with the sky "always day", that button lit, the clock running
  'sky-starts-day': { query: '?empty&workers=3', script: `
    check('the game opens in always day', R.sky.mode() === 'day', 'sky ' + R.sky.mode());
    const lit = QA('[data-sky].on').map((b) => b.dataset.sky).join(',');
    check('the day button is the lit one', lit === 'day', 'lit: ' + lit);
    const h0 = R.sky.hour(); await wait(3000);
    check('the clock runs', R.sky.hour() !== h0, 'hour ' + h0 + ' → ' + R.sky.hour());
  ` },
  // The 4.0 top bar and its menus (ui/v2/shell.ts): Quality in the menu, Reset view in Camera, Esc gives the focus back
  // to the menu's button, the tooltip does not repeat a name already on screen, simulation 0-300 %
  'top-bar-4.0': `
    click('[data-pop=menu]'); await frames(2);
    const q = QA('.v2-pop .v2-orow').find((r) => /Gráficos|Graphics/.test(r.getAttribute('aria-label')));
    check('the menu has the quality row', !!q && q.querySelectorAll('button').length === 4, 'rows: ' + QA('.v2-pop .v2-orow').map((r) => r.getAttribute('aria-label')).join(', '));
    if (q) { click([...q.querySelectorAll('button')].find((b) => /Baixa|Low/.test(b.textContent))); await wait(2500); }
    check('a quality click applies the preset', R.options.get().preset === 'low' && R.options.get().shadows === false, 'preset ' + R.options.get().preset + ', shadows ' + R.options.get().shadows);
    if (!Q('.v2-pop:not([hidden])')) { click('[data-pop=menu]'); await frames(2); }
    const row = byText('.v2-pop .v2-row', 'Sobre|About');
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); await frames(1);
    check('no tooltip repeating a name already shown', Q('.v2-tip').hidden, 'tip: ' + Q('.v2-tip').textContent);
    key('Escape'); await frames(2);
    check('Esc closes the menu and gives the focus back to its button', Q('.v2-pop').hidden && document.activeElement === Q('[data-pop=menu]'), 'open ' + !Q('.v2-pop').hidden + ', focus ' + (document.activeElement && (document.activeElement.dataset.pop || document.activeElement.tagName)));
    const home = [R.camera.pose().x, R.camera.pose().z];
    await R.camera.view(2500, 2500, 20, 40, 300);
    click('[data-pop=camera]'); await frames(2);
    const reset = byText('.v2-pop .v2-icon', 'Enquadrar|Reset');
    check('Camera has the reset view button', !!reset, 'buttons: ' + QA('.v2-pop .v2-icon').map((b) => b.title || b.dataset.tip).join(', '));
    if (reset) { click(reset); await wait(800); }
    check('reset view goes back to the opening view', Math.hypot(R.camera.pose().x - home[0], R.camera.pose().z - home[1]) < 5, 'target ' + R.camera.pose().x.toFixed(0) + ', ' + R.camera.pose().z.toFixed(0));
    click('[data-pop=sim]'); await frames(2);
    const tr = QA('.v2-pop .v2-range').find((e) => /Tráfego|Traffic/.test(e.getAttribute('aria-label')));
    check('simulation sliders run 0-300 %', tr && tr.min === '0' && tr.max === '300', 'range ' + (tr && tr.min + '-' + tr.max));
  `,
  // The 4.0 drawers (ui/v2/shell.ts): help notes where there is nothing to pick, the strip keeps its scroll and fades at
  // the side with more, lots help, water rows only for the river, cloud variation, weather ranges, sign text only for
  // signs with words, street help notes, transit empty state, blocks and roundabout as in 4.0
  'drawers-4.0': `
    // what a tool does is the drawer's description (shell.ts:1115-1117); written in the strip only when it is empty
    const note = () => Q('.v2-drawer').getAttribute('aria-description') || '';
    const shown = () => (Q('.v2-strip .v2-note') || {}).textContent || '';
    click('[data-cat=roads]'); await frames(2);
    click(byText('.v2-tab', '^Mover|^Move')); await frames(2);
    check('Move says what to do', /Arraste um nó|Drag a node/.test(note()), 'note: ' + note());
    click(byText('.v2-tab', '^Controle|^Control')); await frames(2);
    check('Control says what to do', /cruzamento|junction/i.test(note()), 'note: ' + note());
    click(byText('.v2-tab', '^Desenhar|^Draw')); await frames(2);
    click(byText('.v2-choice', 'Quarteir|Blocks')); await frames(2);
    const ang = byText('.v2-toolopts .v2-stepper .v2-icon', 'Giro.*[+]$|Rotation.*[+]$');
    for (let k = 0; k < 7; k++) { click(ang); await frames(1); }
    check('blocks turn past 90° in 15° steps', R.tools.options().road.blocks.angle === 105, 'angle ' + R.tools.options().road.blocks.angle);
    click(byText('.v2-tab', 'Rotatória|Roundabout')); await frames(2);
    const ring = QA('.v2-toolopts .v2-range').find((e) => /Raio|Radius/.test(e.getAttribute('aria-label')));
    check('roundabout radius is a slider', !!ring, 'no slider');
    if (ring) { ring.value = '40'; ring.dispatchEvent(new Event('input', { bubbles: true })); await frames(1); }
    check('the slider sets the radius', R.tools.options().road.ringRadius === 40, 'radius ' + R.tools.options().road.ringRadius);
    click('[data-cat=zones]'); await frames(2); click(byText('.v2-tab', 'Lotes|Lots')); await frames(2);
    check('Lots has its help note', /Crie lotes|Create lots|lot/i.test(note()), 'note: ' + note());
    check('with cards in the strip the note is not written there', shown() === '', 'paragraph: ' + shown());
    check('the delete card has its short name', !!byText('.v2-card', '^Apagar lotes|^Delete lots'), 'cards: ' + QA('.v2-card').map((c) => c.textContent).join(', '));
    click('[data-cat=landscape]'); await frames(2);
    const water = () => QA('.v2-toolopts .v2-range').some((e) => /Ondas|Waves/.test(e.getAttribute('aria-label')));
    check('no water rows with the raise brush', !water(), 'water rows shown');
    click(byText('.v2-card', '^Rio|^River')); await frames(2);
    check('water rows with the river', water(), 'no water rows');
    click(byText('.v2-tab', 'Céu|Sky')); await frames(2);
    check('clouds have the variation slider', QA('.v2-toolopts .v2-range').some((e) => /Variação|Variation/.test(e.getAttribute('aria-label'))), 'no variation');
    click(byText('.v2-card', '^Clima|^Weather')); await frames(2);
    const r = (re) => QA('.v2-toolopts .v2-range').find((e) => re.test(e.getAttribute('aria-label')));
    check('weather ranges as 4.0 (wind 30, direction step 5, lightning 30)', r(/^Vento|^Wind/).max === '30' && r(/Direção|direction/i).step === '5' && r(/Raios|Lightning/).max === '30', 'wind ' + r(/^Vento|^Wind/).max + ', dir step ' + r(/Direção|direction/i).step + ', lightning ' + r(/Raios|Lightning/).max);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    click(byText('.v2-card', '^Placa|^Sign')); await frames(2);
    await choose(/Placa|Sign/, 4);
    check('a Stop sign has no text box', !Q('.v2-toolopts .v2-search'), 'text box shown');
    await choose(/Placa|Sign/, 0);
    check('a speed sign has its text box', !!Q('.v2-toolopts .v2-search'), 'no text box');
    check('street items have their help note', note().length > 20, 'note: ' + note());
    click(byText('.v2-card', '^Muro|^Wall')); await frames(2);
    check('walls have their help note', /muros|walls/i.test(note()), 'note: ' + note());
    check('and it is not a paragraph beside the cards', shown() === '', 'paragraph: ' + shown());
    click('[data-cat=demolish]'); await frames(2);
    check('an empty strip writes the note (demolish)', shown().length > 10 && shown() === note(), 'paragraph: ' + shown() + ' / ' + note());
    click('[data-cat=transit]'); await frames(2);
    check('no lines yet: the empty state says what to do', /Nenhuma linha|No lines/.test(Q('.v2-strip').textContent), 'strip: ' + Q('.v2-strip').textContent.slice(0, 120));
  `,
  // The strip of a narrow screen: it fades at the side with more and keeps its scroll across a pick (Roadcraft 4.0)
  'strip-scroll-narrow': { width: 1000, query: '?empty&hour=11&workers=3', script: `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    const strip = Q('.v2-strip');
    strip.scrollLeft = 120; strip.dispatchEvent(new Event('scroll')); await frames(2);
    const s0 = strip.scrollLeft;
    check('a long strip fades at the side with more', !!strip.dataset.more && s0 > 0, 'no fade; scroll ' + strip.scrollWidth + ' / ' + strip.clientWidth);
    click(QA('.v2-strip .v2-card')[16]); await frames(2);
    check('the strip keeps its scroll after a pick', s0 > 0 && Math.abs(Q('.v2-strip').scrollLeft - s0) <= 1, 'scroll ' + Q('.v2-strip').scrollLeft + ', was ' + s0);
  ` },
  // The 4.0 graphics dialog (ui/graphicsPanel.ts): a full screen row and the graphics card's name
  'options-4.0': `
    let asked = 0;
    const req = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function () { asked++; return Promise.resolve(); };
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const dlg = optionsRoot();
    const row = [...dlg.querySelectorAll('.opt-row')].find((r) => /Tela cheia|Full screen/.test(r.textContent));
    check('the options have a full screen row', !!row, 'rows: ' + [...dlg.querySelectorAll('.opt-row > span:first-child')].map((x) => x.textContent).join(', '));
    if (row) { click(row.querySelector('input')); await frames(2); }
    Element.prototype.requestFullscreen = req;
    check('it asks for full screen at once', asked === 1, 'asked ' + asked);
    const gpu = dlg.querySelector('.opt-gpu');
    check('the options name the graphics card', !!gpu && gpu.textContent.length > 15, 'gpu: ' + (gpu && gpu.textContent));
  `,
  // The 4.0 road keys (ui/roads/keys.ts): a third key, alignment (V), cycles straight, curve and free; Reset in Options
  'road-keys-4.0': `
    click('[data-cat=roads]'); await frames(2);
    const seq = [R.tools.current()];
    for (let k = 0; k < 3; k++) { key('KeyV'); keyUp('KeyV'); await frames(2); seq.push(R.tools.current()); }
    check('V cycles the alignment: straight, curve, free, straight', seq.join(',') === 'road,curve,free,road', 'tools ' + seq.join(','));
    const pill = Q('.v2-toolopts .rp-open');
    check('the keys pill shows the three keys, whole', pill && /V/.test(pill.textContent) && pill.scrollWidth <= pill.clientWidth + 1, 'pill: ' + (pill && pill.textContent + ' (' + pill.scrollWidth + ' / ' + pill.clientWidth + ')'));
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const dlg = optionsRoot();
    check('Options lists the alignment key', /Trocar o traçado|Change the alignment|alignment/i.test(dlg.textContent), 'no alignment key');
    check('Options has Reset for the road keys', [...dlg.querySelectorAll('button')].some((b) => /Restaurar padrão|Reset/.test(b.textContent)), 'no reset');
  `,
  // The 4.0 drawer on a narrow screen (shell.ts:1913-1930): pinned to both edges, tabs that do not fit keep only the
  // lit one's name, and a card name never cut inside a word
  'drawer-narrow-4.0': { width: 700, query: '?empty&hour=11&workers=3', script: `
    click('[data-cat=build]'); await frames(3);
    const d = Q('.v2-drawer').getBoundingClientRect();
    const k = Q('.v2-dock').getBoundingClientRect();
    check('the drawer is pinned to both edges, as the dock', Math.abs(d.left - k.left) <= 2 && Math.abs(d.right - k.right) <= 2, 'drawer ' + d.left.toFixed(0) + '-' + d.right.toFixed(0) + ', dock ' + k.left.toFixed(0) + '-' + k.right.toFixed(0));
    const tabs = Q('.v2-tabs');
    check('tabs that do not fit go compact', tabs.classList.contains('compact') || tabs.classList.contains('tight'), 'tabs ' + tabs.className + ' (' + tabs.scrollWidth + ' / ' + tabs.parentElement.clientWidth + ')');
    click('[data-cat=landscape]'); await frames(2); click(byText('.v2-tab', '^Rua|^Street')); await frames(3);
    const cut = QA('.v2-strip .v2-card-name').filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent);
    check('no card name cut inside a word', cut.length === 0, 'cut: ' + cut.join(', '));
  ` },
  // The 4.0 themed lists (shell.ts:971-1040) in place of the browser's white select: Down, Up, Home, End and Enter in the
  // list, Esc closes it (the tool stays) and gives the focus back
  'dropdown-4.0': `
    click('[data-cat=build]'); await frames(2);
    const natives = QA('.v2-toolopts select, .v2-drawer select').filter((x) => x.offsetParent !== null);
    check('no native select in the panels', natives.length === 0, natives.length + ' native selects: ' + natives.map((x) => x.getAttribute('aria-label') || x.title).join(', '));
    const dd = listOf(/Estilo|Style/);
    if (!dd || dd.tagName === 'SELECT') throw new Error('no themed list');
    click(dd); await frames(2);
    const list = Q('.v2-dd-list');
    check('the list opens in the theme, the choice focused', !!list && document.activeElement && document.activeElement.classList.contains('on'), 'list ' + !!list + ', focus ' + (document.activeElement && document.activeElement.className));
    for (const k of ['ArrowDown', 'ArrowDown']) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }));
    const at = document.activeElement.dataset.value;
    check('Down moves through the list', at === '1', 'focused ' + at);
    document.activeElement.click(); await frames(2);
    check('a pick sets the style', R.tools.options().lots.newArch === 1 && listValue(/Estilo|Style/) === '1', 'next ' + R.tools.options().lots.newArch + ', shows ' + listValue(/Estilo|Style/));
    click(listOf(/Estilo|Style/)); await frames(2);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); await frames(2);
    check('Esc closes the list and keeps the tool', !Q('.v2-dd-list') && R.tools.current() === 'building', 'list open ' + !!Q('.v2-dd-list') + ', tool ' + R.tools.current());
    check('the focus goes back to the list button', document.activeElement === listOf(/Estilo|Style/), 'focus ' + (document.activeElement && document.activeElement.className));
  `,
  // The 4.0 "New world" (v2/shell.ts:712, main.ts:2123-2128): second row of the menu, a new city over the whole map
  // with a seed of its own, always asked first
  'new-world-4.0': `
    click('[data-pop=menu]'); await frames(2);
    const rows = QA('.v2-pop .v2-row').map((r) => r.textContent.trim());
    check('the menu opens with New map, then the new city over the whole map', /^Novo mapa/.test(rows[0]) && /^Nova cidade \\(10 km × 10 km\\)/.test(rows[1]), 'rows: ' + rows.join(' / '));
    const asked = [], made = [];
    const confirm0 = window.confirm;
    window.confirm = (m) => { asked.push(m); return false; };
    const seed = w.seed;
    click(byText('.v2-pop .v2-row', '^Nova cidade|^New city')); await frames(2);
    check('it asks first, naming the map', asked.length === 1 && /10 km/.test(asked[0]), 'asked: ' + asked.join(' / '));
    check('saying no keeps the city', made.length === 0 && w.seed === seed, 'made ' + made.length);
    window.confirm = (m) => { asked.push(m); return true; };
    click('[data-pop=menu]'); await frames(2);
    click(byText('.v2-pop .v2-row', '^Nova cidade|^New city')); await frames(2);
    window.confirm = confirm0;
    for (let k = 0; k < 600 && R.lifecycle.state() !== 'ready'; k++) await wait(200);
    check('saying yes makes a city with a new seed', w.seed !== seed && R.lifecycle.state() === 'ready', 'seed ' + w.seed + ' (was ' + seed + '), lifecycle ' + R.lifecycle.state());
  `,
  // The 4.0 language switch (i18n/index.ts:95-111, v2/shell.ts:2032-2046): at once, no reload, the city as it is,
  // the bar, the dock, the open menu and drawer written in the new language
  'language-live-4.0': `
    window.__samePage = 1;
    road(-200, 300, 200, 300);
    const segs = w.roads.segs.size;
    click('[data-cat=roads]'); await frames(2);
    click('[data-pop=menu]'); await frames(2);
    click(byText('.v2-pop .v2-choice', '^English')); await frames(4);
    check('no reload: the same page, the city as it was', window.__samePage === 1 && w.roads.segs.size === segs && R.lifecycle.unsaved(), 'same ' + window.__samePage + ', segments ' + w.roads.segs.size + ' of ' + segs);
    check('the page says English', document.documentElement.lang === 'en', 'lang ' + document.documentElement.lang);
    check('the dock in English', Q('[data-cat=roads] .v2-cat-name').textContent === 'Roads' && /Roads/.test(Q('[data-cat=roads]').title), 'dock: ' + Q('[data-cat=roads] .v2-cat-name').textContent + ' / ' + Q('[data-cat=roads]').title);
    check('the bar in English', QA('.v2-actions .v2-icon').some((b) => /^Undo/.test(b.title)) && Q('[data-pop=menu]').textContent.trim() === 'Menu', 'undo ' + QA('.v2-actions .v2-icon').map((b) => b.title).join(', ') + ' / menu ' + Q('[data-pop=menu]').textContent);
    check('the open menu written again, English lit', !!byText('.v2-pop .v2-row', '^New map') && byText('.v2-pop .v2-choice', '^English').classList.contains('on'), 'rows: ' + QA('.v2-pop .v2-row').map((r) => r.textContent).join(' / '));
    check('the open drawer written again', QA('.v2-drawer .v2-tab').some((b) => /^Straight|^Curve|^Roundabout/.test(b.textContent)), 'tabs: ' + QA('.v2-drawer .v2-tab').map((b) => b.textContent).join(', '));
    check('the compass in English', /north|North/.test(Q('.v2-compass').title), 'compass ' + Q('.v2-compass').title);
    click(byText('.v2-pop .v2-choice', '^Português')); await frames(4);
    check('and back to Portuguese', Q('[data-cat=roads] .v2-cat-name').textContent === 'Vias' && document.documentElement.lang === 'pt-BR' && !!byText('.v2-pop .v2-row', '^Novo mapa'), 'dock ' + Q('[data-cat=roads] .v2-cat-name').textContent + ', lang ' + document.documentElement.lang);
  `,
  // The 4.0 tool hint (v2/shell.css:158, v2/shell.ts:844-846): never on screen; it describes the map for screen readers
  'hint-hidden-4.0': `
    click('[data-cat=roads]'); await frames(3);
    const h = Q('.v2-hintbar');
    check('the tool hint is not on screen', h && getComputedStyle(h).display === 'none', 'display ' + (h && getComputedStyle(h).display) + ': ' + (h && h.textContent));
    const by = document.getElementById('view').getAttribute('aria-describedby');
    check('it describes the map', !!by && document.getElementById(by) === h && h.textContent.length > 5, 'describedby ' + by);
  `,
  // The 4.0 road keys panel (roads/keysPanel.ts): the pill opens a small panel beside the options, a chip per key, the
  // next key pressed is bound (a game key refused), Esc lets go and then closes, Reset gives the three defaults back
  'road-keys-panel-4.0': `
    click('[data-cat=roads]'); await frames(2);
    click(Q('.v2-toolopts .rp-open')); await frames(2);
    const panel = Q('.rp-keys');
    check('the pill opens the keys panel, not the options', !!panel && !optionsOpen() && QA('.rp-keys .rp-key').length === 3, 'panel ' + !!panel + ', options open ' + optionsOpen());
    if (!panel) throw new Error('no panel');
    click(QA('.rp-keys .rp-key')[1]); await frames(1);
    check('a chip waits for the key', /Aperte|Press/.test(QA('.rp-keys .rp-key')[1].textContent), 'chip ' + QA('.rp-keys .rp-key')[1].textContent);
    key('KeyR', { key: 'r' }); await frames(2);
    check('a game key is refused (R turns the view)', A.settings().roadDown === 'PageDown' && /R/.test((Q('.rp-keys .rp-note') || {}).textContent || ''), 'roadDown ' + A.settings().roadDown + ', note ' + ((Q('.rp-keys .rp-note') || {}).textContent));
    key('KeyJ', { key: 'j' }); await frames(2);
    const st = A.settings();
    check('the key pressed is bound, the tool stays', st.roadDown === 'KeyJ' && R.tools.current() === 'road', 'roadDown ' + st.roadDown + ', tool ' + R.tools.current());
    check('the pill shows it', /J/.test(Q('.v2-toolopts .rp-open').textContent), 'pill ' + Q('.v2-toolopts .rp-open').textContent);
    click(byText('.rp-keys .rp-btn', 'Restaurar|Reset')); await frames(2);
    const back = A.settings();
    check('Reset gives the defaults back', back.roadUp === 'PageUp' && back.roadDown === 'PageDown' && back.roadAlign === 'KeyV', back.roadUp + ' ' + back.roadDown + ' ' + back.roadAlign);
    key('Escape'); await frames(2);
    check('Esc closes it and the tool stays', !Q('.rp-keys') && R.tools.current() === 'road', 'panel ' + !!Q('.rp-keys') + ', tool ' + R.tools.current());
  `,
  // The 4.0 selection panel (v2/shell.ts:891-903, shell.css:283-285): the inspector scrolls inside it and fades at
  // the end with more past it
  'inspector-fade-4.0': `
    road(-150, 400, 150, 400); road(0, 250, 0, 550);
    A.tool('inspect'); await frames(2);
    Q('.v2-side').style.maxHeight = '260px';
    R.tools.inspect(0, 400); await frames(4); await wait(300);
    const ins = Q('.v2-side .inspector');
    check('a long inspector scrolls inside the panel', ins && ins.scrollHeight > ins.clientHeight + 20, 'scroll ' + (ins && ins.scrollHeight + ' / ' + ins.clientHeight));
    check('it fades at the bottom, with more below', ins.dataset.moreY === 'bottom', 'moreY ' + ins.dataset.moreY);
    ins.scrollTop = ins.scrollHeight; ins.dispatchEvent(new Event('scroll')); await frames(2);
    check('scrolled to the end it fades at the top', ins.dataset.moreY === 'top', 'moreY ' + ins.dataset.moreY);
  `,
  // B27: the People tab opened before the people loaded: the click places what the panel shows
  'B27-people-before-load': `
    for (let k = 0; k < 120 && !A.peopleCatalog(); k++) await wait(500);
    const catalog = A.peopleCatalog;
    A.peopleCatalog = () => null;
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Pessoas|^People')); await frames(2);
    click(byText('.v2-orow .v2-choice', '^2 ')); await frames(2);
    A.peopleCatalog = catalog;
    await mapClick(150, 40);
    const o = R.people.last(), last = o && { o };
    check('the click places 2 people standing, as the panel shows', last && last.o.count === 2 && last.o.mode === 'stand', 'placed ' + (last ? last.o.count + ' ' + last.o.mode : 'nothing'));
  `,
};

// run only when called as a program (a test may import the scenarios to check them)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

// put back before every shared scenario: the fresh-game state (tools/checks/run.mjs) and this check's console errors
const SNAPSHOT = FRESH_SNAPSHOT;
const RESET = `${FRESH_RESET}
  errors.length = 0;
`;

async function main() {
  const { names, unknown } = pick(SCENARIOS);
  // one game for every scenario that only needs the empty map; a session of their own for those with their own URL,
  // window width or a reopening (tools/checks/run.mjs sharedScript)
  const alone = (n) => typeof SCENARIOS[n] !== 'string' || process.env.CHECK_ALONE === '1';
  const shared = names.filter((n) => !alone(n));
  let failed = unknown;
  if (shared.length) {
    const own = scenarioFolder('roadcraft-ui-', 'shared');
    const lines = await session({ query: '?empty&hour=11&workers=3', script: sharedScript(PRELUDE + SNAPSHOT, RESET, shared.map((n) => [n, SCENARIOS[n]])), own: own.dir, env: { ROADCRAFT_LIMIT: String(60 + shared.length * 60) } });
    const by = checksByScenario(lines, shared);
    for (const n of shared) failed += report(n, by.get(n));
    own.done();
  }
  failed += await eachScenario(names.filter(alone), async (name) => {
    const bodies = SCENARIOS[name];
    // a scenario is one session, or several sessions one after the other over the same folder (closing and reopening)
    const own = scenarioFolder('roadcraft-ui-', name);
    const checks = [];
    for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
      const query = typeof body === 'object' ? body.query : '?empty&hour=11&workers=3';
      const width = typeof body === 'object' && body.width ? String(body.width) : '1600';
      const code = typeof body === 'object' ? body.script : body;
      checks.push(...checksOf(await session({ query, script: wrap(PRELUDE, code), own: own.dir, env: { ROADCRAFT_W: width } })));
    }
    own.done();
    return checks;
  });
  console.log(failed ? `interface check: ${failed} FAILED` : 'interface check: ok');
  process.exit(failed ? 1 : 0);
}
