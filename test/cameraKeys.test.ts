/// <reference types="node" />
// The camera keys move at Roadcraft 4.0's speeds (roadcraft src/view/cameraMotion.ts: TURN_PER_S 1.6, TILT_PER_S 0.9,
// ZOOM_PER_S 1.8, ease 0.1 s). A held key's travel from rest over T seconds is T - EASE (1 - e^(-T / EASE)).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { CameraRig } from '../src/render/cameraRig.ts';

const EASE = 0.1;
const travel = (t: number): number => t - EASE * (1 - Math.exp(-t / EASE));

function hold(rig: CameraRig, code: string, seconds: number): void {
  rig.keyDown(code);
  for (let i = 0; i < seconds * 10; i++) rig.update(0.1);
  rig.keyUp(code);
}

test('the camera tilts, zooms and turns at 4.0\'s key speeds', () => {
  const rig = new CameraRig(new World().heights);
  const pitch = rig.pitch;
  // half a second: the pitch stays clear of its limit (2 degrees) from the default 50
  hold(rig, 'PageDown', 0.5);
  assert.ok(Math.abs(pitch - rig.pitch - 0.9 * travel(0.5)) < 1e-9, `tilt: ${pitch - rig.pitch} rad in 0.5 s`);
  const rig2 = new CameraRig(new World().heights);
  const dist = rig2.dist;
  hold(rig2, 'Equal', 1);
  assert.ok(Math.abs(Math.log(dist / rig2.dist) - 1.8 * travel(1)) < 1e-9, `zoom: ${Math.log(dist / rig2.dist)} in 1 s`);
  const rig3 = new CameraRig(new World().heights);
  const yaw = rig3.yaw;
  hold(rig3, 'KeyQ', 1);
  assert.ok(Math.abs(rig3.yaw - yaw - 1.6 * travel(1)) < 1e-9, `turn: ${rig3.yaw - yaw} rad in 1 s`);
});
