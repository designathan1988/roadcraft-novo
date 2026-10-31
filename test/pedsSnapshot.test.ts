/// <reference types="node" />
// The pedestrians' behaviour, pinned: the traffic test's grid city with cars and people wired as in the simulation
// worker (src/sim/worker.ts), a fixed seed and a fixed number of steps give the same people table, bit for bit. A
// refactor of the pedestrian code (moving a block of peds.ts to a module) must leave the hash unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { World } from '../src/world/world.ts';
import { planRoad, buildRoad, snap } from '../src/roads/build.ts';
import { SimNet, encodeOps, decodeOp } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { Peds } from '../src/sim/peds.ts';
import type { NetOp } from '../src/roads/network.ts';

function gridCity(n = 4, step = 120): SimNet {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  const half = (n - 1) * step / 2;
  for (let i = 0; i < n; i++) {
    for (const horiz of [true, false]) {
      const c = -half + i * step;
      const a = horiz ? snap(w.roads, -half, c, 8) : snap(w.roads, c, -half, 8);
      const b = horiz ? snap(w.roads, half, c, 8) : snap(w.roads, c, half, 8);
      const p = planRoad(w, a, null, b, i === 1 ? 3 : 0, 0);
      assert.ok(p.ok, p.reason);
      buildRoad(w, p, a, b, i === 1 ? 3 : 0);
    }
  }
  const sim = new SimNet();
  const enc = encodeOps(ops);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i));
  sim.rebuild();
  return sim;
}

function run(steps: number): string {
  const sim = gridCity();
  const traffic = new Traffic(sim);
  sim.onConnRemoved = (c) => traffic.evacuateConn(c);
  const peds = new Peds(sim);
  // wired as in the worker
  peds.walkOk = (n, arm) => traffic.walkOk(n, arm);
  peds.onWait = (n, arm) => traffic.pedCall(n, arm);
  traffic.pedCrossing = (n) => peds.crossing(n);
  traffic.pedCrossingArms = (n, mask) => peds.crossingArms(n, mask);
  traffic.pedCrossingReach = (n, mask, x, z, reach, front) => peds.crossingReach(n, mask, x, z, reach, front);
  peds.carsOn = (n, arm) => traffic.carsOnCrossing(n, arm);
  traffic.sig.pedsOn = (n, mask) => peds.crossingArms(n, mask);
  traffic.onDropOff = (x, z) => { peds.spawnFromPoint(x, z); };
  traffic.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  traffic.density = 1 / 40;
  peds.density = 1 / 3;
  traffic.camX = 0; traffic.camZ = 0; peds.camX = 0; peds.camZ = 0;
  traffic.checkWindow(); peds.checkWindow();
  for (let i = 0; i < steps; i++) {
    peds.setBodies(traffic.bodyBuf, traffic.writeBodies(traffic.camX, traffic.camZ, 180));
    traffic.step(0.05); peds.step(0.05);
    if (i % 10 === 0) { traffic.checkWindow(); peds.checkWindow(); }
  }
  const h = createHash('sha256'), t = peds.t;
  h.update(new Uint8Array(t.alive.buffer, 0, t.end));
  const one = new Float64Array(1), oneBytes = new Uint8Array(one.buffer);
  // in the schema's order; only live people (a released id's leftovers are not behaviour)
  for (const k of Object.keys(t.cols)) {
    const col = t.cols[k as keyof typeof t.cols] as unknown as ArrayLike<number>;
    // the values, not the bytes: a column widened with the same numbers in it keeps the hash
    for (let p = 0; p < t.end; p++) if (t.alive[p]) { one[0] = col[p]; h.update(oneBytes); }
  }
  return `${t.size} ${h.digest('hex')}`;
}

// recorded at b674f77 (the hash by values; the same people as the byte hash recorded at ebe4221): "people sha256"
const EXPECTED = '2400 f45cba49844ebe62db9d379eb7057344be86ebf47d894672c3a8475fe612424f';

test('the pedestrians of a fixed city, seed and number of steps are the same, bit for bit', () => {
  const got = run(20 * 30);
  assert.ok(Number(got.split(' ')[0]) > 50, `people: ${got}`);
  assert.equal(run(20 * 30), got, 'two runs differ: the pedestrians are not deterministic');
  assert.equal(got, EXPECTED);
});
