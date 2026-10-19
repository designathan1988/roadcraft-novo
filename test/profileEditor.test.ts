/// <reference types="node" />
// The profile editor's model (Roadcraft 4.0 ui/roads/profileEditor.ts): the strips as drawn, left to right, without the
// kerbs (put back between a raised strip and the carriageway); where the palette puts a new strip (:82-126); a width
// in whole metres, every lane together (:128-137); a strip moved (:139-146); each problem with the strips it is about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_COUNT, PROFILES, profileIssueSpots, profileKey } from '../src/roads/profiles.ts';
import { fromWork, insertionIndex, movedStrip, toWork, withStripWidth } from '../src/roads/profileWork.ts';

test('every built-in road goes into the editor and back unchanged (the kerbs come back where they were)', () => {
  for (let i = 0; i < BUILTIN_COUNT; i++) {
    const p = PROFILES[i];
    if (p.ring) continue;
    const back = fromWork(p, toWork(p));
    assert.equal(profileKey(back), profileKey(p), p.name);
  }
});

test('the editor works left to right as drawn, with no kerb strips', () => {
  const local = PROFILES[0];
  const w = toWork(local);
  assert.ok(!w.some((s) => s.kind === 'curb'));
  assert.equal(w[0].kind, 'sidewalk');
  // seen from A towards B the lanes going to B are on the right
  const lanes = w.filter((s) => s.kind === 'lane');
  assert.equal(lanes[0].dir, -1); assert.equal(lanes[lanes.length - 1].dir, 1);
});

test('the palette puts each strip where the road can carry it', () => {
  const w = toWork(PROFILES[0]); // sidewalk, lane ←, lane →, sidewalk
  assert.equal(insertionIndex(w, 'laneBackward', 1), 2, 'after the last lane towards A');
  assert.equal(insertionIndex(w, 'laneForward', 1), 3, 'after the last lane towards B');
  assert.equal(insertionIndex(w, 'median', 1), 2, 'between the two directions');
  assert.equal(insertionIndex(w, 'parking', 0), 1, 'by the left kerb when a left strip is picked');
  assert.equal(insertionIndex(w, 'parking', 3), 3, 'by the right kerb otherwise');
});

test('widths in whole metres, every lane together; a strip moved', () => {
  const w = toWork(PROFILES[0]);
  const wider = withStripWidth(w, 1, 4);
  assert.ok(wider.filter((s) => s.kind === 'lane').every((s) => s.width === 4));
  assert.equal(wider[0].width, w[0].width);
  const m = movedStrip(w, 0, 3);
  assert.equal(m[3].kind, 'sidewalk'); assert.equal(m[0].kind, 'lane');
});

test('each problem names the strips it is about', () => {
  const p = { name: 'x', speed: 40, oneWay: false, priority: 1, strips: [
    { kind: 'sidewalk' as const, width: 3 }, { kind: 'curb' as const, width: 0.2 }, { kind: 'lane' as const, width: 3.2, dir: 1 as const },
    { kind: 'parking' as const, width: 2.3 }, { kind: 'lane' as const, width: 3.2, dir: -1 as const }, { kind: 'curb' as const, width: 0.2 }, { kind: 'sidewalk' as const, width: 3 }] };
  const spots = profileIssueSpots(p);
  const parking = spots.find((s) => s.problem === 'parkingSide');
  assert.ok(parking, JSON.stringify(spots));
  assert.deepEqual(parking!.strips, [3]);
});
