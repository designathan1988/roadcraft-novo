/// <reference types="node" />
// The section editor's checks (Roadcraft 4.0 world/roads/profile.ts profileIssues), on the engine's strips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_COUNT, PROFILES, profileIssues, type Profile, type Strip } from '../src/roads/profiles.ts';

const sw = (w = 3): Strip => ({ kind: 'sidewalk', width: w });
const curb: Strip = { kind: 'curb', width: 0.2 };
const lane = (dir: 1 | -1, w = 3.2): Strip => ({ kind: 'lane', width: w, dir });
const park: Strip = { kind: 'parking', width: 2.3 };
const def = (strips: Strip[], extra: Partial<Profile> = {}): Omit<Profile, 'id'> => ({ name: 'x', speed: 40, oneWay: false, priority: 1, strips, ...extra });

test('every built-in road passes the section checks', () => {
  for (let i = 0; i < BUILTIN_COUNT; i++) assert.deepEqual(profileIssues(PROFILES[i]), [], `${PROFILES[i].name}`);
});

test('the section checks catch what Roadcraft refuses', () => {
  const has = (d: Omit<Profile, 'id'>, issue: string) => assert.ok(profileIssues(d).includes(issue as never), `${issue} not found in ${JSON.stringify(profileIssues(d))}`);
  has(def([sw(), curb, lane(1), lane(1), lane(-1), curb, sw()]), 'laneBalance');
  has(def([sw(), curb, lane(1), park, lane(-1), curb, sw()]), 'parkingSide');
  has(def([sw(), curb, lane(1, 7), lane(-1, 7), curb, sw()]), 'width');
  has(def([sw(0.5), curb, lane(1), lane(-1), curb, sw(0.5)]), 'width');
  has(def([sw(), curb, lane(1), lane(1), { kind: 'median', width: 2 }, curb, sw()], { oneWay: true }), 'median');
  has(def([{ kind: 'shoulder', width: 2 }, park, lane(1, 3.6), lane(-1, 3.6), { kind: 'shoulder', width: 2 }], { priority: 5 }), 'class');
  has(def([sw(), curb, curb, sw()]), 'noLanes');
  assert.deepEqual(profileIssues(def([sw(), curb, park, lane(1), lane(-1), park, curb, sw()])), [], 'a street with parking on both kerbs is fine');
});
