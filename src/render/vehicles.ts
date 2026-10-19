// Carros, ônibus, caminhões e pessoas na tela. As poses vêm do worker de simulação
// (buffer triplo); aqui só se interpola, recorta e escolhe o nível:
// perto, modelos com cabine e rodas; no meio, caixas; longe, "carros de
// densidade" pintados no shader das vias (ver roads.ts).
// Quatro chamadas de desenho para a frota inteira.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { POSE_STRIDE, TILE, TILE_GRID, TILES, type PoseReader } from '../sim/poses.ts';
import { T, withPrevious, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { rainU } from './weather.ts';
import { PeopleRenderer } from './people/crowd.ts';

const {
  attribute, vec2, vec3, vec4, float, abs, cos, sin, mix, transformNormalToView, normalize,
  interleavedGradientNoise, screenCoordinate, uniformArray, int, floor, sRGBTransferEOTF, max, step, select, mod, time, smoothstep,
  cameraViewMatrix, fract, hash, clamp, atan, length,
} = T;

const NEAR = 200;
const MID = 1700;
const CAP_NEAR = 6000;
const CAP_MID = 30000;

// frota real: muito branco, prata e cinza, alguns pretos e carros coloridos vivos
export const PAINTS = [
  0xf2f2f0, 0x1c1d20, 0x8c8f94, 0xb5b8bc, 0xe8e8e4, 0xb3221f, 0x2a5aa8, 0xc4c7cb,
  0x2f7a4a, 0xd8c39a, 0x5f6368, 0xe4b512, 0x3f74c9, 0xd96a1d, 0x8e1b1b, 0x1f6f78,
];

/** Partes: [x, y, z, largura, altura, comprimento, cor fixa ou -1 = pintura]. */
type Part = [number, number, number, number, number, number, number];

function model(parts: Part[]): THREE.BufferGeometry {
  const geos = parts.map(([x, y, z, w, h, l, col]) => {
    const g = new THREE.BoxGeometry(w, h, l);
    g.translate(x, y + h / 2, z);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3), paint = new Float32Array(n), glow = new Float32Array(n);
    const color = new THREE.Color(col < 0 ? 0xffffff : col).convertSRGBToLinear();
    // faróis (1) e lanternas (2) acendem à noite e na chuva; setas (3 esquerda, 4 direita) piscam
    const gl = glowOf(col);
    for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; paint[i] = col < 0 ? 1 : 0; glow[i] = gl; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
    g.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    g.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n), 1));
    return g;
  });
  const merged = mergeGeometries(geos)!;
  return merged;
}

const GLASS = 0x1a2430, TIRE = 0x161616, LIGHT = 0xfff1c8, RED = 0x8a1010;
/** Setas (âmbar apagado; acendem pelo bit da simulação): esquerda = +x do modelo (o rumo gira de +z para +x). */
const AMBER_L = 0xb8741a, AMBER_R = 0xb8741b;
const glowOf = (col: number) => (col === LIGHT ? 1 : col === RED ? 2 : col === AMBER_L ? 3 : col === AMBER_R ? 4 : col === GLASS ? GLASS_GLOW : 0);
/** Glass (smooth, reflects the sky), exhaust puff, and the wheel parts (100 + 2 × part + front: tyre, hubcap, spoke). */
const GLASS_GLOW = 5, PUFF = 7, WHEEL = 100;

/** Re-tags a geometry as a wheel part: its colour slot holds the wheel centre (the shader rolls and steers it). */
function asWheelPart(g: THREE.BufferGeometry, part: number, front: boolean, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = g.attributes.color.array as Float32Array, gl = g.attributes.glow.array as Float32Array;
  for (let i = 0; i < n; i++) { c[i * 3] = cx; c[i * 3 + 1] = cy; c[i * 3 + 2] = cz; gl[i] = WHEEL + part * 2 + (front ? 1 : 0); }
  return g;
}

/** A wheel (Roadcraft carBody: tyre, hubcap, five spokes): it rolls with the distance driven and the front ones steer. */
function wheel(parts: THREE.BufferGeometry[], x: number, y: number, z: number, r: number, width: number, front: boolean): void {
  const side = Math.sign(x) || 1;
  const tyre = new THREE.CylinderGeometry(r, r, width, 12, 1, true); tyre.rotateZ(Math.PI / 2); tyre.translate(x, y, z);
  parts.push(asWheelPart(tagged(tyre, TIRE), 0, front, x, y, z));
  const wall = new THREE.RingGeometry(r * 0.62, r, 12); wall.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2); wall.translate(x + side * width / 2, y, z);
  parts.push(asWheelPart(tagged(wall, TIRE), 0, front, x, y, z));
  const cap = new THREE.CircleGeometry(r * 0.62, 10); cap.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2); cap.translate(x + side * (width / 2 - 0.01), y, z);
  parts.push(asWheelPart(tagged(cap, 0xb9bcbf), 1, front, x, y, z));
  for (let k = 0; k < 5; k++) {
    const sp = new THREE.BoxGeometry(0.012, r * 0.5, 0.05); sp.translate(0, r * 0.3, 0); sp.rotateX(k * Math.PI * 2 / 5); sp.translate(x + side * (width / 2 - 0.004), y, z);
    parts.push(asWheelPart(tagged(sp, 0x2a2b2d), 2, front, x, y, z));
  }
}

/** Exhaust puff: a little square at the tailpipe, billboarded and animated in the shader (anchor in the colour slot). */
function puff(parts: THREE.BufferGeometry[], x: number, y: number, z: number): void {
  const q = new THREE.PlaneGeometry(0.36, 0.36); q.translate(x, y, z);
  const g = tagged(q, 0x9a9a98);
  const n = g.attributes.position.count, c = g.attributes.color.array as Float32Array, gl = g.attributes.glow.array as Float32Array;
  for (let i = 0; i < n; i++) { c[i * 3] = x; c[i * 3 + 1] = y; c[i * 3 + 2] = z; gl[i] = PUFF; }
  parts.push(g);
}
/**
 * Sombra de mancha (roadcraft `blobShadows`) para os veículos além de SHADOW_NEAR, que não entram nas cascatas:
 * retângulo escuro 3 cm acima da pista, com a borda pontilhada (o TRAA suaviza). `glow` = BLOB; a cor leva o canto.
 */
