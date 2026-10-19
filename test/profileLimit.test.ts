/// <reference types="node" />
// D44: a map holds up to MAX_PROFILES road profiles, and a profile id past 255 survives the segment table, the road
// graph sent to the workers, the lots and the road mesh's tag (profile and the two end rules, read by the shader).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadNetwork } from '../src/roads/network.ts';
import { buildRoadMesh } from '../src/jobs/roadMesh.ts';
import { MAX_PROFILES, PROFILES, registerProfile, packRoadTag, unpackRoadTag } from '../src/roads/profiles.ts';

/** A profile no other has: a local street whose sidewalks are `w` metres wide. */
function custom(w: number): number {
  const base = PROFILES[0];
  return registerProfile({ ...base, name: `Teste ${w}`, custom: true, category: 'meus',
    strips: base.strips.map((s) => (s.kind === 'sidewalk' ? { ...s, width: w } : s)) });
}

test('D44: more than 256 profiles can be registered', () => {
  assert.ok(MAX_PROFILES >= 512, `MAX_PROFILES ${MAX_PROFILES}`);
  let last = -1;
  for (let k = 0; PROFILES.length <= 300; k++) { last = custom(1 + k * 0.01); assert.ok(last >= 0, `profile ${PROFILES.length} refused`); }
  assert.ok(last >= 300, `last id ${last}`);
});

test('D44: the road tag carries a profile past 255 and both end rules, inside an int16', () => {
  for (const [p, ra, rb] of [[0, 0, 0], [300, 3, 5], [MAX_PROFILES - 1, 7, 7]]) {
    const tag = packRoadTag(p, ra, rb);
    assert.ok(tag >= 0 && tag <= 32767, `tag ${tag}`);
    assert.deepEqual(unpackRoadTag(tag), [p, ra, rb]);
  }
});

test('D44: a segment with profile 300 keeps it in the network, the graph and its mesh', () => {
  while (PROFILES.length <= 301) custom(5 + PROFILES.length * 0.01);
  const w = new World();
  w.heights.fill(9.9);
  const net = new RoadNetwork(w);
  const a = net.addNode({ x: -30, z: 0, y: 10 }), b = net.addNode({ x: 30, z: 0, y: 10 });
  const s = net.addSeg({ a, b, cx: 0, cz: 0, profile: 300, flags: 0 });
  assert.equal(net.segs.cols.profile[s], 300);
  const g = net.gather([s], [a, b]);
  assert.equal(g.sprofile[0], 300);
  const m = buildRoadMesh(w.heights, g, -64, -64, 128, 0)!;
  const tags = new Set<number>();
  for (let i = 0; i < m.vertexCount; i++) tags.add(unpackRoadTag(m.position[i * 4 + 3])[0]);
  assert.ok(tags.has(300), `profiles in the mesh tags: ${[...tags]}`);
});
