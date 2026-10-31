/// <reference types="node" />
// The camera refuses a damaged state (a short or non-numeric camera from a damaged save) and stays where it is (D54:
// restore used to take it and the distance and pitch became NaN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { CameraRig } from '../src/render/cameraRig.ts';

test('D54: a short or non-numeric camera state is refused and the camera stays as it was', () => {
  const rig = new CameraRig(new World().heights);
  const before = Array.from(rig.state());
  assert.equal(rig.restore(new Float64Array([0, 0, 0])), false);
  assert.equal(rig.restore(new Float64Array([0, 0, NaN, 0.5, 300, 0])), false);
  assert.deepEqual(Array.from(rig.state()), before);
  assert.ok(Number.isFinite(rig.dist) && Number.isFinite(rig.pitch));
  assert.equal(rig.restore(new Float64Array([100, 200, 0.3, 0.6, 400, 0])), true);
  assert.equal(rig.dist, 400);
});