const BLOB = 9;
function withBlob(g: THREE.BufferGeometry, w: number, l: number): THREE.BufferGeometry {
  const q = new THREE.PlaneGeometry(w + 0.6, l + 0.9).rotateX(-Math.PI / 2).toNonIndexed();
  q.translate(0, 0.03, 0);
  q.deleteAttribute('uv');
  const n = q.attributes.position.count, pos = q.attributes.position.array;
  const c = new Float32Array(n * 3);
  // canto em −1..1 nos canais r e g (o shader faz a queda do meio para a borda)
  for (let i = 0; i < n; i++) { c[i * 3] = Math.sign(pos[i * 3]); c[i * 3 + 1] = Math.sign(pos[i * 3 + 2]); }
  q.setAttribute('color', new THREE.BufferAttribute(c, 3));
  q.setAttribute('paint', new THREE.BufferAttribute(new Float32Array(n), 1));
  q.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(BLOB), 1));
  q.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n), 1));
  return mergeGeometries([g.index ? g.toNonIndexed() : g, q])!;
}

/** Ocupante (silhueta na janela): `glow` = OCC + lugar (1-16); aparece se o lugar couber na lotação da pose. */
const OCC = 10, HEAD = 0x9c7a62, SHIRT = 0x56677a;
/** Silhuetas de ocupantes 3 cm fora do vidro (o vidro é opaco): cabeça e ombros, lugar `seat`. */
function occupant(parts: THREE.BufferGeometry[], x: number, y: number, z: number, side: number, seat: number): void {
  const head = new THREE.BoxGeometry(0.02, 0.24, 0.2); head.translate(x + side * 0.01, y + 0.42, z);
  const body = new THREE.BoxGeometry(0.02, 0.3, 0.42); body.translate(x + side * 0.01, y + 0.15, z);
  for (const [g, col] of [[head, HEAD], [body, SHIRT]] as const) { const t = tagged(g, col); t.getAttribute('glow').array.fill(OCC + seat); parts.push(t); }
}

/** Atributos de cor, pintura e farol numa geometria pronta (sem índice, para juntar). */
function tagged(g: THREE.BufferGeometry, col: number, limb = 0): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  const n = out.attributes.position.count;
  const c = new Float32Array(n * 3), paint = new Float32Array(n), glow = new Float32Array(n);
  const color = new THREE.Color(col < 0 ? 0xffffff : col).convertSRGBToLinear();
  const gl = glowOf(col);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; paint[i] = col < 0 ? 1 : 0; glow[i] = gl; }
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  out.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
  out.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
  out.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n).fill(limb), 1));
  return out;
}

/** Perfil lateral (z para a frente, y para cima) extrudado na largura, centrado em x. */
function profile(pts: Array<[number, number]>, width: number): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  // rounded edges as Roadcraft's extruded bodies (carBody.ts extrude with a bevel): the same overall size
  const bevel = 0.045;
  const g = new THREE.ExtrudeGeometry(sh, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 1 });
  // the shape lies in the xy plane (x = forward); turned so x = side, z = forward
  g.translate(0, 0, -width / 2 + bevel);
  g.rotateY(-Math.PI / 2);
  return g;
}

/** Pedestre: o mesmo corpo da pessoa do criador (sapatos, pernas, tronco e braços na cor da roupa, mãos, pescoço, cabeça e cabelo). */
function personModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, col: number, limb = 0) => {
    const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y + h / 2, z); parts.push(tagged(b, col, limb));
  };
  const ball = (x: number, y: number, z: number, r: number, sy: number, col: number, detail = 0, limb = 0) => {
    const b = new THREE.IcosahedronGeometry(r, detail); b.scale(1, sy, 1); b.translate(x, y, z); parts.push(tagged(b, col, limb));
  };
  // tronco de cone (7 lados) de y0 a y1, achatado em z; sem tampas onde fica escondido
  const limbC = (x: number, y0: number, y1: number, rTop: number, rBot: number, sz: number, col: number, limb = 0, open = true) => {
    const c = new THREE.CylinderGeometry(rTop, rBot, y1 - y0, 7, 1, open); c.scale(1, 1, sz); c.translate(x, (y0 + y1) / 2, 0); parts.push(tagged(c, col, limb));
  };
  // sapatos, pernas afinando para o tornozelo, quadril
  box(-0.095, 0, 0.03, 0.11, 0.07, 0.24, 0x1b1b1b, 1); box(0.095, 0, 0.03, 0.11, 0.07, 0.24, 0x1b1b1b, 2);
  limbC(-0.095, 0.06, 0.84, 0.078, 0.052, 1, PANTS, 1); limbC(0.095, 0.06, 0.84, 0.078, 0.052, 1, PANTS, 2);
  limbC(0, 0.76, 0.93, 0.17, 0.165, 0.62, PANTS, 0, false);
  // tronco mais largo nos ombros, braços afinando para o punho, mãos
  limbC(0, 0.9, 1.4, 0.205, 0.168, 0.58, -1, 0, false);
  limbC(-0.25, 0.83, 1.38, 0.058, 0.045, 1, -1, 3); limbC(0.25, 0.83, 1.38, 0.058, 0.045, 1, -1, 4);
  ball(-0.25, 0.79, 0, 0.05, 1.2, SKIN, 0, 3); ball(0.25, 0.79, 0, 0.05, 1.2, SKIN, 0, 4);
  // pescoço, cabeça e cabelo
  limbC(0, 1.37, 1.46, 0.048, 0.052, 1, SKIN);
  ball(0, 1.56, 0, 0.115, 1.12, SKIN, 1);
  ball(0, 1.615, -0.02, 0.122, 0.82, HAIR, 1);
  return mergeGeometries(parts)!;
}

/** Carroceria de passeio pelo perfil lateral (z para a frente, y para cima). */
interface CarSpec {
  /** Silhueta da carroceria, dos vidros (um pouco mais larga: aparece dos lados) e do teto. */
  body: Array<[number, number]>; glass: Array<[number, number]>; roof: Array<[number, number]>;
  width: number; half: number;
  /** Rodas: distância do eixo ao centro (z), raio. */
  axle: number; wheel: number;
  /** Altura das luzes. */
  lamp: number;
  /** Caçamba da picape: z0, z1, y0, y1. */
  bed?: [number, number, number, number];
}

