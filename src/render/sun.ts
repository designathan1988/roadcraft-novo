// The sun's direction, shared by whoever chooses shadow casters (the cell layers, the props' cull pass). Kept apart
// from scene.ts so the layers do not pull the sky and the lights in.

import * as THREE from 'three/webgpu';

/** Unit vector from the ground toward the sun (or the moon at night), in the 0.2° steps the light moves in. */
export const sunDirection = new THREE.Vector3(0, 1, 0);

/** How far the sun's shadows reach from the camera (m): the cascades' far end (render/post.ts). */
export const SHADOW_REACH = 1600;

/** Longest shadow a caster is followed for (m): a low sun makes shadows kilometres long that no cascade shows. */
export const SHADOW_LENGTH = 600;

/** Layer of the meshes only the shadow cascades draw (the terrain's coarse shadow copy); the views never enable it. */
export const SHADOW_ONLY_LAYER = 3;

/**
 * Layer of the small casters (props under SMALL_CASTER m): the views and the near cascade draw it, the two far cascades
 * do not (Roadcraft 4.0 drew a caster into a cascade only if it was bigger than that cascade's texel).
 */
export const SMALL_CASTER_LAYER = 4;
/** Height under which a prop is a small caster (m). */
export const SMALL_CASTER = 1.2;
