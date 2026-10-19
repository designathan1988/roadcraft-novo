// The TSL types in @types/three do not accept mixed int/float arithmetic
// or reassigned variables; in shaders we use TSL without static types.
import * as TSL from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const T: Record<string, any> = TSL;

/**
 * Compact vertex (snorm16 position, snorm8 octahedral normal): wires position and
 * normal into the material and returns the world normal as a varying.
 */
export function useCompactVertex(m: { positionNode: Node; normalNode: Node }, name: string): Node {
  const { Fn, attribute, vec3, float, abs, max, select, normalize, varyingProperty, transformNormalToView } = T;
  const vN = varyingProperty('vec3', name);
  const vertex = Fn(() => {
    const e = attribute('nrm', 'vec4').xy;
    const n = vec3(e.x, e.y, float(1).sub(abs(e.x)).sub(abs(e.y))).toVar();
    const t = max(n.z.negate(), float(0));
    n.x.addAssign(select(n.x.greaterThanEqual(0), t.negate(), t));
    n.y.addAssign(select(n.y.greaterThanEqual(0), t.negate(), t));
    vN.assign(normalize(n));
    return attribute('position', 'vec4').xyz;
  });
  m.positionNode = vertex();
  m.normalNode = transformNormalToView(normalize(vN));
  return normalize(vN);
}

/**
 * Previous-frame position for the TRAA velocity. three only knows the previous one through the raw `position` attribute:
 * a material that builds the position in `positionNode` (terrain, water, props, vehicles) wrote the wrong velocity, TRAA
 * gave full weight to the current frame there and the ground and trees shimmered with everything still. `prev` = the
 * same position in the previous frame (moving vehicles); without it, the current one (still: only the camera moves).
 */
export function withPrevious<M extends { setupPosition: (b: Node) => Node }>(m: M, prev?: Node): M {
  const { positionLocal, positionPrevious } = T;
  const base = m.setupPosition.bind(m);
  m.setupPosition = (builder: Node) => {
    const r = base(builder);
    if (builder.needsPreviousData()) positionPrevious.assign(prev ?? positionLocal);
    return r;
  };
  return m;
}

/**
 * Fade mask between detail levels: each mesh carries
 * `userData.fade` (0..1 fading in, −1..0 fading out); the two masks complement each other.
 */
export function lodFadeMask(): Node {
  const { uniform, interleavedGradientNoise, screenCoordinate, select } = T;
  const fade = uniform(1).onObjectUpdate(({ object }: { object: { userData: { fade?: number } } }) => object.userData.fade ?? 1);
  const n = interleavedGradientNoise(screenCoordinate.xy);
  return select(fade.greaterThanEqual(0), fade.sub(n), n.add(fade).add(1e-4)).greaterThan(0);
}

/** A transparent material paints colour only: it leaves the normal and velocity of what is behind it (the occlusion
 *  and the TRAA read those layers; otherwise rain and clouds turn into streaks and smudges). */
export function colorOnly<M extends { mrtNode: Node }>(m: M): M {
  const { mrt, output, vec4 } = T;
  m.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0), velocity: vec4(0, 0, 0, 0) });
  return m;
}