/** Sedã, hatch, SUV, van e picape (os estilos 0-4 da simulação; o 5 é a moto), como os arquétipos do roadcraft. */
const CAR_SPECS: CarSpec[] = [
  {
    body: [[2.2, 0.3], [2.2, 0.68], [1.95, 0.8], [1.0, 0.88], [0.32, 1.4], [-1.05, 1.42], [-1.75, 0.98], [-2.18, 0.9], [-2.2, 0.3]],
    glass: [[1.05, 0.9], [0.34, 1.41], [-1.04, 1.44], [-1.79, 0.99], [-1.6, 0.9]],
    roof: [[0.3, 1.38], [0.33, 1.43], [-1.06, 1.45], [-1.04, 1.38]], width: 1.76, half: 2.2, axle: 1.38, wheel: 0.33, lamp: 0.6,
  },
  {
    body: [[1.95, 0.3], [1.95, 0.66], [1.72, 0.78], [0.86, 0.86], [0.22, 1.42], [-1.55, 1.44], [-1.9, 1.05], [-1.95, 0.3]],
    glass: [[0.9, 0.88], [0.24, 1.43], [-1.52, 1.46], [-1.86, 1.05], [-1.72, 0.9]],
    roof: [[0.2, 1.38], [0.23, 1.45], [-1.56, 1.46], [-1.54, 1.38]], width: 1.72, half: 1.95, axle: 1.25, wheel: 0.31, lamp: 0.64,
  },
  {
    body: [[2.3, 0.4], [2.3, 0.86], [2.02, 0.98], [1.12, 1.06], [0.5, 1.68], [-1.92, 1.7], [-2.26, 1.24], [-2.3, 0.4]],
    glass: [[1.15, 1.08], [0.52, 1.69], [-1.9, 1.72], [-2.22, 1.25], [-2.02, 1.08]],
    roof: [[0.48, 1.64], [0.5, 1.72], [-1.93, 1.73], [-1.9, 1.64]], width: 1.86, half: 2.3, axle: 1.45, wheel: 0.38, lamp: 0.82,
  },
  {
    body: [[2.45, 0.35], [2.45, 0.9], [2.12, 1.06], [1.62, 1.88], [-2.45, 1.95], [-2.45, 0.35]],
    glass: [[1.98, 1.1], [1.64, 1.86], [-2.2, 1.9], [-2.2, 1.15]],
    roof: [[1.56, 1.87], [1.58, 1.97], [-2.45, 1.98], [-2.44, 1.87]], width: 1.9, half: 2.45, axle: 1.62, wheel: 0.34, lamp: 0.8,
  },
  {
    body: [[2.65, 0.42], [2.65, 0.9], [2.35, 1.0], [1.32, 1.08], [0.82, 1.72], [-0.5, 1.74], [-0.6, 1.0], [-0.6, 0.42]],
    glass: [[1.36, 1.1], [0.84, 1.71], [-0.42, 1.73], [-0.44, 1.1]],
    roof: [[0.8, 1.68], [0.82, 1.75], [-0.52, 1.76], [-0.5, 1.68]], width: 1.86, half: 2.65, axle: 1.78, wheel: 0.38, lamp: 0.86,
    bed: [-2.65, -0.62, 0.42, 1.02],
  },
];

/** Carro de passeio: carroceria pelo perfil (capô, para-brisa, teto, traseira), vidros, rodas, para-choques, luzes e setas. */
function carModel(k: CarSpec = CAR_SPECS[0]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [tagged(profile(k.body, k.width), -1), tagged(profile(k.glass, k.width + 0.03), GLASS), tagged(profile(k.roof, k.width - 0.14), -1)];
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, col: number) => {
    const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y + h / 2, z); parts.push(tagged(b, col));
  };
  const H = k.half, W = k.width;
  if (k.bed) {
    const [z0, z1, y0, y1] = k.bed;
    box(0, y0, (z0 + z1) / 2, W, y1 - y0, z1 - z0, -1);
    box(0, y1, (z0 + z1) / 2, W - 0.16, 0.03, z1 - z0 - 0.14, 0x2a2b2d); // a caçamba vista de cima
  }
  const by = k.wheel - 0.11;
  box(0, by, H - 0.03, W - 0.02, 0.22, 0.12, 0x2a2b2d); // para-choques
  box(0, by, -H + 0.03, W - 0.02, 0.22, 0.12, 0x2a2b2d);
  box(W * 0.34, k.lamp, H + 0.01, 0.42, 0.12, 0.02, LIGHT); box(-W * 0.34, k.lamp, H + 0.01, 0.42, 0.12, 0.02, LIGHT);
  box(W * 0.37, k.lamp + 0.06, -H - 0.01, 0.36, 0.12, 0.02, RED); box(-W * 0.37, k.lamp + 0.06, -H - 0.01, 0.36, 0.12, 0.02, RED);
  // setas nos quatro cantos (+x = esquerda do motorista), 3 cm à frente das luzes (nada no mesmo plano)
  for (const zz of [H + 0.04, -H - 0.04]) { box(W / 2 - 0.09, k.lamp - 0.02, zz, 0.18, 0.14, 0.02, AMBER_L); box(-W / 2 + 0.09, k.lamp - 0.02, zz, 0.18, 0.14, 0.02, AMBER_R); }
  // motorista nas janelas dos dois lados (lugar 1)
  const gy = k.lamp + 0.22, gz = k.glass[1][0] - 0.35;
  for (const side of [1, -1]) occupant(parts, side * (W / 2 + 0.03), gy, gz, side, 1);
  for (const z of [k.axle, -k.axle]) for (const x of [W / 2 - 0.08, -W / 2 + 0.08]) wheel(parts, x, k.wheel, z, k.wheel, 0.22, z > 0);
  puff(parts, W * 0.3, 0.28, -H - 0.2);
  return mergeGeometries(parts)!;
}

/** Moto com o piloto (capacete na cor da moto), 2,1 m. */
function motoModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [tagged(profile([[0.95, 0.42], [0.88, 0.78], [0.35, 0.86], [-0.25, 0.9], [-0.9, 0.82], [-0.98, 0.5], [-0.3, 0.4]], 0.3), -1)];
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, col: number) => {
    const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y + h / 2, z); parts.push(tagged(b, col));
  };
  for (const z of [0.72, -0.72]) wheel(parts, 0.06, 0.31, z, 0.31, 0.12, z > 0);
  box(0, 0.86, 0.72, 0.62, 0.04, 0.04, 0x2a2b2d); // guidão
  box(0, 0.74, 0.97, 0.14, 0.1, 0.03, LIGHT); box(0, 0.76, -0.99, 0.12, 0.08, 0.03, RED);
  box(0.17, 0.78, 0.94, 0.05, 0.05, 0.03, AMBER_L); box(-0.17, 0.78, 0.94, 0.05, 0.05, 0.03, AMBER_R);
  box(0.17, 0.7, -0.97, 0.05, 0.05, 0.03, AMBER_L); box(-0.17, 0.7, -0.97, 0.05, 0.05, 0.03, AMBER_R);
  // piloto (só sem as pessoas cozidas, src/render/people): lugar 1 dos ocupantes
  const rider = parts.length;
  box(0.15, 0.5, 0.05, 0.12, 0.42, 0.3, 0x24262c); box(-0.15, 0.5, 0.05, 0.12, 0.42, 0.3, 0x24262c);
  const t = new THREE.BoxGeometry(0.4, 0.62, 0.24); t.rotateX(0.32); t.translate(0, 1.22, 0.02); parts.push(tagged(t, 0x30343c));
  box(0.22, 1.12, 0.42, 0.09, 0.09, 0.42, 0x30343c); box(-0.22, 1.12, 0.42, 0.09, 0.09, 0.42, 0x30343c);
  const h = new THREE.IcosahedronGeometry(0.15, 1); h.translate(0, 1.66, 0.12); parts.push(tagged(h, -1));
  for (let i = rider; i < parts.length; i++) (parts[i].getAttribute('glow').array as Float32Array).fill(OCC + 1);
  return mergeGeometries(parts)!;
}

