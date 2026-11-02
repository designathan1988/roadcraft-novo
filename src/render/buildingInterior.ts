// What a window shows of the room behind it: the camera ray through a room the size of the window (interior mapping), a
// shop's shelves, blinds and curtains, by day and at night. It runs only where a pixel shows a window: in the facade's shader
// it ran for every pixel of every wall. It is called inside a branch, so it reads no derivative and no implicit-level texture
// (WGSL's uniformity), and its inputs are variables made before the branch: a node first built inside a branch is declared
// there and is gone for whoever reads it after.

import { T, type Node } from './tsl.ts';

const { abs, vec3, float, mix, clamp, fract, smoothstep, floor, mod, select, hash, min, step, max, dot } = T;

export interface WindowView {
  V: Node; n: Node; tng: Node; colW: Node; span: Node; roomH: Node; inShop: Node;
  fx: Node; fy: Node; ly: Node; rnd: Node; rnd2: Node; sty: Node; seed: Node; cu: Node; fl: Node; ww: Node;
  night: Node; slatW: Node;
}

export function windowInterior(w: WindowView): Node {
  const { V, n, tng, colW, span, roomH, inShop, fx, fy, ly, rnd, rnd2, sty, seed, cu, fl, ww, night, slatW } = w;
  const depth = select(inShop.greaterThan(0.5), float(8), float(4.5));
  const d = vec3(dot(V, tng).div(colW.mul(span)), V.y.div(roomH), max(dot(V, n.negate()), 0.02).div(depth));
  const sx = select(d.x.greaterThanEqual(0), max(d.x, 1e-4), min(d.x, -1e-4));
  const sy = select(d.y.greaterThanEqual(0), max(d.y, 1e-4), min(d.y, -1e-4));
  const ix = step(float(0), sx).sub(fx).div(sx);
  const iy = step(float(0), sy).sub(fy).div(sy);
  const iz = float(1).div(d.z);
  const tmin = min(min(ix, iy), iz);
  const hz = clamp(d.z.mul(tmin), 0, 1);
  const wallTone = mix(vec3(0.62, 0.55, 0.46), vec3(0.5, 0.56, 0.6), rnd);
  const backC = wallTone;
  const sideC = wallTone.mul(0.78);
  const floorC = mix(vec3(0.24, 0.17, 0.11), vec3(0.32, 0.3, 0.28), rnd2);
  const ceilC = vec3(0.86, 0.85, 0.82);
  const hitY = select(sy.lessThan(0), floorC, ceilC);
  let room: Node = select(iz.lessThanEqual(min(ix, iy)), backC, select(ix.lessThan(iy), sideC, hitY));
  room = room.mul(float(1).sub(hz.mul(0.45)));
  // a dark piece of furniture/partition at the back of some rooms
  room = room.mul(mix(float(1), float(0.55), step(float(0.7), rnd2).mul(step(iz, min(ix, iy)))));
  // a shop's room: walls lined with shelves of goods, a counter at the back, a light tiled floor (the 4.0 furnishes
  // its shops; here the same read in the interior mapping)
  const hx = fx.add(sx.mul(tmin)), hy = fy.add(sy.mul(tmin)), onBack = step(iz, min(ix, iy));
  const along = select(onBack.greaterThan(0.5), hx, hz);
  const shelfRow = fract(hy.mul(5));
  const shelfZone = step(float(0.2), hy).mul(step(hy, float(0.78)));
  const goodsCell = hash(floor(along.mul(16)).add(floor(hy.mul(5)).mul(37)).add(seed.mul(11)));
  const goodsC = mix(mix(vec3(0.75, 0.25, 0.18), vec3(0.2, 0.42, 0.7), step(float(0.33), goodsCell)), mix(vec3(0.85, 0.72, 0.3), vec3(0.3, 0.6, 0.35), step(float(0.8), goodsCell)), step(float(0.6), goodsCell));
  const goods = shelfZone.mul(step(float(0.12), shelfRow)).mul(step(shelfRow, float(0.62))).mul(step(float(0.25), goodsCell));
  const shelfC = mix(vec3(0.8, 0.77, 0.7), vec3(0.42, 0.3, 0.2), step(float(0.5), hash(seed.add(41))));
  let shopWall: Node = mix(mix(vec3(0.86, 0.83, 0.77), shelfC, shelfZone.mul(step(shelfRow, float(0.1)))), goodsC, goods);
  shopWall = mix(shopWall, shelfC.mul(0.7), onBack.mul(step(hy, float(0.22))).mul(step(abs(hx.sub(0.5)), float(0.35))));
  const tile = mod(floor(hx.mul(6)).add(floor(hz.mul(10))), 2);
  const shopFloor = mix(vec3(0.72, 0.7, 0.66), vec3(0.6, 0.58, 0.55), tile);
  const shopRoom = select(iy.lessThan(min(ix, iz)), select(sy.lessThan(0), shopFloor, vec3(0.9, 0.9, 0.88)), shopWall.mul(select(onBack.greaterThan(0.5), float(1), float(0.85))));
  room = select(inShop.greaterThan(0.5), shopRoom.mul(float(1).sub(hz.mul(0.25))), room);

  // night: some rooms lit (fewer later); shops and signs always
  const lit = step(rnd, mix(float(0.15), float(0.62), sty)).max(inShop);
  const lamp = mix(vec3(1.0, 0.84, 0.58), vec3(0.85, 0.92, 1.0), step(float(0.75), rnd2));
  const dayInside = room.mul(select(inShop.greaterThan(0.5), float(0.26), float(0.11)));
  const nightInside = room.mul(lamp).mul(lit).mul(select(inShop.greaterThan(0.5), float(1.7), float(1.5)));
  // a blind (slats, down to some height) or curtains (panels at the sides) in some windows
  const r3 = hash(cu.mul(17).add(fl.add(64).mul(733)).add(seed.mul(53)).add(91));
  const lx = clamp(fx.sub(ww).div(float(1).sub(ww.mul(2)).max(0.05)), 0, 1);
  const blindDown = hash(r3.mul(97.1)).mul(0.75).add(0.15);
  // blind slats: near only (18 per window turn to noise when the window has few pixels)
  const slatFade = clamp(float(1).sub(slatW.mul(1.5)), 0, 1);
  const slats = smoothstep(float(0.35), float(0.5), fract(ly.mul(18))).mul(0.25).mul(slatFade).add(float(1).sub(slatFade.mul(0.25)));
  const blinds = step(r3, float(0.32)).mul(step(float(1).sub(blindDown), ly));
  const curtW = hash(r3.mul(53.7)).mul(0.22).add(0.12);
  const curtains = step(float(0.32), r3).mul(step(r3, float(0.5))).mul(step(lx, curtW).max(step(float(1).sub(curtW), lx)));
  // curtains in neutral tones (cream, light grey); only the odd one coloured
  const curtC = mix(mix(vec3(0.72, 0.66, 0.56), vec3(0.64, 0.64, 0.62), step(float(0.55), hash(r3.mul(11.3)))), vec3(0.5, 0.3, 0.24), step(float(0.88), hash(r3.mul(5.9))));
  const blindC = mix(vec3(0.78, 0.76, 0.7), vec3(0.6, 0.62, 0.64), hash(r3.mul(3.3)));
  const cover = blinds.max(curtains).mul(float(1).sub(inShop));
  const coverC = select(blinds.greaterThan(0.5), blindC.mul(slats), curtC);
  // fabric by day: lit by the light coming in; at night, lit from behind if the room is lit
  return mix(mix(dayInside, coverC.mul(0.32), cover), mix(nightInside, coverC.mul(lamp).mul(lit).mul(0.9), cover), night);
}
