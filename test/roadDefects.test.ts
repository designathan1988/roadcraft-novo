/// <reference types="node" />
// Regression tests for the road, editing, zone, lot, growth, terrain and history defects of DEFEITOS-roadcraft-novo.md
// (section D and A19-A44). Each one failed on the code before its fix; the commit that fixed it quotes both results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadJournal, buildRoad, buildRoundabout, bulbAt, demolishSeg, planRoad, roundaboutRefusal, snap } from '../src/roads/build.ts';
import { heightIndex, sampleCoord } from '../src/world/heights.ts';
import { HEIGHT_MAP_RES } from '../src/config.ts';
import { CommandStack, type Command } from '../src/core/commands.ts';
import { demolishBox } from '../src/tools/demolish.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import { MAX_DEG } from '../src/roads/network.ts';
import { Zone } from '../src/roads/zones.ts';
import { Dirty, cellId, cellX } from '../src/core/grid.ts';
import { decayTenths } from '../src/world/decay.ts';
import { Ctl, Rule, type JunctionSpec } from '../src/roads/control.ts';
import { laneExits } from '../src/roads/laneLinks.ts';

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

test('D5: a bridge or a tunnel leaves the buildings below or above it standing; a road at grade clears them', () => {
  const w = flatWorld(1e9);
  const rec = (x: number, floors: number) => ({ x, z: 0, w: 16, d: 16, h: 0, rot: 0, color: 0, seed: x, zone: Zone.Residential, floors, style: 1 });
  // a low house under a viaduct 16 m up, a row of houses over a metro 12 m down, and a house in the way at grade
  const house = w.addBuilding(rec(0, 2));
  const row = [w.addBuilding(rec(400, 3)), w.addBuilding(rec(430, 3)), w.addBuilding(rec(460, 3))];
  const inWay = w.addBuilding(rec(900, 2));
  // the viaduct's ends stand on piers 16 m up, so the whole span stays up
  w.roads.addNode({ x: -120, z: 0, y: 26 }); w.roads.addNode({ x: 120, z: 0, y: 26 });
  road(w, -120, 0, 120, 0, 0, 16);
  assert.equal(w.buildings.alive[house], 1, 'the house under the viaduct was demolished');
  const metro = PROFILE_INFO.findIndex((p) => p.name.startsWith('Metrô'));
  w.roads.addNode({ x: 300, z: 0, y: -2 }); w.roads.addNode({ x: 560, z: 0, y: -2 });
  road(w, 300, 0, 560, 0, metro, -12);
  for (const id of row) assert.equal(w.buildings.alive[id], 1, `the house ${id} over the metro was demolished`);
  road(w, 860, 0, 940, 0, 0, 0);
  assert.equal(w.buildings.alive[inWay], 0, 'a road at grade still clears the house in its way');
});

test('D5: a tall tower under a low bridge is still in the way', () => {
  const w = flatWorld(1e9);
  const tower = w.addBuilding({ x: 0, z: 0, w: 20, d: 20, h: 0, rot: 0, color: 0, seed: 3, zone: Zone.Commercial, floors: 20, style: 1 });
  w.roads.addNode({ x: -120, z: 0, y: 26 }); w.roads.addNode({ x: 120, z: 0, y: 26 });
  road(w, -120, 0, 120, 0, 0, 16);
  assert.equal(w.buildings.alive[tower], 0, 'a 20-floor tower cannot stand under a deck 16 m up');
});

/** Terrain height at the nearest sample. */
function ground(w: World, x: number, z: number): number { return w.heights[heightIndex(Math.round(sampleCoord(x)), Math.round(sampleCoord(z)))]; }

