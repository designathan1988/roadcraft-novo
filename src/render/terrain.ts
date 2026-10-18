// Terreno CDLOD: uma malha de grade instanciada, uma chamada de desenho.
// A altura vem de uma textura em camadas (uma por ladrilho), lida no vertex
// shader com interpolação bilinear manual, igual à de world/heights.ts.
// Seleção dos nós por quadtree a partir da câmera: custo proporcional ao que se vê.

import * as THREE from 'three/webgpu';
import { currentU, foamU, waveU } from './scene.ts';


import { T, withPrevious, type Node } from './tsl.ts';
import { GRASS_TEX, GRASS_TILE } from './surfaceBake.ts';

/** Grade no mapa ligada (0/1). */
export const gridU = T.uniform(0);

const {
  Fn, attribute, clamp, float, floor, fract, int, ivec2, max, mix, normalize, smoothstep, textureLoad,
  transformNormalToView, uniform, varyingProperty, vec2, vec3, vec4, length, abs, sRGBTransferEOTF,
  positionWorld, fwidth, mx_noise_float, select, texture,
} = T;
import {
  HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_HALF, MAP_SIZE, MAP_TILES, PLATE_SIZE, SEA_LEVEL, TILE_SIZE,
} from '../config.ts';
import { tileX, tileId } from '../core/grid.ts';
import { PAINT_COARSE } from '../jobs/roadPaint.ts';
import { GROUND_COLORS, NO_WATER, WATER_SPACING, WATER_TILE_RES } from '../world/ground.ts';

/** Cor de cada tipo de chão (sRGB). */
const GROUND_TABLE = T.uniformArray(GROUND_COLORS.concat(new Array(16 - GROUND_COLORS.length).fill(0x6b8545)).map((h) => new THREE.Vector4(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, 1)), 'vec4');
import type { World } from '../world/world.ts';

const GRID = 32; // quadrados por lado do remendo
const LEAF = 128; // lado do nó mais fino (m) → 4 m entre vértices
const LEVELS = Math.log2(PLATE_SIZE / LEAF) + 1; // 0..4
const MAX_NODES = 4096;

type N = Node;

export class TerrainRenderer {
  readonly mesh: THREE.Mesh;
  readonly heightTex: THREE.DataArrayTexture;
  /** Vias pintadas (longe): fina 256² e grossa 32² por ladrilho. */
  readonly paintFine: THREE.DataArrayTexture;
  readonly paintCoarse: THREE.DataArrayTexture;
  /** Chão pintado (tipo, força, floresta, clareira) por amostra de 4 m. */
  readonly groundTex: THREE.DataArrayTexture;
  /** Nível da água (8 m) e a malha dela (só nos ladrilhos com água). */
  readonly waterTex: THREE.DataArrayTexture;
  readonly waterMesh: THREE.Mesh;
  private waterGeo: THREE.InstancedBufferGeometry;
  private waterInst: THREE.InstancedBufferAttribute;
  /** Cores da grama pelo bioma. */
  readonly grassA: Node = uniform(new THREE.Color().setRGB(0.275, 0.39, 0.185, THREE.LinearSRGBColorSpace));
  readonly grassB: Node = uniform(new THREE.Color().setRGB(0.345, 0.447, 0.227, THREE.LinearSRGBColorSpace));
  private geometry: THREE.InstancedBufferGeometry;
  private inst: THREE.InstancedBufferAttribute;
  private instArray: Float32Array;
  private ranges = new Float64Array(LEVELS + 1);
  private count = 0;
  private world: World;
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3();
  private camPos = new THREE.Vector3();

  /** Posição do pincel (x, z, raio, visível). */
  readonly brush: Node = uniform(new THREE.Vector4(0, 0, 50, 0));
  readonly camUniform: Node = uniform(new THREE.Vector3());
  readonly rangeBase: Node = uniform(0);
  /** Fator de distância das faixas de LOD (maior = mais detalhe). */
  lodFactor = 5;

