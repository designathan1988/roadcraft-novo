/// <reference types="node" />
// The ecology worker answers every tile it is asked, failures included (D34: a tile that threw, or one asked before
// init, got no answer and the page's queue stayed busy for good).
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('D34: a tile asked before init is answered as -1 - tile (a tile that throws answers the same: the catch beside it)', async () => {
  const sent: unknown[] = [];
  const g = globalThis as Record<string, unknown>;
  g.self = { onmessage: null, postMessage: (m: unknown) => sent.push(m) };
  await import('../src/render/ecologyWorker.ts');
  const scope = g.self as { onmessage: (e: { data: unknown }) => void };
  scope.onmessage({ data: 5 });
  assert.deepEqual(sent, [-6]);
  delete g.self;
});
