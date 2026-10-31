// The pointer gesture (src/app/input.ts) and the tool switch (src/app/tools.ts): a tool changed in the middle of a
// drag leaves the gesture (audit §13.4, combination 4; D74). What the drag already put in the world becomes one undo
// step; what waits for the release (a row, a box, a free road) is dropped, never finished on the next tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { bindInput, type InputHost } from '../src/app/input.ts';
import { ToolState, type ToolHost } from '../src/app/tools.ts';

// the keys listen on the window (ui/keys.ts); the page's window is an event target like any other
const g = globalThis as unknown as { window?: EventTarget };
g.window ??= new EventTarget();

class FakeCanvas extends EventTarget {
  clientWidth = 800;
  clientHeight = 600;
  style = { cursor: '' };
  setPointerCapture(): void { /* the page keeps the pointer; nothing to keep here */ }
  releasePointerCapture(): void { /* idem */ }
  hasPointerCapture(): boolean { return false; }
}

const pointer = (type: string, x: number, y: number, button = 0, pointerId = 1): Event =>
  Object.assign(new Event(type), { button, offsetX: x, offsetY: y, clientX: x, clientY: y, pointerId, pointerType: pointerId === 1 ? 'mouse' : 'pen', shiftKey: false, altKey: false });

/** A host whose tools only record what the input asks of them. */
function rig(tool: InputHost['tool']) {
  const calls: string[] = [];
  const canvas = new FakeCanvas();
  const host = {
    life: { worldEditable: true },
    canvas,
    ambient: { start: () => {} },
    commands: { holding: false, push: () => calls.push('push') },
    rig: {
      pick: () => new THREE.Vector3(10, 0, 10),
      beginPan: () => calls.push('beginPan'), pan: () => {}, endPan: () => calls.push('endPan'), rotate: () => {}, zoomAt: () => {},
    },
    hud: { toast: (s: string) => calls.push('toast ' + s) },
    preview: { hideAll: () => calls.push('hideAll') },
    roadTool: {
      shiftHeld: false,
      freeBegin: () => true, freeEnd: () => calls.push('freeEnd'), cancel: () => calls.push('roadCancel'),
      grab: () => false, drop: () => calls.push('drop'),
    },
    itemTool: { row: () => calls.push('row'), open: false },
    zoneTool: { begin: () => calls.push('zoneBegin'), end: () => calls.push('zoneEnd') },
    editing: { lotMode: 'edit', lotExtra: null, cornerDrag: null },
    pointer: { x: 0, y: 0, inside: false },
    tool,
    zoneBlock: false,
    forestOne: false,
    cloudGrab: -1,
    stroke: null, rockStroke: null, elemStroke: null,
    brush: { mode: 'raise' },
    skyTool: { cloud: 'none', fog: 'none' },
    ndcX: () => 0, ndcY: () => 0,
    // the click dispatch (app/clicks.ts): the road tool's click is broken on purpose
    clickHost: () => ({ tool, roadTool: { click: () => { throw new Error('broken on purpose'); } } }),
  };
  const control = bindInput(host as unknown as InputHost);
  return { calls, canvas, control };
}

test('a row released on its own tool is placed (the drag reaches the release)', () => {
  const { calls, canvas, control } = rig('streetscape');
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  canvas.dispatchEvent(pointer('pointermove', 130, 100));
  assert.equal(control.gesture.drag, 'row');
  canvas.dispatchEvent(pointer('pointerup', 130, 100));
  assert.ok(calls.includes('row'), calls.join(', '));
});

test('a tool switch in the middle of a row drops it: the release places nothing', () => {
  const { calls, canvas, control } = rig('streetscape');
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  canvas.dispatchEvent(pointer('pointermove', 130, 100));
  control.cancel();
  assert.equal(control.gesture.drag, 'none');
  assert.equal(control.gesture.boxStart, null);
  canvas.dispatchEvent(pointer('pointerup', 130, 100));
  assert.ok(!calls.includes('row'), calls.join(', '));
});

test('a tool switch in the middle of a zone stroke commits what was painted, once', () => {
  const { calls, canvas, control } = rig('zone');
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  control.cancel();
  assert.deepEqual(calls.filter((c) => c.startsWith('zone')), ['zoneBegin', 'zoneEnd'], 'committed at the switch, not left for the release');
  canvas.dispatchEvent(pointer('pointerup', 100, 100));
  assert.deepEqual(calls.filter((c) => c.startsWith('zone')), ['zoneBegin', 'zoneEnd'], 'the release does not commit it again');
});