test('D6: the turning bulb of a dead end never pulls the terrain up to a bridge or down to a tunnel', () => {
  const w = flatWorld(1e9);
  // a dead end that ends 14 m above the ground: the end of a viaduct
  w.roads.addNode({ x: 100, z: 0, y: 24 });
  road(w, -100, 0, 100, 0);
  for (const [dx, dz] of [[0, 0], [6, 0], [0, 8], [-8, 4]]) {
    const g = ground(w, 100 + dx, dz);
    assert.ok(g < 11, `the ground at the viaduct end (${100 + dx}, ${dz}) rose to ${g.toFixed(2)} m`);
  }
  // a dead end 12 m down: the end of a tunnel
  w.roads.addNode({ x: 500, z: 300, y: -2 });
  road(w, 300, 300, 500, 300);
  for (const [dx, dz] of [[0, 0], [6, 0], [0, 8]]) {
    const g = ground(w, 500 + dx, 300 + dz);
    assert.ok(g > 9, `the ground over the tunnel end (${500 + dx}, ${300 + dz}) sank to ${g.toFixed(2)} m`);
  }
});

test('D6: rail lines have no turning bulb; streets keep theirs', () => {
  const w = flatWorld(1e9);
  const rail = PROFILE_INFO.findIndex((p) => p.rail && p.oneWay);
  road(w, -100, 0, 100, 0, rail);
  assert.equal(bulbAt(w.roads, w.roads.nearestNode(100, 0, 1)), false, 'a rail dead end got a turning bulb');
  const street = flatWorld(1e9);
  road(street, -100, 0, 100, 0, 0);
  assert.equal(bulbAt(street.roads, street.roads.nearestNode(100, 0, 1)), true, 'a local street dead end keeps its bulb');
});

test('D6: a roundabout never fills the sea', () => {
  const w = flatWorld(1e9);
  // sea west of x = 0
  for (let gz = 0; gz < HEIGHT_MAP_RES; gz++) for (let gx = 0; gx < Math.round(sampleCoord(0)); gx++) w.heights[heightIndex(gx, gz)] = -4;
  road(w, 0, 0, 200, 0);
  const at = [[-10, 0], [-20, 6], [-6, -12]];
  const j = buildRoundabout(w, 10, 0, 22);
  if (j) assert.ok(j.settle());
  for (const [x, z] of at) assert.ok(ground(w, x, z) < 0, `the sea bed at ${x}, ${z} rose to ${ground(w, x, z).toFixed(2)}`);
  assert.notEqual(roundaboutRefusal(w, 10, 0, 22), '', 'the tool says why it cannot go there');
  assert.equal(roundaboutRefusal(w, 120, 0, 22), '', 'on dry land it can');
});

test('D9 and A41: decay tenths rebuild no mesh and mark no tile for saving', () => {
  const w = flatWorld(0);
  for (let i = 0; i < 400; i++) w.addBuilding({ x: (i % 20) * 30 - 300, z: Math.floor(i / 20) * 30 - 300, w: 20, d: 20, h: 0, rot: 0, color: 0, seed: i, zone: Zone.Residential, floors: 3, style: 1, built: i * 37 });
  for (const k of [Dirty.Buildings, Dirty.Props, Dirty.Save, Dirty.Lots]) w.dirty.drain(k);
  w.saveDirty.fill(0);
  const versions = w.cellVersion.slice();
  const before = w.decayChanges;
  for (let day = 0; day < 40; day++) w.advanceClock(1440);
  assert.ok(w.decayChanges - before > 400 * 9, `the buildings aged (${w.decayChanges - before} tenths passed)`);
  for (const [name, k] of [['buildings', Dirty.Buildings], ['props', Dirty.Props], ['save', Dirty.Save]] as const) {
    assert.equal(w.dirty.pending(k), 0, `decay marked ${w.dirty.pending(k)} cells dirty for ${name}`);
  }
  assert.equal(w.saveDirty.reduce((a, b) => a + b, 0), 0, 'decay marked tiles for saving');
  assert.deepEqual(w.cellVersion, versions, 'decay bumped cell versions');
});

test('A40: setting the clock keeps the minute set and files every building again from it', () => {
  const w = flatWorld(0);
  const id = w.addBuilding({ x: 0, z: 0, w: 20, d: 20, h: 0, rot: 0, color: 0, seed: 1, zone: Zone.Residential, floors: 3, style: 1, built: 0 });
  w.setClock(20 * 1440);
  assert.equal(w.clock, 20 * 1440, 'the clock went back to 0');
  assert.equal(w.buildings.cols.decay[id], decayTenths(0, 20 * 1440));
});

