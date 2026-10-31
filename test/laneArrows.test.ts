/// <reference types="node" />
// The painted arrows of hand-adjusted lane connections (features/roads/laneArrows.ts, moved out of game.ts unchanged):
// a junction's adjusted lanes write arrowCode at its segment ends on the next update; a removed segment's ends and a
// cleared network are zeroed at once; nothing else is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture } from 'three/webgpu';
import { gridCity } from './simCity.ts';
import { LaneArrows } from '../src/features/roads/laneArrows.ts';
import { arrowCode, laneExits } from '../src/roads/laneLinks.ts';
import { asNode } from '../src/core/ids.ts';

test('adjusted lanes paint their arrows at the next update; a removed segment and a cleared network clear them', () => {
  const { w } = gridCity(3, 120);
  const data = new Float32Array(w.roads.segs.capacity * 2);
  const tex = new DataTexture(data, data.length, 1);
  const arrows = new LaneArrows(w.roads, tex);
  w.roads.listeners.push((op) => arrows.note(op));
  let n = -1;
  for (let i = 0; i < w.roads.nodes.end; i++) if (w.roads.nodes.alive[i] && w.roads.nodes.cols.deg[i] === 4) { n = i; break; }
  const node = asNode(n), from = w.roads.segsOf(node, [])[0];
  const only = laneExits(w.roads, node, from)[0].exits[0][0];
  const k = from * 2 + (w.roads.segs.cols.a[from] === node ? 0 : 1);
  w.roads.setJunction(node, { ctl: 0, lanes: [[from, 0, [only]]] });
  assert.equal(data[k], 0, 'nothing before the update');
  const v0 = tex.version;
  arrows.update();
  assert.equal(data[k], arrowCode(w.roads, node, from));
  assert.ok(data[k] > 0);
  assert.ok(tex.version > v0, 'the texture goes up again');
  const v1 = tex.version;
  arrows.update();
  assert.equal(tex.version, v1, 'no change, no upload');
  w.roads.removeSeg(from);
  assert.equal(data[from * 2] + data[from * 2 + 1], 0, 'the removed segment\'s ends are cleared at once');
  data[5] = 3;
  w.roads.clear();
  assert.ok(data.every((x) => x === 0), 'a cleared network clears every arrow');
});
