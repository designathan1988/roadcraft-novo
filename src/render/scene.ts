// Base scene: renderer, sky, sun, sky fill, the sky as the PBR environment (PMREM), distance fog and the sea.

import * as THREE from 'three/webgpu';
import { sunDirection } from './sun.ts';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { MAP_SIZE, SEA_LEVEL } from '../config.ts';
import { T } from './tsl.ts';

const { vec3, vec4, float, mix, pow, clamp, dot, normalize, cameraPosition, positionWorld, sRGBTransferEOTF, mx_noise_float, time, max, uniform, smoothstep } = T;

export interface SceneParts {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: GradientSky;
  water: THREE.Mesh;
  isWebGPU: boolean;
  /** Texture layers the GPU accepts (one tile per layer: limits the map size). */
  maxLayers: number;
  /** The sky as image-based light: refreshed only when the sun moves (`SkyEnvironment.update`). */
  env: SkyEnvironment;
}

/** Tone mapping as Roadcraft (ACES at exposure 1: three's ACES already scales its input by 1 / 0.6). */
export const TONE_EXPOSURE = 0.8;

export async function createScene(canvas: HTMLCanvasElement): Promise<SceneParts> {
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  // large maps have one texture layer per tile (24 × 24 = 576): ask the device for the adapter's limits, not
  // the default minimums (256 layers)
  let requiredLimits: Record<string, number> | undefined;
  const gpu = (navigator as { gpu?: { requestAdapter(o?: object): Promise<{ limits: Record<string, number> } | null> } }).gpu;
  if (!forceWebGL && gpu) {
    try {
      const ad = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (ad) requiredLimits = {
        maxTextureArrayLayers: ad.limits.maxTextureArrayLayers,
        maxBufferSize: ad.limits.maxBufferSize,
        maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize,
      };
    } catch { /* keep the default limits */ }
  }
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    requiredLimits,
    // ?webgl forces compatibility mode (to test the Low preset)
    forceWebGL,
    reversedDepthBuffer: true,
    powerPreference: 'high-performance',
    // ?perf: GPU time per render call (render/gpuTiming.ts); the queries are the measurement, off in play
    trackTimestamp: new URLSearchParams(location.search).has('perf'),
  });
  await renderer.init();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_EXPOSURE;
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  let maxLayers = 256;
  try {
    const be = renderer.backend as { device?: { limits: { maxTextureArrayLayers: number } }; gl?: WebGL2RenderingContext };
    if (isWebGPU && be.device) maxLayers = be.device.limits.maxTextureArrayLayers;
    else if (be.gl) maxLayers = be.gl.getParameter(be.gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
  } catch { /* keep the guaranteed minimum */ }

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xa8c3e2);
  scene.fog = new THREE.FogExp2(fogColor, 0.000045);
  scene.background = fogColor;

  const sky = new GradientSky(100000);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xc8dcf0, 0x6b6150, 1.3);
  scene.add(hemi);
  setSun({ sun, sky }, 32, 215);

  // sea: a plane at sea level, colour by incidence and a light ripple
  const wm = new THREE.MeshStandardNodeMaterial();
  const view = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(max(dot(view, vec3(0, 1, 0)), 0)), 4);
  const ripple = mx_noise_float(positionWorld.xz.mul(0.05).add(time.mul(0.05))).mul(0.04).mul(waveU.mul(3).add(0.4));
  const deep = sRGBTransferEOTF(vec3(0.03, 0.09, 0.12));
  const skyc = sRGBTransferEOTF(vec3(0.62, 0.74, 0.85));
  wm.colorNode = vec4(mix(deep, skyc, clamp(fres.add(ripple), 0, 1)), 1);
  wm.roughnessNode = float(0.2);
  wm.metalnessNode = float(0);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE * 8, MAP_SIZE * 8).rotateX(-Math.PI / 2), wm);
  water.position.y = SEA_LEVEL;
  water.frustumCulled = false;
  scene.add(water);

  const env = new SkyEnvironment(renderer, scene, isWebGPU);
  return { renderer, scene, sun, hemi, sky, water, isWebGPU, maxLayers, env };
}

