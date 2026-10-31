/// <reference types="node" />
// D45: a car's search reads each node's kept successors (routing.ts sN...) instead of working out every movement at
// each expansion. The routes must be the very same: every pair of a city, with and without load on the streets, before
// and after the network changes (a junction's control, a segment removed and a new one, a profile), equals the search
// that works each movement out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCity, recordOps, mirror, traffic, syncNet, inner } from './simCity.ts';
import { Router } from '../src/sim/routing.ts';
import { changeProfile, demolishSeg } from '../src/roads/build.ts';
import { asNode, asSeg } from '../src/core/ids.ts';
import { Ctl } from '../src/roads/control.ts';

function routes(tr: ReturnType<typeof traffic>, nodes: number[], kept: boolean): string {
  const r = tr.router, out = new Int32Array(256), parts: string[] = [];
  r.kept = kept;
  for (const a of nodes) for (const b of nodes) {
    if (a === b) continue;
    const n = r.route(a, b, out, 0, 256);
    parts.push(`${a}>${b}:${Array.from(out.subarray(0, n)).join(',')}`);
  }
  r.kept = true;
  return parts.join(';');
}

test('the kept successors give the same car routes as working each movement out', () => {
  const { w, sim } = gridCity(5, 120, 2);
  const ops = recordOps(w);
  const tr = traffic(sim);
  const alive = (): number[] => [...Array(sim.net.nodes.end).keys()].filter((n) => sim.net.nodes.alive[n] && sim.net.nodes.cols.deg[n] > 0);
  const same = (label: string): void => {
    const nodes = alive();
    const kept = routes(tr, nodes, true), worked = routes(tr, nodes, false);
    assert.ok(kept.length > 1000, `${label}: routes found`);
    assert.equal(kept, worked, label);
  };
  same('a fresh city');
  // traffic on the streets: the load changes the costs
  tr.density = 1 / 30;
  for (let i = 0; i < 400; i++) tr.step(0.05);
  same('with load');
  // the network changes: a signal, a profile, a segment gone (and the junctions laid out again)
  const n = alive().find((k) => sim.net.nodes.cols.deg[k] === 4)!;
  w.roads.setJunction(asNode(n), { ctl: Ctl.AllStop });
  const s = sim.net.adj[n * 8];
  changeProfile(w, asSeg(s), 3);
  const other = sim.net.adj[n * 8 + 1];
  demolishSeg(w, asSeg(other));
  mirror(sim, ops.splice(0));
  syncNet(sim, tr);
  same('after edits');
  // what the router keeps, read by its own validity rule, equals a fresh router's lists, node by node
  const kept = inner(tr.router), fresh = inner(new Router(sim));
  kept.ensureSuccessors(); fresh.ensureSuccessors();
  const sc = sim.net.segs.cols;
  for (const node of alive()) {
    if (kept.builtGen[node] !== sim.nodeGen[node] || kept.builtNet[node] !== sim.netGen) kept.buildNode(node);
    fresh.buildNode(node);
    for (let i = 0; i < sim.net.nodes.cols.deg[node]; i++) {
      const sIn = sim.net.adj[node * 8 + i], e = sIn * 2 + (sc.b[sIn] === node ? 0 : 1), at = e * 8, cnt = fresh.sN[e];
      assert.equal(kept.sN[e], cnt, `node ${node} edge ${e}: successors`);
      for (let k = 0; k < cnt; k++) {
        assert.equal(kept.sE[at + k], fresh.sE[at + k]);
        assert.equal(kept.sT[at + k], fresh.sT[at + k], `node ${node} edge ${e}: free-flow time`);
        assert.equal(kept.sC[at + k], fresh.sC[at + k], `node ${node} edge ${e}: junction cost`);
        assert.equal(kept.sCap[at + k], fresh.sCap[at + k]);
      }
    }
  }
});
