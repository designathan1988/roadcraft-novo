// The sun's direction, shared by whoever chooses shadow casters (the cell layers, the props' cull pass). Kept apart
// from scene.ts so the layers do not pull the sky and the lights in.

import * as THREE from 'three/webgpu';

/** Unit vector from the ground toward the sun (or the moon at night), in the 0.2° steps the light moves in. */
export const sunDirection = new THREE.Vector3(0, 1, 0);

/** How far the sun's shadows reach from the camera (m): the cascades' far end (render/post.ts). */
export const SHADOW_REACH = 1600;

/** Longest shadow a caster is followed for (m): a low sun makes shadows kilometres long that no cascade shows. */
export const SHADOW_LENGTH = 600;

/**
 * Layer of the small casters (props under SMALL_CASTER m): the views and the near cascade draw it, the two far cascades
 * do not (Roadcraft 4.0 drew a caster into a cascade only if it was bigger than that cascade's texel).
 */
export const SMALL_CASTER_LAYER = 4;
/**
 * First of the cascades' own layers (one each: CASCADE_LAYER + i). three r186 draws a shadow camera that holds nothing but
 * layer 0 with the view camera's layers (ShadowNode.updateShadow, `(mask & 0xFFFFFFFE) === 0`): the far cascades, set to
 * layer 0 alone, drew the small casters too. A layer of its own keeps each cascade's layers as they are set.
 */
export const CASCADE_LAYER = 5;
/**
 * Layers of the casters that move (traffic, people, trees in the wind, a collapse's pieces), the small ones apart (the near
 * cascade only, as SMALL_CASTER_LAYER). The cascades keep the still casters' depth and draw these over it each frame
 * (render/post.ts CachedShadowNode, Roadcraft 4.0's static shadow cache); the views draw them as any.
 */
export const MOVER_LAYER = 8;
export const MOVER_SMALL_LAYER = 9;
/** The mover layers' bits in a layer mask. */
export const MOVER_BITS = (1 << MOVER_LAYER) | (1 << MOVER_SMALL_LAYER);
/** Height under which a prop is a small caster (m). */
export const SMALL_CASTER = 1.2;
