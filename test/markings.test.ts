/// <reference types="node" />
// Road paint rules of Roadcraft 4.0 (markingStyle.ts, markings.ts, parkingLayout.ts) as the shader will read them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busWordStations, legendStrokes, markingStyle, miniIsland, parkingBays, wordStrokes, PARKING } from '../src/roads/markings.ts';

test('regional styles: PARE and ÔNIBUS in Brazil with dashes by speed, STOP and BUS elsewhere', () => {
  const br = markingStyle('br');
  assert.equal(br.stopText, 'PARE'); assert.equal(br.busText, 'ÔNIBUS');
  assert.deepEqual(br.dash(40), [3, 6]); assert.deepEqual(br.dash(70), [3, 9]); assert.deepEqual(br.dash(100), [4, 12]);
  assert.equal(br.legendHeight(50), 1.6); assert.equal(br.legendHeight(100), 2.4);
  assert.equal(markingStyle('us').stopText, 'STOP');
  assert.equal(markingStyle('eu').centre, 0xeee8d7);
});

test('a word is stroked letter by letter, every letter drawn', () => {
  for (const word of ['PARE', 'ÔNIBUS', 'STOP', 'BUS']) {
    const w = wordStrokes(word);
    assert.ok(w.strokes.length >= word.length, `${word}: ${w.strokes.length} strokes`);
    assert.ok(Math.abs(w.width - (word.length * 1.35 - 0.35)) < 1e-9);
  }
});

test('a stop legend fits its lane and sits behind the stop line; a short approach gets none', () => {
  const br = markingStyle('br');
  const l = legendStrokes(br, 'stop', 3.2, 50, 20)!;
  assert.ok(l);
  for (const [u0, v0, u1, v1] of l.pieces) {
    assert.ok(Math.abs(u0) <= 3.2 * 0.39 + 1e-9 && Math.abs(u1) <= 3.2 * 0.39 + 1e-9, `a stroke at u ${u0}, ${u1}`);
    assert.ok(v0 >= 1.5 - 1e-9 && v1 <= 1.5 + 1.6 + 1e-9 && v1 >= 1.5 - 1e-9, `a stroke at v ${v0}, ${v1}`);
  }
  assert.equal(legendStrokes(br, 'stop', 3.2, 50, 4), null);
});

test('bus words, the mini-roundabout island and parking bays', () => {
  assert.deepEqual(busWordStations(200), [12, 82, 152]);
  assert.equal(miniIsland(4).r, 2); assert.equal(miniIsland(20).r, 4);
  const bays = parkingBays(5, 40);
  assert.equal(bays.length, 6); // 5 bays of 6 m in 35 m, centred
  assert.ok(Math.abs(bays[1] - bays[0] - PARKING.pitch) < 1e-9);
  assert.ok(Math.abs((bays[0] - 5) - (40 - bays[bays.length - 1])) < 1e-9, 'centred');
});
