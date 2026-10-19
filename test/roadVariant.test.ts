/// <reference types="node" />
// The road tool's options on the road in hand (Roadcraft 4.0 main.ts:1489-1512 lanes; world/roadSection.ts:246-259 width;
// editor/roadParking.ts:4-46 parking presets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, PROFILE_INFO, profileIssues } from '../src/roads/profiles.ts';
import { registerVariant, variantOf, withTotalWidth } from '../src/roads/roadVariant.ts';

const local = PROFILES[0];
const none = { lanes: null, width: null, parking: null } as const;
const lanes = (p: { strips: Array<{ kind: string; dir?: number }> }, dir: 1 | -1) => p.strips.filter((s) => s.kind === 'lane' && (s.dir ?? 1) === dir).length;

test('lanes: 2, 4 or 6 both ways together; "median" puts a median between the directions; every result can be built', () => {
  for (const n of [2, 4, 6] as const) {
    const v = variantOf(local, { ...none, lanes: n });
    assert.equal(lanes(v, 1), n / 2); assert.equal(lanes(v, -1), n / 2);
    assert.deepEqual(profileIssues(v), [], `${n} lanes: ${profileIssues(v)}`);
  }
  const m = variantOf(local, { ...none, lanes: 'median' });
  assert.ok(m.strips.some((s) => s.kind === 'median'));
  assert.deepEqual(profileIssues(m), []);
});

test('parking presets: both kerbs, one, cycle lanes, cycle and parking; never on a highway', () => {
  const kerbs = (p: { strips: typeof local.strips }) => [p.strips[2]?.kind, p.strips[p.strips.length - 3]?.kind];
  const both = variantOf(local, { ...none, parking: 'parallel' });
  assert.deepEqual(kerbs(both), ['parking', 'parking']);
  assert.deepEqual(profileIssues(both), []);
  const right = variantOf(local, { ...none, parking: 'parallelRight' });
  assert.equal(right.strips.filter((s) => s.kind === 'parking').length, 1);
  assert.equal(right.strips[2].kind, 'parking', 'the right-hand kerb is the profile\'s first side');
  const cycle = variantOf(local, { ...none, parking: 'cycleParking' });
  assert.ok(cycle.strips.some((s) => s.kind === 'bike') && cycle.strips.some((s) => s.kind === 'parking'));
  const highway = PROFILES.find((p) => (p.priority ?? 0) >= 5)!;
  assert.ok(!variantOf(highway, { ...none, parking: 'parallel' }).strips.some((s) => s.kind === 'parking'));
});

test('width: the lanes share it within 2.5..4.5 m, the sidewalks the rest', () => {
  const w = withTotalWidth(local, 16);
  const total = w.strips.reduce((s, x) => s + x.width, 0);
  assert.ok(Math.abs(total - 16) < 0.25, `total ${total}`);
  const narrow = withTotalWidth(local, 8);
  assert.ok(narrow.strips.filter((s) => s.kind === 'lane').every((s) => s.width >= 2.5));
  assert.ok(narrow.strips.filter((s) => s.kind === 'sidewalk').every((s) => s.width >= 1));
});

test('a variant is registered once, marked as made from the road (not a card of its own)', () => {
  const a = registerVariant(0, { ...none, lanes: 4 }), b = registerVariant(0, { ...none, lanes: 4 });
  assert.equal(a, b);
  assert.equal(PROFILES[a].variantOf, 0);
  assert.equal(PROFILE_INFO[a].lanesFwd, 2);
  assert.equal(registerVariant(0, none), 0, 'no option: the road itself');
});
