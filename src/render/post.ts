// Final image: the sun's shadows in 3 cascades (near only), ambient occlusion (GTAO at half resolution), the glow
// of lights at night (bloom), temporal anti-aliasing (TRAA), ACES tone mapping and Roadcraft's grade (CAS sharpening,
// S curve, vibrance, split toning, vignette). Each part switches with the options; in compatibility mode (WebGL 2)
// everything is off.

import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa as traaNode, traaDebug } from './traa.ts';
import { T, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { SHADOW_REACH } from './sun.ts';
import { stableVelocity, updateVelocityCamera } from './velocity.ts';

const traa = traaNode as unknown as (color: Node, depth: Node, velocity: Node, camera: THREE.Camera) => Node;
const {
  pass, mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, sample, vec2, vec4, vec3, mix, float, dot, renderOutput,
  smoothstep, max, min, clamp, screenUV, select, pow, sqrt, screenSize, cameraProjectionMatrix,
} = T;

/** How far the sun's shadows reach from the perspective camera (m). */
const PERSP_SHADOW_FAR = SHADOW_REACH;

/** CAS strength (Roadcraft's "high" quality: 0.35). */
const SHARPEN = 0.35;

export interface PostOptions { shadows: boolean; ao: boolean; bloom: boolean }

/** A transparent material paints colour only: it leaves the normal and velocity of what is behind it (the occlusion
 *  and the TRAA read those layers; otherwise rain and clouds turn into streaks and smudges). */
export function colorOnly<M extends THREE.NodeMaterial>(m: M): M {
  m.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0), velocity: vec4(0, 0, 0, 0) });
  return m;
}

