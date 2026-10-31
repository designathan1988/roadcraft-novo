/// <reference types="node" />
// D55: the signals buffer (what the page draws of each light) is written for the lights near the camera every step and
// for the timed ones only when their cycle changes sub-phase. Pinned here: after every step the buffer holds, for every
// light, the state the old code wrote every step (through traffic, a camera that moves the window, and a light
// removed); and with nothing near the camera the lights' state is read only at their changes, not every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCity, traffic, inner } from './simCity.ts';
import { Ctl } from '../src/roads/control.ts';
import { asNode } from '../src/core/ids.ts';

test('D55: after every step the buffer holds every light\'s state, through traffic, window moves and a light removed', () => {
  const { sim } = gridCity(4, 120, 1, () => 3); // avenues everywhere: a light at each of the 12 crossings
  const tr = traffic(sim);
  tr.signals = new Uint8Array(1 << 17);
  tr.density = 1 / 40;
  const lights = (): number[] => [...inner(tr).signalNodes as Set<number>];
  assert.ok(lights().length >= 2, 'the grid has lights');
  const check = (label: string): void => {
    for (const n of lights()) assert.equal(tr.signals![n], tr.lightState(n), `${label}: light ${n}`);
  };
  for (let i = 0; i < 1200; i++) {
    // the camera crosses the city: lights enter and leave the window
    if (i % 100 === 0) { tr.camX = -300 + (i / 1200) * 600; tr.camZ = 0; tr.checkWindow(); }
    tr.step(0.05);
    check(`step ${i}`);
  }
  // a light removed by the player: its byte goes to 0 at the next step
  const n = lights()[0];
  sim.apply({ t: 'junction', id: asNode(n), spec: { ctl: Ctl.Priority } });
  tr.nodesRebuilt(sim.rebuild());
  tr.step(0.05);
  assert.equal(sim.nodePhases[n], 0);
  assert.equal(tr.signals![n], 0, 'no light, nothing drawn');
  for (let i = 0; i < 200; i++) { tr.step(0.05); check(`after the removal, step ${i}`); }
});

test('D55: with nothing near the camera, a light\'s state is read at its changes, not every step', () => {
  const { sim } = gridCity(4, 120, 1, () => 3); // avenues everywhere: a light at each of the 12 crossings
  const tr = traffic(sim, 1e5, 1e5);
  tr.signals = new Uint8Array(1 << 17);
  tr.density = 0;
  const lights = (inner(tr).signalNodes as Set<number>).size;
  assert.ok(lights >= 2);
  for (let i = 0; i < 20; i++) tr.step(0.05);
  const sig = tr.sig, real = sig.state.bind(sig);
  let reads = 0;
  sig.state = (n: number) => { reads++; return real(n); };
  const steps = 200;
  try {
    for (let i = 0; i < steps; i++) tr.step(0.05);
  } finally {
    sig.state = real;
  }
  // 10 s: each light changes sub-phase a few times (green, amber, all-red last a second or more); every step would be
  // `steps` reads per light
  assert.ok(reads <= lights * 12, `light states read in ${steps} steps: ${reads} for ${lights} lights`);
});