const BUS: Part[] = [
  [0, 0.35, 0, 2.5, 1.2, 11.8, -1],
  [0, 1.55, 0, 2.52, 1.0, 11.2, GLASS],
  [0, 2.55, 0, 2.5, 0.5, 11.8, -1],
  [0, 0.6, 5.91, 2.0, 0.2, 0.02, LIGHT],
  [0.8, 0.7, -5.91, 0.4, 0.2, 0.02, RED], [-0.8, 0.7, -5.91, 0.4, 0.2, 0.02, RED],
  [1.15, 0.6, 5.92, 0.16, 0.14, 0.02, AMBER_L], [-1.15, 0.6, 5.92, 0.16, 0.14, 0.02, AMBER_R],
  [1.15, 0.95, -5.92, 0.16, 0.14, 0.02, AMBER_L], [-1.15, 0.95, -5.92, 0.16, 0.14, 0.02, AMBER_R],
];
/** Bicicleta com o ciclista (1,8 m): rodas finas, quadro, guidão, ciclista curvado e capacete na cor. */
export function bikeModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, col: number) => {
    const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y + h / 2, z); parts.push(tagged(b, col));
  };
  // wheels: tyre and three spokes, marked as wheel parts so the shader rolls them with the distance ridden
  for (const z of [0.55, -0.55]) {
    const w = new THREE.TorusGeometry(0.33, 0.025, 4, 14); w.rotateY(Math.PI / 2); w.translate(0, 0.35, z);
    parts.push(asWheelPart(tagged(w, TIRE), 0, false, 0, 0.35, z));
    for (let k = 0; k < 3; k++) {
      const sp = new THREE.BoxGeometry(0.012, 0.62, 0.012); sp.rotateX(k * Math.PI / 3); sp.translate(0, 0.35, z);
      parts.push(asWheelPart(tagged(sp, 0x9a9da0), 2, false, 0, 0.35, z));
    }
  }
  const bar = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, col: number) => {
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize());
    const h = new THREE.CylinderGeometry(r, r, L, 5, 1, true); h.applyQuaternion(q); h.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    parts.push(tagged(h, col));
  };
  // quadro (pintado), guidão, selim
  bar(0, 0.35, -0.55, 0, 0.75, -0.12, 0.022, -1); bar(0, 0.35, -0.55, 0, 0.4, 0.05, 0.022, -1);
  bar(0, 0.4, 0.05, 0, 0.75, -0.12, 0.022, -1); bar(0, 0.75, -0.12, 0, 0.82, 0.42, 0.022, -1); bar(0, 0.35, 0.55, 0, 0.92, 0.42, 0.02, 0x2a2b2d);
  box(0, 0.92, 0.38, 0.5, 0.03, 0.04, 0x2a2b2d); box(0, 0.8, -0.16, 0.12, 0.05, 0.24, 0x1b1b1b);
  // ciclista (só sem as pessoas cozidas, src/render/people): lugar 1 dos ocupantes, aceso pela cor
  const rider = parts.length;
  box(0.11, 0.42, -0.08, 0.1, 0.42, 0.14, 0x2c3140); box(-0.11, 0.42, 0.02, 0.1, 0.42, 0.14, 0x2c3140);
  const t = new THREE.BoxGeometry(0.34, 0.55, 0.22); t.rotateX(0.55); t.translate(0, 1.12, 0.02); parts.push(tagged(t, 0x56677a));
  box(0.17, 1.06, 0.26, 0.07, 0.07, 0.36, 0x56677a); box(-0.17, 1.06, 0.26, 0.07, 0.07, 0.36, 0x56677a);
  const head = new THREE.IcosahedronGeometry(0.12, 1); head.translate(0, 1.5, 0.22); parts.push(tagged(head, -1));
  for (let i = rider; i < parts.length; i++) (parts[i].getAttribute('glow').array as Float32Array).fill(OCC + 1);
  return mergeGeometries(parts)!;
}

/** Ônibus com os passageiros nas janelas: 16 lugares alternando os lados, da frente para trás (o 1 é o motorista). */
function busModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [model(BUS).toNonIndexed()];
  for (const z of [3.8, -3.6]) for (const x of [1.1, -1.1]) wheel(parts, x, 0.47, z, 0.47, 0.3, z > 0);
  puff(parts, 0.8, 0.35, -6.1);
  occupant(parts, 1.29, 1.35, 5.0, 1, 1);
  for (let k = 2; k <= 16; k++) {
    const side = k % 2 ? 1 : -1, row = Math.floor((k - 1) / 2);
    occupant(parts, side * 1.29, 1.35, 4.2 - row * 1.25, side, k);
  }
  return mergeGeometries(parts)!;
}

/** Caminhão com o motorista na cabine. */
function truckModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [model(TRUCK).toNonIndexed()];
  for (const z of [3.6, -3.2]) for (const x of [1.1, -1.1]) wheel(parts, x, 0.48, z, 0.48, 0.32, z > 0);
  puff(parts, 0.9, 0.4, -4.9);
  for (const side of [1, -1]) occupant(parts, side * 1.18, 1.45, 3.85, side, 1);
  return mergeGeometries(parts)!;
}

