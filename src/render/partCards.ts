// The 4.0 building parts' thin kinds (a window frame, a balcony railing, a roof railing) as Roadcraft 4.0 draws them
// (render/buildings/thinParts.ts, kit.ts cards): from afar one card a face whose bars the pixel shader draws, each at
// least a pixel wide; near and far, a bar's colour mixed with the tone behind it by the bar's true share of the pixel.
//
// Without cards a frame's six bars were 56 triangles of slivers a pixel wide or less: in the street view (RenderDoc 1.46
// replay, RTX 3060, 2026-10-31) the frames' draw read 1.31 M vertices for 0.09 of a screen of pixels and the props' material
// was 15 % of the frame's GPU time, vertex-bound. 4.0 measured the same: "167 thousand frames 6 M vertices a frame of
// micro-triangles ... 4.8 ms of a 19 ms frame at 1080p".
//
// The parts' vertices carry it in `pext` (zero on every other part): x the bar's width (m in the unit model), y the tone
// behind, z the card's pattern (CARD; 0 on the full models). The patterns' bars are the unit models' (r40 kit.ts).

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { T, type Node } from './tsl.ts';
import { FRAME_BAR } from '../r40/api.ts';

const { attribute, positionWorld, float, vec3, abs, fract, max, step, select, clamp, length, mix, fwidth } = T;

/** The cards' patterns: a window frame, a roof railing, a balcony railing's front and its sides (4.0 thinParts.ts CARD). */
export const CARD = { frame: 1, roofRailing: 2, railingFront: 3, railingSide: 4 } as const;

/** The thin kinds: the bar a pixel is weighed against (m) and the tone behind it (4.0 prefilterThinParts), the far level's
 *  error (4.0 kit.ts: the card leaves out the frame's depth, the railing's bars' and rails' thickness). */
export const THIN_PARTS: Readonly<Record<string, { bar: number; behind: number; cardError: readonly [number, number, number] }>> = {
  frame: { bar: 0.05, behind: 0.08, cardError: [0, 0, 1] },
  railing: { bar: 0.02, behind: 0.16, cardError: [0.05, 0, 0.05] },
  roofRailing: { bar: 0.02, behind: 0.16, cardError: [0.02, 0, 0.05] },
};

/** A flat quad facing z (or x), centred at (x, y, z), its back face too where `twoSided` (a railing is seen from both). */
function quad(x: number, y: number, z: number, axis: 'z' | 'x' | '-x' = 'z'): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  if (axis === 'x') g.rotateY(Math.PI / 2);
  if (axis === '-x') g.rotateY(-Math.PI / 2);
  return g.translate(x, y, z);
}
function twoSided(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const back = g.clone();
  const idx = back.index!.array as Uint16Array;
  for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  const n = back.getAttribute('normal');
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const out = mergeGeometries([g, back])!;
  g.dispose(); back.dispose();
  return out;
}

/** The thin kinds' cards in their unit models' axes (4.0 kit.ts frameCardGeometry, railingCardGeometry, roofRailing). */
export function partCardGeometries(): Readonly<Record<string, THREE.BufferGeometry>> {
  const railing = mergeGeometries([quad(0, 0.5, 1), quad(-0.5, 0.5, 0.5, '-x'), quad(0.5, 0.5, 0.5, 'x')])!;
  return { frame: quad(0, 0, 0.5), railing: twoSided(railing), roofRailing: twoSided(quad(0, 0.5, 0)) };
}

/** Marks a posed part's vertices as its thin kind's (`pext`): its bar and tone, and on a card its pattern by face. */
export function markThin(g: THREE.BufferGeometry, kind: string, card: boolean): THREE.BufferGeometry {
  const t = THIN_PARTS[kind];
  if (!t) return g;
  const ext = g.getAttribute('pext') as THREE.BufferAttribute, normal = g.getAttribute('normal');
  for (let i = 0; i < ext.count; i++) {
    const pattern = !card ? 0 : kind === 'frame' ? CARD.frame : kind === 'roofRailing' ? CARD.roofRailing
      : Math.abs(normal.getX(i)) > 0.5 ? CARD.railingSide : CARD.railingFront;
    ext.setXYZW(i, t.bar, t.behind, pattern, 0);
  }
  return g;
}

/** A bar centred at `c`, `w` wide, at least a pixel (`fw`, the coordinate a pixel spans). */
const bar = (x: Node, c: number, w: number, fw: Node) => step(abs(x.sub(c)), max(float(w), fw).mul(0.5));
/** Bars every `pitch`, `w` wide, at least a pixel. */
const every = (x: Node, pitch: number, w: number, fw: Node) => step(abs(fract(x.div(pitch).add(0.5)).sub(0.5)).mul(pitch), max(float(w), fw).mul(0.5));

/**
 * Whether the fragment is drawn: everywhere but on a card off its bars (4.0 thinParts.ts cardOn: the unit model's point,
 * -0.5..0.5 across and 0..1 up for the railings). Every pattern is worked out and the right one picked, no branch: the
 * pixel's span (fwidth) needs the whole quad.
 */
export function partCardOn(): Node {
  const ext = attribute('pext', 'vec4'), p = attribute('position', 'vec3');
  const kind = ext.z;
  const qx = select(kind.greaterThan(3.5), p.z, p.x), qy = p.y;
  const fx = fwidth(qx), fy = fwidth(qy);
  const t = FRAME_BAR;
  const frame = max(max(max(bar(qx, -0.5 + t / 2, t, fx), bar(qx, 0.5 - t / 2, t, fx)), max(bar(qy, -0.5 + t / 2, t, fy), bar(qy, 0.5 - t / 2, t, fy))),
    max(bar(qx, 0, t * 0.8, fx), bar(qy, 0.18, t * 0.8, fy)));
  const roof = max(max(bar(qy, 0.97, 0.06, fy), bar(qy, 0.45, 0.04, fy)), every(qx.add(0.5), 0.25, 0.02, fx).mul(step(qy, float(1))));
  const front = max(max(bar(qy, 0.97, 0.06, fy), bar(qy, 0.12, 0.04, fy)), every(qx.add(0.5), 0.1, 0.015, fx));
  const side = max(max(bar(qy, 0.97, 0.06, fy), bar(qy, 0.12, 0.04, fy)), every(qx, 0.25, 0.015, fx));
  const on = select(kind.lessThan(1.5), frame, select(kind.lessThan(2.5), roof, select(kind.lessThan(3.5), front, side)));
  return kind.lessThan(0.5).or(on.greaterThan(0.5));
}

/** A thin part's colour mixed with the tone behind it by its bar's share of the pixel (4.0 thinTone; other props as they are). */
export function partThinTone(colour: Node): Node {
  const ext = attribute('pext', 'vec4');
  const metresPerPixel = max(length(fwidth(positionWorld)).mul(0.7071), float(1e-4));
  const toned = mix(vec3(ext.y, ext.y, ext.y), colour, clamp(ext.x.div(metresPerPixel), 0, 1));
  return select(ext.x.greaterThan(0), toned, colour);
}
