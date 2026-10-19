// The interface checked in the real game (the machine's GPU): each scenario clicks the real buttons and presses the
// real keys (the same events the player makes), then checks what the game did. One Electron session per scenario,
// with a user data folder of its own (never the game's). Results are printed as "CHECK OK|FAILED name".
// Usage: npx vite build && node tools/check-interface.mjs [scenario...]   (exits with code 1 if anything fails)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Page helpers shared by every scenario.
const PRELUDE = `
const g = window.__cidade.game, a = g.api, w = g.world, A = g.hudActions, hud = g.hud;
const errors = [];
const logError = console.error.bind(console);
console.error = (...x) => { errors.push(x.map(String).join(' ').slice(0, 300)); logError(...x); };
window.addEventListener('error', (e) => errors.push('error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { const f = () => (n-- <= 0 ? r() : requestAnimationFrame(f)); f(); });
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
const Q = (s) => document.querySelector(s), QA = (s) => [...document.querySelectorAll(s)];
const label = (e) => [e.textContent, e.title, e.dataset.tip, e.getAttribute('aria-label')].filter(Boolean).join(' | ');
const byText = (sel, re) => QA(sel).find((e) => new RegExp(re).test(label(e)));
const click = (s) => { const e = typeof s === 'string' ? Q(s) : s; if (!e) throw new Error('nothing to click: ' + s); e.click(); };
// keys go to the focused element (the page when nothing is), as the browser sends them
const key = (code, o = {}) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { code, key: o.key ?? code, bubbles: true, cancelable: true, ...o }));
const keyUp = (code, o = {}) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keyup', { code, key: o.key ?? code, bubbles: true, ...o }));
/** A left click on the map at (x, z): the camera looks straight at the point and the canvas centre is clicked. */
const mapClick = async (x, z, o = {}) => {
  await g.view(x, z, 0, 70, o.dist ?? 140);
  await frames(3);
  const c = g.canvas, r = c.getBoundingClientRect();
  const p = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', bubbles: true, isPrimary: true, shiftKey: !!o.shift };
  c.dispatchEvent(new PointerEvent('pointermove', { ...p, buttons: 0 }));
  await frames(2);
  c.dispatchEvent(new PointerEvent('pointerdown', p));
  c.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
  await frames(2);
};
const road = (ax, az, bx, bz, profile = 0) => { const r = a.road(ax, az, bx, bz, profile); if (r !== 'ok') throw new Error('road refused: ' + r); };
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
    const real = g.roadTool.elevation;
    check('one + raises the road 4 m', real === 4, 'elevation ' + real);
    check('the stepper shows the height the road is drawn at', shown.includes('4') && !shown.includes('8'), 'shows "' + shown + '" for ' + real + ' m');
  `,
  // B32: the camera panel's "turn left (Q)" and "turn right (E)" turn the way Q and E do
  'B32-turn-buttons': `
    await g.view(0, 0, 0, 40, 300);
    const yaw0 = g.rig.yaw;
    key('KeyQ'); await wait(400); keyUp('KeyQ'); await wait(300);
    const q = g.rig.yaw - yaw0;
    click('[data-pop=camera]');
    await frames(2);
    const y1 = g.rig.yaw;
    click(byText('.v2-pop .v2-icon', '\\\\(Q\\\\)'));
    await wait(1500);
    const left = g.rig.yaw - y1;
    check('Q turns the camera', Math.abs(q) > 0.1, 'Q turned ' + q.toFixed(3));
    check('the "(Q)" button turns the same way as Q', Math.sign(left) === Math.sign(q) && Math.abs(left) > 0.1, 'Q ' + q.toFixed(3) + ', button ' + left.toFixed(3));
  `,
  // B31: [ and ] with the zone tool change the zone brush (the radius the panel shows), not the hidden terrain brush
  'B31-zone-radius-keys': `
    click('[data-cat=zones]');
    await frames(2);
    const before = g.zoneTool.radius, brush = g.brush.radius;
    key('BracketRight');
    await frames(2);
    check('] widens the zone brush', g.zoneTool.radius > before, 'zone radius ' + before + ' → ' + g.zoneTool.radius + ', terrain brush ' + brush + ' → ' + g.brush.radius);
    const slider = QA('.v2-range').find((r) => /Raio|Radius/.test(r.getAttribute('aria-label')));
    check('the radius slider follows', slider && Number(slider.value) === Math.round(g.zoneTool.radius), 'slider ' + (slider && slider.value) + ', zone radius ' + g.zoneTool.radius);
  `,
  // B4: with a bus line chosen, the Train station tab puts a station on a train line (not a bus stop on the bus line)
  'B4-station-tabs': `
    road(0, 100, 400, 100);
    a.line(0, [200, 108], 1);
    road(0, -100, 400, -100, 'Ferrovia dupla');
    const bus = g.transit.lines[0];
    click('[data-cat=transit]');
    await frames(2);
    click(byText('.v2-tab', 'Estação de trem|Train station'));
    await frames(2);
    await mapClick(200, -100);
    const train = g.transit.lines.find((l) => (l.mode ?? 0) === 1);
    check('the click makes a train station', !!train && train.stops.length === 2, 'lines: ' + g.transit.lines.map((l) => 'mode ' + (l.mode ?? 0) + ' with ' + l.stops.length / 2 + ' stops').join('; '));
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
    g.select(id); await frames(2);
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
    check('None is chosen', g.settings.furniture === 2, 'furniture ' + g.settings.furniture);
  `, `
    click('[data-cat=roads]'); await frames(2);
    const on = Q('[data-furniture].on');
    check('the panel shows None after reopening', on && /Nenhum|None/.test(on.textContent), 'lit: ' + (on && on.textContent) + ', settings ' + g.settings.furniture);
  `],
  // B20: applying the options keeps what other panels changed since (simulation traffic)
  'B20-options-keep-others': `
    const options = async () => { click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2); };
    await options();
    click(byText('.v2-dialog button', '^Aplicar$|^Apply$')); await wait(1500);
    click('[data-pop=sim]'); await frames(2);
    const r = QA('.v2-pop .v2-range').find((e) => /Tráfego|Traffic/.test(e.getAttribute('aria-label')));
    r.value = '50'; r.dispatchEvent(new Event('input', { bubbles: true })); await frames(2);
    check('the simulation panel sets traffic 50%', g.settings.traffic === 0.5, 'traffic ' + g.settings.traffic);
    click('[data-pop=sim]');
    await options();
    click(byText('.v2-dialog button', '^Aplicar$|^Apply$')); await wait(1500);
    check('applying the options keeps traffic 50%', g.settings.traffic === 0.5, 'traffic ' + g.settings.traffic);
  `,
  // B21: applying the options keeps the weather set by hand
  'B21-options-keep-weather': `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', 'Céu|Sky')); await frames(2);
    click(byText('.v2-card', '^Clima|^Weather')); await frames(2);
    click(byText('.v2-choice', 'Ajustado aqui|Set here')); await frames(2);
    const rain = QA('.v2-range').find((e) => /Chuva|Rain/.test(e.getAttribute('aria-label')));
    rain.value = '100'; rain.dispatchEvent(new Event('input', { bubbles: true })); await frames(2);
    check('the panel sets rain 100%', g.weather.fixed && g.weather.fixed.rain === 1, 'fixed ' + JSON.stringify(g.weather.fixed));
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    click(byText('.v2-dialog button', '^Aplicar$|^Apply$')); await wait(1500);
    check('applying the options keeps rain 100%', g.weather.fixed && g.weather.fixed.rain === 1, 'fixed ' + JSON.stringify(g.weather.fixed));
  `,
  // B39: the chosen line's colour and ring have buttons in the transit panel
  'B39-line-colour-loop': `
    road(0, 100, 400, 100);
    a.line(0, [100, 108, 300, 108], 1);
    const l = g.transit.lines[0], c0 = l.color;
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
    await g.view(3000, 3000, 0, 40, 300);
    if (warn) click(warn);
    await wait(1500);
    const d = Math.hypot(g.rig.target.x, g.rig.target.z);
    check('its click points the camera at the node', d < 30, 'camera target ' + g.rig.target.x.toFixed(0) + ', ' + g.rig.target.z.toFixed(0));
    check('and inspects it', g.tool === 'inspect' && g.inspector.isOpen, 'tool ' + g.tool + ', inspector open ' + g.inspector.isOpen);
    g.commands.undo();
    await wait(1200);
    check('the warning goes when the junction is fixed', !Q('.v2-warn') || Q('.v2-warn').hidden, 'count now ' + A.impossibleNodes());
  `,
  // B51: always day (or night) fixes the light, while the clock and the traffic demand go on
  'B51-always-day-clock': `
    g.hour = 8; g.clockSpeed = 30; // ?hora stops the clock: half an hour per second here
    click('[data-sky=dia]'); await frames(2);
    const h0 = g.hour;
    await wait(4000);
    check('the clock goes on with always day', g.hour > h0 + 0.03, 'hour ' + h0.toFixed(3) + ' → ' + g.hour.toFixed(3));
    const sent = [];
    const post = g.sim.postMessage.bind(g.sim);
    g.sim.postMessage = (m, t) => { if (m && m.type === 'demand') sent.push(m.hour); return post(m, t); };
    await wait(2600);
    g.sim.postMessage = post;
    check('the demand follows the clock, not noon', sent.length > 0 && sent[sent.length - 1] !== 12 && Math.abs(sent[sent.length - 1] - g.hour) < 1.2, 'demand hour ' + sent + ', clock ' + g.hour.toFixed(2));
  `,
  // B52: the repair notice opening an old map stays readable next to "City loaded"
  'B52-toasts-stack': `
    const net = w.roads;
    const n = (x, z) => net.addNode({ x, z, y: 10 });
    const P = n(1400, 1500), B = n(1700, 1500), C = n(1550, 1500.5), D = n(1550, 1600);
    net.addSeg({ a: P, b: B, cx: 1550, cz: 1500, profile: 0, flags: 0, zl: 0, zr: 0 });
    net.addSeg({ a: C, b: D, cx: 1550, cz: 1550, profile: 0, flags: 0, zl: 0, zr: 0 });
    for (let t = 0; t < w.saveDirty.length; t++) w.saveDirty[t] = 1;
    await g.save(false);
    await g.load();
    await wait(300);
    const shown = QA('.v2-toast').filter((e) => !e.hidden).map((e) => e.textContent).join(' / ');
    check('the repair notice is still shown', /reparado|repaired/i.test(shown), 'toasts: ' + shown);
    check('and so is "City loaded"', /carregada|loaded/i.test(shown), 'toasts: ' + shown);
  `,
  // B41: the builder's tabs (Models, Facade, Roof, Parts, Colours) light up when the buildings session mounts them
  'B41-builder-tabs': `
    const can = typeof hud.registerBuilderTab === 'function';
    check('the interface offers a mount point for builder tabs', can, 'hud.registerBuilderTab is ' + typeof hud.registerBuilderTab);
    if (can) hud.registerBuilderTab('facade', (box, b) => { const p = document.createElement('p'); p.className = 'probe-facade'; p.textContent = 'facade of ' + (b ? b.floors : 'none'); box.append(p); });
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
  'B57-english': { query: '?vazio&hora=11&workers=3&lang=en', script: `
    click('[data-cat=zones]'); await frames(2);
    const hint = Q('.v2-hintbar').textContent;
    check('the zone hint is in English', /Drag/.test(hint) && !/[ãõçéêáíóúâô]|Arraste/.test(hint), 'hint: ' + hint);
    click('[data-cat=build]'); await frames(2);
    g.select(a.lot(100, 100, 130, 100, 115, 130, 1, 3)); await frames(2);
    click(byText('.v2-toolopts button', '^Renovate')); await frames(2);
    const toasts = QA('.v2-toast').map((e) => e.textContent).join(' / ');
    check('the toast is in English', toasts.length > 0 && !/[ãõçéêáíóúâô]|Nenhuma/.test(toasts), 'toasts: ' + toasts);
  ` },
  // B17: the height and radius selectors follow PageUp/PageDown and [ ]
  'B17-selectors-follow-keys': `
    click('[data-cat=roads]'); await frames(2);
    key('PageUp'); keyUp('PageUp'); await frames(2);
    const h = Q('.v2-toolopts .v2-stepper-value').textContent;
    check('PageUp shows in the height selector', /4/.test(h), 'elevation ' + g.roadTool.elevation + ', shows ' + h);
    click(byText('.v2-tab', 'Rotatória|Roundabout')); await frames(2);
    key('BracketRight'); await frames(2);
    const r = Q('.v2-toolopts .v2-stepper-value').textContent;
    check('] shows in the roundabout radius', r !== '22 m', 'shows ' + r);
  `,
  // B22: the next drawn lot shows the style and function that will be used
  'B22-next-lot-choice': `
    click('[data-cat=build]'); await frames(2);
    const sel = QA('.v2-toolopts select');
    sel[0].value = '2'; sel[0].dispatchEvent(new Event('change')); await frames(1);
    sel[1].value = '3'; sel[1].dispatchEvent(new Event('change')); await frames(1);
    click('[data-cat=roads]'); await frames(2); click('[data-cat=build]'); await frames(2);
    const again = QA('.v2-toolopts select');
    check('the style shown is the one chosen', again[0].value === '2' && g.newArch === 2, 'shows ' + again[0].value + ', next ' + g.newArch);
    check('the function shown is the one chosen', again[1].value === '3' && g.newFn === 3, 'shows ' + again[1].value + ', next ' + g.newFn);
  `,
  // B23: the water panel shows the values of the map that was opened
  'B23-panels-show-map': `
    A.water({ waves: 0.9, foam: 0.1, current: 2 });
    await g.save(false); A.water({ waves: 0.3, foam: 0.4, current: 0.5 }); await g.load();
    click('[data-cat=landscape]'); await frames(2);
    const waves = QA('.v2-range').find((e) => /Ondas|Waves/.test(e.getAttribute('aria-label')));
    check('the waves slider shows the map', waves && waves.value === '90', 'slider ' + (waves && waves.value) + ', map ' + g.waterCtl.waves);
  `,
  // B24: the decay figure follows the city clock while the panel is open
  'B24-decay-follows-clock': `
    click('[data-cat=build]'); await frames(2);
    const id = a.lot(100, 100, 130, 100, 115, 130, 1, 3); g.select(id); await frames(2);
    const row = () => { const r = QA('.v2-toolopts .v2-orow').find((e) => /Desgaste|Decay/.test(e.getAttribute('aria-label'))); return r ? r.querySelector('.v2-stepper-value').textContent : 'none'; };
    const before = row();
    a.passTime(60 * 24 * 365 * 30); await wait(1200);
    check('the decay row changes with the clock', row() !== before, 'shows ' + before + ' → ' + row() + ', building ' + w.buildings.cols.decay[id] / 10);
  `,
  // B25: the floors selector stops at 60, and "−" on an empty lot builds nothing
  'B25-floors-limits': `
    click('[data-cat=build]'); await frames(2);
    const id = a.lot(100, 100, 130, 100, 115, 130, 1, 60); g.select(id); await frames(2);
    click(byText('.v2-stepper .v2-icon', '\\\\+$')); await frames(2);
    check('+ at 60 floors stays at 60', Q('.v2-toolopts .v2-stepper-value').textContent === '60', 'shows ' + Q('.v2-toolopts .v2-stepper-value').textContent);
    w.editBuilding(id, 0, w.buildings.cols.style[id], 0); g.select(id); await frames(2);
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
    const l = g.transit.lines[0], real = g.simStats;
    // the simulation reports 480 passengers an hour on the line
    Object.defineProperty(g, 'simStats', { configurable: true, get: () => ({ ...(real || {}), type: 'stats', lines: [{ id: l.id, perHour: 480, waiting: 3 }] }), set: () => undefined });
    await frames(4);
    check('the row stays', row && row.isConnected, 'the panel was rebuilt');
    check('and shows the new figure', Q('.v2-transit-line') && /480/.test(Q('.v2-transit-line').textContent), 'row: ' + (Q('.v2-transit-line') && Q('.v2-transit-line').textContent));
  `,
  // B33: Esc ends the wall being traced and keeps the tool; Esc drops the first click of a lot line
  'B33-esc-steps-back': `
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    click(byText('.v2-card', '^Muro|^Wall')); await frames(2);
    await mapClick(100, 60);
    key('Escape'); await frames(2);
    check('Esc ends the wall and keeps the wall tool', g.tool === 'barrier', 'tool ' + g.tool);
    key('Escape'); await frames(2);
    check('a second Esc puts the tool down', g.tool === 'camera', 'tool ' + g.tool);
    A.lotLine(); await frames(2);
    await mapClick(100, 100);
    key('Escape'); await frames(2);
    check('Esc drops the first click of the lot line', g.lotExtraPts.length === 0 && g.tool === 'building', 'points ' + g.lotExtraPts.length + ', tool ' + g.tool);
  `,
  // B36: closing the options while a road key is being captured leaves the next key to the game
  'B36-options-capture': `
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const before = g.settings.roadUp ?? 'PageUp';
    click(QA('.v2-dialog .v2-btn').find((b) => /Page|Up/.test(b.textContent))); await frames(1);
    click([...g.optionsPanel.root.querySelectorAll('button')].find((b) => /^(Fechar|Close)$/.test(b.textContent))); await frames(2);
    const mode = g.rig.mode;
    key('KeyV'); await frames(2);
    check('the next key goes to the game (V changes the view)', g.rig.mode !== mode, 'view stayed ' + mode + ', focus ' + (document.activeElement && document.activeElement.tagName) + ', options open ' + g.optionsPanel.isOpen);
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const shown = QA('.v2-dialog .v2-btn').find((b) => /Page|Up|Numpad/.test(b.textContent));
    check('the dialog shows the road key unchanged', shown && /Page Up/.test(shown.textContent), 'shows ' + (shown && shown.textContent));
  `,
  // B37: the game's keys do nothing while the options, About or the start screen are open
  'B37-keys-blocked-by-dialogs': `
    click('[data-pop=menu]'); await frames(2); click(byText('.v2-row', 'Opções gráficas|Graphics options')); await frames(2);
    const mode = g.rig.mode;
    key('KeyV'); key('KeyT'); await frames(2);
    check('V does not change the view under the options', g.rig.mode === mode, 'view ' + mode + ' → ' + g.rig.mode);
    check('T does not open a drawer under the options', g.tool === 'camera', 'tool ' + g.tool);
    key('Escape'); await frames(2);
    check('Esc closes the options', !g.optionsPanel.isOpen, 'still open');
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
    g.growth.rate = 0; // nothing grows by itself during the check
    for (let k = 0; k < 40 && g.growth.lots.size === 0; k++) { g.growth.processDirty(); await g.pool.whenIdle(); await wait(250); }
    let free = null;
    for (const l of g.growth.lots.values()) for (let i = 0; i < l.count && !free; i++) if (g.growth.lotAt(l.x[i], l.z[i])) free = [l.x[i], l.z[i]];
    check('there is an empty lot', !!free, 'no free lot; lots in ' + g.growth.lots.size + ' cells, growth cells ' + g.growth.cells.length + ', seg zones ' + w.roads.segs.cols.zl[0] + '/' + w.roads.segs.cols.zr[0] + ', buildings ' + w.buildings.size);
    if (free) {
      click('[data-cat=build]'); await frames(2);
      A.style(4); A.buildingFn(2);
      await mapClick(free[0], free[1]);
      const id = g.selected, c = w.buildings.cols;
      check('the building uses the chosen style and function', id >= 0 && c.style[id] === 128 + 4 && c.fn[id] === 2, 'id ' + id + ', style ' + c.style[id] + ', fn ' + c.fn[id]);
    }
  `,
  // B45: what the hints promise for a double click happens (inside view of a building; the end of a wall)
  'B45-double-clicks': `
    click('[data-cat=build]'); await frames(2);
    const id = a.lot(1500, 1500, 1530, 1500, 1515, 1530, 1, 4);
    await mapClick(w.buildings.cols.x[id], w.buildings.cols.z[id]);
    g.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: innerWidth / 2, clientY: innerHeight / 2 })); await frames(4);
    check('a double click on a building shows it inside', g.inside.on && g.insideId === id, 'inside ' + g.inside.on + ', building ' + g.insideId + ' (clicked ' + id + ')');
    click('[data-cat=landscape]'); await frames(2);
    click(byText('.v2-tab', '^Rua|^Street')); await frames(2);
    click(byText('.v2-card', '^Muro|^Wall')); await frames(2);
    await mapClick(1700, 1600); await mapClick(1760, 1600);
    g.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: innerWidth / 2, clientY: innerHeight / 2 })); await frames(2);
    check('a double click ends the wall', !g.wallOpen && g.tool === 'barrier', 'wall still open ' + g.wallOpen + ', tool ' + g.tool);
  `,
  // B48: split by line and curve side show the line from the first click to the cursor
  'B48-lot-line-preview': `
    click('[data-cat=build]'); await frames(2);
    a.lot(1500, 1500, 1540, 1500, 1520, 1540, 1, 2);
    A.lotLine(); await frames(2);
    await mapClick(1490, 1520);
    await g.view(1550, 1520, 0, 70, 140); await frames(2);
    const c = g.canvas, r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, bubbles: true })); await frames(3);
    check('the line from the first click shows', g.preview.mesh.visible, 'no preview');
  `,
  // B53: a photo parameter in the address (?semsombra) is not written into the player's options
  'B53-url-not-saved': { query: '?vazio&hora=11&workers=3&semsombra', script: `
    check('the photo parameter applies', g.settings.shadows === false, 'shadows ' + g.settings.shadows);
    click('[data-cat=roads]'); await frames(2);
    click(byText('[data-furniture]', 'Básico|Basic')); await frames(2);
    const kept = JSON.parse(localStorage.getItem('cidade.opcoes') || '{}');
    check('the furniture choice is kept', kept.furniture === 1, 'stored ' + JSON.stringify(kept));
    check('the shadows of the address are not kept', kept.shadows !== false, 'stored shadows ' + kept.shadows);
  ` },
  // B54: two fingers apart on a touch screen zoom in
  'B54-pinch-zoom': `
    await g.view(1500, 1500, 0, 50, 400); await frames(4);
    const c = g.canvas, r = c.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (type, id, x) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    const d0 = g.rig.dist;
    ev('pointerdown', 1, cx - 50); ev('pointerdown', 2, cx + 50);
    for (let k = 1; k <= 10; k++) { ev('pointermove', 1, cx - 50 - k * 15); ev('pointermove', 2, cx + 50 + k * 15); await frames(1); }
    ev('pointerup', 1, cx - 200); ev('pointerup', 2, cx + 200);
    await wait(800);
    check('spreading two fingers zooms in', g.rig.dist < d0 * 0.7, 'distance ' + d0.toFixed(0) + ' → ' + g.rig.dist.toFixed(0));
    const t = g.rig.target;
    check('and does not drag the map away', Math.hypot(t.x - 1500, t.z - 1500) < 60, 'target ' + t.x.toFixed(0) + ', ' + t.z.toFixed(0));
  `,
  // B55: the sound stops while the game is hidden (minimised); no birds in a city block with no trees
  'B55-sound-hidden-birds': `
    g.ambient.start(); await wait(300);
    const ctx = g.ambient.ctx;
    check('the sound runs', ctx && ctx.state === 'running', 'state ' + (ctx && ctx.state));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange')); await wait(400);
    check('hidden, the sound stops', ctx && ctx.state === 'suspended', 'state ' + (ctx && ctx.state));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange')); await wait(400);
    check('shown again, it plays', ctx && ctx.state === 'running', 'state ' + (ctx && ctx.state));
    await g.view(1500, 1500, 0, 50, 120); await wait(1500);
    check('birds in the open country', g.green > 0.5, 'green ' + g.green);
    // a block of streets and buildings, no trees
    for (let k = 0; k < 5; k++) { road(1400, 1400 + k * 50, 1600, 1400 + k * 50); road(1400 + k * 50, 1400, 1400 + k * 50, 1600); }
    for (let k = 0; k < 4; k++) for (let m = 0; m < 4; m++) a.lot(1405 + k * 50, 1420 + m * 50, 1445 + k * 50, 1420 + m * 50, 1425 + k * 50, 1445 + m * 50, 2, 6);
    await g.view(1500, 1500, 0, 50, 120); await wait(1500);
    check('no birds over a treeless block', typeof g.green === 'number' && g.green < 0.2, 'green ' + g.green);
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
    { const sc = w.roads.segs.cols, nc = w.roads.nodes.cols; const k = w.roads.segs.alive.indexOf(1); g.inspector.pick((nc.x[sc.a[k]] + nc.x[sc.b[k]]) / 2, (nc.z[sc.a[k]] + nc.z[sc.b[k]]) / 2); } await frames(4);
    const segs = w.roads.segs.size;
    key('KeyD', { ctrlKey: true }); await frames(4);
    check('Ctrl+D duplicates the inspected road', w.roads.segs.size > segs, 'segments ' + segs + ' → ' + w.roads.segs.size + ', inspector ' + g.inspector.isOpen + ' seg ' + g.inspector.seg + ', toasts ' + QA('.v2-toast').map((e) => e.textContent).join(' / '));
    key('Escape'); key('Escape'); await frames(2);
    const home = [g.rig.target.x, g.rig.target.z, g.rig.dist];
    await g.view(3000, 3000, 30, 40, 200);
    key('Home'); await wait(600);
    check('Home goes back to the opening view', Math.hypot(g.rig.target.x - home[0], g.rig.target.z - home[1]) < 5, 'target ' + g.rig.target.x.toFixed(0) + ', ' + g.rig.target.z.toFixed(0) + ' (home ' + home[0].toFixed(0) + ', ' + home[1].toFixed(0) + ')');
    const y0 = g.rig.yaw;
    key('KeyQ', { shiftKey: true }); keyUp('KeyQ', { shiftKey: true }); await wait(3000);
    const d = ((g.rig.yaw - y0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
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
  'B30-health-panel-dev': { query: '?vazio&hora=11&workers=3&dev', script: `
    road(1400, 1500, 1700, 1500);
    click('[data-cat=info]'); await frames(2);
    g.inspector.pick(1450, 1500); await frames(4);
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
    const idle = async () => { for (let k = 0; k < 600 && (g.busy || window.__cidade.status !== 'pronto'); k++) await wait(200); await wait(300); };
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
    w.money = w.money; g.unsaved = false; for (let t = 0; t < w.saveDirty.length; t++) w.saveDirty[t] = 0;
    click('[data-pop=menu]'); await frames(2);
    click(byText('.v2-pop .v2-row', 'Gerar cidade|Generate')); await wait(500); await idle();
    check('the generate of the menu takes a new seed', w.seed !== 4321, 'seed ' + w.seed);
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
    const groups = g.vehicles.people.creator.groups, last = groups[groups.length - 1];
    check('the click places 2 people standing, as the panel shows', last && last.o.count === 2 && last.o.mode === 'stand', 'placed ' + (last ? last.o.count + ' ' + last.o.mode : 'nothing'));
  `,
};

// run only when called as a program (a test may import the scenarios to check them)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const pick = process.argv.slice(2);
  const names = pick.length ? pick : Object.keys(SCENARIOS);
  let failed = 0;
  for (const name of names) {
    const bodies = SCENARIOS[name];
    if (!bodies) { console.log(`unknown scenario ${name}`); failed++; continue; }
    // a scenario is one session, or several sessions one after the other over the same folder (closing and reopening)
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-ui-'));
    const checks = [];
    for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
      const query = typeof body === 'object' ? body.query : '?vazio&hora=11&workers=3';
      const code = typeof body === 'object' ? body.script : body;
      const script = `(async()=>{${PRELUDE}\ntry {${code}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
      const lines = await new Promise((resolve) => {
        const out = [];
        const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(own, 'shot.png'), query, script],
          { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: '300' } });
        p.stdout.on('data', (d) => out.push(...String(d).split('\n')));
        p.on('exit', () => resolve(out));
      });
      const got = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
      if (!got.includes('END')) got.push('FAILED the session did not finish (hung or crashed) after: ' + (got[got.length - 1] ?? 'nothing'));
      checks.push(...got.filter((c) => c !== 'END'));
    }
    const bad = checks.filter((c) => c.startsWith('FAILED'));
    failed += bad.length;
    console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
    for (const c of checks) console.log('  ' + c);
    fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log(failed ? `interface check: ${failed} FAILED` : 'interface check: ok');
  process.exit(failed ? 1 : 0);
}
