/// <reference types="node" />
// The interface's pure parts with the real modules (keys.ts): the game's one keyboard listener, fed key events the
// way the browser sends them. Defect ids refer to DEFEITOS-roadcraft-novo.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installKeys, type GameKeyDeps } from '../src/ui/keys.ts';

type Listener = (e: unknown) => void;
/** A window with listeners, enough for installKeys (no DOM in Node). */
function fakeWindow(): { send(type: string, e: Partial<KeyboardEvent>): { prevented: boolean } } {
  const on = new Map<string, Listener[]>();
  const g = globalThis as Record<string, unknown>;
  g.window = { addEventListener: (type: string, fn: Listener) => on.set(type, [...(on.get(type) ?? []), fn]) };
  for (const n of ['HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement']) g[n] ??= class {};
  return {
    send(type, e) {
      const ev = { prevented: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, target: null, key: e.code, ...e, preventDefault() { ev.prevented = true; } };
      for (const fn of on.get(type) ?? []) fn(ev);
      return ev;
    },
  };
}

/** Every action a key can reach, counted. */
function deps(over: Partial<GameKeyDeps> = {}): { d: GameKeyDeps; calls: string[] } {
  const calls: string[] = [];
  const log = (name: string) => () => { calls.push(name); };
  const d: GameKeyDeps = {
    tool: () => 'camera', setTool: (t) => calls.push(`tool ${t}`), openCategory: (c) => calls.push(`category ${c}`),
    dialog: () => false, closeDialog: () => undefined, closeMenu: () => false, closePanel: () => false, cancelStroke: () => false, toolKey: () => false,
    undo: log('undo'), redo: log('redo'), save: log('save'), help: log('help'), health: log('health'), pause: log('pause'),
    openMap: log('open'), duplicate: log('duplicate'), home: log('home'), quarterTurn: (d) => calls.push(`quarter ${d}`), changes: log('changes'), developer: () => true,
    nextSpeed: log('speed'), toggleIso: log('iso'), congestion: log('congestion'), follow: log('follow'), wake: () => undefined,
    camera: { keyDown: (c) => calls.push(`camera ${c}`), keyUp: () => undefined, clearKeys: () => undefined },
    ...over,
  };
  return { d, calls };
}

test('B3: Ctrl + a letter, a digit or Space never reaches the plain game shortcuts', () => {
  const w = fakeWindow();
  const { d, calls } = deps();
  installKeys(d);
  for (const code of ['KeyC', 'KeyV', 'KeyK', 'KeyP', 'Space', 'Digit1', 'KeyZ', 'KeyH', 'KeyT', 'KeyW', 'KeyQ']) {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      calls.length = 0;
      w.send('keydown', { code, ...mod });
      const wrong = calls.filter((c) => c !== 'undo');
      assert.deepEqual(wrong, [], `${Object.keys(mod)[0]}+${code} did ${wrong.join(', ')}`);
    }
  }
  calls.length = 0;
  w.send('keydown', { code: 'KeyZ', ctrlKey: true });
  assert.deepEqual(calls, ['undo'], 'Ctrl+Z still undoes');
});

test('B46: the money tip says the refund the game gives on demolishing (roads/tuning.ts), in both languages', async () => {
  const { ROAD_TUNING } = await import('../src/roads/tuning.ts');
  const { ENGINE_PT } = await import('../src/shared/i18n/lang/engine.pt-BR.ts');
  const { ENGINE_EN } = await import('../src/shared/i18n/lang/engine.en.ts');
  const pct = String(Math.round(ROAD_TUNING.economy.demolitionRefund * 100));
  for (const [name, tip] of [['pt-BR', ENGINE_PT['ui.money.tip']], ['en', ENGINE_EN['ui.money.tip']]]) {
    assert.ok(tip.includes('{refund}'), `${name}: "${tip}" does not take the refund from the tuning (${pct} %)`);
  }
});

