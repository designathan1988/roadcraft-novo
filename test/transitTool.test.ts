/// <reference types="node" />
// The transit tool keeps the stops drawn: every sync asks the renderer to bring the stops, stations and line paths up
// to date (it rebuilds only on a change). e84f206 moved the sync out of game.ts and lost this call: no stop was drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { TransitTool } from '../src/features/transit/transitTool.ts';
import { Transit } from '../src/world/transit.ts';

test('every sync of the transit tool asks the renderer to draw the stops', () => {
  const w = new World(), transit = new Transit();
  let drawn = 0;
  const tool = new TransitTool({
    transit: transit, roads: w.roads, heights: w.heights, dirty: w.dirty,
    view: { update: (transit, net, heights, version) => { drawn++; assert.equal(transit, transit); assert.equal(net, w.roads); assert.equal(heights, w.heights); assert.equal(version, transit.version); } },
    run: () => {}, toast: () => {}, lineMade: () => {}, sendLines: () => {}, showLines: () => {},
  });
  tool.sync(0, false, null);
  tool.sync(0, true, null);
  assert.equal(drawn, 2);
});
