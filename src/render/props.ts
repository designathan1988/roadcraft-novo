// Peças desenhadas pela GPU: um pool único de instâncias (todas as células,
// todos os tipos), recortado num compute shader a cada quadro contra o
// frustum e a distância, que escreve as listas visíveis por tipo e nível e as
// contagens dos desenhos indiretos. Um material para tudo, uma chamada por
// tipo e nível. As células sujas são refeitas nos workers e só os blocos
// delas sobem para a GPU. Troca de nível esmaece por pontilhado.

import * as THREE from 'three/webgpu';
import { CELL_COUNT, Dirty, cellOriginX, type DirtyCells } from '../core/grid.ts';
import { MAP_CELLS } from '../config.ts';
import type { JobPool } from '../jobs/pool.ts';
import { boxTransfer, roadGraphTransfer, type PropColumns } from '../jobs/protocol.ts';
import { PROP, PROP_FREE, PROP_TYPES } from '../jobs/props.ts';
import type { World } from '../world/world.ts';
import { buildPropDefs, buildSignAtlas, impostorSources, FACE_LAST, PMAT, SIGN_ATLAS, SIGN_FACES, type PropDef } from './propMeshes.ts';
import { IMP_FRAME, IMP_G, IMP_TYPES, bakeImpostors, hemiOctDecodeNode, hemiOctEncodeNode } from './impostor.ts';
import { nightU } from './scene.ts';
import { PAINTS } from './vehicles.ts';
import { windU } from './weather.ts';
import { T, withPrevious, type Node } from './tsl.ts';

const {
  Fn, If, storage, uniform, uniformArray, instanceIndex, atomicAdd, atomicStore, atomicLoad, uint, float, int, vec3, vec4, ivec2,
  attribute, positionLocal, normalLocal, varyingProperty, transformNormalToView, normalize, cos, sin, min, select, length, dot,
  textureLoad, time, interleavedGradientNoise, screenCoordinate, mix, step, abs, fract, hash, sRGBTransferEOTF,
  texture, vec2, cross, clamp, floor, uniformArray: uArr, cameraPosition, positionWorld: positionWorldP,
} = T;

const CAP = 1 << 20;
const BLOCK = 64;
const REGION = 1 << 17;
const LODS = 3;
const DRAWS = PROP_TYPES * LODS;
const FADE_BAND = 0.12;

export class PropRenderer {
  readonly group = new THREE.Group();
  readonly enabled: boolean;
  private world: World;
  private pool: JobPool;
  private dirty: DirtyCells;
  private defs: PropDef[];
  private data = new Float32Array(CAP * 4);
  private extra = new Uint32Array(CAP).fill(PROP_FREE);
  private poolAttr: THREE.StorageBufferAttribute;
  private extraAttr: THREE.StorageBufferAttribute;
  private visAttr: THREE.StorageBufferAttribute;
  private drawAttr: THREE.IndirectStorageBufferAttribute;
  private freeBlocks: number[] = [];
  private cellBlocks: Array<number[] | null> = new Array(CELL_COUNT).fill(null);
  private cellVer = new Uint32Array(CELL_COUNT);
  private cellReq = new Uint32Array(CELL_COUNT);
  private highBlock = 0;
  private usedU = uniform(0, 'uint');
  private camU = uniform(new THREE.Vector3());
  private planes: THREE.Vector4[] = Array.from({ length: 6 }, () => new THREE.Vector4());
  private planesU: Node;
  private distArr: number[] = new Array(DRAWS).fill(0);
  private distU: Node;
  private radiusU: Node;
  private reset: Node;
  private cull: Node;
  private clamp: Node;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  /** Texto de estado dos semáforos (nó → 1 + braço * 4 + estado). */
  readonly signalTex: THREE.DataTexture;
  pixelScale = 1;
  private signalSent = 0;
  // modo de compatibilidade (WebGL 2): malhas instanciadas por célula, só perto da câmera
  private fallbackMat: THREE.MeshStandardNodeMaterial | null = null;
  private cellMeshes: Array<THREE.Mesh[] | null> = new Array(CELL_COUNT).fill(null);
  private fbFrustum = new THREE.Frustum();
  private fbBox = new THREE.Box3();
  // atlas dos impostores (cor e normal); trocado pela foto na carga
  private impColor = texture(new THREE.Texture());
  private impNormal = texture(new THREE.Texture());
  // sign faces (speed limits, stop, yield…), drawn once at load
  private signAtlas = texture(buildSignAtlas());
  impRT: THREE.RenderTarget[] = [];