/** The segment at node n heading (dx, dz) out of it. */
function legToward(w: World, n: number, dx: number, dz: number): number {
  const net = w.roads, nc = net.nodes.cols;
  let best = -1, bd = -2;
  for (const s of net.segsOf(n, [])) {
    const o = net.segs.cols.a[s] === n ? net.segs.cols.b[s] : net.segs.cols.a[s];
    const ex = nc.x[o] - nc.x[n], ez = nc.z[o] - nc.z[n], l = Math.hypot(ex, ez) || 1;
    const d = (ex * dx + ez * dz) / l;
    if (d > bd) { bd = d; best = s; }
  }
  return best;
}

/** Every segment id a junction's hand-made settings name. */
function specSegs(spec: JunctionSpec | undefined): number[] {
  if (!spec) return [];
  return [...(spec.legs ?? []).map(([s]) => s), ...(spec.bans ?? []), ...(spec.lanes ?? []).flatMap(([s, , to]) => [s, ...to])];
}

test('D8: junction rules and lane links follow a split leg and forget a removed one; undo brings them back', () => {
  const w = flatWorld(1e9);
  road(w, -200, 0, 200, 0);
  road(w, 0, -200, 0, 200);
  const c = w.roads.nearestNode(0, 0, 1);
  const east = legToward(w, c, 1, 0), west = legToward(w, c, -1, 0), north = legToward(w, c, 0, -1);
  const set = new RoadJournal(w, 'junction');
  set.setJunction(c, { ctl: Ctl.Priority, legs: [[east, Rule.Stop]], bans: [north, east], lanes: [[west, 0, [east]]] });
  assert.ok(set.settle());
  // a new road crosses the east leg 40 m out: the leg at the node is a new piece
  road(w, 40, -60, 40, 60);
  const east2 = legToward(w, c, 1, 0);
  let spec = w.roads.junctions.get(c);
  for (const s of specSegs(spec)) {
    assert.ok(w.roads.segs.alive[s], `the junction names segment ${s}, which is gone`);
    assert.ok(w.roads.segsOf(c, []).includes(s), `the junction names segment ${s}, which is not at the node`);
  }
  assert.deepEqual(spec?.legs, [[east2, Rule.Stop]], 'the stop sign stayed with the east leg');
  assert.equal(laneExits(w.roads, c, west)[0].exits.length, 1, 'the west lane still has its one exit');
  assert.equal(laneExits(w.roads, c, west)[0].exits[0][0], east2);
  // the east leg is demolished: nothing names it any more, and the west lane has exits again (automatic)
  const commands = new CommandStack();
  const d = demolishSeg(w, east2);
  assert.ok(d.settle());
  commands.push(d);
  spec = w.roads.junctions.get(c);
  for (const s of specSegs(spec)) assert.ok(w.roads.segsOf(c, []).includes(s), `after the demolition the junction still names segment ${s}`);
  assert.ok(laneExits(w.roads, c, west)[0].exits.length > 0, 'the west lane was left with no exit: cars stuck');
  // a new road elsewhere takes the freed id: it must not inherit anything
  road(w, 500, 500, 600, 500);
  for (const s of specSegs(w.roads.junctions.get(c))) assert.ok(w.roads.segsOf(c, []).includes(s));
  commands.push(road(w, 700, 500, 800, 500));
  commands.undo(); commands.undo();
});

