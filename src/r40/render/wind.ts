import {
  Vector2,
  type Material,
} from 'three';

/** Wind: the one moving thing in a scene of static props. */

/** Shared by every material with wind; `renderer.ts` advances the time. */
export const windUniforms = {
  uWindTime: { value: 0 },
  /** Direction the wind blows TOWARDS, in three's XZ plane. */
  uWindDir: { value: new Vector2(0.82, -0.57).normalize() },
  /** How hard it blows, 1 the breeze the plants were tuned to (`setWindWeather`). */
  uWindStrength: { value: 1 },
};

/** The map's wind (`world/weather.ts`): which way it blows, towards (three's x and z), and how fast, metres a second. */
export function setWindWeather(dirX: number, dirZ: number, metresPerSecond: number): void {
  const length = Math.hypot(dirX, dirZ);
  if (length > 1e-6) windUniforms.uWindDir.value.set(dirX / length, dirZ / length);
  windUniforms.uWindStrength.value = Math.min(4.2, 0.3 + metresPerSecond / 6.5);
}

export interface WindResponse {
  /** Top displacement as a fraction of height, at a full gust. */
  readonly sway: number;
  /** Leaf or blade flutter, as a fraction of height. */
  readonly flutter: number;
}

/** The mark of a material whose vertices the wind moves: what it draws sways every frame, and the sun's cascades draw it over their store of what stands still (`sunCascades.ts` movers, `renderer.ts`). */
const SWAYS = Symbol('sways');
type Swaying = Material & { [SWAYS]?: true };
/** A material the wind moves (its shader reads `windUniforms`): every shader that sways marks its material, lit and depth. */
export function markSway(material: Material): void {
  (material as Swaying)[SWAYS] = true;
}
/** Whether a material sways in the wind (`markSway`). */
export function sways(material: Material): boolean {
  return (material as Swaying)[SWAYS] === true;
}
