/// <reference types="node" />
// Regression tests for the road, editing, zone, lot, growth, terrain and history defects of DEFEITOS-roadcraft-novo.md
// (section D and A19-A44). Each one failed on the code before its fix; the commit that fixed it quotes both results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadJournal, buildRoad, buildRoundabout, demolishSeg, planRoad, snap } from '../src/roads/build.ts';
import { CommandStack, type Command } from '../src/core/commands.ts';
import { demolishBox } from '../src/tools/demolish.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import { MAX_DEG } from '../src/roads/network.ts';
import { Zone } from '../src/roads/zones.ts';

function flatWorld(money: number, y = 10): World {
  const w = new World();
  w.heights.fill(y); w.tileMin.fill(y); w.tileMax.fill(y);
  w.money = money;
  return w;
}

function road(w: World, ax: number, az: number, bx: number, bz: number, profile = 0, elevation = 0): RoadJournal {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, profile, elevation);
  assert.ok(p.ok, p.reason);
  const j = buildRoad(w, p, a, b, profile);
  assert.ok(j.settle());
  return j;
}

/** Network as sorted text (ends, heights and profiles), to compare before and after. */
function shape(w: World): string {
  const net = w.roads, sc = net.segs.cols, nc = net.nodes.cols, out: string[] = [];
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) {
    const a = sc.a[s], b = sc.b[s];
    out.push(`${nc.x[a].toFixed(1)},${nc.z[a].toFixed(1)},${nc.y[a].toFixed(2)}>${nc.x[b].toFixed(1)},${nc.z[b].toFixed(1)},${nc.y[b].toFixed(2)}:${sc.profile[s]}`);
  }
  return out.sort().join(" ");
}

/** The generated city puts its roads straight into the network, with no build kind (game.ts generatedCity). */
function generatedRoad(w: World, ax: number, az: number, bx: number, bz: number, profile = 3): number {
  const net = w.roads;
  const find = (x: number, z: number) => { const n = net.nearestNode(x, z, 0.5); return n >= 0 ? n : net.addNode({ x, z, y: 10 }); };
  const a = find(ax, az), b = find(bx, bz);
  return net.addSeg({ a, b, cx: (ax + bx) / 2, cz: (az + bz) / 2, profile, flags: 0, zl: Zone.Residential, zr: Zone.Residential });
}

test('D2: demolishing the generated city, which was free, gives no money back', () => {
  const w = flatWorld(1000);
  const s1 = generatedRoad(w, -200, 0, -100, 0);
  generatedRoad(w, -100, 0, 0, 0);
  generatedRoad(w, 0, 0, 100, 0);
  generatedRoad(w, 0, -100, 0, 0);
  const start = w.money;
  const d = demolishSeg(w, s1);
  assert.ok(d.settle());
  assert.equal(w.money, start, `demolishing one generated segment changed the money from ${start} to ${w.money}`);
  const box = demolishBox(w, -150, -150, 150, 150)!;
  assert.ok(box);
  assert.equal(box.charge, 0, `demolishing the area gave back R$ ${-box.charge}`);
  assert.equal(w.money, start);
  // undo and redo of the demolition keep the money as it is
  box.cmd.invert(); assert.equal(w.money, start);
  box.cmd.apply(); assert.equal(w.money, start);
});

test('D2: a road built across a generated road costs only itself; the generated pieces stay free', () => {
  const w = flatWorld(1e9);
  generatedRoad(w, -100, 0, 100, 0);
  const a = snap(w.roads, 0, -80, 8), b = snap(w.roads, 0, 80, 8);
  const p = planRoad(w, a, null, b, 0, 0);
  assert.ok(p.ok, p.reason);
  const j = buildRoad(w, p, a, b, 0);
  const own = 160 * PROFILE_INFO[0].cost;
  assert.ok(Math.abs(j.price - own) < own * 0.02, `the crossing road costs ${j.price}, its own price is ${own}`);
  assert.ok(j.settle());
  // the generated road was split in two at the crossing: demolishing its pieces still gives nothing
  const before = w.money;
  const west = w.roads.nearestSeg(-60, 0, 3)![0];
  const d = demolishSeg(w, west);
  assert.ok(d.settle());
  assert.equal(w.money, before, 'a piece of the split generated road gave money back');
  // the player's own road still gives back its share
  const north = w.roads.nearestSeg(0, -50, 3)![0];
  const e = demolishSeg(w, north);
  assert.ok(e.settle());
  assert.ok(w.money > before, 'the player\'s own road gives back a share when demolished');
});

test('D2: making a free road dearer costs the difference; making it cheaper gives nothing back', async () => {
  const { changeProfile } = await import('../src/roads/build.ts');
  const w = flatWorld(1e9);
  const s = generatedRoad(w, -50, 0, 50, 0, 0);
  const wide = PROFILE_INFO.findIndex((p) => p.name === 'Avenida 6 faixas com canteiro');
  const up = changeProfile(w, s, wide);
  const diff = 100 * (PROFILE_INFO[wide].cost - PROFILE_INFO[0].cost);
  assert.ok(Math.abs(up.price - diff) < diff * 0.02, `upgrading costs ${up.price}, the difference is ${diff}`);
  assert.ok(up.settle());
  const down = changeProfile(w, s, 0);
  assert.equal(down.price, 0, 'downgrading a free road gave money back');
});

