// The automation contract (src/app/automation.ts, audit §13.6): version 1 publishes exactly these names, each one
// delegating to its owner. A name is added in a new version, never changed or dropped in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation, type AutomationHost, type AutomationPage } from '../src/app/automation.ts';

const V1: Record<string, string[] | null> = {
  version: null, status: null, setLang: null, t: null,
  lifecycle: ['state', 'whenIdle', 'unsaved'],
  camera: ['view', 'pose', 'place', 'pick', 'toScreen', 'following', 'followAt'],
  view: ['layers', 'inside', 'insideId'],
  audio: ['start', 'state', 'green'],
  panels: ['registerBuilderTab'],
  people: ['ready', 'groups', 'last'],
  demo: ['hitKind', 'force'],
  frames: ['settle', 'stats', 'drawnStats', 'fixDetail', 'gpu', 'profile', 'drawn'],
  world: null, actions: null,
  history: ['undo', 'redo', 'canUndo'],
  tools: ['current', 'set', 'select', 'inspect', 'click', 'options', 'selected', 'design', 'inspector'],
  options: ['get', 'apply'],
  sky: ['hour', 'mode', 'clouds', 'setHour', 'weather'],
  ui: null,
  saves: ['save', 'load', 'importMap', 'newMap', 'store', 'autosaveNow'],
  cities: ['generated', 'testCity', 'growthRate', 'freeLots'],
  sim: ['paused', 'togglePause', 'speed', 'stats', 'inspect', 'post', 'poses', 'signals', 'demandSentAt'],
  transit: ['lines', 'terminals'],
  notices: ['show'],
  render: ['props', 'sun', 'demolition', 'bolt', 'preview'],
};

const page = (state: string): AutomationPage => ({ life: { state, whenIdle: async () => true, unsaved: false } as unknown as AutomationPage['life'], setLang: () => {}, t: (k) => k });

/** A host whose every member records its own name when used. */
function recordingHost(calls: string[]): AutomationHost {
  const world = { tag: 'world' }, actions = { tag: 'actions' }, ui = { tag: 'ui' };
  return new Proxy({ world, actions, ui } as unknown as AutomationHost, {
    get: (o, k: string) => (k in o ? (o as unknown as Record<string, unknown>)[k] : (...a: unknown[]) => { calls.push(k + (a.length ? '(' + a.join(',') + ')' : '')); return k === 'life' ? 'ready' : undefined; }),
  });
}

test('version 1 publishes exactly the contract names', () => {
  const api = createAutomation(page('ready'), () => recordingHost([])) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(api).sort(), Object.keys(V1).sort());
  for (const [name, members] of Object.entries(V1)) {
    if (!members) continue;
    assert.deepEqual(Object.keys(api[name] as object).sort(), [...members].sort(), name);
  }
  assert.equal(api.version, 1);
});

test('each member delegates to its owner (no state kept in the automation)', async () => {
  const calls: string[] = [];
  const host = recordingHost(calls);
  const api = createAutomation(page('ready'), () => host);
  assert.equal(api.status, 'ready');
  api.tools.set('road');
  api.sim.speed(4);
  await api.saves.save();
  api.camera.place({ dist: 30 });
  assert.deepEqual(calls, ['setTool(road)', 'speed(4)', 'save(false)', 'place([object Object])']);
  assert.equal((api.world as unknown as { tag: string }).tag, 'world');
  assert.equal((api.actions as unknown as { tag: string }).tag, 'actions');
  assert.equal((api.ui as unknown as { tag: string }).tag, 'ui');
});

test('before the game runs (or when it failed to start) the status answers and the rest says so', () => {
  const api = createAutomation(page('failed'), () => null);
  assert.equal(api.status, 'failed');
  assert.equal(api.lifecycle.state(), 'failed');
  assert.throws(() => api.tools.current(), /the game is not running \(lifecycle failed\)/);
  assert.throws(() => api.world, /not running/);
});

test('no tool, script or page publishes or reaches the game outside the contract', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(ts|mjs|js|cjs)$/.test(e.name) && !e.name.endsWith('.head.tmp.mjs')) files.push(p); } };
  for (const d of ['src', 'tools', 'scripts', 'electron']) walk(d);
  const offenders = files.filter((f) => /__cidade\b/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'the old global of the Game: ' + offenders.join(', '));
});