const TRUCK: Part[] = [
  [0, 0.4, 3.65, 2.4, 1.3, 2.2, -1], // cabine
  [0, 1.7, 3.85, 2.3, 0.75, 1.6, GLASS],
  [0, 2.45, 3.65, 2.4, 0.25, 2.2, -1],
  [0, 0.9, -1.1, 2.5, 2.7, 7.1, 0xd9d6cf], // baú
  [0, 0.35, -1.1, 2.0, 0.55, 7.1, 0x2b2b2b],
  [0.9, 0.55, -4.67, 0.36, 0.16, 0.02, RED], [-0.9, 0.55, -4.67, 0.36, 0.16, 0.02, RED],
  [1.12, 0.75, 4.77, 0.14, 0.12, 0.02, AMBER_L], [-1.12, 0.75, 4.77, 0.14, 0.12, 0.02, AMBER_R],
  [1.12, 0.75, -4.67, 0.14, 0.12, 0.02, AMBER_L], [-1.12, 0.75, -4.67, 0.14, 0.12, 0.02, AMBER_R],
];
const SKIN = 0xc89a78, PANTS = 0x2c3140, HAIR = 0x2a1f18;
/** Vagão de trem/metrô (20 m): caixa pintada na cor da linha, faixa de janelas, teto, truques. */
const WAGON: Part[] = [
  [0, 0.9, 0, 2.9, 2.9, 19.6, 0xd8dadc],
  [0, 1.05, 0, 2.94, 0.5, 19.7, -1], // faixa da cor da linha
  [0, 2.0, 0, 2.95, 1.0, 18.4, GLASS],
  [0, 3.8, 0, 2.6, 0.25, 18.8, 0x9aa0a4],
  [0, 0.3, 6.5, 2.4, 0.65, 2.6, 0x2a2b2d], [0, 0.3, -6.5, 2.4, 0.65, 2.6, 0x2a2b2d], // truques
  [0, 1.4, 9.82, 2.2, 1.6, 0.04, GLASS], [0, 0.95, 9.84, 1.6, 0.18, 0.02, LIGHT],
];
/** Caixa unitária para o nível do meio (escalada por instância). */
const BOX: Part[] = [[0, 0, 0, 1, 1, 1, -1]];
const KIND_DIMS: Array<[number, number, number]> = [[1.8, 1.45, 4.4], [2.5, 3.0, 12], [2.5, 3.3, 9.5], [0.45, 1.7, 0.3], [2.95, 4.0, 19.8],
  // estilos de carro 1-5 (hatch, SUV, van, picape, moto): caixa 5-9
  [1.74, 1.45, 3.9], [1.88, 1.72, 4.6], [1.92, 1.97, 4.9], [1.88, 1.74, 5.3], [0.7, 1.6, 2.1],
  // bicicleta (10)
  [0.6, 1.75, 1.8]];
/** Índice do modelo detalhado: estilos de carro 0-5, ônibus 6, caminhão 7, pessoa 8, vagão 9, bicicleta 10. */
const modelOf = (kind: number, style: number) => (kind === 0 ? style : kind + 5);
const dimsOf = (kind: number, style: number) => (kind === 0 && style > 0 ? 4 + style : kind === 5 ? 10 : kind);
/** Pessoas: modelo até aqui, caixa até PERSON_MID. */
const PERSON_NEAR = 70;
/** Veículos detalhados com sombra só até aqui; depois, o mesmo modelo sem sombra (a sombra some na distância). */
const SHADOW_NEAR = 90;
const PERSON_MID = 480;

class Batch {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly info: Float32Array;
  /** Pose do quadro anterior (velocidade do TRAA: sem ela o carro andando borra e treme). */
  readonly prev: Float32Array;
  private posAttr: THREE.InstancedBufferAttribute;
  private prevAttr: THREE.InstancedBufferAttribute;
  private infoAttr: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  count = 0;
  readonly cap: number;

  constructor(base: THREE.BufferGeometry, cap: number, scaled: boolean, shadows = true, animated = false) {
    this.cap = cap;
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.attributes[k]);
    this.pos = new Float32Array(cap * 4);
    this.info = new Float32Array(cap * 4);
    this.prev = new Float32Array(cap * 4);
    this.prevAttr = new THREE.InstancedBufferAttribute(this.prev, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    // pessoas: os membros já ocupam o 8º buffer de vértices (limite do WebGPU); a 1,4 m/s a pose atual basta
    if (!animated) g.setAttribute('iprev', this.prevAttr);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    g.setAttribute('ipos', this.posAttr);
    g.setAttribute('iinfo', this.infoAttr);
    g.instanceCount = 0;
    this.geo = g;
    // um material por combinação (comum, caixa, pessoa) para todos os lotes: cada material a mais é um shader a
    // montar e compilar na carga (19 lotes eram 19 materiais e a cidade abria 1,5 s mais devagar)
    const key = (scaled ? 1 : 0) + (animated ? 2 : 0);
    this.mesh = new THREE.Mesh(g, MATERIALS[key] ??= vehicleMaterial(scaled, animated));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = true;
  }

  /** `lod`: troca perto/meio por máscaras complementares (perto: ruído < lod; meio: lod = −1 − f, ruído ≥ f),
   *  assim o modelo e a caixa nunca disputam o mesmo pixel. */
  push(x: number, y: number, z: number, yaw: number, color: number, alpha: number, kind: number, lod = 1, px = x, py = y, pz = z, pyaw = yaw): void {
    if (this.count >= this.cap) return;
    const o = this.count * 4;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z; this.pos[o + 3] = yaw;
    this.prev[o] = px; this.prev[o + 1] = py; this.prev[o + 2] = pz; this.prev[o + 3] = pyaw;
    this.info[o] = color; this.info[o + 1] = alpha; this.info[o + 2] = kind; this.info[o + 3] = lod;
    this.count++;
  }

  commit(): void {
    this.geo.instanceCount = this.count;
    this.posAttr.clearUpdateRanges(); this.posAttr.addUpdateRange(0, this.count * 4); this.posAttr.needsUpdate = true;
    this.infoAttr.clearUpdateRanges(); this.infoAttr.addUpdateRange(0, this.count * 4); this.infoAttr.needsUpdate = true;
    this.prevAttr.clearUpdateRanges(); this.prevAttr.addUpdateRange(0, this.count * 4); this.prevAttr.needsUpdate = true;
  }
}

const MATERIALS: Array<THREE.MeshStandardNodeMaterial | undefined> = [];

