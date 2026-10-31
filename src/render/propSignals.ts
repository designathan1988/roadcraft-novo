// Which lamp of a traffic signal prop is lit (render/props.ts reads it in its vertex stage): the simulation's state of
// the node's arms from the signal texture (128 | amber << 6 | arms with green), or outside the simulation's window a
// decorative cycle by the clock.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';
import { PMAT } from './propMeshes.ts';

const { uint, int, float, ivec2, textureLoad, time, hash, select, fract, floor, step, abs, mix } = T;

/** 1 where this vertex's lamp (its material: red, yellow, green) is lit for the instance's node and arm (its key). */
export function signalLampLit(keyRaw: Node, sigTex: THREE.Texture, mat: Node): Node {
  const key = keyRaw.shiftRight(uint(5));
  const node = int(key.shiftRight(uint(3)));
  const arm = float(key.bitAnd(uint(7)));
  const st = textureLoad(sigTex, ivec2(node.mod(int(512)), node.div(int(512)))).r.mul(255).add(0.5).floor();
  // outside the simulation's window: a decorative cycle by the clock
  const fakeT = time.add(hash(node.toUint()).mul(60));
  const fakePhase = float(fakeT.div(16).floor().mod(2));
  const fakeState = select(fract(fakeT.div(16)).greaterThan(0.85), float(1), float(0));
  // from the simulation: 128 | amber << 6 | arms with green
  const known = step(float(127.5), st);
  const mask = st.mod(64);
  const armOn = floor(mask.div(T.pow(float(2), arm))).mod(2);
  const state = mix(fakeState, step(float(0.5), floor(st.div(64)).mod(2)), known);
  const armMatch = mix(step(abs(fract(arm.div(2)).mul(2).sub(fakePhase)), float(0.1)), armOn, known);
  const isRed = step(abs(mat.sub(PMAT.Red)), float(0.5));
  const isYel = step(abs(mat.sub(PMAT.Yellow)), float(0.5));
  const isGrn = step(abs(mat.sub(PMAT.Green)), float(0.5));
  const greenOn = armMatch.mul(step(state, float(0.5)));
  const yellowOn = armMatch.mul(step(abs(state.sub(1)), float(0.5)));
  const redOn = float(1).sub(greenOn).sub(yellowOn);
  return isRed.mul(redOn).add(isYel.mul(yellowOn)).add(isGrn.mul(greenOn));
}
