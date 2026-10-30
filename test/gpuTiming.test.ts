// GPU time per render call (src/render/gpuTiming.ts): every call index up to the last is reported, a call without a
// timestamp in those frames as 0 ms (the probe failed on a hole that crossed the DevTools protocol as null).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuTiming } from '../src/render/gpuTiming.ts';

test('the per-call times have no holes', async () => {
  const timestamps = new Map([['r:0:1:f7', 2], ['r:3:1:f7', 4]]);
  const renderer = { resolveTimestampsAsync: async () => {}, backend: { timestampQueryPool: { render: { timestamps } } } };
  const t = new GpuTiming(renderer as never);
  t.frameEnd();
  await new Promise((r) => setTimeout(r, 0));
  const s = t.snapshot();
  assert.equal(s.frames, 1);
  assert.equal(s.totalMs, 6);
  assert.deepEqual(s.perCallMs, [2, 0, 0, 4]);
  assert.ok(Object.keys(s.perCallMs).length === 4, 'dense: every index present');
});