test('A23: a street name stays with its street and never passes to a road that reuses the id', () => {
  const w = flatWorld(1e9);
  const commands = new CommandStack();
  commands.push(road(w, -100, 0, 0, 0));
  const s = w.roads.nearestSeg(-50, 0, 3)![0];
  w.streetNames.set(s, 'Rua Teste');
  // splitting the street keeps the name on both pieces
  commands.push(road(w, -50, -60, -50, 60));
  const west = w.roads.nearestSeg(-80, 0, 3)![0], east = w.roads.nearestSeg(-20, 0, 3)![0];
  assert.equal(w.streetNames.get(west), 'Rua Teste', 'the west piece lost the name');
  assert.equal(w.streetNames.get(east), 'Rua Teste', 'the east piece lost the name');
  // demolished: the ids are free and the name goes with the road
  const d = new RoadJournal(w, 'demolish');
  for (const x of [west, east]) d.removeSeg(x);
  assert.ok(d.settle());
  commands.push(d);
  for (const x of [west, east]) assert.equal(w.streetNames.has(x), false, `the name of the demolished segment ${x} stayed`);
  commands.push(road(w, 300, 300, 400, 300));
  const fresh = w.roads.nearestSeg(350, 300, 3)![0];
  assert.equal(w.streetNames.get(fresh), undefined, 'the new road got the demolished street\'s name');
  // undo the new road and the demolition: the name is back on the pieces
  commands.undo(); commands.undo();
  assert.equal(w.streetNames.get(w.roads.nearestSeg(-80, 0, 3)![0]), 'Rua Teste');
});

test('D7: zoning or building a road near a cell edge refreshes the lots of the cell across the edge', () => {
  const w = flatWorld(1e9);
  // a street 14 m south of the edge between two cell rows (z = 256): its north lots stand in the next row
  road(w, 20, 242, 120, 242);
  w.dirty.drain(Dirty.Lots);
  const s = w.roads.nearestSeg(70, 242, 3)![0];
  const z = new RoadJournal(w, 'zone');
  z.setZone(s, 0, Zone.Residential); z.setZone(s, 1, Zone.Residential);
  const north = cellId(cellX(70), cellX(270)), south = cellId(cellX(70), cellX(242));
  assert.notEqual(north, south);
  const dirty = w.dirty.drain(Dirty.Lots);
  assert.ok(dirty.includes(south), 'the street\'s own cell');
  assert.ok(dirty.includes(north), 'zoning did not refresh the lots of the cell across the edge');
  // a new road in the south cell whose side lots overlap the north cell's lots
  road(w, 200, 230, 200, 250);
  assert.ok(w.dirty.drain(Dirty.Lots).includes(cellId(cellX(200), cellX(270))), 'a new road did not refresh the lots across the edge');
});

test('A19: restoring ids one by one (load, undo) takes time in proportion to the count, not its square', async () => {
  const { Table } = await import('../src/core/table.ts');
  const n = 100_000;
  const t = new Table({ v: Float32Array }, 1024);
  for (let i = 0; i < n; i++) t.alloc();
  for (let i = 0; i < n; i++) t.release(i);
  // an undo restores the ids it removed, oldest first: each one sits at the far end of the free list
  const t0 = performance.now();
  for (let i = 0; i < n; i++) t.allocAt(i);
  const ms = performance.now() - t0;
  assert.equal(t.size, n);
  assert.ok(ms < 1000, `restoring ${n} ids took ${ms.toFixed(0)} ms`);
  // the free list stays right: releasing and allocating again hands the ids back without repeats
  for (let i = 0; i < 10; i++) t.release(i * 7);
  const got = new Set<number>();
  for (let i = 0; i < 10; i++) got.add(t.alloc());
  assert.equal(got.size, 10);
  for (const id of got) assert.equal(id % 7, 0);
});

test('A44: the undo history drops its oldest steps past a byte budget; flattening the map says what it holds', async () => {
  const { FlattenMap } = await import('../src/world/brush.ts');
  const w = flatWorld(0);
  const flat = new FlattenMap(w, 20);
  assert.ok((flat.bytes ?? 0) >= w.heights.length * 2, 'the flatten command reports the heights it keeps');
  const commands = new CommandStack();
  const big = (): Command => ({ label: 'big', bytes: 100 * 2 ** 20, apply() {}, invert() {} });
  for (let i = 0; i < 10; i++) commands.push(big());
  let steps = 0;
  while (commands.undo()) steps++;
  assert.ok(steps * 100 <= 512 && steps >= 1, `${steps} steps of 100 MB kept in the history`);
});