test('B56: a game that fails to start says why, in words for the player', async () => {
  const { ENGINE_PT } = await import('../src/shared/i18n/lang/engine.pt-BR.ts');
  const { ENGINE_EN } = await import('../src/shared/i18n/lang/engine.en.ts');
  for (const d of [ENGINE_PT, ENGINE_EN]) assert.ok(!/npm/.test(d['ui.error.isolation']), `the isolation error tells the player to run a developer command: "${d['ui.error.isolation']}"`);
  const { bootGame } = await import('../src/ui/boot.ts');
  const shown: string[] = [];
  await bootGame({ isolated: true, create: () => { throw new Error('no GPU adapter'); }, show: (s) => shown.push(s), failed: () => undefined });
  assert.ok(shown.some((s) => s.includes('no GPU adapter')), `a failure building the game shows: ${JSON.stringify(shown)}`);
  shown.length = 0;
  await bootGame({ isolated: true, create: () => ({ start: () => Promise.reject(new Error('shader')) }), show: (s) => shown.push(s), failed: () => undefined });
  assert.ok(shown.some((s) => s.includes('shader')), `a failure starting the game shows: ${JSON.stringify(shown)}`);
});

test('B59: each language writes money with one currency (the unlimited money too)', async () => {
  const { t, initLang } = await import('../src/shared/i18n/index.ts');
  for (const l of ['pt-BR', 'en'] as const) {
    initLang(l);
    const symbol = t('economy.money', { value: '' }).trim();
    assert.ok(t('ui.money.unlimited').startsWith(symbol), `${l}: money is "${symbol} …" but unlimited money is "${t('ui.money.unlimited')}"`);
  }
  initLang('pt-BR');
});