  constructor(world: World) {
    this.world = world;
    this.heightTex = new THREE.DataArrayTexture(world.heights, HEIGHT_TILE_RES, HEIGHT_TILE_RES, MAP_TILES * MAP_TILES);
    this.heightTex.format = THREE.RedFormat;
    this.heightTex.type = THREE.FloatType;
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    const mkPaint = (res: number) => {
      const t = new THREE.DataArrayTexture(new Uint8Array(res * res * 4 * MAP_TILES * MAP_TILES), res, res, MAP_TILES * MAP_TILES);
      t.format = THREE.RGBAFormat;
      t.type = THREE.UnsignedByteType;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.paintFine = mkPaint(HEIGHT_TILE_RES);
    this.paintCoarse = mkPaint(PAINT_COARSE);
    this.groundTex = new THREE.DataArrayTexture(new Uint8Array(world.groundSab), WATER_TILE_RES, WATER_TILE_RES, MAP_TILES * MAP_TILES);
    this.groundTex.format = THREE.RGBAFormat;
    this.groundTex.type = THREE.UnsignedByteType;
    this.groundTex.minFilter = THREE.NearestFilter;
    this.groundTex.magFilter = THREE.NearestFilter;
    this.groundTex.generateMipmaps = false;
    this.groundTex.needsUpdate = true;
    this.waterTex = new THREE.DataArrayTexture(world.water, WATER_TILE_RES, WATER_TILE_RES, MAP_TILES * MAP_TILES);
    this.waterTex.format = THREE.RedFormat;
    this.waterTex.type = THREE.FloatType;
    this.waterTex.minFilter = THREE.NearestFilter;
    this.waterTex.magFilter = THREE.NearestFilter;
    this.waterTex.generateMipmaps = false;
    this.waterTex.needsUpdate = true;

    // grade unitária (u, v) em [0, 1]
    const g = new THREE.InstancedBufferGeometry();
    const verts = (GRID + 1) * (GRID + 1);
    const pos = new Float32Array(verts * 3);
    for (let j = 0, k = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++, k += 3) { pos[k] = i / GRID; pos[k + 2] = j / GRID; }
    const idx = new Uint16Array(GRID * GRID * 6);
    for (let j = 0, k = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++, k += 6) {
        const a = j * (GRID + 1) + i, b = a + 1, c = a + GRID + 1, d = c + 1;
        // diagonal alternada evita viés visual
        if ((i + j) & 1) { idx.set([a, c, b, b, c, d], k); } else { idx.set([a, c, d, a, d, b], k); }
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.instArray = new Float32Array(MAX_NODES * 4);
    this.inst = new THREE.InstancedBufferAttribute(this.instArray, 4);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('node', this.inst);
    g.instanceCount = 0;
    this.geometry = g;

    this.mesh = new THREE.Mesh(g, this.createMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;

    // água de rios e lagos: grade de 8 m por ladrilho, instanciada nos ladrilhos com água
    const wg = new THREE.InstancedBufferGeometry();
    const WR = WATER_TILE_RES;
    const wpos = new Float32Array((WR + 1) * (WR + 1) * 3);
    for (let j = 0, k = 0; j <= WR; j++) for (let i = 0; i <= WR; i++, k += 3) { wpos[k] = i / WR; wpos[k + 2] = j / WR; }
    const widx = new Uint32Array(WR * WR * 6);
    for (let j = 0, k = 0; j < WR; j++) for (let i = 0; i < WR; i++, k += 6) {
      const a = j * (WR + 1) + i, b = a + 1, c = a + WR + 1, d = c + 1;
      widx.set([a, c, b, b, c, d], k);
    }
    wg.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    wg.setIndex(new THREE.BufferAttribute(widx, 1));
    this.waterInst = new THREE.InstancedBufferAttribute(new Float32Array(MAP_TILES * MAP_TILES), 1);
    this.waterInst.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('wtile', this.waterInst);
    wg.instanceCount = 0;
    this.waterGeo = wg;
    this.waterMesh = new THREE.Mesh(wg, this.createWaterMaterial());
    this.waterMesh.frustumCulled = false;
    this.setLodFactor(this.lodFactor);
  }

  setLodFactor(f: number): void {
    this.lodFactor = f;
    for (let l = 0; l <= LEVELS; l++) this.ranges[l] = LEAF * (1 << l) * f;
    this.rangeBase.value = LEAF * f;
  }

  private createMaterial(): THREE.MeshStandardNodeMaterial {
    const tex = this.heightTex;
    const RES = HEIGHT_TILE_RES * MAP_TILES;

    const loadH = (gx: N, gz: N) => {
      const cx = clamp(gx, int(0), int(RES - 1));
      const cz = clamp(gz, int(0), int(RES - 1));
      const layer = cz.shiftRight(int(8)).mul(int(MAP_TILES)).add(cx.shiftRight(int(8)));
      return textureLoad(tex, ivec2(cx.bitAnd(int(255)), cz.bitAnd(int(255)))).depth(layer).r;
    };

    const gtex = this.groundTex;
    const GRES = WATER_TILE_RES * MAP_TILES;
    const loadG = (gx: N, gz: N) => {
      const cx = clamp(gx, int(0), int(GRES - 1));
      const cz = clamp(gz, int(0), int(GRES - 1));
      const layer = cz.shiftRight(int(7)).mul(int(MAP_TILES)).add(cx.shiftRight(int(7)));
      return textureLoad(gtex, ivec2(cx.bitAnd(int(127)), cz.bitAnd(int(127)))).depth(layer);
    };

    const heightAt = Fn(([p]: [N]) => {
      const f = p.add(float(MAP_HALF)).div(float(HEIGHT_SPACING));
      const i = floor(f);
      const t = f.sub(i);
      const ix = int(i.x), iz = int(i.y);
      const h00 = loadH(ix, iz), h10 = loadH(ix.add(1), iz);
      const h01 = loadH(ix, iz.add(1)), h11 = loadH(ix.add(1), iz.add(1));
      return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
    });

    const vNormal = varyingProperty('vec3', 'vTerrainNormal');
    const vMorph = varyingProperty('float', 'vTerrainMorph');
    const cam = this.camUniform;
    const rangeBase = this.rangeBase;

    const position = Fn(() => {
      const node = attribute('node', 'vec4');
      const uv = attribute('position', 'vec3').xz;
      const size = node.z;
      const level = node.w;
      const step = size.div(float(GRID));
      const xz = node.xy.add(uv.mul(size));
      const h0 = heightAt(xz);
      const dist = length(vec3(xz.x, h0, xz.y).sub(cam));
      const range = rangeBase.mul(level.exp2());
      const morph = clamp(dist.sub(range.mul(0.72)).div(range.mul(0.28)), 0, 1);
      // vértices ímpares escorregam para a grade do nível de cima
      const g = uv.mul(float(GRID));
      const odd = fract(g.mul(0.5)).mul(2);
      const mxz = xz.sub(odd.mul(step).mul(morph));
      // sob as vias, nos níveis grossos: o triângulo de 8-64 m não segue o corte/aterro conformado e subia por cima
      // da pista e da calçada ao longe (a pista "piscava" sumindo no gramado). Desce proporcional ao passo do nível,
      // pela máscara das vias (a mesma que pinta o chão); no nível de 4 m nada muda.
      const tileF = clamp(floor(mxz.add(float(MAP_HALF)).div(float(TILE_SIZE))), 0, float(MAP_TILES - 1));
      const layerV = int(tileF.y.mul(MAP_TILES).add(tileF.x));
      const uvV = mxz.add(float(MAP_HALF)).div(float(TILE_SIZE)).sub(tileF);
      const fineV = texture(this.paintFine, uvV).depth(layerV).level(0);
      const coarseV = texture(this.paintCoarse, uvV).depth(layerV).level(0);
      const cover = max(max(fineV.x, fineV.y), smoothstep(0, 0.25, max(coarseV.x, coarseV.y)));
      const spacing = step.mul(morph.add(1));
      // under the roads the terrain also drops 0.4 m at the finest level: the 4 m grid does not follow the junction
      // fans and corners, and it surfaced through the asphalt in the middle of junctions (the road skirts reach 0.7 m)
      const sink = cover.mul(clamp(spacing.sub(float(HEIGHT_SPACING)).mul(0.08), 0, 3).add(smoothstep(0.35, 0.7, cover).mul(0.4)));
      const y = heightAt(mxz).sub(sink);
      // normal por diferenças centrais na escala do nível
      const e = max(step, float(HEIGHT_SPACING));
      const hl = heightAt(mxz.sub(vec2(e, 0))), hr = heightAt(mxz.add(vec2(e, 0)));
      const hd = heightAt(mxz.sub(vec2(0, e))), hu = heightAt(mxz.add(vec2(0, e)));
      vNormal.assign(normalize(vec3(hl.sub(hr), e.mul(2), hd.sub(hu))));
      vMorph.assign(morph);
      return vec3(mxz.x, y, mxz.y);
    });

    const m = new THREE.MeshStandardNodeMaterial();
    m.positionNode = position();
    withPrevious(m);
    m.normalNode = transformNormalToView(normalize(vNormal));

    // cor: grama, terra, rocha, areia, por inclinação e altura, com variação larga
    const color = Fn(() => {
      const n = normalize(vNormal);
      const p = positionWorld;
      const slope = float(1).sub(n.y);
      const big = mx_noise_float(p.xz.mul(1 / 180)).mul(0.5).add(0.5);
      const mid = mx_noise_float(p.xz.mul(1 / 23));
      // some com a distância antes de virar ruído (fwidth > período)
      const fadeMid = clamp(float(1).sub(fwidth(p.xz.x).div(6)), 0, 1);
      const grassA = sRGBTransferEOTF(this.grassA);
      const grassB = sRGBTransferEOTF(this.grassB);
      const dirt = sRGBTransferEOTF(vec3(0.52, 0.45, 0.36));
      const rock = sRGBTransferEOTF(vec3(0.47, 0.46, 0.44));
      const sand = sRGBTransferEOTF(vec3(0.72, 0.66, 0.52));
      let c = mix(grassA, grassB, clamp(big.add(mid.mul(0.22).mul(fadeMid)), 0, 1)).mul(0.78);
      // gramado assado (tufos, terra nas falhas, manchas secas; `surfaceBake.ts`) em duas escalas para não repetir;
      // o mipmap leva a média de longe
      const g1 = texture(GRASS_TEX, p.xz.div(GRASS_TILE)).xyz.mul(2);
      const g2 = texture(GRASS_TEX, p.xz.div(GRASS_TILE * 4.37).add(0.37)).xyz.mul(2);
      c = c.mul(g1).mul(mix(vec3(1, 1, 1), g2, 0.45));
      const speck = clamp(g1.y.mul(0.5), 0, 1);
      c = mix(c, dirt, smoothstep(0.12, 0.25, slope.add(mid.mul(0.04).mul(fadeMid))));
      c = mix(c, rock, smoothstep(0.28, 0.42, slope));
      c = mix(c, sand, smoothstep(float(SEA_LEVEL + 2.5), float(SEA_LEVEL + 0.5), p.y));
      // chão pintado: 4 amostras vizinhas, cada uma com o seu tipo, misturadas (borda quebrada por ruído)
      {
        const f = p.xz.add(float(MAP_HALF)).div(float(WATER_SPACING)).sub(0.5).add(mid.mul(0.3).mul(fadeMid));
        const i0 = floor(f), t = fract(f);
        const ix = int(i0.x), iz = int(i0.y);
        const g00 = loadG(ix, iz), g10 = loadG(ix.add(1), iz), g01 = loadG(ix, iz.add(1)), g11 = loadG(ix.add(1), iz.add(1));
        const tint = (gs: N) => {
          const kind = int(floor(gs.r.mul(255).add(0.5)));
          const col = sRGBTransferEOTF(GROUND_TABLE.element(kind).xyz);
          // pedras e flores: textura miúda de pontos (o mesmo ruído das manchas, calculado uma vez)
          const pc = mix(col, col.mul(mix(float(0.75), float(1.2), speck)), fadeMid);
          const painted = mix(c, pc, gs.g);
          // floresta: chão escuro de folhas
          return mix(painted, sRGBTransferEOTF(vec3(0.24, 0.3, 0.16)), gs.b.mul(0.55));
        };
        const top = mix(tint(g00), tint(g10), t.x), bot = mix(tint(g01), tint(g11), t.x);
        c = mix(top, bot, t.y);
      }
      // vias pintadas no chão (visíveis onde a malha das vias não chega)
      const tileF = clamp(floor(p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE))), 0, float(MAP_TILES - 1));
      const layer = int(tileF.y.mul(MAP_TILES).add(tileF.x));
      const uvT = p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE)).sub(tileF);
      const fine = texture(this.paintFine, uvT).depth(layer);
      const coarse = texture(this.paintCoarse, uvT).depth(layer);
      const pix = fwidth(p.x).add(fwidth(p.z)).mul(0.5);
      const paint = mix(fine, coarse, smoothstep(5, 28, pix));
      c = mix(c, sRGBTransferEOTF(vec3(0.27, 0.28, 0.3)), paint.x);
      c = mix(c, sRGBTransferEOTF(vec3(0.72, 0.69, 0.64)), paint.y);
      // anel do pincel
      const b = this.brush;
      const d = length(p.xz.sub(b.xy));
      const w = max(fwidth(d), float(0.15)).mul(1.5);
      const ring = smoothstep(b.z.sub(w.mul(2)), b.z.sub(w), d).mul(smoothstep(b.z.add(w), b.z, d)).mul(b.w);
      const inner = smoothstep(b.z, float(0), d).mul(0.12).mul(b.w);
      c = mix(c, vec3(1.0, 0.85, 0.35), max(ring, inner));
      // grade no mapa (opcional): linhas a cada 64 m, mais fortes a cada 256 m; somem de longe
      const gl = (step: number, wid: number) => {
        const g2 = abs(fract(p.xz.div(step)).sub(0.5)).mul(step);
        const fw = max(fwidth(p.x), float(0.02)).mul(wid);
        return max(smoothstep(fw.mul(2), fw, g2.x.sub(step / 2).abs()), smoothstep(fw.mul(2), fw, g2.y.sub(step / 2).abs()));
      };
      const grid = max(gl(64, 1).mul(0.35), gl(256, 1.6).mul(0.6)).mul(gridU).mul(smoothstep(float(3), float(0.6), pix));
      c = mix(c, vec3(1, 1, 1), grid);
      // borda do mapa
      const edge = max(abs(p.x), abs(p.z));
      c = select(edge.greaterThan(float(MAP_HALF - 0.5)), c.mul(0.6), c);
      return vec4(c, 1);
    });
    m.colorNode = color();
    m.roughnessNode = float(0.95);
    m.metalnessNode = float(0);
    return m;
  }

  /** Água: superfície no nível guardado; cor pela profundidade (chão lido da mesma textura do terreno), espuma na margem. */
  private createWaterMaterial(): THREE.MeshStandardNodeMaterial {
    const tex = this.heightTex, wtex = this.waterTex;
    const RES = HEIGHT_TILE_RES * MAP_TILES, WRES = WATER_TILE_RES * MAP_TILES;
    const loadH = (gx: N, gz: N) => {
      const cx = clamp(gx, int(0), int(RES - 1)), cz = clamp(gz, int(0), int(RES - 1));
      const layer = cz.shiftRight(int(8)).mul(int(MAP_TILES)).add(cx.shiftRight(int(8)));
      return textureLoad(tex, ivec2(cx.bitAnd(int(255)), cz.bitAnd(int(255)))).depth(layer).r;
    };
    const loadW = (gx: N, gz: N) => {
      const cx = clamp(gx, int(0), int(WRES - 1)), cz = clamp(gz, int(0), int(WRES - 1));
      const layer = cz.shiftRight(int(7)).mul(int(MAP_TILES)).add(cx.shiftRight(int(7)));
      return textureLoad(wtex, ivec2(cx.bitAnd(int(127)), cz.bitAnd(int(127)))).depth(layer).r;
    };
    const vDepth = varyingProperty('float', 'vWaterDepth');
    const pos = Fn(() => {
      const tile = attribute('wtile', 'float');
      const tx = tile.mod(float(MAP_TILES)), tz = floor(tile.div(float(MAP_TILES)));
      const uv = attribute('position', 'vec3').xz;
      const xz = vec2(tx, tz).add(uv).mul(float(TILE_SIZE)).sub(float(MAP_HALF));
      // nível no vértice: o maior dos 4 vizinhos com água (a borda passa um pouco por baixo da margem)
      const g = xz.add(float(MAP_HALF)).div(float(WATER_SPACING));
      const ix = int(floor(g.x.add(0.5))), iz = int(floor(g.y.add(0.5)));
      const w = max(max(loadW(ix.sub(1), iz.sub(1)), loadW(ix, iz.sub(1))), max(loadW(ix.sub(1), iz), loadW(ix, iz)));
      const gh = loadH(int(floor(xz.x.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)))), int(floor(xz.y.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)))));
      vDepth.assign(w.sub(gh));
      // ondas: a superfície sobe e desce um pouco (até 0,35 m)
      const wave = T.sin(xz.x.mul(0.21).add(T.time.mul(1.3))).mul(T.sin(xz.y.mul(0.17).add(T.time.mul(1.1)))).mul(waveU.mul(0.35));
      // na foz (nível no do mar) a superfície do rio desce sob o plano do mar: com as ondas as duas se cruzavam e piscavam
      const surf = select(w.lessThan(float(SEA_LEVEL + 0.6)), float(SEA_LEVEL - 0.3), w.add(wave));
      const y = select(w.greaterThan(float(NO_WATER + 1)), surf, float(-2000));
      return vec3(xz.x, y, xz.y);
    });
    const m = new THREE.MeshStandardNodeMaterial();
    m.positionNode = pos();
    withPrevious(m);
    const p = positionWorld;
    // correnteza: o ruído escorre na direção do vento; ondas: mais forte e mais rápido; espuma: cristas brancas
    const flow = vec2(0.91, 0.41).mul(T.time.mul(currentU.mul(0.35).add(0.12)));
    const ripple = mx_noise_float(p.xz.mul(waveU.mul(0.08).add(0.1)).add(flow)).mul(0.5).add(0.5);
    const deep = sRGBTransferEOTF(vec3(0.03, 0.09, 0.11)), shallow = sRGBTransferEOTF(vec3(0.14, 0.26, 0.24));
    const depth = clamp(vDepth.div(3), 0, 1);
    const crest = smoothstep(float(1).sub(foamU.mul(0.35)), float(1.02), ripple).mul(waveU).mul(foamU);
    const foam = clamp(smoothstep(foamU.mul(0.5).add(0.15), 0.0, vDepth).mul(ripple.mul(0.6).add(0.4)).add(crest), 0, 1);
    m.colorNode = vec4(mix(mix(shallow, deep, depth), vec3(0.85, 0.88, 0.86), foam), 1);
    m.roughnessNode = mix(float(0.16), float(0.34), ripple.mul(waveU.add(0.4)));
    m.metalnessNode = float(0);
    m.maskNode = p.y.greaterThan(float(-1500));
    return m;
  }

  /** Bioma do mapa: cores da grama. */
  setBiome(b: number): void {
    const pal: Array<[number, number]> = [[0x46642f, 0x58723a], [0x9c9450, 0xb0a565], [0x4e7a35, 0x5f8a40], [0x3f6e2c, 0x4f7f34], [0x8a8458, 0x9e906a], [0x7a9a50, 0x92a860], [0x5f8a45, 0x7a9050]];
    const [a, c] = pal[b] ?? pal[0];
    // componentes sRGB guardados como estão (o shader converte)
    const set = (u: Node, h: number) => (u.value as THREE.Color).setRGB(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, THREE.LinearSRGBColorSpace);
    set(this.grassA, a); set(this.grassB, c);
  }

  /** Grava a pintura de vias de um ladrilho e reenvia só aquela camada. */
  setRoadPaint(tile: number, fine: Uint8Array, coarse: Uint8Array): void {
    (this.paintFine.image.data as Uint8Array).set(fine, tile * fine.length);
    (this.paintCoarse.image.data as Uint8Array).set(coarse, tile * coarse.length);
    this.paintFine.addLayerUpdate(tile);
    this.paintCoarse.addLayerUpdate(tile);
    this.paintFine.needsUpdate = true;
    this.paintCoarse.needsUpdate = true;
  }

  /** Reenvia à GPU só as camadas (ladrilhos) alteradas. */
  uploadDirtyLayers(): void {
    const w = this.world;
    if (w.groundDirty.size) { for (const l of w.groundDirty) this.groundTex.addLayerUpdate(l); w.groundDirty.clear(); this.groundTex.needsUpdate = true; }
    if (w.waterDirty.size) {
      for (const l of w.waterDirty) this.waterTex.addLayerUpdate(l);
      w.waterDirty.clear(); this.waterTex.needsUpdate = true;
      // ladrilhos com água (no máximo 100: lista refeita só quando a água muda)
      const a = this.waterInst.array as Float32Array;
      let n = 0;
      for (let t = 0; t < MAP_TILES * MAP_TILES; t++) if (w.tileWater[t]) a[n++] = t;
      this.waterGeo.instanceCount = n;
      this.waterInst.needsUpdate = true;
    }
    const dirty = this.world.layerDirty;
    if (dirty.size === 0) return;
    for (const l of dirty) this.heightTex.addLayerUpdate(l);
    dirty.clear();
    this.heightTex.needsUpdate = true;
  }

  /** Seleção CDLOD a partir da câmera. */
  update(camera: THREE.Camera, viewPos: THREE.Vector3): void {
    camera.updateMatrixWorld();
    const pv = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.camPos.copy(viewPos);
    this.camUniform.value.copy(viewPos);
    this.count = 0;
    const roots = Math.ceil(MAP_SIZE / PLATE_SIZE);
    const top = LEVELS - 1;
    for (let rz = 0; rz < roots; rz++) {
      for (let rx = 0; rx < roots; rx++) {
        const x = rx * PLATE_SIZE - MAP_HALF, z = rz * PLATE_SIZE - MAP_HALF;
        if (!this.select(x, z, PLATE_SIZE, top)) this.add(x, z, PLATE_SIZE, top);
      }
    }
    this.geometry.instanceCount = this.count;
    this.inst.clearUpdateRanges();
    this.inst.addUpdateRange(0, this.count * 4);
    this.inst.needsUpdate = true;
  }

  private add(x: number, z: number, size: number, level: number): void {
    if (this.count >= MAX_NODES) return;
    // nós que passam da borda do mapa (raízes de 2048 num mapa de 10240) são cortados
    if (x >= MAP_HALF || z >= MAP_HALF) return;
    const o = this.count * 4;
    this.instArray[o] = x; this.instArray[o + 1] = z; this.instArray[o + 2] = size; this.instArray[o + 3] = level;
    this.count++;
  }

  private bounds(x: number, z: number, size: number): THREE.Box3 {
    const tx0 = tileX(x), tx1 = tileX(Math.min(x + size, MAP_HALF) - 1);
    const tz0 = tileX(z), tz1 = tileX(Math.min(z + size, MAP_HALF) - 1);
    let lo = Infinity, hi = -Infinity;
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = tileId(tx, tz);
      lo = Math.min(lo, this.world.tileMin[t]); hi = Math.max(hi, this.world.tileMax[t]);
    }
    this.box.min.set(x, lo, z);
    this.box.max.set(Math.min(x + size, MAP_HALF), hi, Math.min(z + size, MAP_HALF));
    return this.box;
  }

  /** true se o nó (ou seus filhos) foi tratado; false se está fora da sua faixa. */
  private select(x: number, z: number, size: number, level: number): boolean {
    if (x >= MAP_HALF || z >= MAP_HALF) return true;
    const b = this.bounds(x, z, size);
    if (b.distanceToPoint(this.camPos) > this.ranges[level]) return false;
    if (!this.frustum.intersectsBox(b)) return true;
    if (level === 0) { this.add(x, z, size, level); return true; }
    const childRange = this.ranges[level - 1];
    if (b.distanceToPoint(this.camPos) > childRange) { this.add(x, z, size, level); return true; }
    const h = size / 2;
    for (let k = 0; k < 4; k++) {
      const cx = x + (k & 1 ? h : 0), cz = z + (k & 2 ? h : 0);
      // filho fora da sua faixa: desenha o quadrante na densidade do filho, já todo transformado
      if (!this.select(cx, cz, h, level - 1)) {
        const cb = this.bounds(cx, cz, h);
        if (this.frustum.intersectsBox(cb)) this.add(cx, cz, h, level - 1);
      }
    }
    return true;
  }

  /** Lado do ladrilho, para quem precisa saber. */
  static readonly tileSize = TILE_SIZE;
}