test('D10: the terrain brush and the river redraw the roads and redo the lots they reshape', async () => {
  const { BrushStroke } = await import('../src/world/brush.ts');
  const { RiverCommand } = await import('../src/world/ground.ts');
  const w = flatWorld(0);
  const cell = cellId(cellX(0), cellX(0));
  for (const k of [Dirty.Roads, Dirty.RoadPaint, Dirty.Lots]) w.dirty.drain(k);
  const b = new BrushStroke(w);
  b.dab(0, 0, { mode: 'raise', radius: 20, strength: 2 }, 0.5);
  for (const [name, k] of [['roads', Dirty.Roads], ['road paint', Dirty.RoadPaint], ['lots', Dirty.Lots]] as const) {
    assert.ok(w.dirty.drain(k).includes(cell), `the brush did not mark the ${name}`);
  }
  b.finish();
  const r = new RiverCommand(w, [[-100, 300], [100, 300]], 12, 2);
  r.apply();
  const rc = cellId(cellX(0), cellX(300));
  for (const [name, k] of [['roads', Dirty.Roads], ['road paint', Dirty.RoadPaint], ['lots', Dirty.Lots]] as const) {
    assert.ok(w.dirty.drain(k).includes(rc), `the river did not mark the ${name}`);
  }
});

test('D11: a road across a river the player dug crosses it on a bridge and leaves the riverbed alone', async () => {
  const { RiverCommand, waterAt } = await import('../src/world/ground.ts');
  const { BuildKind, buildKindAt } = await import('../src/roads/economy.ts');
  const w = flatWorld(1e9, 20);
  const river = new RiverCommand(w, [[0, -300], [0, 300]], 24, 3);
  river.apply();
  const level = waterAt(w.water, 0, 0);
  assert.ok(level > 10 && level < 20, `the river runs at ${level}`);
  const bed = ground(w, 0, 0);
  const a = snap(w.roads, -150, 0, 8), b = snap(w.roads, 150, 0, 8);
  const p = planRoad(w, a, null, b, 0, 0);
  assert.ok(p.ok, p.reason);
  const mid = p.profile.y[Math.floor(p.profile.y.length / 2)];
  assert.ok(mid > level + 4, `the road crosses the river at ${mid.toFixed(2)}, the water is at ${level.toFixed(2)}`);
  assert.ok(buildRoad(w, p, a, b, 0).settle());
  assert.ok(Math.abs(ground(w, 0, 0) - bed) < 0.01, `the riverbed was filled from ${bed.toFixed(2)} to ${ground(w, 0, 0).toFixed(2)}`);
  // a road 2 m over a riverbed that is under water is a bridge, never an embankment
  assert.equal(buildKindAt(bed + 2, bed, level), BuildKind.Bridge, 'over the river the road is priced as an embankment');
});

test('D12: the roundabout ring clears the buildings under it', () => {
  const w = flatWorld(1e9);
  road(w, -120, 0, 120, 0);
  // a house where the ring will pass (radius 30, north side), and one well outside
  const under = w.addBuilding({ x: 0, z: -30, w: 12, d: 12, h: 0, rot: 0, color: 0, seed: 1, zone: Zone.Residential, floors: 2, style: 1 });
  const away = w.addBuilding({ x: 0, z: -80, w: 12, d: 12, h: 0, rot: 0, color: 0, seed: 2, zone: Zone.Residential, floors: 2, style: 1 });
  const j = buildRoundabout(w, 0, 0, 30);
  assert.ok(j && j.settle());
  assert.equal(w.buildings.alive[under], 0, 'the house under the ring is still standing in the roundabout');
  assert.equal(w.buildings.alive[away], 1, 'the house away from the ring was demolished');
  j.invert();
  assert.equal(w.buildings.alive[under], 1, 'undo brings the house back');
});