function vehicleMaterial(scaled: boolean, animated: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const ipos = attribute('ipos', 'vec4');
  const info = attribute('iinfo', 'vec4');
  const iprev = animated ? null : attribute('iprev', 'vec4');
  const rotBy = (yaw: Node) => {
    const c = cos(yaw), s = sin(yaw);
    return (p: Node) => vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.x.negate().mul(s).add(p.z.mul(c)));
  };
  const rot = rotBy(ipos.w);
  let local: Node = attribute('position', 'vec3');
  let nrm: Node = attribute('normal', 'vec3');
  if (animated) {
    // só as pessoas: pernas e braços balançam (carros e ônibus não pagam esta conta)
    const limb = attribute('limb', 'float');
    const isLimb = step(float(0.5), limb);
    const isArm = step(float(2.5), limb);
    const side = select(mod(limb, 2).greaterThan(0.5), float(1), float(-1));
    // passo: ~1,9 passadas por segundo, fase pela posição (cada pessoa no seu ritmo)
    const phase = time.mul(6).add(ipos.x.mul(0.71)).add(ipos.z.mul(0.53));
    const ang = sin(phase).mul(select(isArm.greaterThan(0.5), float(0.45), float(0.5))).mul(side).mul(select(isArm.greaterThan(0.5), float(-1), float(1))).mul(isLimb);
    const pivot = select(isArm.greaterThan(0.5), float(1.36), float(0.83));
    const ca = cos(ang), sa = sin(ang);
    const dy = local.y.sub(pivot);
    local = vec3(local.x, pivot.add(dy.mul(ca)).sub(local.z.mul(sa)), dy.mul(sa).add(local.z.mul(ca)));
    nrm = vec3(nrm.x, nrm.y.mul(ca).sub(nrm.z.mul(sa)), nrm.y.mul(sa).add(nrm.z.mul(ca)));
  }
  if (scaled) {
    // caixa unitária com base no chão, escalada pelo tipo
    const k = int(info.z.add(0.5));
    const dims = uniformArray(KIND_DIMS.map((d) => new THREE.Vector3(...d)), 'vec3');
    local = local.add(vec3(0, 0.5, 0)).mul(dims.element(k));
  }
  const glowV = attribute('glow', 'float');
  let world: Node = rot(local).add(ipos.xyz);
  let puffShow: Node = float(1).greaterThan(0);
  if (!animated) {
    // wheels roll by the distance driven along the heading and the front ones steer by the turn rate (curvature ×
    // wheelbase from this frame's and last frame's pose), round their own centre (kept in the colour slot)
    const isWheel = step(float(WHEEL - 0.5), glowV);
    const front = mod(glowV.sub(WHEEL), 2).mul(isWheel);
    const centre = attribute('color', 'vec3');
    const r = max(centre.y, float(0.1));
    const travelled = ipos.x.mul(sin(ipos.w)).add(ipos.z.mul(cos(ipos.w)));
    const a = travelled.div(r).mul(isWheel);
    let dyaw: Node = ipos.w.sub(iprev.w);
    dyaw = dyaw.sub(floor(dyaw.div(6.2832).add(0.5)).mul(6.2832));
    const moved = length(ipos.xz.sub(iprev.xz));
    const steer = clamp(atan(dyaw.div(max(moved, float(0.05))).mul(2.6)), -0.55, 0.55).mul(step(float(0.02), moved)).mul(front);
    const ca = cos(a), sa = sin(a), cs = cos(steer), ss = sin(steer);
    const roll = (v: Node) => vec3(v.x, v.y.mul(ca).sub(v.z.mul(sa)), v.y.mul(sa).add(v.z.mul(ca)));
    const turn = (v: Node) => vec3(v.x.mul(cs).add(v.z.mul(ss)), v.y, v.x.negate().mul(ss).add(v.z.mul(cs)));
    const q = local.sub(centre);
    local = mix(local, centre.add(turn(roll(q))), isWheel);
    nrm = mix(nrm, turn(roll(nrm)), isWheel);
    world = rot(local).add(ipos.xyz);
    // exhaust puff: rises and drifts back from the tailpipe over ~1.3 s, growing and fading (dithered)
    const isPuff = step(abs(glowV.sub(PUFF)), float(0.5));
    const life = fract(time.mul(0.75).add(hash(ipos.x.mul(1.7).add(ipos.z.mul(3.1)))));
    const anchor = attribute('color', 'vec3');
    const rel = attribute('position', 'vec3').sub(anchor);
    const corner = rel.xy.mul(float(1).add(life.mul(2)));
    const camR = vec3(cameraViewMatrix.element(0).x, cameraViewMatrix.element(1).x, cameraViewMatrix.element(2).x);
    const camU = vec3(cameraViewMatrix.element(0).y, cameraViewMatrix.element(1).y, cameraViewMatrix.element(2).y);
    const puffPos = rot(anchor.add(vec3(0, life.mul(0.55), life.mul(-0.9)))).add(ipos.xyz).add(camR.mul(corner.x)).add(camU.mul(corner.y));
    world = mix(world, puffPos, isPuff);
    const r2 = clamp(length(rel.xy).div(0.18), 0, 1);
    puffShow = isPuff.lessThan(0.5).or(float(1).sub(life).mul(float(1).sub(r2)).mul(0.45).greaterThan(interleavedGradientNoise(screenCoordinate.xy.add(vec2(51, 17)))));
  }
  m.positionNode = world;
  withPrevious(m, animated ? undefined : rotBy(iprev.w)(local).add(iprev.xyz));
  m.normalNode = transformNormalToView(normalize(rot(nrm)));
  const palette = uniformArray(PAINTS.map((p) => new THREE.Color(p)), 'color');
  // info.x = cor (0-15) + 16 × luzes da simulação (1 freio, 2 seta esquerda, 4 seta direita)
  const code = floor(info.x.add(0.5));
  const paint = sRGBTransferEOTF(palette.element(int(mod(code, 16))));
  const lightBits = floor(code.div(16));
  // ocupantes: lugares até a lotação (bits 3-5 das luzes, 0-7 → 0-16 lugares; carro = só o motorista)
  const seatsOn = floor(lightBits.div(8)).mul(16 / 7);
  const glowA = attribute('glow', 'float');
  const seat = glowA.sub(OCC);
  const occOk = seat.lessThan(0.5).or(seat.greaterThan(16.5)).or(seat.lessThan(seatsOn.add(0.5)));
  // sombra de mancha: escura no meio, some na borda (pontilhado por outro ruído)
  const isBlob = step(abs(glowA.sub(BLOB)), float(0.5));
  const blobR = attribute('color', 'vec3').xy.length().div(1.414);
  const blobOk = isBlob.lessThan(0.5).or(float(1).sub(smoothstep(float(0.35), float(1), blobR)).mul(0.85).greaterThan(interleavedGradientNoise(screenCoordinate.xy.add(vec2(7.0, 13.0)))));
  // wheel parts and puffs keep a centre in the colour slot: their colour is by part
  const wPart = floor(glowA.sub(WHEEL).div(2));
  const wheelC = select(wPart.lessThan(0.5), sRGBTransferEOTF(vec3(0.086, 0.086, 0.086)), select(wPart.lessThan(1.5), sRGBTransferEOTF(vec3(0.73, 0.74, 0.75)), sRGBTransferEOTF(vec3(0.16, 0.17, 0.18))));
  const isWheelF = step(float(WHEEL - 0.5), glowA);
  const isPuffF = step(abs(glowA.sub(PUFF)), float(0.5));
  const isGlass = step(abs(glowA.sub(GLASS_GLOW)), float(0.5));
  const surf = mix(mix(attribute('color', 'vec3'), paint, attribute('paint', 'float')), wheelC, isWheelF);
  m.colorNode = vec4(mix(mix(surf, vec3(0.015, 0.015, 0.02), isBlob), vec3(0.45, 0.45, 0.44), isPuffF), 1);
  // paint with a clear coat look, glass smooth (it shows the sky from the environment), the rest matte
  m.roughnessNode = mix(mix(float(0.28), float(0.62), attribute('paint', 'float').oneMinus()), float(0.05), isGlass).add(isPuffF);
  m.metalnessNode = attribute('paint', 'float').mul(0.3);
  if (!scaled) {
    const gl = attribute('glow', 'float');
    const on = max(nightU, rainU.mul(0.7));
    const isK = (k: number) => step(abs(gl.sub(k)), float(0.5));
    const brake = mod(lightBits, 2), left = mod(floor(lightBits.div(2)), 2), right = mod(floor(lightBits.div(4)), 2);
    // (os lugares dos ocupantes ficam acima de 9.5: nenhuma luz)
    // seta pisca a 1,5 Hz; freio acende a lanterna também de dia
    const blink = step(float(0), sin(time.mul(9.42)));
    const head = vec3(1, 0.93, 0.78).mul(6).mul(on).mul(isK(1));
    const tail = vec3(1, 0.05, 0.03).mul(max(on.mul(3.5), brake.mul(2.6))).mul(isK(2));
    const amber = vec3(1, 0.5, 0.06).mul(7).mul(blink).mul(isK(3).mul(left).add(isK(4).mul(right)));
    m.emissiveNode = head.add(tail).add(amber);
  }
  // aparece e some por pontilhado (sem transparência)
  const alpha = info.y, lod = info.w;
  const n = interleavedGradientNoise(screenCoordinate.xy);
  const lodOk = select(lod.greaterThanEqual(0), n.lessThan(lod), n.greaterThanEqual(lod.negate().sub(1)));
  // surgir/sumir com outro ruído (o mesmo ruído do nível furaria os mesmos pixels nos dois)
  m.maskNode = lodOk.and(occOk).and(blobOk).and(puffShow).and(alpha.greaterThan(interleavedGradientNoise(screenCoordinate.xy.add(vec2(23.0, 41.0)))));
  return m;
}

