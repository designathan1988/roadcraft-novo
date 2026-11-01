import test from 'node:test';
import assert from 'node:assert/strict';
import { grassHeightRange } from '../src/render/grassCulling.ts';
import { heightAt, heightIndex } from '../src/world/heights.ts';
import { HEIGHT_MAP_RES, HEIGHT_SPACING, MAP_HALF } from '../src/config.ts';

/** A flat field at 10 m, big enough for the real height layout (one sample per tile layer). */
function flat(): Float32Array {
  return new Float32Array(HEIGHT_MAP_RES * HEIGHT_MAP_RES).fill(10);
}
const sample = (world: number) => Math.round((world + MAP_HALF) / HEIGHT_SPACING);

test('the grass cull range reads every height sample of the field, so no crest falls between samples', () => {
  const h = flat();
  // a crest exactly on a height sample inside the field, at an offset the old distance-stepped loop skipped
  h[heightIndex(sample(4), sample(4))] = 50;
  const [lo, hi] = grassHeightRange(h, 0.5, 0.5, 72);
  assert.ok(lo <= 10, 'the flat ground is the lower bound');
  assert.ok(hi >= 50, `the crest is inside the range (hi ${hi}); a loop that starts at the field edge misses it`);
});

test('the grass cull range is a conservative bound of the field', () => {
  const h = flat();
  h[heightIndex(sample(-20), sample(30))] = 80;
  h[heightIndex(sample(40), sample(-10))] = -5;
  const [lo, hi] = grassHeightRange(h, 0, 0, 72);
  assert.ok(lo <= -5, `low crest covered (lo ${lo})`);
  assert.ok(hi >= 80, `high crest covered (hi ${hi})`);
  // every point of the square, not only the samples, lies inside the range (bilinear support is included)
  for (let x = -72; x <= 72; x += 7) {
    for (let z = -72; z <= 72; z += 7) {
      const v = heightAt(h, x, z);
      assert.ok(v >= lo && v <= hi, `height ${v} at (${x}, ${z}) inside [${lo}, ${hi}]`);
    }
  }
});
