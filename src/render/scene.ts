// Base scene: renderer, sky, sun, sky fill, the sky as the PBR environment (PMREM), distance fog and the sea.

import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { MAP_SIZE, SEA_LEVEL } from '../config.ts';
import { T } from './tsl.ts';

const { vec3, vec4, float, mix, pow, clamp, dot, normalize, cameraPosition, positionWorld, sRGBTransferEOTF, mx_noise_float, time, max } = T;

export interface SceneParts {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: SkyMesh;
  water: THREE.Mesh;
  isWebGPU: boolean;
  /** Texture layers the GPU accepts (one tile per layer: limits the map size). */
  maxLayers: number;
  /** The sky as image-based light: refreshed only when the sun moves (`SkyEnvironment.update`). */
  env: SkyEnvironment;
}

/** Tone mapping as Roadcraft (ACES at exposure 1: three's ACES already scales its input by 1 / 0.6). */
export const TONE_EXPOSURE = 0.92;

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
  const fogColor = new THREE.Color(0xb9cbdc);
  scene.fog = new THREE.FogExp2(fogColor, 0.000045);
  scene.background = fogColor;

  const sky = new SkyMesh();
  sky.scale.setScalar(100000);
  configureSky(sky);
  sky.frustumCulled = false;
  // with reversed depth the sky lands on the nearest plane: drawn before everything, writing no depth
  sky.renderOrder = -1000;
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
  const deep = sRGBTransferEOTF(vec3(0.07, 0.17, 0.2));
  const skyc = sRGBTransferEOTF(vec3(0.62, 0.74, 0.85));
  wm.colorNode = vec4(mix(deep, skyc, clamp(fres.add(ripple), 0, 1)), 1);
  wm.roughnessNode = float(0.12);
  wm.metalnessNode = float(0);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE * 8, MAP_SIZE * 8).rotateX(-Math.PI / 2), wm);
  water.position.y = SEA_LEVEL;
  water.frustumCulled = false;
  scene.add(water);

  const env = new SkyEnvironment(renderer, scene, isWebGPU);
  return { renderer, scene, sun, hemi, sky, water, isWebGPU, maxLayers, env };
}

function configureSky(sky: SkyMesh): void {
  sky.turbidity.value = 3;
  sky.rayleigh.value = 1.2;
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
export class SkyEnvironment {
  /** How much of the sky the materials see by day (Roadcraft: 0.6, with a sky fill of 0.8). */
  static readonly INTENSITY = 0.16;
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
    configureSky(this.probeSky);
    this.probeSky.scale.setScalar(50);
    this.probeSky.showSunDisc.value = 0; // the sun's highlight is the directional light's
    this.probeSky.frustumCulled = false;
    this.probe.add(this.probeSky);
  }

  /** `dir` = toward the sun, `light` = daylight 0..1 (already dimmed by the clouds). */
  update(dir: THREE.Vector3, light: number): void {
    this.scene.environmentIntensity = SkyEnvironment.INTENSITY * (0.08 + 0.92 * light);
    if (!this.pmrem) return;
    const moved = this.lastDir.angleTo(dir) * 180 / Math.PI;
    if (moved < ENV_STEP_DEG && Math.abs(light - this.lastLight) < ENV_STEP_LIGHT && this.target) return;
    this.lastDir.copy(dir);
    this.lastLight = light;
    this.probeSky.sunPosition.value.copy(dir);
    // overcast: the sky goes flat and grey (more turbid, less blue)
    this.probeSky.turbidity.value = 3 + 9 * (1 - light);
    this.probeSky.rayleigh.value = 1.2 * (0.35 + 0.65 * light);
    this.target = this.pmrem.fromScene(this.probe, 0.04, 0.1, 100, { size: 128, renderTarget: this.target });
    this.scene.environment = this.target.texture;
    this.refreshes++;
  }
}

const SUN_STEP = 0.2;
const _sunDir = new THREE.Vector3();

/** Places the sun by elevation and azimuth in degrees. */
export function setSun(p: { sun: THREE.DirectionalLight; sky: SkyMesh }, elevation: number, azimuth: number): void {
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  p.sky.sunPosition.value.copy(dir);
  // the light (and the shadow) moves in 0.2° steps: snapping the cascades to the texel grid only holds with the
  // light still; turning a little every frame made every shadow edge crawl one texel per frame (the image shook)
  const q = (deg: number) => THREE.MathUtils.degToRad(Math.round(deg / SUN_STEP) * SUN_STEP);
  _sunDir.setFromSphericalCoords(1, q(90 - elevation), q(azimuth));
  p.sun.position.copy(_sunDir).multiplyScalar(1000);
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

const GRAY_FOG = new THREE.Color(0x9aa1a8);
const DAY_FOG = new THREE.Color(0xb9cbdc), DUSK_FOG = new THREE.Color(0xd9a27a), NIGHT_FOG = new THREE.Color(0x0c1220);
const SUN_DAY = new THREE.Color(0xfff0d2), SUN_LOW = new THREE.Color(0xffa860), MOON = new THREE.Color(0x9fb4d8);
// a near-neutral sky fill (Roadcraft: a saturated blue tinted every shadow blue at close zoom)
const HEMI_DAY = new THREE.Color(0xe6e4da), HEMI_NIGHT = new THREE.Color(0x34456a);
/** Light bounced off the ground and the façades (by day warm and clear; at night almost nothing). */
const BOUNCE_DAY = new THREE.Color(0x6a6b4c), BOUNCE_NIGHT = new THREE.Color(0x56483a);
const tmpC = new THREE.Color();
const _envDir = new THREE.Vector3();

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Hour of the day (0–24): sun, moon, sky, environment, fog and the night uniform. */
export function setTimeOfDay(p: SceneParts, hour: number, clouds = 0.25, rain = 0, eyeHeight = 0): void {
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
    p.sun.intensity = 4.0 * day * (1 - 0.88 * overcast);
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
  p.hemi.intensity = (0.25 + 0.5 * day + 1.25 * night) * (1 + 1.1 * overcast) * (1 - 0.3 * rain);
  _envDir.copy(p.sky.sunPosition.value as THREE.Vector3);
  p.env.update(_envDir, day * (1 - 0.6 * overcast) * (1 - 0.3 * rain));
  const dusk = smooth(-6, 2, elev) * (1 - smooth(4, 16, elev));
  tmpC.copy(NIGHT_FOG).lerp(DAY_FOG, day).lerp(DUSK_FOG, dusk * 0.5 * (1 - clouds));
  // overcast: greyer fog; rain: denser
  tmpC.lerp(GRAY_FOG.clone().multiplyScalar(0.25 + 0.75 * day), Math.max(0, clouds - 0.3) * 0.9);
  // heavy rain darkens the horizon (otherwise the band under the clouds is too bright)
  tmpC.multiplyScalar(1 - 0.4 * rain);
  (p.scene.fog as THREE.FogExp2).color.copy(tmpC);
  // seen from high up (whole map): the air between the camera and the ground is thinner than the horizon's
  const high = 1 / (1 + Math.max(0, eyeHeight - 400) / 1200);
  (p.scene.fog as THREE.FogExp2).density = 0.000045 * (1 + 0.8 * clouds + 4 * rain) * high * fogLevel.value;
  (p.scene.background as THREE.Color).copy(tmpC);
  p.sky.visible = elev > -9;
}