export class Post {
  readonly pipeline: THREE.RenderPipeline;
  private scenePass: Node;
  private renderer: THREE.WebGPURenderer;
  readonly csm: CSMShadowNode | null = null;
  opts: PostOptions;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, sun: THREE.DirectionalLight, opts: PostOptions) {
    this.renderer = renderer;
    this.opts = opts;
    this.sun = sun;
    // cascaded shadows: only as far as a shadow still covers a useful pixel
    if (opts.shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 4000;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.4;
      const csm = new CSMShadowNode(sun, { cascades: 3, maxFar: PERSP_SHADOW_FAR, mode: 'practical', lightMargin: 300 });
      csm.fade = true;
      sun.shadow.shadowNode = csm;
      this.csm = csm;
    }

    this.pipeline = new THREE.RenderPipeline(renderer);
    // no MSAA: anti-aliasing is temporal (TRAA), which also cleans the occlusion's noise
    const scenePass = pass(scene, camera, { samples: 0 });
    this.scenePass = scenePass;
    this.owned.push(scenePass);
    // normal and velocity blend by material: opaque overwrites, colorOnly's transparent leaves them
    const outs = mrt({ output, normal: packNormalToRGB(normalView), velocity: stableVelocity });
    outs.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
    outs.setBlendMode('velocity', new THREE.BlendMode(THREE.MaterialBlending));
    scenePass.setMRT(outs);
    const nTex = scenePass.getTexture('normal');
    nTex.type = THREE.UnsignedByteType;
    let color: Node = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    if (opts.ao) {
      const normal = sample((uv: Node) => unpackRGBToNormal(scenePass.getTextureNode('normal').sample(uv)));
      const depth = depthTex;
      const aoPass = ao(depth, normal, camera);
      this.owned.push(aoPass);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 3.5;
      aoPass.distanceExponent.value = 1.5;
      aoPass.thickness.value = 2;
      const clean: Node = denoise(aoPass.getTextureNode(), depth, normal, camera);
      this.owned.push(clean);
      const occ = clean.r;
      color = vec4(color.rgb.mul(mix(float(1), occ, 0.85)), color.a);
    }
    // one TRAA per output: one TRAA shared by two final images loses its history and the whole image shook at the
    // edges (10% of the pixels changing with everything still)
    const aa = traa(color, depthTex, scenePass.getTextureNode('velocity'), camera);
    this.ownTraa(aa);
    this.camera = camera;
    this.traas = [aa];

    // Grade as Roadcraft's GRADED_OUTPUT_FRAGMENT, after the tone mapping and the sRGB transfer (display colour).
    const toDisplay = (c: Node): Node => renderOutput(vec4(c.rgb, 1)).rgb;
    // CAS only where a pixel spans little ground (10-30 cm, as Roadcraft's sharp mask), never on the sky
    const viewZ = scenePass.getViewZNode('depth');
    const persp = cameraProjectionMatrix.element(2).element(3).lessThan(-0.5);
    const span = select(persp, viewZ.negate(), float(1)).mul(2).div(cameraProjectionMatrix.element(1).element(1).mul(screenSize.y));
    const sharpMask = float(1).sub(smoothstep(0.1, 0.3, span)).mul(depthTex.sample(screenUV).r.greaterThan(0).toFloat());
    /** What CAS (AMD FidelityFX, sharpen-only path) changes on the displayed pixel, from the resolved image's taps.
     *  A delta so the night output can add it to the image with bloom (the bloom itself is never sharpened). */
    const casDelta = (srcNode: Node): Node => {
      // the TRAA node renders into its own target: its texture is what can be sampled at the neighbours
      const src = srcNode.getTextureNode ? srcNode.getTextureNode() : srcNode;
      const px = vec2(1, 1).div(screenSize);
      const tap = (dx: number, dy: number) => pow(toDisplay(src.sample(screenUV.add(px.mul(vec2(dx, dy))))), vec3(2.2));
      const cl = pow(toDisplay(src.sample(screenUV)), vec3(2.2));
      const b = tap(0, -1), d = tap(-1, 0), f = tap(1, 0), h = tap(0, 1);
      const mn = min(min(min(d, cl), min(f, b)), h);
      const mx = max(max(max(d, cl), max(f, b)), h);
      const amp = sqrt(clamp(min(mn, vec3(1, 1, 1).sub(mx)).div(max(mx, vec3(1e-4, 1e-4, 1e-4))), 0, 1));
      const w = amp.g.mul(-1 / (8 + (5 - 8) * SHARPEN));
      const sharp = clamp(b.add(d).add(f).add(h).mul(w).add(cl).div(w.mul(4).add(1)), 0, 1);
      return pow(sharp, vec3(1 / 2.2)).sub(pow(cl, vec3(1 / 2.2))).mul(sharpMask);
    };
    const grade = (c: Node, src: Node): Node => {
      let d: Node = clamp(toDisplay(c).add(casDelta(src)), 0, 1);
      const l = dot(d, vec3(0.2126, 0.7152, 0.0722));
      // contrast: an S round the middle grey
      d = mix(d, smoothstep(0, 1, d), 0.35);
      // vibrance: the dull colours gain more than the vivid
      const sat = max(max(d.r, d.g), d.b).sub(min(min(d.r, d.g), d.b));
      d = mix(vec3(l, l, l), d, float(1).add(float(1).sub(sat).mul(0.3)));
      // split toning: warm highlights, cool shadows
      d = d.add(vec3(0.02, 0.008, -0.014).mul(smoothstep(0.15, 0.85, l)));
      const q = screenUV.sub(0.5);
      const vig = mix(float(1), float(0.78), smoothstep(0.3, 0.85, dot(q, q).mul(2.4)));
      return vec4(clamp(d.mul(vig), 0, 1), 1);
    };
    // the conversion to the screen is done inside the grade
    this.pipeline.outputColorTransform = false;
    this.dayOut = grade(aa, aa);
    this.nightOut = this.dayOut;
    if (opts.bloom) {
      // only the strong lights (windows, lamps, headlights), at night and at dusk. After the TRAA: over the resolved
      // image (before it, the glow of the jittered frame went into the history and the image drizzled).
      // By day the glow hardly shows and the pass costs: the day output has no bloom.
      const aaN = traa(color, depthTex, scenePass.getTextureNode('velocity'), camera);
      this.ownTraa(aaN);
      this.traas.push(aaN);
      const b = bloom(aaN, 0.6, 0.35, 0.9);
      this.owned.push(b);
      b.strength = nightU.mul(0.55).add(0.08);
      this.nightOut = grade(aaN.add(b), aaN);
    }
    // image stability debugging (see CLAUDE.md "Traps"):
    //  ?semtraa  image without temporal anti-aliasing (no jitter): the floor of the difference between still frames;
    //  ?traadbg  red = history rejected, green = current frame weight, blue = disocclusion (still: almost black);
    //  ?vel      velocity ×5000 (red x, green y, blue = NaN); with the camera still it must stay dark.
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    if (q?.has('semtraa')) this.dayOut = this.nightOut = grade(color, scenePass.getTextureNode('output'));
    if (q?.has('traadbg')) { traaDebug.value = 1; this.dayOut = this.nightOut = aa; }
    if (q?.has('vel')) {
      const v = scenePass.getTextureNode('velocity');
      const nan = v.x.equal(v.x).not().or(v.y.equal(v.y).not());
      // + the TRAA at zero weight: it has to be in the graph (it is what jitters the camera)
      this.dayOut = this.nightOut = T.select(nan, vec4(0, 0, 1, 1), vec4(min(v.x.abs().mul(5000), 1), min(v.y.abs().mul(5000), 1), 0.12, 1)).add(aa.mul(1e-6));
    }
    this.pipeline.outputNode = this.nightOut;
    this.active = this.nightOut;
  }

  private traas: Node[] = [];
  /** Nodes holding GPU targets (the scene pass, AO, bloom, anti-aliasing and the image copied into it). */
  private owned: Array<{ dispose(): void }> = [];
  private sun: THREE.DirectionalLight;

  /** The anti-aliasing node and, when the image fed to it had to be copied into a texture, that copy. */
  private ownTraa(n: Node): void {
    this.owned.push(n);
    const beauty = (n as unknown as { beautyNode?: { isRTTNode?: boolean; dispose(): void } }).beautyNode;
    if (beauty?.isRTTNode) this.owned.push(beauty);
  }
  private camera: THREE.Camera;
  private dayOut: Node;
  private nightOut: Node;
  private active: Node | null = null;
  /** Forces the output with bloom (warm-up: compiles both). */
  bloomOverride: boolean | null = null;

  /** The active camera changed (perspective/isometric). */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    if (this.scenePass.camera !== camera) {
      this.scenePass.camera = camera;
      for (const t of this.traas) t.camera = camera;
      // GTAO and its denoise hold the matrices (and near/far) of the camera they were made with: in the isometric
      // view they unprojected the depth with the perspective camera's
      type CamUniforms = { _cameraProjectionMatrix?: { value: unknown }; _cameraProjectionMatrixInverse?: { value: unknown }; _cameraNear?: { object: unknown }; _cameraFar?: { object: unknown } };
      for (const n of this.owned as CamUniforms[]) {
        if (n._cameraProjectionMatrix) n._cameraProjectionMatrix.value = camera.projectionMatrix;
        if (n._cameraProjectionMatrixInverse) n._cameraProjectionMatrixInverse.value = camera.projectionMatrixInverse;
        if (n._cameraNear) n._cameraNear.object = camera;
        if (n._cameraFar) n._cameraFar.object = camera;
      }
    }
    this.fitCascades(camera);
  }

  /** Projection the cascades were last split for. */
  private cascadeProj = new THREE.Matrix4();
  private cascadeCam: THREE.Camera | null = null;

  /**
   * The cascades are split from the camera's projection: three does it once, for the camera of the first frame. Again
   * when the camera changes (the isometric camera sits 1.2-10 km from the ground, past the perspective camera's 1.6 km
   * of shadow: no sun shadow at all) or its projection does (a resize: the sides of the view lost their shadow).
   */
  private fitCascades(camera: THREE.Camera): void {
    const csm = this.csm as (CSMShadowNode & { mainFrustum: unknown }) | null;
    if (!csm || !csm.mainFrustum) return;
    if (this.cascadeCam === camera && this.cascadeProj.equals(camera.projectionMatrix)) return;
    this.cascadeCam = camera;
    this.cascadeProj.copy(camera.projectionMatrix);
    csm.camera = camera as THREE.PerspectiveCamera;
    // isometric: the whole depth of its view (the ground is `reach` away); perspective: shadows up to 1.6 km
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
    csm.maxFar = ortho ? (camera as THREE.OrthographicCamera).far : PERSP_SHADOW_FAR;
    csm.updateFrustums();
  }

  // what the cascades were last drawn for
  private shadowView = new THREE.Matrix4();
  private shadowProj = new THREE.Matrix4();
  private shadowSun = new THREE.Vector3();
  private shadowDirty = true;

  /** Something that casts changed (a mesh came, left or was rebuilt): the cascades are redrawn next frame. */
  invalidateShadows(): void { this.shadowDirty = true; }

  /**
   * The 3 cascades are drawn only when something in them can have changed: the camera or its projection (the cascades
   * follow the view), the sun, the city (`invalidateShadows`), or casters that move (`moving`: traffic and people
   * walking, trees in the wind). Still, the maps of the last frame are reused (they used to be redrawn every frame).
   */
  prepareShadows(moving: boolean): void {
    const csm = this.csm as (CSMShadowNode & { lights: Array<{ shadow: THREE.LightShadow }> }) | null;
    if (!csm || csm.lights.length === 0) return;
    const cam = this.camera;
    const still = !moving && !this.shadowDirty && this.shadowView.equals(cam.matrixWorld) && this.shadowProj.equals(cam.projectionMatrix) && this.shadowSun.equals(this.sun.position);
    this.shadowView.copy(cam.matrixWorld);
    this.shadowProj.copy(cam.projectionMatrix);
    this.shadowSun.copy(this.sun.position);
    this.shadowDirty = false;
    for (const l of csm.lights) { l.shadow.autoUpdate = false; l.shadow.needsUpdate = !still; }
  }

  /** `moving`: casters that move this frame (see prepareShadows). */
  render(moving = true): void {
    this.prepareShadows(moving);
    // switch only when it changes (kept here: rebuilding the final image every frame zeroes the TRAA's history)
    const want = (this.bloomOverride ?? nightU.value > 0.04) ? this.nightOut : this.dayOut;
    if (this.active !== want) { this.active = want; this.pipeline.outputNode = want; this.pipeline.needsUpdate = true; }
    updateVelocityCamera(this.camera);
    this.pipeline.render();
  }

  /**
   * Frees everything this final image holds on the GPU. Rebuilding it (shadows, occlusion or bloom switched in the
   * options) used to free only the pipeline's quad: the scene targets, the AO, bloom and anti-aliasing targets and the
   * three cascade shadow maps stayed, 100-200 MB per change.
   */
  dispose(): void {
    for (const n of this.owned) n.dispose();
    this.owned.length = 0;
    if (this.csm) {
      for (const s of (this.csm as unknown as { _shadowNodes: Array<{ dispose(): void }> })._shadowNodes) s.dispose();
      this.csm.dispose();
      if ((this.sun.shadow as { shadowNode?: unknown }).shadowNode === this.csm) (this.sun.shadow as { shadowNode?: unknown }).shadowNode = null;
    }
    this.pipeline.dispose();
    void this.renderer;
  }
}
