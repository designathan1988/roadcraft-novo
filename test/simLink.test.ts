/// <reference types="node" />
// The page's link to the simulation (app/simLink.ts, moved out of game.ts unchanged): the network's changes as one batch
// a frame, the demand every 2 s, the camera every 250 ms, the doors when the camera moved 80 m or the city changed, and
// the whole network again when the worker's mirror failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimLink } from '../src/app/simLink.ts';
import { World } from '../src/world/world.ts';
import { decodeOp } from '../src/sim/lanes.ts';
import { Zone } from '../src/roads/zones.ts';

function link(): { w: World; sent: Array<{ type: string; [k: string]: unknown }>; s: SimLink; cam: { x: number; z: number } } {
  const w = new World();
  w.unlimited = true;
  const sent: Array<{ type: string; [k: string]: unknown }> = [];
  const worker = { postMessage: (m: { type: string }) => { sent.push(m); } } as unknown as Worker;
  const cam = { x: 0, z: 0 };
  const s = new SimLink({ world: w, target: () => cam, hour: () => 9, demandChoice: () => ({ traffic: 0.5, people: 0.7 }), hasLines: () => true }, worker);
  // wired as game.ts wires it
  w.roads.listeners.push((op) => s.queue(op));
  return { w, sent, s, cam };
}
const kinds = (sent: Array<{ type: string }>): string[] => sent.map((m) => m.type);

test('the network changes go as one batch at the next sync, and segments bump the lines\' roads version', () => {
  const { w, sent, s } = link();
  const a = w.roads.addNode({ x: 0, z: 0, y: 0 }), b = w.roads.addNode({ x: 100, z: 0, y: 0 });
  w.roads.addSeg({ a, b, cx: 50, cz: 0, profile: 0, flags: 0 });
  assert.equal(sent.length, 0, 'nothing is sent before the frame');
  const v = s.roadsVersion;
  s.sync(5000);
  const ops = sent.filter((m) => m.type === 'ops');
  assert.equal(ops.length, 1);
  const enc = ops[0].ops as Float64Array, extra = ops[0].extra as string[];
  assert.deepEqual([0, 1, 2].map((i) => decodeOp(enc, i, extra).t), ['addNode', 'addNode', 'addSeg']);
  assert.equal(s.roadsVersion, v + 1);
  sent.length = 0;
  s.sync(5001);
  assert.equal(sent.filter((m) => m.type === 'ops').length, 0, 'no change, no batch');
});

test('demand every 2 s (or at once when asked), camera every 250 ms', () => {
  const { sent, s } = link();
  s.sync(10000);
  assert.deepEqual(kinds(sent).filter((k) => k !== 'doors' && k !== 'docks'), ['demand', 'camera']);
  const d = sent.find((m) => m.type === 'demand')!;
  assert.deepEqual([d.hour, d.traffic, d.people], [9, 0.5, 0.7]);
  sent.length = 0;
  s.sync(10200);
  assert.deepEqual(kinds(sent), []);
  s.sync(10300);
  assert.deepEqual(kinds(sent), ['camera']);
  sent.length = 0;
  s.demandNow();
  s.sync(10350);
  assert.deepEqual(kinds(sent), ['demand']);
});

test('doors and docks only when the camera moved 80 m or the city changed', () => {
  const { w, sent, s, cam } = link();
  w.addBuilding({ x: 10, z: 10, w: 20, d: 30, h: 0, rot: 0, color: 0, seed: 1, zone: Zone.Industrial, floors: 2, style: 1 });
  s.sync(4000);
  const doors = sent.find((m) => m.type === 'doors')!, docks = sent.find((m) => m.type === 'docks')!;
  assert.equal((doors.pts as Float32Array).length, 2);
  assert.equal((docks.pts as Float32Array).length, 3, 'an industrial lot has a loading dock');
  sent.length = 0;
  s.sync(8000);
  assert.ok(!kinds(sent).includes('doors'), 'same camera, same city: not again');
  cam.x = 100;
  s.sync(12000);
  assert.ok(kinds(sent).includes('doors'), 'moved 100 m');
});

test('resync sends a clear, then every node, segment and junction, and forgets the pending batch', () => {
  const { w, sent, s } = link();
  const a = w.roads.addNode({ x: 0, z: 0, y: 0 }), b = w.roads.addNode({ x: 100, z: 0, y: 0 });
  w.roads.addSeg({ a, b, cx: 50, cz: 0, profile: 0, flags: 0 });
  const v = s.roadsVersion;
  s.resync('test');
  const enc = sent[0].ops as Float64Array, extra = sent[0].extra as string[];
  assert.deepEqual([0, 1, 2, 3].map((i) => decodeOp(enc, i, extra).t), ['clear', 'addNode', 'addNode', 'addSeg']);
  assert.equal(s.roadsVersion, v + 1);
  sent.length = 0;
  s.sync(9000);
  assert.equal(sent.filter((m) => m.type === 'ops').length, 0, 'the pending changes were in the whole network');
});
