/// <reference types="node" />
// Small cities for the simulation tests: built with the game's road tools, mirrored into the simulation through the
// same encoded ops the worker receives.
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { planRoad, buildRoad, snap } from '../src/roads/build.ts';
import { SimNet, encodeOps, decodeOp } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import type { NetOp } from '../src/roads/network.ts';

export interface SimCity { w: World; sim: SimNet; ops: NetOp[] }

/** n × n grid of roads `step` metres apart, centred on the origin; the second row and column are avenues (profile 3). */
/** `profile`: the profile of street i (horizontal or not), instead of an avenue at `avenue` and local streets. */
export function gridCity(n = 4, step = 120, avenue = 1, profile?: (i: number, horiz: boolean) => number): SimCity {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  const half = (n - 1) * step / 2;
  for (let i = 0; i < n; i++) {
    for (const horiz of [true, false]) {
      const c = -half + i * step;
      const a = horiz ? snap(w.roads, -half, c, 8) : snap(w.roads, c, -half, 8);
      const b = horiz ? snap(w.roads, half, c, 8) : snap(w.roads, c, half, 8);
      const prof = profile ? profile(i, horiz) : i === avenue ? 3 : 0;
      const p = planRoad(w, a, null, b, prof, 0);
      assert.ok(p.ok, p.reason);
      buildRoad(w, p, a, b, prof);
    }
  }
  const sim = new SimNet();
  mirror(sim, ops);
  sim.rebuild();
  // a freshly opened map: nothing was on the segments the building replaced
  sim.removedSegs.length = 0; sim.reprofiledSegs.length = 0;
  return { w, sim, ops: [] };
}

/** Applies ops to the simulation's network through the worker's encoding. */
export function mirror(sim: SimNet, ops: NetOp[]): void {
  const extra: string[] = [];
  const enc = encodeOps(ops, extra);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i, extra));
}

/** Records the world's network changes from now on (to mirror them later). */
export function recordOps(w: World): NetOp[] {
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  return ops;
}

/** Traffic wired the way the worker wires it, every signal known, camera at (x, z). */
export function traffic(sim: SimNet, x = 0, z = 0): Traffic {
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.camX = x; tr.camZ = z;
  tr.checkWindow();
  return tr;
}

/** What the worker does when the network changed between steps. */
export function syncNet(sim: SimNet, tr: Traffic): void {
  tr.segsRemoved(sim.removedSegs.splice(0));
  tr.segsReprofiled(sim.reprofiledSegs.splice(0));
  tr.nodesRebuilt(sim.rebuild());
}

/** Private members, for tests that set up a precise situation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inner = (x: unknown): any => x;