test('a tool switch in the middle of a free road drops it: the release builds nothing', () => {
  const { calls, canvas, control } = rig('free');
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  assert.equal(control.gesture.drag, 'free');
  control.cancel();
  canvas.dispatchEvent(pointer('pointerup', 140, 100));
  assert.ok(calls.includes('roadCancel'));
  assert.ok(!calls.includes('freeEnd'), calls.join(', '));
});

test('a tool that throws on release leaves no drag behind, and the player is told (D4)', () => {
  const { calls, canvas, control } = rig('road');
  const err = console.error;
  console.error = () => {};
  try {
    // the release of a still click goes to the road tool's click (app/clicks.ts), which throws here
    canvas.dispatchEvent(pointer('pointerdown', 100, 100));
    assert.equal(control.gesture.drag, 'click');
    canvas.dispatchEvent(pointer('pointerup', 100, 100));
  } finally { console.error = err; }
  assert.equal(control.gesture.drag, 'none');
  assert.ok(calls.some((c) => c.startsWith('toast ')), calls.join(', '));
  canvas.dispatchEvent(pointer('pointermove', 220, 160));
  assert.ok(!calls.includes('beginPan'), 'the next move does not pan the camera');
});

/** The tool switch's host: what it ends is recorded. */
function toolHost() {
  const calls: string[] = [];
  const host = {
    zoneLayer: false, brush: { mode: 'raise' }, lotMode: 'edit', skyTool: { cloud: 'none', fog: 'none' },
    riverPts: [], view: { insideId: -1, zoneToolInHand: () => {} },
    roadTool: { setMode: () => {}, cancel: () => {} },
    itemTool: { setMode: () => {}, cancel: () => {} },
    transitView: { showPaths: false },
    preview: { circle: { visible: false } },
    inside: { on: false, hide: () => {} },
    hud: { setHint: () => {}, toolChanged: () => {}, setInside: () => {} },
    canvas: { style: { cursor: '' } },
    ambient: { sfx: () => {} },
    select: () => {}, setLotMode: () => {},
    cancelGesture: () => calls.push('cancelGesture'),
    exitLots: () => calls.push('exitLots'),
  };
  return { calls, host: host as unknown as ToolHost };
}

test('switching tools leaves the gesture under way', () => {
  const tools = new ToolState(), { calls, host } = toolHost();
  tools.set(host, 'streetscape');
  calls.length = 0;
  tools.set(host, 'road');
  assert.deepEqual(calls, ['cancelGesture']);
  assert.equal(tools.current, 'road');
});

test('leaving the building tool drops the lot points under way; staying on it keeps them', () => {
  const tools = new ToolState(), { calls, host } = toolHost();
  tools.set(host, 'building');
  calls.length = 0;
  tools.set(host, 'building');
  assert.deepEqual(calls, ['cancelGesture']);
  calls.length = 0;
  tools.set(host, 'road');
  assert.deepEqual(calls, ['cancelGesture', 'exitLots']);
});

test('the landform picked reaches the brush only while the Landform tool is in hand', () => {
  const tools = new ToolState(), { host } = toolHost(), brush = host.brush;
  tools.set(host, 'raise');
  tools.setLandform(brush, 'canyon');
  assert.equal(brush.mode, 'raise');
  tools.set(host, 'landform');
  assert.equal(brush.mode, 'canyon');
  tools.setLandform(brush, 'gully');
  assert.equal(brush.mode, 'gully');
});

test('D71: a second pointer during a gesture neither starts another one over it nor ends it', () => {
  const { calls, canvas, control } = rig('zone');
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  assert.equal(control.gesture.drag, 'zone');
  // a pen comes down and up while the mouse still drags
  canvas.dispatchEvent(pointer('pointerdown', 120, 100, 0, 2));
  canvas.dispatchEvent(pointer('pointerup', 120, 100, 0, 2));
  assert.equal(control.gesture.drag, 'zone', 'the mouse gesture goes on');
  assert.equal(calls.filter((c) => c === 'zoneBegin').length, 1, calls.join(', '));
  canvas.dispatchEvent(pointer('pointerup', 130, 100));
  assert.equal(control.gesture.drag, 'none');
  assert.equal(calls.filter((c) => c === 'zoneEnd').length, 1, calls.join(', '));
});