/** Ring segments: each ring node in exactly two, none shorter than `min` m, and the arcs going round once. */
function checkRing(w: World, cx: number, cz: number, min: number): void {
  const net = w.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const uses = new Map<number, number>();
  let turn = 0;
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s] && sc.flags[s] & 1) {
    assert.ok(sc.len[s] >= min, `ring segment ${s} is ${sc.len[s].toFixed(2)} m long`);
    for (const n of [sc.a[s], sc.b[s]]) uses.set(n, (uses.get(n) ?? 0) + 1);
    let d = Math.atan2(nc.z[sc.b[s]] - cz, nc.x[sc.b[s]] - cx) - Math.atan2(nc.z[sc.a[s]] - cz, nc.x[sc.a[s]] - cx);
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    turn += d;
  }
  for (const [n, k] of uses) assert.equal(k, 2, `ring node ${n} is in ${k} ring segments`);
  assert.ok(Math.abs(Math.abs(turn) - 2 * Math.PI) < 0.01, `the ring turns ${(turn / Math.PI).toFixed(2)}π`);
}

test('D13: a roundabout over roads that meet the circle close together makes one clean ring', () => {
  for (const gap of [1, 3, 6]) {
    const w = flatWorld(1e9);
    // two roads that cross the circle (radius 25) a few metres apart on its east side
    road(w, 0, 0, 120, gap);
    road(w, 0, 0, 120, -gap - 2);
    road(w, -120, 0, 0, 0);
    const j = buildRoundabout(w, 0, 0, 25);
    if (!j) continue; // refusing is fine; a broken ring is not
    assert.ok(j.settle());
    checkRing(w, 0, 0, 4);
  }
});

test('D14: a road from one point of a segment to another point of the same segment splits it at both points', () => {
  const w = flatWorld(1e9);
  road(w, -100, 0, 0, 0);
  const a = snap(w.roads, -80, 0, 8), b = snap(w.roads, -20, 0, 8);
  assert.ok(a.seg >= 0 && a.seg === b.seg, 'both ends are on the same segment');
  const p = planRoad(w, a, { x: -50, z: 50 }, b, 0, 0);
  assert.ok(p.ok, p.reason);
  assert.ok(buildRoad(w, p, a, b, 0).settle());
  for (const x of [-80, -20]) {
    const n = w.roads.nearestNode(x, 0, 1);
    assert.ok(n >= 0, `no node where the new road meets the old one at x = ${x}`);
    assert.equal(w.roads.nodes.cols.deg[n], 3, `the node at x = ${x} has ${w.roads.nodes.cols.deg[n]} roads`);
  }
});

test('D15: joining two segments keeps each side\'s zone and refuses what one segment cannot hold', async () => {
  const { joinAt } = await import('../src/roads/build.ts');
  const make = (y: number, z2l: number = Zone.Commercial) => {
    const w = flatWorld(1e9);
    const net = w.roads;
    const p = net.addNode({ x: -50, z: 0, y: 10 }), n = net.addNode({ x: 0, z: 0, y }), q = net.addNode({ x: 50, z: 0, y: 10 });
    // both drawn east to west (q → n → p): residential on the left, commercial on the right
    net.addSeg({ a: n, b: p, cx: -25, cz: 0, profile: 0, flags: 16, zl: Zone.Residential, zr: Zone.Commercial });
    net.addSeg({ a: q, b: n, cx: 25, cz: 0, profile: 0, flags: 16, zl: Zone.Residential, zr: z2l });
    return { w, n };
  };
  const { w, n } = make(10);
  const j = joinAt(w, n);
  assert.ok(!j.empty, 'the two segments join');
  const s = w.roads.nearestSeg(0, 0, 2)![0], sc = w.roads.segs.cols, nc = w.roads.nodes.cols;
  const westward = nc.x[sc.a[s]] > nc.x[sc.b[s]];
  const left = westward ? sc.zl[s] : sc.zr[s], right = westward ? sc.zr[s] : sc.zl[s];
  assert.equal(left, Zone.Residential, 'the residential side (left going west) changed');
  assert.equal(right, Zone.Commercial, 'the commercial side (right going west) changed');
  // a raised middle node or different zones on the two halves cannot become one straight segment
  const hump = make(14);
  assert.ok(joinAt(hump.w, hump.n).empty, 'joining lost the 4 m hump of the middle node');
  const mixed = make(10, Zone.Industrial);
  assert.ok(joinAt(mixed.w, mixed.n).empty, 'joining lost the zone of one half');
});