  constructor(world: World, pool: JobPool, signalsSab: SharedArrayBuffer, isWebGPU: boolean) {
    this.world = world;
    this.pool = pool;
    this.dirty = world.dirty;
    this.enabled = isWebGPU; // recorte em compute: só no WebGPU (no WebGL 2 as peças ficam de fora por ora)
    this.defs = buildPropDefs();
    for (let b = CAP / BLOCK - 1; b >= 0; b--) this.freeBlocks.push(b);
    this.poolAttr = new THREE.StorageBufferAttribute(this.data, 4);
    this.extraAttr = new THREE.StorageBufferAttribute(this.extra, 1);
    this.visAttr = new THREE.StorageBufferAttribute(new Uint32Array(DRAWS * REGION), 1);
    const draw = new Uint32Array(DRAWS * 5);
    this.defs.forEach((d, t) => d.lods.forEach((g, l) => { if (g) draw[(t * LODS + l) * 5] = g.attributes.position.count; }));
    this.drawAttr = new THREE.IndirectStorageBufferAttribute(draw, 1);
    const sig = new Uint8Array(signalsSab);
    this.signalTex = new THREE.DataTexture(sig, 512, sig.length / 512, THREE.RedFormat, THREE.UnsignedByteType);
    this.signalTex.minFilter = THREE.NearestFilter;
    this.signalTex.magFilter = THREE.NearestFilter;
    this.signalTex.needsUpdate = true;

    this.planesU = uniformArray(this.planes, 'vec4');
    this.distU = uniformArray(this.distArr, 'float');
    this.radiusU = uniformArray(this.defs.map((d) => d.radius), 'float');

    // ---- compute: zera, recorta, limita
    const drawsA = storage(this.drawAttr, 'uint', DRAWS * 5).toAtomic();
    this.reset = Fn(() => {
      atomicStore(drawsA.element(instanceIndex.mul(5).add(1)), uint(0));
    })().compute(DRAWS);
    const poolC = storage(this.poolAttr, 'vec4', CAP).toReadOnly();
    const extraC = storage(this.extraAttr, 'uint', CAP).toReadOnly();
    const visW = storage(this.visAttr, 'uint', DRAWS * REGION);
    this.cull = Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(this.usedU), () => {
        const type = extraC.element(i).bitAnd(uint(31)).toVar();
        If(type.lessThan(uint(PROP_FREE)), () => {
          const p = poolC.element(i).xyz.toVar();
          const r = this.radiusU.element(type);
          let inside: Node = float(1);
          for (let k = 0; k < 6; k++) {
            const pl = this.planesU.element(k);
            inside = inside.mul(step(r.negate(), dot(pl.xyz, p).add(pl.w)));
          }
          If(inside.greaterThan(0.5), () => {
            const d = length(p.sub(this.camU)).toVar();
            for (let l = 0; l < LODS; l++) {
              const slot = type.mul(LODS).add(l);
              const end = this.distU.element(slot);
              const start = l === 0 ? float(-1) : this.distU.element(slot.sub(1));
              // entra no nível l no fim do anterior (esmaecendo), sai no fim do seu
              const bandIn = start.mul(1 - FADE_BAND);
              If(end.greaterThan(0).and(d.lessThan(end)).and(d.greaterThanEqual(bandIn)), () => {
                // fade de saída (perto do fim) e de entrada (dentro da faixa do anterior)
                const outA = select(d.greaterThan(end.mul(1 - FADE_BAND)), end.sub(d).div(end.mul(FADE_BAND)), float(1));
                const inA = select(d.lessThan(start), d.sub(bandIn).div(start.mul(FADE_BAND).max(0.001)), float(1));
                const a = min(outA, inA);
                // código: 8 bits de cobertura; bit 31 = máscara complementar (quem entra)
                const comp = select(d.lessThan(start), uint(1), uint(0));
                const cov = uint(min(a, 1).mul(255));
                const n = atomicAdd(drawsA.element(slot.mul(5).add(1)), uint(1));
                If(n.lessThan(uint(REGION)), () => {
                  visW.element(slot.mul(REGION).add(n)).assign(i.bitOr(cov.shiftLeft(uint(22))).bitOr(comp.shiftLeft(uint(31))));
                });
              });
            }
          });
        });
      });
    })().compute(CAP, [64]);
    this.clamp = Fn(() => {
      const e = drawsA.element(instanceIndex.mul(5).add(1));
      atomicStore(e, min(atomicLoad(e), uint(REGION)));
    })().compute(DRAWS);

    // ---- desenho
    if (!this.enabled) {
      this.fallbackMat = this.createMaterial('cpu');
      // uma instância escondida para o shader compilar na carga
      this.setCellFallback(0, { count: 1, data: new Float32Array([0, -5000, 0, 0]), extra: new Uint32Array([0]) });
      for (const m of this.cellMeshes[0] ?? []) this.group.children.push(m);
      this.cellMeshes[0] = null;
      return;
    }
    const material = this.createMaterial('gpu');
    this.defs.forEach((d, t) => d.lods.forEach((g, l) => {
      if (!g) return;
      g.setIndirect(this.drawAttr, (t * LODS + l) * 5 * 4);
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      mesh.userData.base = (t * LODS + l) * REGION;
      // só o nível de perto faz sombra (e não os fios)
      mesh.castShadow = l === 0 && t !== PROP.Wire;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }));
  }

  /**
   * Material único. 'gpu': instância vem da lista visível do compute (WebGPU);
   * 'cpu': instância vem de atributos instanciados por célula (WebGL 2, só perto).
   */
  private createMaterial(source: 'gpu' | 'cpu'): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial();
    const gpu = source === 'gpu';
    const baseU = gpu ? uniform(0, 'uint').onObjectUpdate(({ object }: { object: THREE.Object3D }) => object.userData.base as number) : null;
    const visR = gpu ? storage(this.visAttr, 'uint', DRAWS * REGION).toReadOnly() : null;
    const poolR = gpu ? storage(this.poolAttr, 'vec4', CAP).toReadOnly() : null;
    const extraR = gpu ? storage(this.extraAttr, 'uint', CAP).toReadOnly() : null;
    const vN = varyingProperty('vec3', 'vPropN');
    // varyings packed in vec4s (WebGPU caps the inter-stage variables; one float each ran out once the sign atlas
    // came in): A = fade, complementary mask, variant, lit lamp; B = impostor uv, impostor yaw cos/sin;
    // C = sign atlas uv, sign back face, flower
    const vA = varyingProperty('vec4', 'vPropA');
    const vB = varyingProperty('vec4', 'vPropB');
    const vC = varyingProperty('vec4', 'vPropC');
    const vFade = vA.x, vComp = vA.y, vVar = vA.z, vLit = vA.w;
    const vImpUV = vB.xy, vImpCS = vB.zw;
    const vAtlasUV = vC.xy, vAtlasBack = vC.z, vFlower = vC.w;
    let fadeN: Node = float(1), compN: Node = float(0), flowerN: Node = float(0), atlasUVN: Node = vec2(0, 0), backN: Node = float(0);
    const pcol = attribute('pcol', 'vec4');
    const sigTex = this.signalTex;

    m.positionNode = Fn(() => {
      let inst: Node, keyRaw: Node;
      if (gpu) {
        const code = visR.element(instanceIndex.add(baseU)).toVar();
        const idx = code.bitAnd(uint(0x3fffff));
        fadeN = float(code.shiftRight(uint(22)).bitAnd(uint(255))).div(255);
        compN = float(code.shiftRight(uint(31)));
        inst = poolR.element(idx).toVar();
        keyRaw = extraR.element(idx);
      } else {
        inst = attribute('ipose', 'vec4');
        keyRaw = uint(attribute('ikey', 'float'));
      }
      const w = uint(inst.w);
      const yaw = float(w.bitAnd(uint(4095))).mul(Math.PI * 2 / 4096);
      const variant = float(w.shiftRight(uint(12)).bitAnd(uint(15)));
      const scale = float(w.shiftRight(uint(16)).bitAnd(uint(63))).div(42).add(0.5);
      // ipê (como as árvores floridas do roadcraft): parte das árvores de variante 3 florida, amarelo, roxo ou rosa
      const isTreeT = step(abs(float(keyRaw.bitAnd(uint(31))).sub(PROP.Tree)), float(0.5));
      const fh = hash(floor(inst.x).add(floor(inst.z).mul(157)));
      flowerN = (isTreeT.mul(step(abs(variant.sub(3)), float(0.5))).mul(step(fh, float(0.3))).mul(floor(fh.mul(10)).add(1)));
      const c = cos(yaw), s = sin(yaw);
      // fio: escala = comprimento do vão (m), variante = desnível; z vai de 0 a 1 ao longo do vão
      const isWire = step(abs(pcol.w.mul(255).sub(PMAT.Wire)), float(0.5));
      const span = float(w.shiftRight(uint(16)).bitAnd(uint(63)));
      const dy = variant.sub(8).mul(0.5);
      const lz = positionLocal.z;
      const sag = lz.mul(float(1).sub(lz)).mul(4).mul(span.mul(0.018));
      const wireP = vec3(positionLocal.x, positionLocal.y.add(dy.mul(lz)).sub(sag), lz.mul(span));
      // placa: some com as faces das outras variantes
      const mat0 = pcol.w.mul(255);
      const isFace = step(float(PMAT.Sign0 - 0.5), mat0).mul(step(mat0, float(FACE_LAST + 0.5)));
      const wrongFace = isFace.mul(step(float(0.5), abs(mat0.sub(PMAT.Sign0).sub(variant))));
      // muro/cerca: comprimento em decímetros na escala, desnível na chave
      const isBarrier = step(abs(float(keyRaw.bitAnd(uint(31))).sub(PROP.Barrier)), float(0.5));
      const bDy = float(keyRaw.shiftRight(uint(5))).sub(512).mul(0.05);
      const barrierP = vec3(positionLocal.x, positionLocal.y.add(bDy.mul(lz)), lz.mul(span.mul(0.1)));
      // sign face: one quad sized per variant (SIGN_FACES), its atlas cell by the variant or, for speed limits, by the
      // speed in the key (km/h; 0 = 60)
      const isAtlas = step(abs(mat0.sub(PMAT.Atlas)), float(0.5));
      const face = uArr(SIGN_FACES.map(([hx, hy, cy, cellK]) => new THREE.Vector4(hx, hy, cy, cellK)), 'vec4').element(int(variant));
      const atlasP = vec3(positionLocal.x.mul(face.x), face.z.add(positionLocal.y.mul(face.y)), positionLocal.z);
      const kmh = float(keyRaw.shiftRight(uint(5)));
      const speedCell = clamp(select(kmh.lessThan(5), float(60), kmh).div(10).round().sub(2), 0, 10);
      const cellK = select(face.w.lessThan(-0.5), speedCell, face.w);
      const back = step(normalLocal.z, float(0));
      const lxA = mix(positionLocal.x, positionLocal.x.negate(), back);
      atlasUVN = (vec2(T.mod(cellK, SIGN_ATLAS.COLS).add(lxA.mul(0.5).add(0.5)).div(SIGN_ATLAS.COLS),
        float(1).sub(floor(cellK.div(SIGN_ATLAS.COLS)).add(float(0.5).sub(positionLocal.y.mul(0.5))).div(SIGN_ATLAS.ROWS))));
      backN = back;
      const local = mix(positionLocal, atlasP, isAtlas);
      const p = mix(mix(local.mul(scale), wireP, isWire), barrierP, isBarrier).mul(float(1).sub(wrongFace)).toVar();
      // folhagem balança um pouco com o vento
      const leaf = step(abs(pcol.w.mul(255).sub(PMAT.Leaf)), float(0.5));
      // com vento forte: balanço mais rápido e mais largo, inclinado a favor do vento
      const sway = sin(time.mul(windU.mul(2.2).add(1.3)).add(inst.x.mul(0.07)).add(inst.z.mul(0.05))).mul(windU.mul(0.09).add(0.03)).add(windU.mul(windU).mul(0.06)).mul(p.y).mul(leaf);
      const wx = p.x.mul(c).add(p.z.mul(s)).add(sway);
      const wz = p.x.negate().mul(s).add(p.z.mul(c));
      const n = normalLocal;
      vN.assign(vec3(n.x.mul(c).add(n.z.mul(s)), n.y, n.x.negate().mul(s).add(n.z.mul(c))));
      // semáforo: qual foco está aceso
      const key = keyRaw.shiftRight(uint(5));
      const node = int(key.shiftRight(uint(3)));
      const arm = float(key.bitAnd(uint(7)));
      const st = textureLoad(sigTex, ivec2(node.mod(int(512)), node.div(int(512)))).r.mul(255).add(0.5).floor();
      // fora da janela da simulação: ciclo de enfeite pelo relógio
      const fakeT = time.add(hash(node.toUint()).mul(60));
      const fakePhase = float(fakeT.div(16).floor().mod(2));
      const fakeState = select(fract(fakeT.div(16)).greaterThan(0.85), float(1), float(0));
      // da simulação: 128 | amarelo << 6 | braços com verde
      const known = step(float(127.5), st);
      const mask = st.mod(64);
      const armOn = floor(mask.div(T.pow(float(2), arm))).mod(2);
      const state = mix(fakeState, step(float(0.5), floor(st.div(64)).mod(2)), known);
      const armMatch = mix(step(abs(fract(arm.div(2)).mul(2).sub(fakePhase)), float(0.1)), armOn, known);
      const mat = pcol.w.mul(255);
      const isRed = step(abs(mat.sub(PMAT.Red)), float(0.5));
      const isYel = step(abs(mat.sub(PMAT.Yellow)), float(0.5));
      const isGrn = step(abs(mat.sub(PMAT.Green)), float(0.5));
      const greenOn = armMatch.mul(step(state, float(0.5)));
      const yellowOn = armMatch.mul(step(abs(state.sub(1)), float(0.5)));
      const redOn = float(1).sub(greenOn).sub(yellowOn);
      vA.assign(vec4(fadeN, compN, variant, isRed.mul(redOn).add(isYel.mul(yellowOn)).add(isGrn.mul(greenOn))));
      // impostor: quadrado virado para a câmera com a foto da direção mais próxima
      const isImp = step(abs(mat.sub(PMAT.Impostor)), float(0.5));
      const col = pcol.x.mul(255).add(0.5).floor();
      const frame = uArr(IMP_FRAME.map((f) => new THREE.Vector2(f.cy, f.r)), 'vec2').element(int(col));
      const centerW = inst.xyz.add(vec3(0, frame.x.mul(scale), 0));
      const vw = normalize(cameraPosition.sub(centerW));
      // para o espaço da árvore (sem o rumo)
      const vl = normalize(vec3(vw.x.mul(c).sub(vw.z.mul(s)), vw.y.max(0.02), vw.x.mul(s).add(vw.z.mul(c))));
      const fuv = hemiOctEncodeNode(vl);
      const cell = clamp(floor(fuv.mul(IMP_G)), 0, IMP_G - 1);
      const dl = hemiOctDecodeNode(cell.add(0.5).div(IMP_G));
      const dw = vec3(dl.x.mul(c).add(dl.z.mul(s)), dl.y, dl.x.negate().mul(s).add(dl.z.mul(c)));
      const upRef = select(abs(dl.y).greaterThan(0.985), vec3(s, 0, c), vec3(0, 1, 0));
      const right = normalize(cross(upRef, dw));
      const upv = cross(dw, right);
      const R = frame.y.mul(scale);
      const impPos = centerW.add(right.mul(positionLocal.x.mul(R))).add(upv.mul(positionLocal.y.mul(R)));
      const atlas = vec2(col.mul(IMP_G).add(cell.x).add(positionLocal.x.mul(0.5).add(0.5)).div(IMP_G * IMP_TYPES),
        cell.y.add(positionLocal.y.mul(0.5).add(0.5)).div(IMP_G));
      vB.assign(vec4(atlas, c, s));
      vC.assign(vec4(atlasUVN, backN, flowerN));
      return mix(vec3(wx, p.y, wz).add(inst.xyz), impPos, isImp);
    })();
    withPrevious(m);
    // impostor: normal da foto (espaço da árvore) girada pelo rumo
    const fmat = pcol.w.mul(255);
    const isImpF = step(abs(fmat.sub(PMAT.Impostor)), float(0.5));
    const impC = this.impColor.sample(vImpUV);
    const impN = this.impNormal.sample(vImpUV).xyz.mul(2).sub(1);
    const impNW = vec3(impN.x.mul(vImpCS.x).add(impN.z.mul(vImpCS.y)), impN.y, impN.x.negate().mul(vImpCS.y).add(impN.z.mul(vImpCS.x)));
    m.normalNode = transformNormalToView(normalize(mix(vN, impNW, isImpF)));

    const mat = pcol.w.mul(255);
    const isLeaf = step(abs(mat.sub(PMAT.Leaf)), float(0.5));
    const isGlass = step(abs(mat.sub(PMAT.Glass)), float(0.5));
    const isBulb = step(float(2.5), mat).mul(step(mat, float(5.5)));
    const isMetal = step(abs(mat.sub(PMAT.Metal)), float(0.5));
    // variação da folhagem por variante
    const tint = mix(vec3(1, 1, 1), mix(vec3(0.82, 1.05, 0.7), vec3(1.15, 1.0, 0.75), step(float(1.5), vVar)), step(float(0.5), vVar).mul(isLeaf));
    // pintura dos carros estacionados pela variante
    const isPaint = step(abs(mat.sub(PMAT.Paint)), float(0.5));
    const paint = sRGBTransferEOTF(uArr(PAINTS.map((p) => new THREE.Color(p)), 'color').element(int(vVar.add(0.5))));
    const isAtlasF = step(abs(mat.sub(PMAT.Atlas)), float(0.5));
    const atlasC = this.signAtlas.sample(vAtlasUV);
    const signFace = mix(atlasC.xyz, pcol.xyz, vAtlasBack);
    const base = mix(mix(mix(pcol.xyz, paint, isPaint), signFace, isAtlasF), impC.xyz, isImpF).mul(mix(tint, mix(vec3(1, 1, 1), tint, step(float(0.5), vVar)), isImpF));
    const bulbOff = base.mul(0.12);
    // folhagem: cada árvore com o seu tom (mais clara, amarelada ou escura), o topo da copa mais claro e a
    // luz que atravessa as folhas (o lado da sombra não fica preto)
    const treeH = hash(floor(positionWorldP.xz.div(7)).dot(vec2(1, 57.3)));
    const leafTone = mix(mix(vec3(0.82, 0.9, 0.8), vec3(1.12, 1.08, 0.82), step(float(0.55), treeH)), vec3(1.0, 1.12, 0.92), step(float(0.85), treeH));
    // flor: multiplica a cor da folha (sRGB 0x6a9a45 em linear) até a cor da flor; o tronco do impostor quase não muda
    const flowerC = select(vFlower.lessThan(1.5), vec3(5.9, 1.67, 0.45), select(vFlower.lessThan(2.5), vec3(4.2, 0.6, 7.2), vec3(6.0, 1.1, 3.4)));
    const leafK = mix(leafTone, flowerC, step(float(0.5), vFlower));
    const leafBase = base.mul(mix(vec3(1, 1, 1), leafK, isLeaf.max(isImpF)));
    const up = clamp(normalize(mix(vN, impNW, isImpF)).y, 0, 1);
    const through = leafBase.mul(float(0.1).add(up.mul(0.1))).mul(float(1).sub(nightU.mul(0.9))).mul(isLeaf.max(isImpF));
    m.colorNode = vec4(mix(leafBase, bulbOff, isBulb), 1);
    m.emissiveNode = through.add(pcol.xyz.mul(isBulb).mul(vLit).mul(mix(float(2.2), float(4), nightU)))
      .add(sRGBTransferEOTF(vec3(1, 0.86, 0.6)).mul(isGlass).mul(nightU).mul(6));
    m.roughnessNode = mix(mix(float(0.85), float(0.45), isMetal), float(0.95), isLeaf.max(isImpF));
    m.metalnessNode = isMetal.mul(0.3);
    // esmaecimento entre níveis
    const noise = interleavedGradientNoise(screenCoordinate.xy);
    const fadeOk = select(vComp.greaterThan(0.5), noise.greaterThanEqual(float(1).sub(vFade)), noise.lessThan(vFade.add(0.002)));
    m.maskNode = fadeOk.and(isImpF.lessThan(0.5).or(impC.a.greaterThan(0.5))).and(isAtlasF.lessThan(0.5).or(atlasC.a.greaterThan(0.5)));
    return m;
  }

  /** Fotografa as árvores para os impostores (na carga). */
  bake(renderer: THREE.WebGPURenderer): void {
    if (!this.enabled) return;
    const baked = bakeImpostors(renderer, impostorSources(this.defs));
    this.impRT = baked.targets;
    this.impColor.value = baked.color;
    this.impNormal.value = baked.normal;
  }

  /** Células sujas: pede as peças de novo. */
  processDirty(): void {
    const cells = this.dirty.drain(Dirty.Props);
    const w = this.world, net = w.roads;
    for (const c of cells) {
      const v = ++this.cellVer[c];
      this.cellReq[c] = v;
      const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
      const segs: number[] = [];
      net.forSegsNear(x0 - 40, z0 - 40, x0 + 296, z0 + 296, (s) => segs.push(s));
      const boxes = w.gatherBoxes([c]);
      const graph = net.gather(segs, []);
      const items = w.items.gather(c, MAP_CELLS);
      this.pool.submit('props', { graph, boxes, cell: c, items, biome: w.biome }, (r) => { if (this.cellReq[r.cell] === v) this.setCell(r.cell, r.props); }, {
        key: `props:${c}`, priority: 2600, transfer: [...roadGraphTransfer(graph), ...boxTransfer(boxes), items.buffer as ArrayBuffer],
      });
    }
  }

  private setCell(c: number, p: PropColumns | null): void {
    if (!this.enabled) { this.setCellFallback(c, p); return; }
    const old = this.cellBlocks[c];
    if (old) {
      for (const b of old) {
        this.extra.fill(PROP_FREE, b * BLOCK, (b + 1) * BLOCK);
        this.extraAttr.addUpdateRange(b * BLOCK, BLOCK);
        this.freeBlocks.push(b);
      }
      this.extraAttr.needsUpdate = true;
      this.cellBlocks[c] = null;
    }
    if (!p || p.count === 0) return;
    const need = Math.ceil(p.count / BLOCK);
    const blocks: number[] = [];
    for (let k = 0; k < need && this.freeBlocks.length; k++) blocks.push(this.freeBlocks.pop()!);
    let i = 0;
    for (const b of blocks) {
      const s0 = b * BLOCK;
      const n = Math.min(BLOCK, p.count - i);
      this.data.set(p.data.subarray(i * 4, (i + n) * 4), s0 * 4);
      this.extra.set(p.extra.subarray(i, i + n), s0);
      if (n < BLOCK) this.extra.fill(PROP_FREE, s0 + n, s0 + BLOCK);
      this.poolAttr.addUpdateRange(s0 * 4, BLOCK * 4);
      this.extraAttr.addUpdateRange(s0, BLOCK);
      i += n;
      this.highBlock = Math.max(this.highBlock, b + 1);
    }
    this.poolAttr.needsUpdate = true;
    this.extraAttr.needsUpdate = true;
    this.cellBlocks[c] = blocks;
  }

  /** WebGL 2: uma malha instanciada por tipo na célula (nível do meio, ou o único que houver). */
  private setCellFallback(c: number, p: PropColumns | null): void {
    const old = this.cellMeshes[c];
    if (old) for (const m of old) m.geometry.dispose();
    this.cellMeshes[c] = null;
    if (!p || p.count === 0 || !this.fallbackMat) return;
    const meshes: THREE.Mesh[] = [];
    for (let t = 0; t < PROP_TYPES; t++) {
      const def = this.defs[t];
      const base = def.lods[1] ?? def.lods[0];
      if (!base) continue;
      let n = 0;
      for (let i = 0; i < p.count; i++) if ((p.extra[i] & 31) === t) n++;
      if (n === 0) continue;
      const pose = new Float32Array(n * 4), key = new Float32Array(n);
      let k = 0;
      for (let i = 0; i < p.count; i++) {
        if ((p.extra[i] & 31) !== t) continue;
        pose.set(p.data.subarray(i * 4, i * 4 + 4), k * 4);
        key[k] = p.extra[i];
        k++;
      }
      const g = new THREE.InstancedBufferGeometry();
      for (const name of ['position', 'normal', 'pcol']) g.setAttribute(name, base.attributes[name]);
      g.setAttribute('ipose', new THREE.InstancedBufferAttribute(pose, 4));
      g.setAttribute('ikey', new THREE.InstancedBufferAttribute(key, 1));
      g.instanceCount = n;
      const mesh = new THREE.Mesh(g, this.fallbackMat);
      mesh.frustumCulled = false;
      (mesh as { parent: THREE.Object3D | null }).parent = this.group;
      meshes.push(mesh);
    }
    this.cellMeshes[c] = meshes;
  }

  /** WebGL 2: células perto e no campo de visão. */
  private updateFallback(camera: THREE.Camera, camPos: THREE.Vector3): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.fbFrustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    const out = this.group.children;
    out.length = 0;
    const R = 420 * this.pixelScale;
    const c0x = Math.floor((camPos.x - R + MAP_CELLS * 128) / 256), c1x = Math.floor((camPos.x + R + MAP_CELLS * 128) / 256);
    const c0z = Math.floor((camPos.z - R + MAP_CELLS * 128) / 256), c1z = Math.floor((camPos.z + R + MAP_CELLS * 128) / 256);
    for (let cz = Math.max(0, c0z); cz <= Math.min(MAP_CELLS - 1, c1z); cz++) {
      for (let cx = Math.max(0, c0x); cx <= Math.min(MAP_CELLS - 1, c1x); cx++) {
        const list = this.cellMeshes[cz * MAP_CELLS + cx];
        if (!list) continue;
        const x0 = cellOriginX(cx), z0 = cellOriginX(cz);
        this.fbBox.min.set(x0 - 8, -100, z0 - 8);
        this.fbBox.max.set(x0 + 264, 600, z0 + 264);
        if (!this.fbFrustum.intersectsBox(this.fbBox)) continue;
        for (const m of list) out.push(m);
      }
    }
  }

  /** Antes de desenhar: recorte na GPU (ou escolha das células, no WebGL 2). */
  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, camPos: THREE.Vector3, now: number): void {
    if (now - this.signalSent > 250) { this.signalSent = now; this.signalTex.needsUpdate = true; }
    if (!this.enabled) { this.updateFallback(camera, camPos); return; }
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.frustum.planes.forEach((p, k) => this.planes[k].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
    this.camU.value.copy(camPos);
    this.defs.forEach((d, t) => d.dist.forEach((x, l) => { this.distArr[t * LODS + l] = d.lods[l] ? x * this.pixelScale : 0; }));
    this.usedU.value = this.highBlock * BLOCK;
    renderer.compute(this.reset);
    renderer.compute(this.cull);
    renderer.compute(this.clamp);
  }

  /** Esquece tudo (outra cidade). */
  clear(): void {
    for (let c = 0; c < CELL_COUNT; c++) { this.cellReq[c] = ++this.cellVer[c]; this.setCell(c, null); }
  }
}
