/// <reference types="node" />
// The map's extra (platform/mapExtra.ts): what is written is read back, and one bad field falls back alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeExtra, encodeExtra, type MapExtra } from '../src/platform/mapExtra.ts';
import { asSeg } from '../src/core/ids.ts';

const full: MapExtra = {
  weather: { rain: 0.5, wind: 8, dir: 90, lightning: 0.2, thunder: 1 }, water: { waves: 0.6, foam: 0.1, current: 0.9 },
  clouds: [{ x: 1, z: 2, y: 300, size: 400, density: 0.7 }], fog: 0.4, terminals: [3, 4], signs: [['a', 'Rua A']],
  streets: [[asSeg(7), 'Avenida B']], clock: 1234, paint: 'us', unlimited: true,
};

test('the extra written is the extra read', () => {
  assert.deepEqual(decodeExtra(encodeExtra(full)), full);
});

test('one malformed field falls back alone; the others are kept', () => {
  const raw = JSON.parse(encodeExtra(full)) as Record<string, unknown>;
  raw.weather = { rain: 'heavy' };
  raw.clouds = [{ x: 1 }, full.clouds[0]];
  const got = decodeExtra(JSON.stringify(raw));
  assert.equal(got.weather, null);
  assert.deepEqual(got.clouds, full.clouds);
  assert.deepEqual(got.signs, full.signs);
  assert.equal(got.clock, 1234);
});

test('an old save without the extra opens with the defaults', () => {
  const got = decodeExtra(undefined);
  assert.equal(got.fog, 1); assert.equal(got.weather, null); assert.equal(got.unlimited, null);
  assert.deepEqual(decodeExtra('not json'), got);
});

test('the sky mode of an older save is not read: it is the player choice, not map data (Roadcraft 4.0)', () => {
  const got = decodeExtra(JSON.stringify({ sky: 'noite', fog: 0.5 })) as unknown as Record<string, unknown>;
  assert.equal('sky' in got, false);
  assert.equal(got.fog, 0.5);
});