test('B35: the road keys cannot take a key the game answers (zoom = − + included), and can take Page Up / Down', async () => {
  const { reservedKeys } = await import('../src/ui/keys.ts');
  const r = reservedKeys();
  for (const c of ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Home', 'F8', 'KeyO', 'KeyU', 'Digit0', 'Space']) assert.ok(r.has(c), `${c} is free for the road keys`);
  for (const c of ['PageUp', 'PageDown', 'Numpad8']) assert.ok(!r.has(c), `${c} is refused`);
});

test('B34: the help lists every key of the table, Ctrl+S as Save, and no bundle of letters', async () => {
  const { keyHelp, DOCK_KEYS, TOOL_KEYS, keyName } = await import('../src/ui/keys.ts');
  const { t } = await import('../src/shared/i18n/index.ts');
  const h = keyHelp();
  const keys = [...h.game, ...h.tools].map(([k]) => k);
  for (const c of [...Object.keys(DOCK_KEYS), ...Object.keys(TOOL_KEYS)]) assert.ok(keys.includes(keyName(c)), `${c} is not in the help`);
  for (const k of ['Ctrl + O', 'Ctrl + D', 'Home', 'Shift + Q / E']) assert.ok(keys.includes(k), `${k} is not in the help`);
  assert.equal(h.game.find(([k]) => k === 'Ctrl + S')?.[1], t('keys.do.save'));
  assert.ok(!keys.includes('1 Z H T O B I'));
});

test('the in-game interface checks (tools/check-interface.mjs) all compile', async () => {
  const tool = '../tools/check-interface.mjs';
  const { SCENARIOS, PRELUDE } = await import(tool) as { SCENARIOS: Record<string, unknown>; PRELUDE: string };
  const bad: string[] = [];
  for (const [name, body] of Object.entries(SCENARIOS)) {
    for (const x of ([] as unknown[]).concat(body)) {
      const code = typeof x === 'object' ? (x as { script: string }).script : String(x);
      try { new Function(`return (async () => {${PRELUDE}\n${code}\n})`); } catch (e) { bad.push(`${name}: ${(e as Error).message}`); }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(Object.keys(SCENARIOS).length > 40);
});

test('reload keys (Ctrl+R, Ctrl+Shift+R, F5) never reach the browser, even from a text box', () => {
  const w = fakeWindow();
  const { d } = deps();
  installKeys(d);
  const box = new (globalThis as unknown as { HTMLInputElement: new () => object }).HTMLInputElement();
  for (const [code, mods] of [['KeyR', { ctrlKey: true }], ['KeyR', { ctrlKey: true, shiftKey: true }], ['KeyR', { metaKey: true }], ['F5', {}], ['F5', { ctrlKey: true }]] as const) {
    for (const target of [null, box]) assert.ok(w.send('keydown', { code, ...mods, target: target as EventTarget | null }).prevented, `${code} ${JSON.stringify(mods)} ${target ? 'in a box' : ''} reaches the browser`);
  }
});

// Roadcraft 4.0 v2/shell.ts:1632-1634: the bomb's force goes 1..50, a step of 1 up to 10 and of 5 above; its blast
// radius is 2.5 + 1.1 × force metres (actionsWiring.ts:230), force 5 to start (toolChoices.ts:214).
test('bomb force steps 1..50 and blast radius as Roadcraft 4.0', async () => {
  const { bombStep, bombRadius, BOMB_START } = await import('../src/ui/strike.ts');
  assert.equal(BOMB_START, 5);
  let f = 1;
  const ups: number[] = [];
  for (let k = 0; k < 20; k++) { f = bombStep(f, 1); ups.push(f); }
  assert.deepEqual(ups.slice(0, 13), [2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30]);
  assert.equal(f, 50);
  assert.equal(bombStep(15, -1), 10);
  assert.equal(bombStep(10, -1), 9);
  assert.equal(bombStep(1, -1), 1);
  assert.ok(Math.abs(bombRadius(5) - 8) < 1e-9);
  assert.ok(Math.abs(bombRadius(50) - 57.5) < 1e-9);
});

// Roadcraft 4.0 v2/shell.ts:644-645 and render/isoViewport.ts:393-395: the Camera panel reads the zoom as screen pixels
// per metre at the centre, in %, and the centre as "X · Y" with Y the map's north (three.js −z).
test('camera readouts: zoom in % and centre X · Y as Roadcraft 4.0', async () => {
  const { zoomPercent, centreText } = await import('../src/ui/readouts.ts');
  // 1000 px tall, 45° field: at 500 m the view is 2·500·tan(22.5°) = 414.2 m tall → 2.414 px/m → 241 %
  assert.equal(zoomPercent(1000, 500, 45), 241);
  assert.equal(zoomPercent(1000, 1207.1, 45), 100);
  assert.equal(centreText(1234.4, -567.6, (v) => String(Math.round(v))), 'X 1234 · Y 568');
  assert.equal(centreText(0, 0.3, (v) => String(Math.round(v))), 'X 0 · Y 0');
});

// Roadcraft 4.0 world/transit.ts:134-138 and v2/transitLine.ts: a line is named by its mode and its number among the
// lines of that mode, in the order they were made: buses 1, 2…, trains T1…, metro M1…
test('transit lines are named as Roadcraft 4.0', async () => {
  const { lineName } = await import('../src/ui/transitNames.ts');
  const rows = [{ id: 1, mode: 0 }, { id: 2, mode: 2 }, { id: 5, mode: 0 }, { id: 7, mode: 1 }, { id: 9, mode: 2 }];
  assert.deepEqual(rows.map((l) => lineName(rows, l)), ['1', 'M1', '2', 'T1', 'M2']);
});

// Roadcraft 4.0 v2/shell.ts:741: the simulation's demand is 0.55 (low), 1 (normal) or 1.55 (peak).
test('simulation demand factors as Roadcraft 4.0', async () => {
  const { demandFactor } = await import('../src/ui/readouts.ts');
  assert.deepEqual(['baixa', 'normal', 'pico', undefined].map((d) => demandFactor(d)), [0.55, 1, 1.55, 1]);
});