/**
 * Roadcraft 4.0's gradient sky (`render/environment.ts`): horizon to zenith by pow(h, 0.62), the ground colour below
 * the horizon, the sun's glow, and the colours by the hour (day, dusk, night) and the clouds. Near the ground the
 * horizon is the saturated pale blue of 4.0's sky pass (`postprocess.ts`: 0x86bdf0 rising to 0x2a66c8), not the white
 * haze of the physical sky (the street view's horizon was too bright). The
 * environment probe's sky is still the physical one (the city's lighting is tuned to it).
 */
export class GradientSky extends THREE.Mesh {
  /** Toward the sun (unit). */
  readonly sunPosition = uniform(new THREE.Vector3(0, 1, 0));
  readonly zenith = uniform(new THREE.Color(0x4d7fc4));
  readonly horizon = uniform(new THREE.Color(0xc9dcea));
  readonly groundColor = uniform(new THREE.Color(0x6f7a68));
  readonly sunColor = uniform(new THREE.Color(1, 0.96, 0.9));
  /** 1 with the eye near the ground (street view): the low, saturated horizon; 0 high up. */
  readonly low = uniform(0);
  /** 0 = no sun disc (the environment probe: the highlight is the directional light's). */
  readonly sunDisc = uniform(1);
  /** Radiance scale: the colours are display colours; the image is tone mapped after (and the probe lights the city). */
  readonly gain = uniform(SKY_GAIN);

  constructor(radius: number) {
    super(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false }));
    this.scale.setScalar(radius);
    const m = this.material as THREE.MeshBasicNodeMaterial;
    const dir = normalize(positionWorld.sub(cameraPosition));
    const h = dir.y;
    const up = clamp(h, 0, 1);
    const zen = sRGBTransferEOTF(this.zenith), hor = sRGBTransferEOTF(this.horizon);
    let sky = mix(hor, zen, pow(up, 0.62));
    // street view: pale saturated blue at the horizon, deep blue by half way up (4.0's sky pass near the ground)
    const lowSky = mix(hor.mul(sRGBTransferEOTF(vec3(0x86 / 255, 0xbd / 255, 0xf0 / 255)).div(sRGBTransferEOTF(vec3(0xc9 / 255, 0xdc / 255, 0xea / 255)))),
      zen.mul(sRGBTransferEOTF(vec3(0x2a / 255, 0x66 / 255, 0xc8 / 255)).div(sRGBTransferEOTF(vec3(0x4d / 255, 0x7f / 255, 0xc4 / 255)))), smoothstep(0, 0.5, up));
    sky = mix(sky, lowSky, this.low);
    sky = mix(sRGBTransferEOTF(this.groundColor), sky, smoothstep(-0.12, 0.02, h));
    const sd = clamp(dot(dir, normalize(this.sunPosition)), 0, 1);
    const glow = pow(sd, 7).mul(0.28).add(pow(sd, 120).mul(0.9).mul(this.sunDisc)).mul(smoothstep(-0.05, 0.05, h));
    m.colorNode = vec4(sky.add(sRGBTransferEOTF(this.sunColor).mul(glow)).mul(this.gain), 1);
    this.frustumCulled = false;
    // with reversed depth the sky lands on the nearest plane: drawn before everything, writing no depth
    this.renderOrder = -1000;
  }

}

/** The visible sky's radiance over its display colours (the image is tone mapped after). */
const SKY_GAIN = 2.2;

/** The environment probe's physical sky (three's SkyMesh): a clear blue sky (Roadcraft's day: zenith 4d7fc4). */
function configureProbeSky(sky: SkyMesh): void {
  sky.turbidity.value = 2;
  sky.rayleigh.value = 2.2;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.8;
}

