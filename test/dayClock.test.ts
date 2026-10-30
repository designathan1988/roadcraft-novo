// One clock (plan P8; Roadcraft 4.0 sim/city/city.ts:9-32): the time of day is the city clock plus a shift. Setting the
// hour moves only the shift; the clock (building decay) runs on; loading a save's clock or starting another city keeps
// the time of day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';

test('a city starts at 06:30 and the hour runs with the city clock', () => {
  const w = new World();
  assert.equal(w.hour, 6.5);
  w.advanceClock(90);
  assert.equal(w.hour, 8);
  w.advanceClock(24 * 60);
  assert.equal(w.hour, 8, 'a whole day later, the same hour');
});

test('setting the hour does not move the city clock; a saved clock or another city keeps the hour', () => {
  const w = new World();
  w.advanceClock(500);
  w.setHour(22);
  assert.equal(w.clock, 500);
  assert.equal(w.hour, 22);
  w.advanceClock(180);
  assert.equal(w.hour, 1, 'past midnight it wraps');
  w.setClock(12345);
  assert.equal(w.hour, 1);
  w.clearBuildings();
  assert.equal(w.clock, 0);
  assert.equal(w.hour, 1);
});
