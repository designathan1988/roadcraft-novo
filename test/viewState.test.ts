/// <reference types="node" />
// What the player chose to see has one owner (app/viewState.ts); the overlay uniforms are derived from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewState } from '../src/app/viewState.ts';
import { gridU } from '../src/render/groundOverlays.ts';
import { trafficOverlayU, zoneOverlayU } from '../src/render/roads.ts';

test('the layers drive their overlays; the zone tool shows the zone colours only while in hand', () => {
  const v = new ViewState();
  v.set('grid', true);
  v.set('traffic', true);
  assert.deepEqual({ ...v.layers }, { grid: true, zones: false, traffic: true });
  assert.equal(gridU.value, 1);
  assert.equal(trafficOverlayU.value, 1);
  assert.equal(zoneOverlayU.value, 0);
  v.zoneToolInHand(true);
  assert.equal(zoneOverlayU.value, 1);
  v.zoneToolInHand(false);
  assert.equal(zoneOverlayU.value, 0, 'another tool: the colours go with the zone tool');
  v.set('zones', true);
  v.zoneToolInHand(false);
  assert.equal(zoneOverlayU.value, 1, 'the layer keeps them whatever the tool');
  v.set('grid', false);
  assert.equal(gridU.value, 0);
});