/** Environment refreshes: the sun moved at least this much (degrees), or the light changed this much. */
const ENV_STEP_DEG = 2;
const ENV_STEP_LIGHT = 0.08;

/**
 * The sky as the PBR environment (Roadcraft `environment.ts`: the sky doubles as the environment map, so paint,
 * glass and wet surfaces show it). A second SkyMesh in a probe scene, prefiltered by PMREM into one reused target;
 * refreshed only when the sun moves ≥ 2° or the daylight / cloud cover changes, never per frame.
 */
/**
 * Materials that see the sky at their own share of the environment, as 4.0's `envMapIntensity` (water: 0.42,
 * water.ts:177). Ours lights everything at `SkyEnvironment.INTENSITY`, which stands for 4.0's usual 0.6 (finishes
 * 0.4-1, finishRecipes.ts): a material registered with k sees k / 0.6 of it. The env map is set on the material
 * because three's node materials only take their own intensity with their own map (`materialEnvIntensity`).
 */
const ownEnv: Array<{ m: THREE.Material & { envMap: THREE.Texture | null; envMapIntensity: number }; k: number }> = [];
let lastEnv: { tex: THREE.Texture | null; intensity: number } = { tex: null, intensity: 1 };
export function waterEnv(m: THREE.MeshStandardNodeMaterial, k = 0.42): void {
  const e = { m, k };
  ownEnv.push(e);
  applyOwnEnv(e);
}
function applyOwnEnv(e: (typeof ownEnv)[number]): void {
  if (lastEnv.tex && e.m.envMap !== lastEnv.tex) { e.m.envMap = lastEnv.tex; e.m.needsUpdate = true; }
  e.m.envMapIntensity = lastEnv.intensity * e.k / 0.6;
}

export class SkyEnvironment {
  /** How much of the sky the materials see by day (Roadcraft: 0.6, with a sky fill of 0.8). */
  static readonly INTENSITY = 0.1;
  private pmrem: THREE.PMREMGenerator | null = null;
  private probe = new THREE.Scene();
  private probeSky = new SkyMesh();
  private target: THREE.RenderTarget | null = null;
  private lastDir = new THREE.Vector3(0, -2, 0);
  private lastLight = -1;
  private scene: THREE.Scene;
  /** Refreshes so far (counted, for the stats). */
  refreshes = 0;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, enabled: boolean) {
    this.scene = scene;
    if (!enabled) return;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // the physical sky, as before the gradient: the city's light (environment intensity, fill, grade) is tuned to it
    configureProbeSky(this.probeSky);
    this.probeSky.scale.setScalar(50);
    this.probeSky.showSunDisc.value = 0; // the sun's highlight is the directional light's
    this.probeSky.frustumCulled = false;
    this.probe.add(this.probeSky);
  }

  /** `dir` = toward the sun, `light` = daylight 0..1 (already dimmed by the clouds). */
  update(dir: THREE.Vector3, light: number): void {
    this.scene.environmentIntensity = SkyEnvironment.INTENSITY * (0.08 + 0.92 * light);
    lastEnv.intensity = this.scene.environmentIntensity;
    for (const e of ownEnv) applyOwnEnv(e);
    if (!this.pmrem) return;
    const moved = this.lastDir.angleTo(dir) * 180 / Math.PI;
    if (moved < ENV_STEP_DEG && Math.abs(light - this.lastLight) < ENV_STEP_LIGHT && this.target) return;
    this.lastDir.copy(dir);
    this.lastLight = light;
    this.probeSky.sunPosition.value.copy(dir);
    // overcast: the sky goes flat and grey (more turbid, less blue)
    this.probeSky.turbidity.value = 2 + 10 * (1 - light);
    this.probeSky.rayleigh.value = 2.2 * (0.35 + 0.65 * light);
    this.target = this.pmrem.fromScene(this.probe, 0.04, 0.1, 100, { size: 128, renderTarget: this.target });
    this.scene.environment = this.target.texture;
    lastEnv.tex = this.target.texture;
    for (const e of ownEnv) applyOwnEnv(e);
    this.refreshes++;
  }
}

