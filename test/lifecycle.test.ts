// The lifecycle state machine (src/app/lifecycle.ts): the transitions the flows rely on and the ones that are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../src/app/lifecycle.ts';

test('loading becomes ready once; operations start only from ready', () => {
  const l = new Lifecycle();
  assert.equal(l.begin('saving'), false, 'no save while loading');
  l.loaded();
  assert.equal(l.state, 'ready');
  assert.equal(l.begin('saving'), true);
  assert.equal(l.busy, true);
  assert.equal(l.begin('opening'), false, 'no opening over a save');
  assert.equal(l.begin('generating'), false, 'no new city over a save');
  l.end('saving');
  assert.equal(l.state, 'ready');
});

test('a failed rebuild leaves the world unsaveable and uneditable until another city is made or opened', () => {
  const l = new Lifecycle();
  l.loaded();
  l.begin('opening');
  l.end('opening', new Error('broken tile'));
  assert.equal(l.state, 'failed');
  assert.equal(l.editable, false);
  assert.equal(l.begin('saving'), false, 'the half-built world is never saved');
  assert.equal(l.begin('exporting'), false);
  assert.equal(l.begin('generating'), true, 'a new city may replace it');
  l.end('generating');
  assert.equal(l.state, 'ready');
});

test('a failed save or export returns to ready (the world is whole)', () => {
  const l = new Lifecycle();
  l.loaded();
  l.begin('saving'); l.end('saving', new Error('disk full'));
  assert.equal(l.state, 'ready');
  l.begin('exporting'); l.end('exporting', new Error('cancelled'));
  assert.equal(l.state, 'ready');
});

test('ending an operation that is not running is an error (a flow ended twice)', () => {
  const l = new Lifecycle();
  l.loaded();
  assert.throws(() => l.end('saving'));
});

test('unsaved follows the change counter: a change during the save keeps it unsaved', () => {
  const l = new Lifecycle();
  l.loaded();
  assert.equal(l.unsaved, false);
  l.changed();
  const at = l.serial;
  l.changed(); // an edit while the save writes
  l.saved(at);
  assert.equal(l.unsaved, true);
  l.saved(l.serial);
  assert.equal(l.unsaved, false);
  l.changed(); l.clean();
  assert.equal(l.unsaved, false);
});

test('the first city is made while loading and the game turns ready only once it settled', () => {
  const l = new Lifecycle();
  assert.equal(l.begin('generating'), true, 'the first city starts while loading');
  l.end('generating');
  assert.equal(l.state, 'loading', 'not ready before the game settled');
  assert.equal(l.begin('saving'), false);
  l.loaded();
  assert.equal(l.state, 'ready');
});

test('importing a file only writes the save slot: a failure returns to ready, and it may replace a failed city', () => {
  const l = new Lifecycle();
  l.loaded();
  l.begin('importing'); l.end('importing', new Error('damaged file'));
  assert.equal(l.state, 'ready', 'the world was not touched');
  l.begin('opening'); l.end('opening', new Error('broken'));
  assert.equal(l.begin('importing'), true, 'a file may replace the half-built city');
});

test('the world is editable when whole and not being rebuilt; a save does not stop editing', () => {
  const l = new Lifecycle();
  assert.equal(l.worldEditable, false, 'loading');
  l.loaded(); assert.equal(l.worldEditable, true);
  l.begin('saving'); assert.equal(l.worldEditable, true, 'the save copied the world at its start'); l.end('saving');
  l.begin('opening'); assert.equal(l.worldEditable, false, 'opening'); l.end('opening', new Error('x'));
  assert.equal(l.worldEditable, false, 'failed: the world is half built');
});

test('whenIdle resolves when the operation ends, or false after the wait', async () => {
  const l = new Lifecycle();
  l.loaded();
  assert.equal(await l.whenIdle(10), true, 'nothing running');
  l.begin('saving');
  const p = l.whenIdle(1000);
  setTimeout(() => l.end('saving'), 20);
  assert.equal(await p, true);
  l.begin('saving');
  assert.equal(await l.whenIdle(20), false, 'still saving after the wait');
  l.end('saving');
});
