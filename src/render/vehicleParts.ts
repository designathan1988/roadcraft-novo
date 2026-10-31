// The parts the vehicle models are built from (render/carBody.ts, render/heavyBody.ts), once at load: a PartList takes
// each part's triangles straight into flat arrays (position, normal, linear colour) and frees the part, so a model is
// one geometry per material without a geometry and a colour buffer kept per part and merged at the end. x forward,
// y up, z right; metres.

import { BoxGeometry, BufferGeometry, Color, ExtrudeGeometry, Float32BufferAttribute, Quaternion, Shape, Vector2, Vector3 } from 'three/webgpu';

/** A point of a side profile or a plan: (x, y) or (x, z). */
export type P2 = readonly [number, number];

/** The paint's own colour: vertex colours multiply the paint, white leaves it as it is. */
export const PAINT = 0xffffff;

const colour = new Color();

/** Triangles of one material, as they are added. */
export class PartList {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];

  /**
   * Adds `g`'s triangles in `hex` (sRGB), or in its own vertex colours when `hex` is left out and it has them (white
   * otherwise), then disposes of it.
   */
  add(g: BufferGeometry, hex?: number): this {
    const tri = g.index ? g.toNonIndexed() : g;
    if (!tri.getAttribute('normal')) tri.computeVertexNormals();
    const p = tri.getAttribute('position'), n = tri.getAttribute('normal');
    const own = hex === undefined ? tri.getAttribute('color') : undefined;
    if (!own) colour.setHex(hex ?? PAINT);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      if (own) this.col.push(own.getX(i), own.getY(i), own.getZ(i));
      else this.col.push(colour.r, colour.g, colour.b);
    }
    if (tri !== g) tri.dispose();
    g.dispose();
    return this;
  }

  /**
   * Adds triangles given flat: `pos` 9 numbers each, `nor` their normals (flat per face when null), all in `hex`
   * (sRGB) or in `rgb` (linear, 9 numbers each) when given.
   */
  triangles(pos: ArrayLike<number>, nor: ArrayLike<number> | null, hex: number, rgb?: ArrayLike<number>): this {
    colour.setHex(hex);
    for (let k = 0; k < pos.length; k += 9) {
      for (let i = 0; i < 9; i++) this.pos.push(pos[k + i]);
      if (nor) for (let i = 0; i < 9; i++) this.nor.push(nor[k + i]);
      else {
        const ux = pos[k + 3] - pos[k], uy = pos[k + 4] - pos[k + 1], uz = pos[k + 5] - pos[k + 2];
        const vx = pos[k + 6] - pos[k], vy = pos[k + 7] - pos[k + 1], vz = pos[k + 8] - pos[k + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (let i = 0; i < 3; i++) this.nor.push(nx, ny, nz);
      }
      if (rgb) for (let i = 0; i < 9; i++) this.col.push(rgb[k + i]);
      else for (let i = 0; i < 3; i++) this.col.push(colour.r, colour.g, colour.b);
    }
    return this;
  }

  /** The positions added so far, flat (9 a triangle). */
  positions(): readonly number[] { return this.pos; }

  /** The parts as one non-indexed geometry (empty when none was added). */
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    return g;
  }
}

/** A box `sx × sy × sz` centred on (x, y, z). */
export function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(sx, sy, sz).translate(x, y, z);
}

const UP = new Vector3(0, 1, 0), along = new Vector3(), turn = new Quaternion();

/** A bar from `a` to `b`, `thick` across and `thickB` deep. */
export function bar(a: Vector3, b: Vector3, thick: number, thickB = thick): BufferGeometry {
  along.subVectors(b, a);
  const g = new BoxGeometry(thick, along.length(), thickB);
  g.applyQuaternion(turn.setFromUnitVectors(UP, along.normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/** A slab `lx × lz` in plan with corners rounded by `radius`, `height` tall, its bottom at y, centred on (x, z). */
export function slab(lx: number, lz: number, radius: number, height: number, x: number, y: number, z: number, curve = 3): BufferGeometry {
  const hx = lx / 2, hz = lz / 2, r = Math.min(radius, hx - 1e-4, hz - 1e-4);
  const s = new Shape().moveTo(-hx + r, -hz)
    .lineTo(hx - r, -hz).quadraticCurveTo(hx, -hz, hx, -hz + r)
    .lineTo(hx, hz - r).quadraticCurveTo(hx, hz, hx - r, hz)
    .lineTo(-hx + r, hz).quadraticCurveTo(-hx, hz, -hx, hz - r)
    .lineTo(-hx, -hz + r).quadraticCurveTo(-hx, -hz, -hx + r, -hz);
  const g = new ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: curve });
  // the shape lies in x-y and extrudes along z: stood up, the extrusion runs up
  g.rotateX(-Math.PI / 2);
  return g.translate(x, y, z);
}

/** `points` without repeats in a row, nor a last one equal to the first. */
export function cleanOutline(points: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

/**
 * A side profile (x, y) extruded `width` across, centred on `z`, its edges rounded by `bevel` into the outline (never
 * grown out of it).
 */
export function profile(points: readonly P2[], width: number, bevel: number, z = 0, curve = 4, bevelSegments = 2): BufferGeometry {
  const depth = Math.max(1e-3, width - bevel * 2);
  const g = new ExtrudeGeometry(new Shape(cleanOutline(points).map(([x, y]) => new Vector2(x, y))), {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelOffset: -bevel * 0.8,
    bevelSegments: bevel > 0 ? bevelSegments : 0, curveSegments: curve,
  });
  return g.translate(0, 0, z - depth / 2);
}