/** The pose at `o` is the followed vehicle: its own id (pose index 10) and kind and colour (light bits left out). */
export function followMatch(d: Float32Array, o: number, f: { info: number; id: number }): boolean {
  return d[o + 10] === f.id && d[o + 8] % 65536 === f.info;
}

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private near: Batch[];
  /** Carros, ônibus e caminhões detalhados além de SHADOW_NEAR: o mesmo modelo, sem sombra. */
  private nearFar: Batch[];
  private mid: Batch;
  private reader: PoseReader;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 7);
  private tileBox = new THREE.Box3();
  /** Pedestres e ciclistas cozidos (src/render/people); até carregarem, os bonecos simples. */
  readonly people = new PeopleRenderer();

  constructor(reader: PoseReader) {
    this.reader = reader;
    // um modelo por estilo de carro (o mesmo material: uma chamada a mais por estilo que aparece)
    const cars = [...CAR_SPECS.map((k) => carModel(k)), motoModel()];
    const bus = busModel(), truck = truckModel();
    const carCap = (i: number) => (i < 2 ? CAP_NEAR : CAP_NEAR / 2);
    this.near = [...cars.map((g, i) => new Batch(g, carCap(i), false)), new Batch(bus, 1024, false), new Batch(truck, 1024, false), new Batch(personModel(), 8000, false, true, true), new Batch(model(WAGON), 512, false), new Batch(bikeModel(), 2000, false)];
    // além da sombra das cascatas: o mesmo modelo com a sombra de mancha embaixo
    const blobs = [...CAR_SPECS.map((k) => [k.width, k.half * 2]), [0.7, 2.1]];
    this.nearFar = [...cars.map((g, i) => new Batch(withBlob(g, blobs[i][0], blobs[i][1]), carCap(i), false, false)),
      new Batch(withBlob(bus, 2.5, 11.8), 1024, false, false), new Batch(withBlob(truck, 2.5, 9.5), 1024, false, false)];
    // longe (caixas até 1,7 km): sem sombra (menos de um pixel, e eram até 30 mil nas três passadas de sombra)
    this.mid = new Batch(model(BOX), CAP_MID, true, false);
    for (const b of [...this.near, ...this.nearFar, this.mid]) this.group.add(b.mesh);
    this.group.add(this.people.group);
    void this.people.load();
  }

  /** Medições: não desenha as pessoas. */
  hidePeople = false;

  /** Veículo seguido pela câmera: rastreado pela pose mais perto da última, com o mesmo tipo e cor. */
  follow: { x: number; z: number; info: number; id: number; lost: number } | null = null;
  /** Pose do seguido neste quadro: x, y, z, rumo. */
  readonly followPose = new Float64Array(4);

  /** Começa a seguir o veículo mais perto de (x, z), num raio. */
  pick(x: number, z: number, radius: number): boolean {
    const r = this.reader, d = r.data;
    let best = -1, bd = radius * radius;
    for (let i = 0; i < r.count; i++) {
      const o = i * POSE_STRIDE;
      if ((Math.floor(d[o + 8] / 256) & 255) === 3) continue; // pessoas não
      const dd = (d[o + 4] - x) ** 2 + (d[o + 6] - z) ** 2;
      if (dd < bd) { bd = dd; best = o; }
    }
    if (best < 0) return false;
    this.follow = { x: d[best + 4], z: d[best + 6], info: d[best + 8] % 65536, id: d[best + 10], lost: 0 };
    return true;
  }

  /** Lê as poses mais novas, interpola e enche os lotes visíveis. */
  /** Momento do quadro anterior (pose anterior para a velocidade do TRAA). */
  private lastNow = 0;

  update(camera: THREE.Camera, eye: THREE.Vector3, frameNow = performance.now()): void {
    const r = this.reader;
    r.acquire();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    for (const b of this.near) b.count = 0;
    for (const b of this.nearFar) b.count = 0;
    this.mid.count = 0;
    const people = this.people.ready ? this.people : null;
    people?.begin(camera);
    const n = r.count;
    if (n > 0) {
      // instante do quadro (o do rAF), não o do meio do quadro: senão o passo varia com o trabalho antes daqui
      const now = performance.timeOrigin + frameNow;
      const span = Math.max(1, r.dt);
      const t = Math.min(1, Math.max(0, (now - r.tickTime) / span));
      // anterior pela mesma reta (antes do passo atual: extrapola para trás, no máximo um passo)
      const prevNow = this.lastNow > 0 && frameNow - this.lastNow < 200 ? performance.timeOrigin + this.lastNow : now;
      const tp = Math.min(t, Math.max(-1, (prevNow - r.tickTime) / span));
      const d = r.data;
      const fol = this.follow, fp = this.followPose;
      let fbest = 12 * 12;
      // tile by tile (the worker sorts the records by tile around the camera): whole tiles out of view or beyond the
      // drawing distance are skipped without reading their poses; the grid's edge tiles hold what lies beyond it
      const tiled = r.tiled, tiles = r.tiles, gx = r.originX, gz = r.originZ, box = this.tileBox;
      for (let tile = 0; tile < (tiled ? TILES : 1); tile++) {
        const i0 = tiled ? tiles[tile] : 0, i1 = tiled ? tiles[tile + 1] : n;
        if (i0 >= i1) continue;
        if (tiled) {
          const tx = tile % TILE_GRID, tz = (tile / TILE_GRID) | 0;
          if (tx > 0 && tz > 0 && tx < TILE_GRID - 1 && tz < TILE_GRID - 1) {
            box.min.set(gx + tx * TILE - 15, -500, gz + tz * TILE - 15);
            box.max.set(gx + (tx + 1) * TILE + 15, 2500, gz + (tz + 1) * TILE + 15);
            if (box.distanceToPoint(eye) > MID || !this.frustum.intersectsBox(box)) continue;
          }
        }
        for (let i = i0; i < i1; i++) {
          const o = i * POSE_STRIDE;
          const x = d[o] + (d[o + 4] - d[o]) * t;
          const y = d[o + 1] + (d[o + 5] - d[o + 1]) * t;
          const z = d[o + 2] + (d[o + 6] - d[o + 2]) * t;
          let dy = d[o + 7] - d[o + 3];
          if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
          const yaw = d[o + 3] + dy * t;
          const px = d[o] + (d[o + 4] - d[o]) * tp, py = d[o + 1] + (d[o + 5] - d[o + 1]) * tp, pz = d[o + 2] + (d[o + 6] - d[o + 2]) * tp;
          const pyaw = d[o + 3] + dy * tp;
          if (fol && followMatch(d, o, fol)) {
            const dd = (x - fol.x) ** 2 + (z - fol.z) ** 2;
            if (dd < fbest) { fbest = dd; fp[0] = x; fp[1] = y; fp[2] = z; fp[3] = yaw; }
          }
          this.sphere.center.set(x, y + 1, z);
          this.sphere.radius = d[o + 8] % 65536 >= 4 * 256 ? 12 : 7;
          if (!this.frustum.intersectsSphere(this.sphere)) continue;
          const dist = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
          if (dist > MID) continue;
          // tipo × 256 + cor (bits 0-3; estilo do carro nos bits 4-6; 128 = vagão da frente) + luzes × 65536
          const info = d[o + 8], lights = Math.floor(info / 65536), base = info - lights * 65536;
          const kind = Math.floor(base / 256), low = base - kind * 256;
          const style = kind === 0 ? (low >> 4) & 7 : 0;
          // com as pessoas cozidas o piloto da moto é uma delas: os lugares da moto apagam
          const shown = people && kind === 0 && style === 5 ? lights & 7 : lights;
          const color = (kind === 0 ? low & 15 : low & 127) + shown * 16 + (kind === 5 && !people ? 128 : 0);
          // pessoas e bicicletas: pequenas, modelo só até PERSON_NEAR e caixa até PERSON_MID
          const person = kind === 3, small = person || kind === 5;
          if ((small && dist > PERSON_MID) || (person && this.hidePeople)) continue;
          if (people && small) { people.push(d, o, x, y, z, yaw, px, py, pz, pyaw, dist, r.dt, !person); if (person) continue; }
          if (people && kind <= 2 && dist < NEAR) people.occupants(kind, style, x, y, z, yaw, px, py, pz, pyaw, info, lights, dist, d[o + 10]);
          // perto/meio com troca pontilhada numa faixa de 30 m (pessoas: 10 m)
          const fadeNear = small ? Math.min(1, Math.max(0, (PERSON_NEAR + 5 - dist) / 10)) : Math.min(1, Math.max(0, (NEAR + 15 - dist) / 30));
          const alpha = d[o + 9];
          const mi = modelOf(kind, style);
          if (fadeNear > 0) (kind < 3 && dist > SHADOW_NEAR ? this.nearFar[mi] : this.near[mi]).push(x, y, z, yaw, color, alpha, kind, fadeNear, px, py, pz, pyaw);
          const farFade = small ? Math.min(1, Math.max(0, (PERSON_MID - dist) / 40)) : 1;
          if (fadeNear < 1) this.mid.push(x, y, z, yaw, color, alpha * farFade, dimsOf(kind, style), -1 - fadeNear, px, py, pz, pyaw);
        }
      }
      this.trackFollow(fbest < 12 * 12);
    }
    this.lastNow = frameNow;
    people?.end();
    for (const b of this.near) b.commit();
    for (const b of this.nearFar) b.commit();
    this.mid.commit();
  }

  /** Atualiza o seguido depois do quadro: perdeu de vista por meio segundo, solta. */
  private trackFollow(found: boolean): void {
    const f = this.follow;
    if (!f) return;
    if (found) { f.x = this.followPose[0]; f.z = this.followPose[2]; f.lost = 0; }
    else if (++f.lost > 30) this.follow = null;
  }

  /** Malhas para compilar os shaders na carga. */
  warmup(): void {
    for (const b of [...this.near, ...this.nearFar, this.mid]) { b.count = 0; b.push(0, -1000, 0, 0, 0, 1, 0); b.commit(); }
  }
}
