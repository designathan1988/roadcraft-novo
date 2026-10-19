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
