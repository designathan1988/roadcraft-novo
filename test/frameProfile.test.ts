// The frame's own timing (src/app/frameProfile.ts): durations per system add up between marks; still frames count as
// frames, not as drawn ones; the simulation's messages are counted where they arrive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameProfile, FRAME_PARTS, PART } from '../src/app/frameProfile.ts';

test('each system gets the time since the previous mark; a reset starts again', () => {
  const p = new FrameProfile();
  p.begin(100); p.lap(PART.camera, 103); p.lap(PART.tools, 104); p.drew(); p.lap(PART.layersDirty, 110); p.lap(PART.draw, 120);
  p.begin(200); p.lap(PART.camera, 201); p.lap(PART.tools, 202);          // a still frame: it stops before the layers
  p.simMessage(); p.simMessage();
  const s = p.snapshot();
  assert.equal(s.frames, 2);
  assert.equal(s.drawn, 1);
  assert.equal(s.simIn, 2);
  assert.equal(s.camera, 4);
  assert.equal(s.tools, 2);
  assert.equal(s.layersDirty, 6);
  assert.equal(s.draw, 10);
  assert.deepEqual(Object.keys(s).sort(), ['drawn', 'frames', 'simIn', ...FRAME_PARTS].sort());
  p.reset();
  assert.equal(p.snapshot().frames, 0);
  assert.equal(p.snapshot().camera, 0);
  assert.equal(p.snapshot().simIn, 0);
});
