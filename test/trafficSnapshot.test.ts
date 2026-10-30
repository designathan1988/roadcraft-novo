/// <reference types="node" />
// The traffic's behaviour, pinned: the same network, the same seed and the same steps give the same vehicle table,
// bit for bit. A refactor of the traffic code (who writes which column, P9) must leave this hash unchanged; a change
// of behaviour shows here at once, in seconds. The hash covers every column of every live vehicle and the counters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { World } from '../src/world/world.ts';
import { planRoad, buildRoad, snap } from '../src/roads/build.ts';
import { SimNet, encodeOps, decodeOp } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import type { NetOp } from '../src/roads/network.ts';

/** A 4 × 4 grid of streets with one avenue each way (the traffic test's city). */
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

/** `window`: the micro window's radius (a small one leaves most vehicles meso); `buses`: a bus line through the grid. */
function run(steps: number, window?: number, buses = false): string {
  const sim = gridCity();
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 1 / 40;
  if (window !== undefined) tr.window = window;
  // three stops on the sidewalks of different streets (the bus test's line)
  if (buses) tr.setLines([{ id: 1, color: 3, buses: 3, stops: [-120, -189, 189, 0, 0, 189] }]);
  tr.camX = 0; tr.camZ = 0;
  tr.checkWindow();
  for (let step = 0; step < steps; step++) {
    tr.step(0.05);
    if (step % 10 === 0) tr.checkWindow();
  }
  const h = createHash('sha256'), t = tr.veh;
  h.update(new Uint8Array(t.alive.buffer, 0, t.end));
  // in the schema's order, not by name: renaming a column (with its meaning unchanged) leaves the hash as it was
  for (const k of Object.keys(t.cols)) {
    const col = t.cols[k as keyof typeof t.cols] as unknown as ArrayLike<number> & { buffer: ArrayBuffer; BYTES_PER_ELEMENT: number };
    // only live vehicles: a released id's leftovers are not behaviour
    const one = col.BYTES_PER_ELEMENT, bytes = new Uint8Array(col.buffer);
    for (let v = 0; v < t.end; v++) if (t.alive[v]) h.update(bytes.subarray(v * one, (v + 1) * one));
  }
  h.update(JSON.stringify([tr.microN, t.size, t.end]));
  const busesNow = buses ? tr.lineStats(1)[0].buses : 0;
  return `${t.size} ${tr.microN} ${busesNow} ${h.digest('hex')}`;
}

// recorded at d540d98 (traffic code as at 71825f5), before the vehicle table's owner (P9.2): "vehicles micro buses sha256"
const EXPECTED_MICRO = '114 113 0 b829699ce623f7ffdd499e8592dddd99abdab67900f7d940ddb09ab0cc7bf868';
const EXPECTED_MIXED = '114 65 3 1095aa6510e25ef8e196a18ab04f16875f98ce9b2c1e8ea35c23a07f7eed3fb8';

test('the traffic of a fixed city, seed and number of steps is the same, bit for bit (all micro)', () => {
  // 60 s of simulated time at 20 Hz on the grid city
  const got = run(20 * 60);
  // a city with traffic in it (an empty table would prove nothing), and the run repeats itself
  const [vehicles, micro] = got.split(' ').map(Number);
  assert.ok(vehicles > 50 && micro > 20, `vehicles ${vehicles}, micro ${micro}`);
  assert.equal(run(20 * 60), got, 'two runs differ: the traffic is not deterministic');
  assert.equal(got, EXPECTED_MICRO);
});

test('the same with a bus line and many vehicles meso (a small micro window)', () => {
  // 120 s: the buses dwell and turn round, vehicles cross the window's edge both ways
  const got = run(20 * 120, 70, true);
  const [vehicles, micro, busesNow] = got.split(' ').map(Number);
  assert.ok(vehicles > 50 && micro > 10 && vehicles - micro > 10 && busesNow === 3, `vehicles ${vehicles}, micro ${micro}, buses ${busesNow}`);
  assert.equal(run(20 * 120, 70, true), got, 'two runs differ: the traffic is not deterministic');
  assert.equal(got, EXPECTED_MIXED);
});
