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
const key = (code, o = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: o.key ?? code, bubbles: true, cancelable: true, ...o }));
const keyUp = (code, o = {}) => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: o.key ?? code, bubbles: true, ...o }));
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