const SUN_STEP = 0.2;
const _sunDir = new THREE.Vector3(), _sunPos = new THREE.Vector3();
/** The angle snapped to the light's step (degrees to radians). */
const quantDeg = (deg: number): number => THREE.MathUtils.degToRad(Math.round(deg / SUN_STEP) * SUN_STEP);

/** Places the sun by elevation and azimuth in degrees. */
export function setSun(p: { sun: THREE.DirectionalLight; sky: GradientSky }, elevation: number, azimuth: number): void {
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  p.sky.sunPosition.value.copy(_sunPos.setFromSphericalCoords(1, phi, theta));
  // the light (and the shadow) moves in 0.2° steps: snapping the cascades to the texel grid only holds with the
  // light still; turning a little every frame made every shadow edge crawl one texel per frame (the image shook)
  _sunDir.setFromSphericalCoords(1, quantDeg(90 - elevation), quantDeg(azimuth));
  p.sun.position.copy(_sunDir).multiplyScalar(1000);
  sunDirection.copy(_sunDir);
  p.sun.target.position.set(0, 0, 0);
}

/** General mist chosen in the weather panel (multiplies the distance fog density). */
export const fogLevel = { value: 1 };
/** Water (weather panel): waves 0..1, foam 0..1, current in m/s. */
export const waveU = T.uniform(0.3);
export const foamU = T.uniform(0.4);
export const currentU = T.uniform(0.5);

/** 0 by day, 1 at night: read by the materials (lit windows, signs). */
export const nightU = T.uniform(0);

