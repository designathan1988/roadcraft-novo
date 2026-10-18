// Imagem final: sombras do sol em 3 cascatas (só perto), oclusão de ambiente
// (GTAO em meia resolução), brilho das luzes à noite (bloom), suavização
// temporal (TRAA) e o mapeamento de tons. Cada parte liga e desliga pelas opções; no modo de
// compatibilidade (WebGL 2) tudo fica desligado.

import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa as traaNode, traaDebug } from './traa.ts';
import { T, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { stableVelocity, updateVelocityCamera } from './velocity.ts';

const traa = traaNode as unknown as (color: Node, depth: Node, velocity: Node, camera: THREE.Camera) => Node;
const { pass, mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, sample, vec4, vec3, mix, float, dot, renderOutput, smoothstep, max, min, clamp, screenUV } = T;

export interface PostOptions { shadows: boolean; ao: boolean; bloom: boolean }

/** Material transparente só pinta a cor: deixa a normal e a velocidade do que está atrás
 *  (a oclusão e o TRAA leem essas camadas; senão chuva e nuvens viram riscos e manchas). */
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
    // sombras em cascata: só até onde a sombra ainda passa de um pixel útil
    if (opts.shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 4000;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.4;
      const csm = new CSMShadowNode(sun, { cascades: 3, maxFar: 1600, mode: 'practical', lightMargin: 300 });
      csm.fade = true;
      sun.shadow.shadowNode = csm;
      this.csm = csm;
    }

    this.pipeline = new THREE.RenderPipeline(renderer);
    // sem MSAA: a suavização é temporal (TRAA), que também limpa o ruído da oclusão
    const scenePass = pass(scene, camera, { samples: 0 });
    this.scenePass = scenePass;
    // normal e velocidade misturam pelo material: o opaco sobrescreve, o transparente de colorOnly não mexe
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
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 3.5;
      aoPass.distanceExponent.value = 1.5;
      aoPass.thickness.value = 2;
      const clean: Node = denoise(aoPass.getTextureNode(), depth, normal, camera);
      const occ = clean.r;
      color = vec4(color.rgb.mul(mix(float(1), occ, 0.85)), color.a);
    }
    // uma suavização (TRAA) por saída: um mesmo TRAA em duas imagens finais perde o histórico e a imagem
    // inteira tremia nas bordas (10% dos pixels mudando com tudo parado)
    const aa = traa(color, depthTex, scenePass.getTextureNode('velocity'), camera);
    this.camera = camera;
    this.traas = [aa];
    // acabamento da cor: saturação +18% e contraste leve em volta do meio-tom (antes do AgX da saída)
    // acabamento como o do roadcraft, depois do AgX e do sRGB (na cor da tela): curva S de contraste, vibração
    // (realça só as cores fracas), luzes um pouco quentes e bordas da tela levemente escuras
    const grade = (c: Node): Node => {
      const hdrLuma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      const pre = mix(vec3(hdrLuma, hdrLuma, hdrLuma), c.rgb, 1.08);
      const d = renderOutput(vec4(pre, 1)).rgb;
      const sCurve = mix(d, smoothstep(0, 1, d), 0.22);
      const l = dot(sCurve, vec3(0.2126, 0.7152, 0.0722));
      const sat = max(max(sCurve.r, sCurve.g), sCurve.b).sub(min(min(sCurve.r, sCurve.g), sCurve.b));
      const vib = mix(vec3(l, l, l), sCurve, float(1).add(float(1).sub(sat).mul(0.3)));
      const warm = vib.add(vec3(0.02, 0.008, -0.014).mul(smoothstep(0.55, 1, l)));
      const r = screenUV.sub(0.5).length().mul(1.35);
      const vig = mix(float(1), float(0.84), smoothstep(0.45, 1.05, r));
      return vec4(clamp(warm.mul(vig), 0, 1), 1);
    };
    // a conversão para a tela já foi feita dentro do acabamento
    this.pipeline.outputColorTransform = false;
    this.dayOut = grade(aa);
    this.nightOut = this.dayOut;
    if (opts.bloom) {
      // só as luzes fortes (janelas, postes, faróis), à noite e no entardecer. Depois do TRAA: sobre a imagem
      // já resolvida (antes dele, o brilho do quadro tremido entrava na história e a imagem chuviscava).
      // De dia o brilho quase não aparece e a passada custa: a saída de dia não tem bloom.
      const aaN = traa(color, depthTex, scenePass.getTextureNode('velocity'), camera);
      this.traas.push(aaN);
      const b = bloom(aaN, 0.6, 0.35, 0.9);
      b.strength = nightU.mul(0.55).add(0.08);
      this.nightOut = grade(aaN.add(b));
    }
    // depuração da estabilidade da imagem (ver CLAUDE.md "Traps"):
    //  ?semtraa  imagem sem a suavização temporal (sem jitter): o piso da diferença entre quadros parados;
    //  ?traadbg  vermelho = histórico recusado, verde = peso do quadro atual, azul = desoclusão (parado: quase preto);
    //  ?vel      velocidade ×5000 (vermelho x, verde y, azul = NaN); com a câmera parada tem de ficar escuro.
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    if (q?.has('semtraa')) this.dayOut = this.nightOut = grade(color);
    if (q?.has('traadbg')) { traaDebug.value = 1; this.dayOut = this.nightOut = aa; }
    if (q?.has('vel')) {
      const v = scenePass.getTextureNode('velocity');
      const nan = v.x.equal(v.x).not().or(v.y.equal(v.y).not());
      // + o TRAA em quantidade nula: ele precisa estar no grafo (é ele quem põe o jitter na câmera)
      this.dayOut = this.nightOut = T.select(nan, vec4(0, 0, 1, 1), vec4(min(v.x.abs().mul(5000), 1), min(v.y.abs().mul(5000), 1), 0.12, 1)).add(aa.mul(1e-6));
    }
    this.pipeline.outputNode = this.nightOut;
    this.active = this.nightOut;
  }

  private traas: Node[] = [];
  private camera: THREE.Camera;
  private dayOut: Node;
  private nightOut: Node;
  private active: Node | null = null;
  /** Força a saída com bloom (aquecimento: compila as duas). */
  bloomOverride: boolean | null = null;

  /** A câmera ativa mudou (perspectiva/isométrica). */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    if (this.scenePass.camera !== camera) {
      this.scenePass.camera = camera;
      for (const t of this.traas) t.camera = camera;
      if (this.csm) this.csm.camera = camera as THREE.PerspectiveCamera;
    }
  }

  render(): void {
    // troca só quando muda (guardada aqui: refazer a imagem final a cada quadro zera o histórico do TRAA)
    const want = (this.bloomOverride ?? nightU.value > 0.04) ? this.nightOut : this.dayOut;
    if (this.active !== want) { this.active = want; this.pipeline.outputNode = want; this.pipeline.needsUpdate = true; }
    updateVelocityCamera(this.camera);
    this.pipeline.render();
  }

  dispose(): void { this.pipeline.dispose(); void this.renderer; }
}
