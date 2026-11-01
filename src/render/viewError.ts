// The screen-space-error rule every LOD switch follows (Cesium 3D Tiles selection, `maximumScreenSpaceError`:
// https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html): a coarser level may stand in for
// the finer one while its geometric error spans at most a documented pixel budget - the switch distance is where the
// error spans exactly that budget, error_px = error_m * pxPerMetre / distance. The pixels per metre come from the
// ACTUAL projection (perspective: the frame's height over the fov's tangent; orthographic: the frame's height over
// the frustum's height, zoom-driven, as partSize.ts already reads it), never from a fixed reference alone.
import type { OrthographicCamera, PerspectiveCamera } from 'three/webgpu';

/** The pixel budgets (4.0 render/buildings/massCells.ts:23,28): the far level's 1.5 m may span 2 px, the facade
 *  level's 0.3 m flattening 0.5 px. */
export const NEAR_PIXELS = 2;
export const FINE_PIXELS = 0.5;

/** Metres a pixel spans at 1 m with the reference view (1080 px, 45° vertical fov): the constants below derive
 *  from it, so a switch distance and its formula can never drift apart. */
export const PX_PER_METRE_AT_1080 = 1080 / (2 * Math.tan((45 / 2) * Math.PI / 180));

/** The distance at which `errorM` spans `thresholdPx` on the reference view (1080 px, 45°): the 4.0 switches -
 *  the far level (1.5 m at 2 px -> 978 m), the facade (0.3 m at 0.5 px -> 782 m), the plate (8 m at 2 px -> 5216 m). */
export function distanceForError(errorM: number, thresholdPx: number): number {
  return (errorM * PX_PER_METRE_AT_1080) / thresholdPx;
}

/** The view's scale against the reference view: what every fixed 1080p/45° switch distance is multiplied by. More
 *  pixels per metre -> the coarser levels run out of pixel budget nearer -> the scale grows and the near levels
 *  reach farther. The perspective reads the camera's own fov; the orthographic its frustum height, so the zoom
 *  drives the switches (its pixels per metre do not fall with distance). */
export function viewScale(camera: PerspectiveCamera | OrthographicCamera, framePx: number): number {
  const perMetre = 'top' in camera
    ? framePx / (camera.top - camera.bottom)
    : framePx / (2 * Math.tan(((camera as PerspectiveCamera).fov / 2) * Math.PI / 180));
  return perMetre / PX_PER_METRE_AT_1080;
}
