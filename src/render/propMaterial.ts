// The props' one material: the vertex shader places a pooled instance (or a WebGL 2 cell's instanced attributes),
// and the fragment shader colours every kind (building parts, signs, wires, barriers, trees and their impostors).
// Its own module: the renderer keeps the pool, the cull and the draws; the material is a separate responsibility.

import * as THREE from 'three/webgpu';
import { PROP } from '../jobs/props.ts';
import { PART_TYPES, SCALE_MIN, SCALE_OCTAVES, VARIANT_TYPES } from '../jobs/parts40.ts';
import { PAINTS } from '../shared/vehiclePaints.ts';
import { nightU } from './scene.ts';
import { windDirU, windU } from './weather.ts';
import { T, withPrevious, type Node } from './tsl.ts';
import { partCardOn, partThinTone } from './partCards.ts';
import { FACE_LAST, PMAT, SIGN_ATLAS, SIGN_FACES } from './propMeshes.ts';
import { IMP_FRAME, IMP_G, IMP_TYPES, hemiOctDecodeNode, hemiOctEncodeNode } from './impostor.ts';
import { signalLampLit } from './propSignals.ts';

const {
  Fn, storage, uniform, instanceIndex, uint, float, int, vec3, vec4, attribute, positionLocal, normalLocal,
  varyingProperty, transformNormalToView, normalize, cos, sin, select, dot, time, interleavedGradientNoise, screenCoordinate,
  mix, step, abs, hash, sRGBTransferEOTF, vec2, cross, clamp, floor, uniformArray: uArr, cameraPosition,
  positionWorld: positionWorldP, cameraViewMatrix, max,
} = T;

/** Share of the ipês in flower. */
const IPE_IN_FLOWER = 0.35;
/** The leaf tones (treeMeshes.ts LEAF, linear) an ipê out of flower takes. */
const LEAF_DARK = new THREE.Color(0x24401c), LEAF_LIT = new THREE.Color(0x4f7a34);
/** The LOD dissolve's dither moves every frame; the TRAA averages it (set by PropRenderer.update). */
export const fadeJitter = uniform(new THREE.Vector2(0, 0));

export interface PropMaterialInputs {
  gpu: boolean;
  cap: number;
  visible: number;
  draws: number;
  visAttr: THREE.StorageBufferAttribute;
  offsetAttr: THREE.StorageBufferAttribute;
  poolAttr: THREE.StorageBufferAttribute;
  extraAttr: THREE.StorageBufferAttribute;
  signalTex: THREE.DataTexture;
  impColor: Node;
  impNormal: Node;
  leafAtlas: Node;
  signAtlas: Node;
}

/**
 * One material. 'gpu': the instance comes from the compute's visible list (WebGPU); 'cpu': the instance comes from
 * instanced attributes per cell (WebGL 2, near only).
 */