test('A21: an undo that fails half way leaves the world and the history as they were', () => {
  const w = flatWorld(1e9);
  const commands = new CommandStack();
  commands.push(road(w, -100, 0, 100, 0));
  const net = w.roads;
  const n0 = net.nearestNode(-100, 0, 1), n1 = net.nearestNode(0, 0, 1), n2 = net.nearestNode(100, 0, 1);
  const s0 = net.segsOf(n0)[0], s1 = net.segsOf(n2)[0];
  // demolish the whole road west to east: the undo puts the east end back first and the west node last
  const d = new RoadJournal(w, 'demolish');
  d.removeSeg(s0); d.removeNode(n0); d.removeSeg(s1); d.removeNode(n1); d.removeNode(n2);
  assert.ok(d.settle());
  commands.push(d);
  const before = shape(w);
  // something outside the history took the id of the west node: the undo fails after restoring half the road
  const taken = n0;
  w.roads.nodes.allocAt(taken);
  const nodesAlive = Array.from(w.roads.nodes.alive.subarray(0, w.roads.nodes.end));
  let error: unknown = null;
  commands.onError = (e) => { error = e; };
  assert.doesNotThrow(() => commands.undo(), 'undo threw out of the stack');
  assert.ok(error, 'the failure was reported');
  assert.equal(shape(w), before, 'the failed undo left the network half restored');
  assert.deepEqual(Array.from(w.roads.nodes.alive.subarray(0, w.roads.nodes.end)), nodesAlive);
  assert.equal(commands.canUndo, true, 'the step is still in the history');
  // once the id is free again the same undo works
  w.roads.nodes.release(taken);
  assert.equal(commands.undo(), true);
  assert.notEqual(shape(w), before);
});

test('A21: a redo that throws keeps the step to redo', () => {
  const commands = new CommandStack();
  let fail = true, state = 0;
  const c: Command = { label: 'x', apply: () => { if (fail) throw new Error('no'); state = 1; }, invert: () => { state = 0; } };
  commands.push(c);
  assert.equal(commands.undo(), true);
  let error: unknown = null;
  commands.onError = (e) => { error = e; };
  assert.doesNotThrow(() => commands.redo());
  assert.ok(error);
  assert.equal(commands.canRedo, true);
  fail = false;
  assert.equal(commands.redo(), true);
  assert.equal(state, 1);
});

test('D4: a 9th road at a node is refused before building, never half built', () => {
  const w = flatWorld(1e9);
  for (let k = 0; k < MAX_DEG; k++) {
    const a = (k / MAX_DEG) * Math.PI * 2;
    road(w, 0, 0, Math.cos(a) * 100, Math.sin(a) * 100);
  }
  const centre = w.roads.nearestNode(0, 0, 1);
  assert.equal(w.roads.nodes.cols.deg[centre], MAX_DEG);
  const before = shape(w);
  const money = w.money;
  const ang = Math.PI / MAX_DEG; // half way between two roads
  const a = snap(w.roads, 0, 0, 8);
  const b = snap(w.roads, Math.cos(ang) * 100, Math.sin(ang) * 100, 8);
  let plan: ReturnType<typeof planRoad> | null = null;
  assert.doesNotThrow(() => { plan = planRoad(w, a, null, b, 0, 0); if (plan.ok) buildRoad(w, plan, a, b, 0); }, 'planning or building the 9th road threw');
  assert.equal(plan!.ok, false, 'the plan refuses the 9th road');
  assert.equal(shape(w), before, 'nothing was built');
  // a straight road crossing the full node is refused too (it would take two more)
  const c = snap(w.roads, -Math.cos(ang) * 30, -Math.sin(ang) * 30, 8), d = snap(w.roads, Math.cos(ang) * 30, Math.sin(ang) * 30, 8);
  let cross: ReturnType<typeof planRoad> | null = null;
  assert.doesNotThrow(() => { cross = planRoad(w, c, null, d, 0, 0); if (cross.ok) buildRoad(w, cross, c, d, 0); });
  assert.equal(cross!.ok, false, 'the road through the full node is refused');
  assert.equal(shape(w), before, 'nothing was built through the full node');
  assert.equal(w.money, money);
});

test('D4: a build that fails half way puts back everything it did', () => {
  const w = flatWorld(1e9);
  road(w, -100, 0, 100, 0);
  const before = shape(w);
  const j = new RoadJournal(w, 'test');
  const s = w.roads.nearestSeg(0, 0, 3)![0];
  assert.throws(() => j.guard(() => { j.removeSeg(s); j.addNode(0, 50, 10); throw new Error('broken'); }), /broken/);
  assert.equal(shape(w), before, 'the half-built edit stayed');
  assert.equal(j.empty, true);
  assert.equal(j.price, 0);
});

test('D3: a refused roundabout leaves every road as it was', () => {
  const w = flatWorld(1e9);
  // an existing roundabout, and roads all around it that a second circle would cut
  road(w, -120, 0, 120, 0);
  road(w, 0, -120, 0, 120);
  const first = buildRoundabout(w, 0, 0, 22);
  assert.ok(first);
  assert.ok(first.settle());
  road(w, 60, -120, 60, 120);
  road(w, -120, 50, 120, 50);
  const before = shape(w);
  const money = w.money;
  for (const [x, z] of [[40, 20], [30, 30], [45, 10], [25, 35], [35, 25]]) {
    const j = buildRoundabout(w, x, z, 30);
    assert.ok(j === null, `a roundabout at ${x}, ${z} over the first one is refused`);
    assert.equal(shape(w), before, `after refusing the roundabout at ${x}, ${z} the roads are cut`);
    assert.equal(w.money, money);
  }
});
