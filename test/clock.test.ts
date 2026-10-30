// The game clock's controls (src/app/clock.ts): pause and speed, and the held hour of a photo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../src/app/clock.ts';

test('pausing keeps the chosen speed; resuming runs at it', () => {
  const c = new Clock();
  c.setSpeed(4);
  assert.equal(c.running, 4);
  c.togglePause();
  assert.equal(c.paused, true);
  assert.equal(c.running, 0);
  assert.equal(c.speed, 4, 'the speed survives the pause');
  c.togglePause();
  assert.equal(c.running, 4);
  c.setSpeed(0);
  assert.equal(c.paused, true);
  assert.equal(c.speed, 4, 'speed 0 pauses, the chosen speed stays');
});

test('the time of day follows the speed unless the hour is held', () => {
  const c = new Clock();
  c.setSpeed(2);
  assert.equal(c.daySpeed, 2);
  c.holdHour();
  c.setSpeed(4);
  assert.equal(c.daySpeed, 0, 'a held hour stays held');
  assert.equal(c.running, 4, 'the simulation still runs');
});

test('every change is heard (the simulation worker is told its speed)', () => {
  const c = new Clock();
  const heard: number[] = [];
  c.onChange(() => heard.push(c.running));
  c.setSpeed(2); c.togglePause(); c.togglePause();
  assert.deepEqual(heard, [2, 0, 2]);
});
