// GPU time per pass (src/render/gpuTiming.ts): a pass is named by what it is, read when it begins, and keyed by the same uid
// the query pool files its timestamp under. The shadow cascades draw none, one or two passes each a frame, so the n-th
// render call of one frame is not the n-th of the next: summing by call index mixed passes (A19-005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuTiming } from '../src/render/gpuTiming.ts';

function renderer(timestamps: Map<string, number>) {
  const data = new Map<unknown, { timestampUID?: string }>();
  const backend = {
    timestampQueryPool: { render: { timestamps }, compute: { timestamps: new Map<string, number>() } },
    get: (o: unknown) => { let d = data.get(o); if (!d) { d = {}; data.set(o, d); } return d; },
    beginRender: (_c: unknown) => {},
    beginCompute: (_g: unknown) => {},
  };
  return { r: { resolveTimestampsAsync: async () => {}, backend }, backend };
}

test('passes are summed by name across frames, whatever their order', async () => {
  const stamps = new Map<string, number>();
  const { r, backend } = renderer(stamps);
  const t = new GpuTiming(r as never);
  // frame 7: a shadow cascade redrawn, then the view; frame 8: the view alone (the cascade kept): the view is call 1, then 0
  const ctx = (uid: string, name: string) => { const c = { width: 10, height: 10, scene: { name }, renderTarget: null, textures: [] }; backend.get(c).timestampUID = uid; return c; };
  backend.beginRender(ctx('r:0:5:f7', 'Shadow Map [ 1 ]'));
  backend.beginRender(ctx('r:1:9:f7', 'view'));
  backend.beginRender(ctx('r:0:9:f8', 'view'));
  stamps.set('r:0:5:f7', 3); stamps.set('r:1:9:f7', 5); stamps.set('r:0:9:f8', 7);
  t.frameEnd();
  await new Promise((res) => setTimeout(res, 0));
  const s = t.snapshot();
  assert.equal(s.frames, 2);
  assert.equal(s.totalMs, 7.5);
  assert.deepEqual(s.names, ['view > screen 10x10', 'Shadow Map [ 1 ] > screen 10x10']);
  assert.deepEqual(s.perCallMs, [6, 1.5]);
});
