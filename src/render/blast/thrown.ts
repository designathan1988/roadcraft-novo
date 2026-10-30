// What a blast does to the things in the street, as Roadcraft 4.0 throws them (render/playEffects.ts explode): a tree
// split (a charred stump left standing, the top thrown burning, splinters and clumps of its crown), a shrub torn up, a
// street light bent over with its head flung off, a hydrant broken into a jet of water, and benches, bins and the like
// in pieces; vehicles as their own burnt-out bodies, burning, and their wheels. Only pieces are added (render/blast/
// debris.ts); what was struck is removed from the world by the bomb's command.

import { Item } from '../../world/items.ts';
import { Puff } from '../particles.ts';
import type { Blast } from '../blast.ts';
import { Kind } from '../blast.ts';
import { Shape } from './debris.ts';

/** The horizontal push from the blast at (bx, bz) on what stands at (x, z) (4.0 `away`), into `out` [x, y, z]. */
export function away(bx: number, bz: number, radius: number, x: number, z: number, k: number, out: number[]): number[] {
  const dx = x - bx, dz = z - bz, d = Math.hypot(dx, dz) || 1;
  const f = k * Math.max(0.25, 1 - d / (radius * 1.6));
  out[0] = (dx / d) * f; out[1] = f * 0.6; out[2] = (dz / d) * f;
  return out;
}

const push: number[] = [0, 0, 0];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** An item of type `type` at (x, g, z) struck by the blast at (bx, bz) of `radius`: its pieces thrown. */
export function throwItem(blast: Blast, type: number, x: number, g: number, z: number, bx: number, bz: number, radius: number): void {
  const s = blast.spec, d = blast.debris;
  if (type === Item.Tree || type === Item.Conifer || type === Item.Palm) {
    away(bx, bz, radius, x, z, 6, push);
    const tall = rnd(6, 9), cut = tall * rnd(0.25, 0.5);
    const ax = push[2], az = -push[0], al = Math.hypot(ax, az) || 1;
    // split: the broken stump left standing, charred; the top thrown over, burning
    s.reset(); s.shape = Shape.Rod; s.color = 0x2b211a; s.x = x; s.y = g + cut / 2; s.z = z; s.sx = s.sz = 0.22; s.sy = cut;
    s.wx = s.wy = s.wz = 0; d.add(s);
    const spin = rnd(1.4, 2.4);
    s.reset(); s.shape = Shape.Rod; s.color = Kind.wood; s.x = x; s.y = g + cut + (tall - cut) / 2; s.z = z; s.sx = s.sz = 0.18; s.sy = tall - cut;
    s.vx = push[0] * 0.6; s.vy = push[1] * 0.6; s.vz = push[2] * 0.6; s.wx = (ax / al) * spin; s.wy = 0; s.wz = (az / al) * spin;
    s.burn = rnd(12, 22); d.add(s);
    // the splinters at the break
    for (let k = 0; k < 6; k++) {
      s.reset(); s.shape = Shape.Box; s.color = Kind.wood; s.x = x; s.y = g + cut; s.z = z; s.sx = 0.05; s.sy = rnd(0.3, 0.8); s.sz = 0.05;
      s.vx = push[0] + rnd(-2.5, 2.5); s.vy = push[1] + rnd(2, 6); s.vz = push[2] + rnd(-2.5, 2.5); d.add(s);
    }
    // the crown, in clumps of leaves and branches
    const leaf = type === Item.Conifer ? 0x2c4f2a : Kind.leaf;
    for (let k = 0; k < 24; k++) {
      s.reset(); s.shape = Shape.Box; s.color = leaf; s.x = x; s.y = g + tall * 0.85; s.z = z; s.sx = rnd(0.4, 1); s.sy = 0.1; s.sz = rnd(0.4, 1);
      s.vx = push[0] + rnd(-3.5, 3.5); s.vy = push[1] + rnd(1, 6); s.vz = push[2] + rnd(-3.5, 3.5); d.add(s);
    }
    blast.emitAt(x, g + tall * 0.7, z, Puff.Smoke, 4, 1.5);
  } else if (type === Item.Bush || type === Item.Planter) {
    away(bx, bz, radius, x, z, 6, push);
    const tall = 1.2, al = Math.hypot(push[0], push[2]) || 1;
    s.reset(); s.shape = Shape.Rod; s.color = Kind.wood; s.x = x; s.y = g + tall / 2; s.z = z; s.sx = s.sz = 0.14; s.sy = tall;
    s.vx = push[0] * 0.4; s.vy = push[1] * 0.4; s.vz = push[2] * 0.4; s.wx = (push[2] / al) * 1.2; s.wy = 0; s.wz = (-push[0] / al) * 1.2; d.add(s);
    for (let k = 0; k < 14; k++) {
      s.reset(); s.shape = Shape.Box; s.color = Kind.leaf; s.x = x; s.y = g + tall * 0.8; s.z = z; s.sx = 0.3; s.sy = 0.05; s.sz = 0.3;
      s.vx = push[0] + rnd(-3, 3); s.vy = push[1] + rnd(2, 7); s.vz = push[2] + rnd(-3, 3); d.add(s);
    }
  } else if (type === Item.Lamp) {
    // a street light: its column bent over and thrown, the head flung off, sparks
    away(bx, bz, radius, x, z, 6, push);
    const al = Math.hypot(push[0], push[2]) || 1;
    s.reset(); s.shape = Shape.Rod; s.color = 0x3a3e43; s.x = x; s.y = g + 3; s.z = z; s.sx = s.sz = 0.1; s.sy = 6;
    s.vx = push[0] * 0.5; s.vy = push[1] * 0.5; s.vz = push[2] * 0.5; s.wx = (push[2] / al) * 1.6; s.wy = 0; s.wz = (-push[0] / al) * 1.6; d.add(s);
    s.reset(); s.shape = Shape.Box; s.color = 0x2a2d31; s.x = x; s.y = g + 6; s.z = z; s.sx = 0.6; s.sy = 0.15; s.sz = 0.3;
    s.vx = push[0]; s.vy = push[1] + 4; s.vz = push[2]; d.add(s);
    blast.emitAt(x, g + 6, z, Puff.Sparks, 6, 0.8);
  } else if (type === Item.Hydrant) {
    // broken: a jet of water dying down (4.0 GEYSER_SECONDS 45), and its cap thrown
    away(bx, bz, radius, x, z, 6, push);
    s.reset(); s.shape = Shape.Rod; s.color = 0xb3221f; s.x = x; s.y = g + 0.4; s.z = z; s.sx = s.sz = 0.12; s.sy = 0.3;
    s.vx = push[0]; s.vy = push[1] + 5; s.vz = push[2]; d.add(s);
    blast.emitAt(x, g + 0.4, z, Puff.Fountain, 12, 45);
    blast.emitAt(x, g + 0.2, z, Puff.Spray, 8, 45);
  } else {
    // benches, bins, letter boxes, phones, signs, bollards: in pieces
    away(bx, bz, radius, x, z, 6, push);
    const wood = type === Item.Bench;
    for (let k = 0; k < 4; k++) {
      s.reset(); s.shape = Shape.Box; s.color = wood ? Kind.wood : Kind.metal; s.x = x; s.y = g + 0.5; s.z = z;
      s.sx = rnd(0.2, 0.7); s.sy = rnd(0.06, 0.26); s.sz = rnd(0.1, 0.4);
      s.vx = push[0] + rnd(-2, 2); s.vy = push[1] + rnd(2, 7); s.vz = push[2] + rnd(-2, 2); d.add(s);
    }
  }
}

