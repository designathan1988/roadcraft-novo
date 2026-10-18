// Cena base: renderizador, céu, sol, luz de ambiente, neblina de distância e água.

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
  /** Camadas de textura que a placa aceita (um ladrilho por camada: limita o tamanho do mapa). */
  maxLayers: number;
}

export async function createScene(canvas: HTMLCanvasElement): Promise<SceneParts> {
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  // mapas grandes têm uma camada de textura por ladrilho (24 × 24 = 576): pede ao
  // dispositivo os limites que o adaptador tem, não os mínimos padrão (256 camadas)
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
    } catch { /* fica com os limites padrão */ }
  }
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    requiredLimits,
    // ?webgl força o modo de compatibilidade (para testar o preset Baixo)
    forceWebGL,
    reversedDepthBuffer: true,
    powerPreference: 'high-performance',
  });
  await renderer.init();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  let maxLayers = 256;
  try {
    const be = renderer.backend as { device?: { limits: { maxTextureArrayLayers: number } }; gl?: WebGL2RenderingContext };
    if (isWebGPU && be.device) maxLayers = be.device.limits.maxTextureArrayLayers;
    else if (be.gl) maxLayers = be.gl.getParameter(be.gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
  } catch { /* fica no mínimo garantido */ }

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xb9cbdc);
  scene.fog = new THREE.FogExp2(fogColor, 0.000045);
  scene.background = fogColor;

  const sky = new SkyMesh();
  sky.scale.setScalar(100000);
  sky.turbidity.value = 3;
  sky.rayleigh.value = 1.2;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.8;
  sky.frustumCulled = false;
  // o céu sai no plano mais próximo com profundidade invertida: desenhado antes de tudo, sem escrever profundidade
  sky.renderOrder = -1000;
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xc8dcf0, 0x6b6150, 1.3);
  scene.add(hemi);
  setSun({ sun, sky }, 32, 215);

  // água: um plano no nível do mar, cor pela incidência e um leve ondular
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

  return { renderer, scene, sun, hemi, sky, water, isWebGPU, maxLayers };
}

const SUN_STEP = 0.2;
const _sunDir = new THREE.Vector3();

/** Posiciona o sol por elevação e azimute em graus. */
export function setSun(p: { sun: THREE.DirectionalLight; sky: SkyMesh }, elevation: number, azimuth: number): void {
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  p.sky.sunPosition.value.copy(dir);
  // a luz (e a sombra) anda em degraus de 0,2°: o encaixe das cascatas na grade de texels só vale com a luz
  // parada; girando um pouco a cada quadro, toda borda de sombra rastejava um texel por quadro (imagem tremendo)
  const q = (deg: number) => THREE.MathUtils.degToRad(Math.round(deg / SUN_STEP) * SUN_STEP);
  _sunDir.setFromSphericalCoords(1, q(90 - elevation), q(azimuth));
  p.sun.position.copy(_sunDir).multiplyScalar(1000);
  p.sun.target.position.set(0, 0, 0);
}

/** Água (painel de clima): ondas 0..1, espuma 0..1, correnteza em m/s. */
/** Névoa geral escolhida no clima (multiplica a densidade da neblina de distância). */
export const fogLevel = { value: 1 };
export const waveU = T.uniform(0.3);
export const foamU = T.uniform(0.4);
export const currentU = T.uniform(0.5);

/** 0 de dia, 1 de noite: lido pelos materiais (janelas acesas, letreiros). */
export const nightU = T.uniform(0);

const GRAY_FOG = new THREE.Color(0x9aa1a8);
const DAY_FOG = new THREE.Color(0xb9cbdc), DUSK_FOG = new THREE.Color(0xd9a27a), NIGHT_FOG = new THREE.Color(0x0c1220);
const SUN_DAY = new THREE.Color(0xfff1dc), SUN_LOW = new THREE.Color(0xffb27a), MOON = new THREE.Color(0x9fb4d8);
const HEMI_DAY = new THREE.Color(0xc8dcf0), HEMI_NIGHT = new THREE.Color(0x34456a);
/** Luz rebatida do chão e das fachadas (de dia, quente e clara; à noite, quase nada). */
const BOUNCE_DAY = new THREE.Color(0xb8a98e), BOUNCE_NIGHT = new THREE.Color(0x56483a);
const tmpC = new THREE.Color();

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Hora do dia (0–24): sol, lua, céu, neblina e o uniforme da noite. */
export function setTimeOfDay(p: SceneParts, hour: number, clouds = 0.25, rain = 0, eyeHeight = 0): void {
  const k = (hour - 5.75) / 13; // 0 nascer (5h45), 1 pôr (18h45)
  const elev = 62 * Math.sin(Math.PI * k);
  const az = 90 + 180 * k;
  const night = smooth(3, -7, elev);
  const day = smooth(-3, 12, elev);
  nightU.value = night;
  if (elev > -3) {
    setSun(p, Math.max(elev, 0.5), az);
    p.sun.color.copy(SUN_LOW).lerp(SUN_DAY, smooth(2, 25, elev));
    p.sun.intensity = 3.8 * day * (1 - 0.92 * smooth(0.3, 0.92, clouds));
  } else {
    // lua do outro lado do céu
    setSun(p, 38, az + 180);
    p.sky.sunPosition.value.set(0, -1, 0);
    p.sun.color.copy(MOON);
    p.sun.intensity = 0.6 * night;
  }
  p.hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, day);
  p.hemi.groundColor.copy(BOUNCE_NIGHT).lerp(BOUNCE_DAY, day);
  // nublado: sem sol, o céu ilumina tudo por igual (mais forte)
  p.hemi.intensity = (0.25 + 0.72 * day + 0.7 * night) * (1 + 1.1 * smooth(0.3, 0.92, clouds)) * (1 - 0.3 * rain);
  const dusk = smooth(-6, 2, elev) * (1 - smooth(4, 16, elev));
  tmpC.copy(NIGHT_FOG).lerp(DAY_FOG, day).lerp(DUSK_FOG, dusk * 0.5 * (1 - clouds));
  // nublado: neblina mais cinza; chuva: mais densa
  tmpC.lerp(GRAY_FOG.clone().multiplyScalar(0.25 + 0.75 * day), Math.max(0, clouds - 0.3) * 0.9);
  // chuva forte escurece o horizonte (senão a faixa sob as nuvens fica clara demais)
  tmpC.multiplyScalar(1 - 0.4 * rain);
  (p.scene.fog as THREE.FogExp2).color.copy(tmpC);
  // vista do alto (mapa inteiro): o ar entre a câmera e o chão é menos espesso que o do horizonte
  const high = 1 / (1 + Math.max(0, eyeHeight - 400) / 1200);
  (p.scene.fog as THREE.FogExp2).density = 0.000045 * (1 + 0.8 * clouds + 4 * rain) * high * fogLevel.value;
  (p.scene.background as THREE.Color).copy(tmpC);
  p.sky.visible = elev > -9;
}