// the gradient sky's colours (sRGB, Roadcraft 4.0)
const ZENITH_DAY = new THREE.Color(0x4d7fc4), ZENITH_NIGHT = new THREE.Color(0x0b1424);
const HORIZON_DAY = new THREE.Color(0xc9dcea), HORIZON_DUSK = new THREE.Color(0xf0b383), HORIZON_NIGHT = new THREE.Color(0x1c2638);
const GRAY_SKY = new THREE.Color(0x6f7782);
/** Street-level horizon over the day horizon, per channel in linear (0x86bdf0 / 0xc9dcea). */
const LOW_TINT = (() => {
  const a = new THREE.Color(0x86bdf0).convertSRGBToLinear(), b = new THREE.Color(0xc9dcea).convertSRGBToLinear();
  return new THREE.Color(a.r / b.r, a.g / b.g, a.b / b.b);
})();
const tmpLow = new THREE.Color();
const SUN_DAY = new THREE.Color(0xfff0d2), SUN_LOW = new THREE.Color(0xffa860), MOON = new THREE.Color(0x9fb4d8);
// a near-neutral sky fill (Roadcraft: a saturated blue tinted every shadow blue at close zoom)
const HEMI_DAY = new THREE.Color(0xe6e4da), HEMI_NIGHT = new THREE.Color(0x34456a);
/** The sky's light during a lightning flash. */
const FLASH_COLOR = new THREE.Color(0xdde6ff);
/** Light bounced off the ground and the façades (by day warm and clear; at night almost nothing). */
const BOUNCE_DAY = new THREE.Color(0x6a6b4c), BOUNCE_NIGHT = new THREE.Color(0x56483a);
const tmpC = new THREE.Color();
const _envDir = new THREE.Vector3();

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Hour of the day (0–24): sun, moon, sky, environment, fog and the night uniform. */
/** The scene's light at `hour`; `flash` (0..1, render/weather.ts flashU) brightens and cools the sky's light. */
export function setTimeOfDay(p: SceneParts, hour: number, clouds = 0.25, rain = 0, eyeHeight = 0, flash = 0): void {
  const k = (hour - 5.75) / 13; // 0 sunrise (5:45), 1 sunset (18:45)
  const elev = 62 * Math.sin(Math.PI * k);
  const az = 90 + 180 * k;
  const night = smooth(3, -7, elev);
  const day = smooth(-3, 12, elev);
  const overcast = smooth(0.3, 0.92, clouds);
  nightU.value = night;
  if (elev > -3) {
    setSun(p, Math.max(elev, 0.5), az);
    p.sun.color.copy(SUN_LOW).lerp(SUN_DAY, smooth(2, 25, elev));
    p.sun.intensity = 4.6 * day * (1 - 0.88 * overcast);
  } else {
    // the moon, on the other side of the sky
    setSun(p, 38, az + 180);
    p.sky.sunPosition.value.set(0, -1, 0);
    p.sun.color.copy(MOON);
    p.sun.intensity = 0.95 * night;
  }
  p.hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, day);
  p.hemi.groundColor.copy(BOUNCE_NIGHT).lerp(BOUNCE_DAY, day);
  // overcast: no sun, the sky lights everything evenly (stronger). By day the environment (PMREM of the sky) carries
  // part of the sky light, so the fill is lower than before it (0.72 → 0.5)
  p.hemi.intensity = (0.25 + 0.3 * day + 1.25 * night) * (1 + 1.1 * overcast) * (1 - 0.3 * rain);
  if (flash > 0) { p.hemi.intensity += flash * 4; p.hemi.color.lerp(FLASH_COLOR, flash * 0.6); }
  // the gradient sky's colours by the hour (Roadcraft 4.0 environment.ts: zenith, horizon, dusk, night, overcast)
  const height = Math.sin(THREE.MathUtils.degToRad(elev));
  const light = Math.min(1, Math.max(0, (height + 0.1) / 0.25)), dark = 1 - light;
  const warm = Math.max(0, 1 - 1.6 * height);
  const grey = GRAY_SKY;
  const sk = p.sky;
  // as 4.0's environment.ts:249-266: overcast greys the zenith 0.85 and the horizon 0.7 of the way (by daylight); the
  // sun's glow goes from fff0d2 to ffa860 as it sinks
  (sk.zenith.value as THREE.Color).copy(ZENITH_DAY).lerp(ZENITH_NIGHT, dark).lerp(grey, overcast * 0.85 * light);
  (sk.horizon.value as THREE.Color).copy(HORIZON_DAY).lerp(HORIZON_DUSK, warm * light * 0.7).lerp(HORIZON_NIGHT, dark).lerp(grey, overcast * 0.7 * light).multiplyScalar(1 - 0.4 * rain);
  (sk.sunColor.value as THREE.Color).copy(SUN_DAY).lerp(SUN_LOW, Math.min(1, warm)).multiplyScalar(light * (1 - overcast));
  // near the ground the horizon is the saturated pale blue (by day; it fades with the light and the clouds)
  sk.low.value = (1 - smooth(100, 260, eyeHeight)) * light * (1 - overcast) * (1 - warm);
  _envDir.copy(p.sky.sunPosition.value as THREE.Vector3);
  p.env.update(_envDir, day * (1 - 0.6 * overcast) * (1 - 0.3 * rain));
  // the distance fog is the sky's colour at the horizon: far buildings melt into the sky, not into a lighter band
  tmpC.copy(sk.horizon.value as THREE.Color).convertSRGBToLinear();
  tmpLow.copy(tmpC).multiply(LOW_TINT);
  tmpC.lerp(tmpLow, sk.low.value as number).convertLinearToSRGB();
  (p.scene.fog as THREE.FogExp2).color.copy(tmpC);
  // seen from high up (whole map): the air between the camera and the ground is thinner than the horizon's
  const high = 1 / (1 + Math.max(0, eyeHeight - 400) / 1200);
  (p.scene.fog as THREE.FogExp2).density = 0.000045 * (1 + 0.8 * clouds + 4 * rain) * high * fogLevel.value;
  (p.scene.background as THREE.Color).copy(tmpC);
  p.sky.visible = elev > -9;
}