/** Whether a blast throws an item of this type (things standing in the street; not lines, ground cover nor effects). */
export function struckItem(type: number): boolean {
  return (type <= Item.Sign && type !== Item.Drain) || type === Item.Conifer || type === Item.Palm;
}

/**
 * A vehicle at (x, y, z) facing `yaw`, model `model` (Vehicles.wreckModels), `paint` 0xRRGGBB, struck by the blast at
 * (bx, bz): its own body burnt out, thrown and burning (a motorbike flies farther and burns less), and two wheels.
 */
export function throwVehicle(blast: Blast, model: number, x: number, y: number, z: number, yaw: number, paint: number, bx: number, bz: number, radius: number): void {
  const s = blast.spec, d = blast.debris, size = blast.wreckSize(model);
  const light = model === 5;
  away(bx, bz, radius, x, z, 9, push);
  push[1] += 3;
  const k = light ? 1.6 : 1, sp = light ? 2 : 1;
  s.reset().turn(0, 1, 0, yaw);
  s.shape = Shape.Shell + 1 + model; s.color = paint;
  s.x = x; s.y = y + size[1] / 2 + 0.05; s.z = z;
  s.sx = size[0]; s.sy = size[1]; s.sz = size[2];
  s.vx = push[0] * k; s.vy = push[1] * k; s.vz = push[2] * k;
  s.wx = rnd(-1.5, 1.5) * sp; s.wy = rnd(-1, 1) * sp; s.wz = rnd(-1.5, 1.5) * sp;
  s.burn = light ? rnd(8, 14) : rnd(30, 50);
  d.add(s);
  blast.emitAt(x, y + 1, z, Puff.Fire, light ? 4 : 8, 1);
  if (light) return;
  for (let w = 0; w < 2; w++) {
    s.reset().turn(1, 0, 0, Math.PI / 2);
    s.shape = Shape.Rod; s.color = 0x141414; s.x = x; s.y = y + 0.35; s.z = z; s.sx = s.sz = 0.32; s.sy = 0.22;
    const f = rnd(0.6, 1.6);
    s.vx = push[0] * f + rnd(-4, 4); s.vy = push[1] * f + rnd(2, 6); s.vz = push[2] * f + rnd(-4, 4);
    d.add(s);
  }
}