export function createPropMaterial(inputs: PropMaterialInputs): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const gpu = inputs.gpu;
  const slotU = gpu ? uniform(0, 'uint').onObjectUpdate(({ object }: { object: THREE.Object3D }) => object.userData.slot as number) : null;
  const visR = gpu ? storage(inputs.visAttr, 'uint', inputs.visible).toReadOnly() : null;
  const offsetR = gpu ? storage(inputs.offsetAttr, 'uint', inputs.draws).toReadOnly() : null;
  const poolR = gpu ? storage(inputs.poolAttr, 'vec4', inputs.cap).toReadOnly() : null;
  const extraR = gpu ? storage(inputs.extraAttr, 'uint', inputs.cap).toReadOnly() : null;
  const vN = varyingProperty('vec3', 'vPropN');
  // varyings packed in vec4s (WebGPU caps the inter-stage variables; one float each ran out once the sign atlas
  // came in): A = fade, complementary mask, variant, lit lamp; B = impostor uv, impostor yaw cos/sin;
  // C = sign atlas uv, sign back face, flower
  const vA = varyingProperty('vec4', 'vPropA');
  const vB = varyingProperty('vec4', 'vPropB');
  const vC = varyingProperty('vec4', 'vPropC');
  // D = a building part's instance colour (linear), and whether it is one
  const vD = varyingProperty('vec4', 'vPropD');
  const vFade = vA.x, vComp = vA.y, vVar = vA.z, vLit = vA.w;
  const vImpUV = vB.xy, vImpCS = vB.zw;
  const vAtlasUV = vC.xy, vAtlasBack = vC.z, vFlower = vC.w;
  let fadeN: Node = float(1), compN: Node = float(0), flowerN: Node = float(0), atlasUVN: Node = vec2(0, 0), backN: Node = float(0);
  const pcol = attribute('pcol', 'vec4');
  const sigTex = inputs.signalTex;

  m.positionNode = Fn(() => {
    let inst: Node, keyRaw: Node;
    if (gpu) {
      const code = visR.element(offsetR.element(slotU).add(instanceIndex)).toVar();
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
    // a 4.0 building part (jobs/parts40.ts): scale per axis in the key (log code), its colour in w over the turn,
    // a variant on top of the key for the types that hold several parts
    const ptype = float(keyRaw.bitAnd(uint(31)));
    const isPart = step(float(PART_TYPES[0] - 0.5), ptype).mul(step(ptype, float(PART_TYPES[PART_TYPES.length - 1] + 0.5)));
    let isVarT: Node = float(0);
    for (const t of VARIANT_TYPES) isVarT = isVarT.add(step(abs(ptype.sub(t)), float(0.5)));
    const pkey = keyRaw.shiftRight(uint(5));
    const q9 = (k: number) => float(pkey.shiftRight(uint(k * 9)).bitAnd(uint(511))).div(511);
    const q8 = (k: number) => float(pkey.shiftRight(uint(k * 8)).bitAnd(uint(255))).div(255);
    const sc = (k: number) => T.exp2(mix(q9(k), q8(k), isVarT).mul(SCALE_OCTAVES)).mul(SCALE_MIN);
    const scale3 = vec3(sc(0), sc(1), sc(2));
    const partVariant = float(pkey.shiftRight(uint(24)).bitAnd(uint(7)));
    const pc12 = w.shiftRight(uint(12));
    const partRgb = vec3(float(pc12.shiftRight(uint(8)).bitAnd(uint(15))), float(pc12.shiftRight(uint(4)).bitAnd(uint(15))), float(pc12.bitAnd(uint(15)))).div(15);
    vD.assign(vec4(sRGBTransferEOTF(partRgb), isPart));
    const variant = mix(float(w.shiftRight(uint(12)).bitAnd(uint(15))), partVariant, isPart);
    const scale = float(w.shiftRight(uint(16)).bitAnd(uint(63))).div(42).add(0.5);
    // the ipê (tree or oak, variant 3) is a model of its own with its crown in flower; each one draws a number that
    // says whether it is in flower (about a third are, as the season spreads them)
    const typeF = float(keyRaw.bitAnd(uint(31)));
    const isIpe = max(step(abs(typeF.sub(PROP.Tree)), float(0.5)), step(abs(typeF.sub(PROP.Oak)), float(0.5))).mul(step(abs(variant.sub(3)), float(0.5)));
    flowerN = isIpe.mul(hash(floor(inst.x).add(floor(inst.z).mul(157))).mul(0.998).add(0.001));
    const c = cos(yaw), s = sin(yaw);
    // wire: scale = span length (m), variant = height difference; z goes from 0 to 1 along the span
    const isWire = step(abs(pcol.w.mul(255).sub(PMAT.Wire)), float(0.5));
    const span = float(w.shiftRight(uint(16)).bitAnd(uint(63)));
    const dy = variant.sub(8).mul(0.5);
    const lz = positionLocal.z;
    const sag = lz.mul(float(1).sub(lz)).mul(4).mul(span.mul(0.018));
    const wireP = vec3(positionLocal.x, positionLocal.y.add(dy.mul(lz)).sub(sag), lz.mul(span));
    // sign: the faces of the other variants collapse
    const mat0 = pcol.w.mul(255);
    const isFace = step(float(PMAT.Sign0 - 0.5), mat0).mul(step(mat0, float(FACE_LAST + 0.5)));
    const wrongFace = isFace.mul(step(float(0.5), abs(mat0.sub(PMAT.Sign0).sub(variant))));
    // wall/fence: length in decimetres in the scale, height difference in the key
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
    const p = mix(mix(mix(local.mul(scale), positionLocal.mul(scale3), isPart), wireP, isWire), barrierP, isBarrier).mul(float(1).sub(wrongFace)).toVar();
    // foliage sways a little with the wind
    const isCard = step(abs(pcol.w.mul(255).sub(PMAT.LeafCard)), float(0.5));
    const leaf = max(step(abs(pcol.w.mul(255).sub(PMAT.Leaf)), float(0.5)), isCard);
    // with strong wind: faster and wider sway, leaning with the wind
    // along the wind, as much as the wind: none in still air (it used to sway 3 cm per metre of height with no
    // wind, always along x)
    const sway = sin(time.mul(windU.mul(2.2).add(1.3)).add(inst.x.mul(0.07)).add(inst.z.mul(0.05))).mul(windU.mul(0.09)).add(windU.mul(windU).mul(0.06)).mul(p.y).mul(leaf);
    const wx = p.x.mul(c).add(p.z.mul(s)).add(sway.mul(windDirU.x));
    const wz = p.x.negate().mul(s).add(p.z.mul(c)).add(sway.mul(windDirU.y));
    const n = normalize(mix(normalLocal, normalLocal.div(scale3), isPart));
    vN.assign(vec3(n.x.mul(c).add(n.z.mul(s)), n.y, n.x.negate().mul(s).add(n.z.mul(c))));
    const mat = pcol.w.mul(255);
    // traffic light: which lamp is lit (render/propSignals.ts)
    vA.assign(vec4(fadeN, compN, variant, signalLampLit(keyRaw, sigTex, mat)));
    // impostor: a square facing the camera with the photo of the nearest direction
    const isImp = step(abs(mat.sub(PMAT.Impostor)), float(0.5));
    const col = pcol.x.mul(255).add(0.5).floor();
    const frame = uArr(IMP_FRAME.map((f) => new THREE.Vector2(f.cy, f.r)), 'vec2').element(int(col));
    const centerW = inst.xyz.add(vec3(0, frame.x.mul(scale), 0));
    const vw = normalize(cameraPosition.sub(centerW));
    // into the tree's space (without the heading)
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
    vC.assign(vec4(select(isCard.greaterThan(0.5), attribute('pext', 'vec4').xy, atlasUVN), backN, flowerN));
    // foliage cards face the camera (the shadow pass's camera too: leafy shadows); corner offset in metres
    const pext = attribute('pext', 'vec4');
    const camR = vec3(cameraViewMatrix.element(0).x, cameraViewMatrix.element(1).x, cameraViewMatrix.element(2).x);
    const camU = vec3(cameraViewMatrix.element(0).y, cameraViewMatrix.element(1).y, cameraViewMatrix.element(2).y);
    const card = camR.mul(pext.z).add(camU.mul(pext.w)).mul(scale).mul(isCard);
    return mix(vec3(wx, p.y, wz).add(inst.xyz).add(card), impPos, isImp);
  })();
  withPrevious(m);
  // impostor: the photo's normal (tree space) turned by the heading
  const fmat = pcol.w.mul(255);
  const isImpF = step(abs(fmat.sub(PMAT.Impostor)), float(0.5));
  const impC = inputs.impColor.sample(vImpUV);
  const impN = inputs.impNormal.sample(vImpUV).xyz.mul(2).sub(1);
  const impNW = vec3(impN.x.mul(vImpCS.x).add(impN.z.mul(vImpCS.y)), impN.y, impN.x.negate().mul(vImpCS.y).add(impN.z.mul(vImpCS.x)));
  m.normalNode = transformNormalToView(normalize(mix(vN, impNW, isImpF)));

  const mat = pcol.w.mul(255);
  const isCardF = step(abs(mat.sub(PMAT.LeafCard)), float(0.5));
  const isLeaf = max(step(abs(mat.sub(PMAT.Leaf)), float(0.5)), isCardF);
  // Foliage cards carry the atlas uv and the billboard corner in `pext`: the thin parts' reading of that attribute
  // must never reach them (their bars/holes on a crown).
  const foliage = max(isLeaf, isImpF);
  const leafC = inputs.leafAtlas.sample(vAtlasUV);
  const isGlass = step(abs(mat.sub(PMAT.Glass)), float(0.5));
  const isBulb = step(float(2.5), mat).mul(step(mat, float(5.5)));
  const isMetal = step(abs(mat.sub(PMAT.Metal)), float(0.5));
  // foliage variation by variant
  const tint = mix(vec3(1, 1, 1), mix(vec3(0.82, 1.05, 0.7), vec3(1.15, 1.0, 0.75), step(float(1.5), vVar)), step(float(0.5), vVar).mul(isLeaf));
  // paint of the parked cars by variant
  const isPaint = step(abs(mat.sub(PMAT.Paint)), float(0.5));
  const paint = sRGBTransferEOTF(uArr(PAINTS.map((p) => new THREE.Color(p)), 'color').element(int(vVar.add(0.5))));
  const isAtlasF = step(abs(mat.sub(PMAT.Atlas)), float(0.5));
  const atlasC = inputs.signAtlas.sample(vAtlasUV);
  const signFace = mix(atlasC.xyz, pcol.xyz, vAtlasBack);
  // an ipê out of flower: its bloom (redder than green) takes the leaf tone of the same brightness
  const bloomVert = step(pcol.y.mul(1.05), pcol.x).mul(isLeaf.max(isImpF));
  const outOfFlower = step(float(0.0005), vFlower).mul(step(float(IPE_IN_FLOWER), vFlower)).mul(bloomVert);
  const leafOf = mix(LEAF_DARK, LEAF_LIT, clamp(dot(pcol.xyz, vec3(0.2126, 0.7152, 0.0722)).mul(3), 0, 1));
  const pc = mix(pcol.xyz, leafOf, outOfFlower);
  const impBase = mix(impC.xyz, leafOf.mul(dot(impC.xyz, vec3(0.2126, 0.7152, 0.0722)).mul(4)), step(float(0.0005), vFlower).mul(step(float(IPE_IN_FLOWER), vFlower)).mul(step(impC.y.mul(1.05), impC.x)));
  const base = mix(mix(mix(pc.mul(mix(vec3(1, 1, 1), leafC.xyz, isCardF)), paint, isPaint), signFace, isAtlasF), impBase, isImpF).mul(mix(tint, mix(vec3(1, 1, 1), tint, step(float(0.5), vVar)), isImpF));
  const bulbOff = base.mul(0.12);
  // foliage: each tree with its own tone (lighter, yellower or darker), the top of the crown lighter and the
  // light that passes through the leaves (the shadow side does not go black)
  const treeH = hash(floor(positionWorldP.xz.div(7)).dot(vec2(1, 57.3)));
  const leafTone = mix(mix(vec3(0.82, 0.9, 0.8), vec3(1.12, 1.08, 0.82), step(float(0.55), treeH)), vec3(1.0, 1.12, 0.92), step(float(0.85), treeH));
  // flower: multiplies the leaf colour (sRGB 0x6a9a45 in linear) up to the flower colour; the impostor trunk barely changes
  const leafK = leafTone;
  const leafBase = base.mul(mix(vec3(1, 1, 1), leafK, isLeaf.max(isImpF)));
  const up = clamp(normalize(mix(vN, impNW, isImpF)).y, 0, 1);
  const through = leafBase.mul(float(0.1).add(up.mul(0.1))).mul(float(1).sub(nightU.mul(0.9))).mul(isLeaf.max(isImpF));
  // a thin part's bars against the tone behind them (render/partCards.ts)
  m.colorNode = vec4(partThinTone(mix(leafBase, bulbOff, isBulb).mul(mix(vec3(1, 1, 1), vD.xyz, vD.w)), foliage), 1);
  m.emissiveNode = through.add(pcol.xyz.mul(isBulb).mul(vLit).mul(mix(float(2.2), float(4), nightU)))
    .add(sRGBTransferEOTF(vec3(1, 0.86, 0.6)).mul(isGlass).mul(nightU).mul(6));
  m.roughnessNode = mix(mix(float(0.85), float(0.45), isMetal), float(0.95), isLeaf.max(isImpF));
  m.metalnessNode = isMetal.mul(0.3);
  // fading between levels
  const noise = interleavedGradientNoise(screenCoordinate.xy.add(fadeJitter));
  const fadeOk = select(vComp.greaterThan(0.5), noise.greaterThanEqual(float(1).sub(vFade)), noise.lessThan(vFade.add(0.002)));
  m.maskNode = partCardOn(foliage).and(fadeOk).and(isImpF.lessThan(0.5).or(impC.a.greaterThan(0.5))).and(isAtlasF.lessThan(0.5).or(atlasC.a.greaterThan(0.5))).and(isCardF.lessThan(0.5).or(leafC.a.greaterThan(0.5)));
  return m;
}
