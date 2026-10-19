/// <reference types="node" />
// Regression tests for the simulation defects (section C of DEFEITOS-roadcraft-novo.md), one test per defect id.
// Each one failed on the code before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SimNet } from '../src/sim/lanes.ts';
import { ROUTE_CAP, type Traffic } from '../src/sim/traffic.ts';
import { gridCity, inner, traffic } from './simCity.ts';

/** A connection whose two lanes are both long enough to hold a queue. */
function someConn(sim: SimNet): number {
  const k = sim.conns.cols;
  for (let c = 0; c < sim.conns.end; c++) {
    if (!sim.conns.alive[c] || k.turn[c] !== 1) continue;
    if (sim.laneLen(k.from[c]) > 40 && sim.laneLen(k.to[c]) > 40 && sim.net.nodes.cols.deg[k.node[c]] >= 3) return c;
  }
  throw new Error('no straight connection between long lanes');
}

/** A vehicle placed on `lane` at `s`, driving to the end node of `next` through the connection's node. */
function place(tr: Traffic, lane: number, s: number, next: number, micro: boolean): number {
  const T = inner(tr), sim = tr.sim, c = tr.veh.cols;
  const v = tr.veh.alloc();
  T.initVehicle(v);
  c.kind[v] = 0; c.len[v] = 4.4;
  const o = v * ROUTE_CAP;
  tr.routes[o] = sim.laneFrom(lane); tr.routes[o + 1] = sim.laneTo(lane); tr.routes[o + 2] = sim.laneTo(next);
  c.rLen[v] = 3; c.rIdx[v] = 1; c.dest[v] = sim.laneTo(next);
  c.lane[v] = lane; c.conn[v] = -1; c.s[v] = s;
  T.setLaneCount(lane, 1);
  if (micro) { T.addMicro(v); T.insert(v, false, lane); } else T.schedule(v, tr.time);
  return v;
}

test('C8: a far vehicle that finds no room at the start of the next lane is not counted as having passed the node', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  tr.window = 1e6; // every lane in the micro window: the meso vehicle would become micro on the next lane
  const k = sim.conns.cols, conn = someConn(sim);
  const from = k.from[conn], to = k.to[conn], node = k.node[conn];
  // a stopped micro car right at the start of the next lane: no room to enter it
  const blocker = place(tr, to, 1, to, true);
  tr.veh.cols.v[blocker] = 0;
  // a meso car at the end of its lane, due to move on now
  const v = place(tr, from, tr.sim.laneLen(from), to, false);
  const passed = tr.nodePass[node], arm = k.arm[conn], flow = tr.advisor.pass[node * 8 + arm];
  inner(tr).mesoAdvance(v);
  assert.equal(tr.veh.cols.lane[v], from, 'the car is still on its lane');
  assert.equal(tr.nodePass[node], passed, `node pass count went from ${passed} to ${tr.nodePass[node]} with nobody through`);
  assert.equal(tr.advisor.pass[node * 8 + arm], flow, 'the automatic control saw a vehicle that did not pass');
});

/** Segment between two nodes (−1 if none). */
function segBetween(sim: SimNet, a: number, b: number): number {
  const sc = sim.net.segs.cols;
  for (const s of sim.net.segsOf(a, [])) if ((sc.a[s] === a && sc.b[s] === b) || (sc.b[s] === a && sc.a[s] === b)) return s;
  return -1;
}

/** First movement along `path` (arriving at path[0] by `inSeg`) that no connection makes, as "node from→to", or null. */
function illegalTurn(sim: SimNet, inSeg: number, path: Int32Array, len: number): string | null {
  const k = sim.conns.cols;
  let sIn = inSeg;
  for (let i = 0; i + 1 < len; i++) {
    const n = path[i], sOut = segBetween(sim, n, path[i + 1]);
    if (sIn >= 0) {
      let ok = false;
      for (let c = sim.nodeConn[n]; c >= 0 && !ok; c = k.nextAtNode[c]) ok = (k.from[c] >> 4) === sIn && (k.to[c] >> 4) === sOut;
      if (!ok) return `node ${n}: ${sIn}→${sOut}`;
    }
    sIn = sOut;
  }
  return null;
}

test('C12: routes never use a banned turn or a movement the hand-made lane connectors removed', async () => {
  const { mirror, recordOps } = await import('./simCity.ts');
  const { Router } = await import('../src/sim/routing.ts');
  const { w, sim } = gridCity(4, 120);
  const ops = recordOps(w);
  const nc = sim.net.nodes.cols, sc = sim.net.segs.cols;
  // an inner four-way junction, the arm it is entered by and the arm straight ahead
  let n = -1;
  for (let i = 0; i < sim.net.nodes.end && n < 0; i++) if (sim.net.nodes.alive[i] && nc.deg[i] === 4 && Math.abs(nc.x[i]) < 100 && Math.abs(nc.z[i]) < 100) n = i;
  assert.ok(n >= 0, 'an inner junction');
  const segs = sim.net.segsOf(n, []);
  const dir = (s: number) => { const o = sc.a[s] === n ? sc.b[s] : sc.a[s]; return [nc.x[o] - nc.x[n], nc.z[o] - nc.z[n]]; };
  const A = segs[0], [ax, az] = dir(A);
  const B = segs.find((s) => { const [bx, bz] = dir(s); return bx * ax + bz * az < -0.5 * Math.hypot(ax, az) * Math.hypot(bx, bz); })!;
  const far = sc.a[B] === n ? sc.b[B] : sc.a[B];
  const router = new Router(sim);
  const path = new Int32Array(64);
  // straight on is the obvious route
  let len = router.route(n, far, path, 0, 64, false, A);
  assert.deepEqual([...path.subarray(0, len)], [n, far], 'straight on before the ban');
  // the player bans that movement
  w.roads.setJunction(n, { ctl: 0, bans: [A, B] });
  mirror(sim, ops.splice(0)); sim.rebuild();
  len = router.route(n, far, path, 0, 64, false, A);
  assert.ok(len >= 2 && path[len - 1] === far, 'still reachable another way');
  assert.equal(illegalTurn(sim, A, path, len), null, `route ${[...path.subarray(0, len)]}`);
  // hand-made connectors: the lanes of A at n may only turn into one other arm
  const C = segs.find((s) => s !== A && s !== B)!;
  w.roads.setJunction(n, { ctl: 0, lanes: [[A, 0, [C]], [A, 1, [C]]] });
  mirror(sim, ops.splice(0)); sim.rebuild();
  len = router.route(n, far, path, 0, 64, false, A);
  assert.ok(len >= 2 && path[len - 1] === far, 'still reachable another way');
  assert.equal(illegalTurn(sim, A, path, len), null, `route ${[...path.subarray(0, len)]}`);
});
