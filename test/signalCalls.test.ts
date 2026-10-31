/// <reference types="node" />
// A light far from the camera runs its timed cycle and never clears its pedestrian calls (only an actuated stage
// turning green does): when the camera comes and it starts running actuated, the old calls start over instead of
// reading as minutes-old waits (D55 stale far calls; 4.0 rebuilds the crossings' demand from the walkers each tick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCity, traffic, inner } from './simCity.ts';

test('a light that starts running actuated forgets the calls made while it ran timed', () => {
  const { sim } = gridCity(4, 120, 1, () => 3);
  const tr = traffic(sim, 1e5, 1e5);
  const lights = [...inner(tr).signalNodes as Set<number>];
  assert.ok(lights.length > 0);
  const n = lights[0];
  const sig = inner(tr.sig);
  assert.equal(sig.on[n], 0, 'far from the camera: timed');
  tr.pedCall(n, 0);
  assert.ok(sig.call[n * 8] >= 0, 'the call is kept');
  for (let i = 0; i < 20 * 60; i++) tr.step(0.05);
  assert.ok(sig.call[n * 8] >= 0, 'a minute later it is still there (a timed light never answers it)');
  // the camera comes
  const nc = sim.net.nodes.cols;
  tr.camX = nc.x[n]; tr.camZ = nc.z[n];
  tr.checkWindow();
  assert.equal(sig.on[n], 1, 'near the camera: actuated');
  assert.equal(sig.call[n * 8], -1, 'the old call starts over');
});