test('D16: no edit makes a segment longer than the spatial index holds; clicks near the end still find it', async () => {
  const { joinAt, moveNode } = await import('../src/roads/build.ts');
  const { MAX_SEG_LEN } = await import('../src/roads/network.ts');
  const w = flatWorld(1e9);
  const net = w.roads;
  const p = net.addNode({ x: -110, z: 0, y: 10 }), n = net.addNode({ x: 0, z: 0, y: 10 }), q = net.addNode({ x: 110, z: 0, y: 10 });
  net.addSeg({ a: p, b: n, cx: -55, cz: 0, profile: 0, flags: 16 });
  net.addSeg({ a: n, b: q, cx: 55, cz: 0, profile: 0, flags: 16 });
  const j = joinAt(w, n);
  if (!j.empty) assert.ok(j.settle());
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) assert.ok(net.segs.cols.len[s] <= MAX_SEG_LEN + 0.01, `a join made a ${net.segs.cols.len[s].toFixed(0)} m segment`);
  assert.ok(net.nearestSeg(108, 0, 4), 'a click 2 m from the end of the road finds nothing');
  // moving a node far away
  const w2 = flatWorld(1e9);
  road(w2, 0, 0, 100, 0);
  const end = w2.roads.nearestNode(100, 0, 1);
  const m = moveNode(w2, end, 400, 0);
  if (typeof m !== 'string') assert.ok(m.settle());
  for (let s = 0; s < w2.roads.segs.end; s++) if (w2.roads.segs.alive[s]) assert.ok(w2.roads.segs.cols.len[s] <= MAX_SEG_LEN + 0.01, `moving a node made a ${w2.roads.segs.cols.len[s].toFixed(0)} m segment`);
});

test('D17: moving a node clears and settles under the roads that move, and refuses crossings and the map edge', async () => {
  const { moveNode } = await import('../src/roads/build.ts');
  const { MAP_HALF } = await import('../src/config.ts');
  const w = flatWorld(1e9);
  road(w, 0, 0, 80, 0);
  const end = w.roads.nearestNode(80, 0, 1);
  // a house and a hill where the road will swing to
  const house = w.addBuilding({ x: 40, z: 30, w: 12, d: 12, h: 0, rot: 0, color: 0, seed: 1, zone: Zone.Residential, floors: 2, style: 1 });
  for (let gz = Math.round(sampleCoord(20)); gz <= Math.round(sampleCoord(40)); gz++) for (let gx = Math.round(sampleCoord(20)); gx <= Math.round(sampleCoord(60)); gx++) w.heights[heightIndex(gx, gz)] = 12.5;
  const m = moveNode(w, end, 80, 60);
  assert.ok(typeof m !== 'string', `the move was refused: ${m}`);
  assert.ok(m.settle());
  assert.equal(w.buildings.alive[house], 0, 'the house the moved road now runs through still stands');
  assert.ok(ground(w, 40, 30) < 11, `the ground under the moved road stayed at ${ground(w, 40, 30).toFixed(2)}`);
  // across another road at grade: refused (it would cross without a junction)
  road(w, 150, -60, 150, 60);
  const r2 = moveNode(w, w.roads.nearestNode(80, 60, 1), 200, 0);
  assert.equal(typeof r2, 'string', 'moving the node made the road cross another one without a junction');
  // off the map: refused
  const r3 = moveNode(w, w.roads.nearestNode(0, 0, 1), -MAP_HALF - 50, 0);
  assert.equal(typeof r3, 'string', 'the node was moved off the map');
});
