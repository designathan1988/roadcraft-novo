// Malhas das peças (perto, meio, longe), montadas uma vez na carga a partir de
// primitivas. Cor por vértice; o canal alfa diz o acabamento:
// 0 liso, 1 folhagem, 2 vidro de luminária, 3/4/5 lâmpadas vermelha/amarela/verde, 6 casca, 7 metal.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BARRIER, FURN, PROP, PROP_TYPES, SIGN, WIRE_Y } from '../jobs/props.ts';
import { impostorQuad } from './impostor.ts';

export const PMAT = { Plain: 0, Leaf: 1, Glass: 2, Red: 3, Yellow: 4, Green: 5, Bark: 6, Metal: 7, Wire: 8, Sign0: 9, Impostor: 30, Paint: 31 } as const;
/** Faces por variante: Sign0 … Sign0 + 15. */
export const FACE_LAST = PMAT.Sign0 + 15;
/** Partes de placa: acabamento Sign0 + variante (o shader some com as das outras variantes). */
export const SIGN_PARTS = 4;

export interface PropDef {
  /** Malha por nível (null = não desenha). */
  lods: Array<THREE.BufferGeometry | null>;
  /** Fim de cada nível (m, a 1080p). */
  dist: [number, number, number];
  /** Raio para o recorte. */
  radius: number;
}

const m4 = new THREE.Matrix4();

function part(g: THREE.BufferGeometry, rgb: number, mat: number, tx = 0, ty = 0, tz = 0, sx = 1, sy = 1, sz = 1, ry = 0): THREE.BufferGeometry {
  const ng = (g.index ? g.toNonIndexed() : g.clone());
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal') ng.deleteAttribute(k);
  m4.compose(new THREE.Vector3(tx, ty, tz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));
  ng.applyMatrix4(m4);
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 4);
  const c = new THREE.Color(rgb).convertSRGBToLinear();
  for (let i = 0; i < n; i++) { col[i * 4] = c.r; col[i * 4 + 1] = c.g; col[i * 4 + 2] = c.b; col[i * 4 + 3] = mat / 255; }
  ng.setAttribute('pcol', new THREE.BufferAttribute(col, 4));
  return ng;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

const cyl = (r0: number, r1: number, h: number, seg: number) => new THREE.CylinderGeometry(r1, r0, h, seg, 1, false).translate(0, h / 2, 0);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
const ball = (r: number, detail: number) => new THREE.IcosahedronGeometry(r, detail);
const cone = (r: number, h: number, seg: number) => new THREE.ConeGeometry(r, h, seg).translate(0, h / 2, 0);

const BARK = 0x6a5238, LEAF = 0x6a9a45, PINE = 0x3f7045, POLE = 0x6d7276, GLASS = 0xfff2cc;

function tree(): PropDef {
  const near = merge([
    part(cyl(0.22, 0.14, 3.6, 6), BARK, PMAT.Bark),
    part(ball(2.1, 1), LEAF, PMAT.Leaf, 0, 4.6, 0, 1, 0.9, 1),
    part(ball(1.6, 1), LEAF, PMAT.Leaf, 1.1, 3.9, 0.5, 1, 0.85, 1),
    part(ball(1.5, 1), LEAF, PMAT.Leaf, -0.9, 4.1, -0.7, 1, 0.85, 1),
    part(ball(1.3, 1), LEAF, PMAT.Leaf, 0.2, 5.8, -0.3),
  ]);
  const mid = merge([part(box(0.3, 3, 0.3), BARK, PMAT.Bark), part(ball(2.5, 0), LEAF, PMAT.Leaf, 0, 4.6, 0, 1, 0.9, 1)]);
  return { lods: [near, mid, impostorQuad(PMAT.Impostor, 0)], dist: [230, 700, 3600], radius: 6 };
}

function conifer(): PropDef {
  const near = merge([
    part(cyl(0.2, 0.12, 2.2, 6), BARK, PMAT.Bark),
    part(cone(2.0, 3.4, 9), PINE, PMAT.Leaf, 0, 1.6, 0),
    part(cone(1.55, 3.0, 9), PINE, PMAT.Leaf, 0, 3.4, 0),
    part(cone(1.05, 2.6, 9), PINE, PMAT.Leaf, 0, 5.1, 0),
  ]);
  const mid = merge([part(box(0.25, 1.8, 0.25), BARK, PMAT.Bark), part(cone(1.9, 6.4, 6), PINE, PMAT.Leaf, 0, 1.4, 0)]);
  return { lods: [near, mid, impostorQuad(PMAT.Impostor, 1)], dist: [230, 700, 3600], radius: 6 };
}

function bush(): PropDef {
  const near = merge([part(ball(0.9, 1), 0x4a7030, PMAT.Leaf, 0, 0.55, 0, 1, 0.7, 1), part(ball(0.6, 1), 0x557a36, PMAT.Leaf, 0.6, 0.45, 0.2, 1, 0.7, 1)]);
  const mid = merge([part(ball(1.0, 0), 0x4a7030, PMAT.Leaf, 0.2, 0.5, 0, 1, 0.7, 1)]);
  return { lods: [near, mid, null], dist: [130, 420, 0], radius: 1.6 };
}

const CONCRETE = 0xb4b0a8;

function lamp(double: boolean): PropDef {
  const arms = double ? [1, -1] : [1];
  // na calçada: poste de concreto da rede elétrica com cruzeta (fios ao longo da via) e braço da luminária
  const utility = double ? [] : [
    part(cyl(0.17, 0.1, WIRE_Y + 0.4, 8), CONCRETE, PMAT.Plain),
    part(box(1.7, 0.12, 0.12), CONCRETE, PMAT.Plain, 0, WIRE_Y - 0.06, 0),
    part(box(0.5, 0.5, 0.5), 0x5c6064, PMAT.Metal, 0, 6.6, -0.32), // transformador pequeno
  ];
  const near = merge([
    ...(double ? [part(cyl(0.12, 0.08, 8.2, 8), POLE, PMAT.Metal), part(cyl(0.2, 0.2, 0.5, 8), POLE, PMAT.Metal)] : utility),
    ...arms.flatMap((s) => [
      part(box(0.08, 0.08, 1.9), POLE, PMAT.Metal, 0, 8.0, s * 0.95),
      part(box(0.34, 0.16, 0.8), POLE, PMAT.Metal, 0, 7.95, s * 1.9),
      part(box(0.28, 0.04, 0.66), GLASS, PMAT.Glass, 0, 7.92, s * 1.9),
    ]),
  ]);
  const mid = merge([
    double ? part(box(0.18, 8.2, 0.18), POLE, PMAT.Metal) : part(box(0.26, WIRE_Y + 0.4, 0.26), CONCRETE, PMAT.Plain),
    ...(double ? [] : [part(box(1.7, 0.14, 0.14), CONCRETE, PMAT.Plain, 0, WIRE_Y - 0.07, 0)]),
    ...arms.flatMap((s) => [part(box(0.1, 0.1, 1.9), POLE, PMAT.Metal, 0, 8.0, s * 0.95), part(box(0.36, 0.2, 0.8), GLASS, PMAT.Glass, 0, 7.9, s * 1.9)]),
  ]);
  const far = merge(arms.map((s) => part(box(0.5, 0.3, 0.9), GLASS, PMAT.Glass, 0, 7.85, s * 1.9)));
  return { lods: [near, mid, far], dist: [220, 750, 2200], radius: 5 };
}

function signalHead(x: number, y: number, z: number, big: boolean): THREE.BufferGeometry[] {
  const k = big ? 1 : 0.8;
  const out = [part(box(0.36 * k, 1.0 * k, 0.28 * k), 0x23262a, PMAT.Metal, x, y, z)];
  const bulbs: Array<[number, number]> = [[PMAT.Red, 0.78], [PMAT.Yellow, 0.5], [PMAT.Green, 0.22]];
  for (const [mat, h] of bulbs) {
    const color = mat === PMAT.Red ? 0xd03a2a : mat === PMAT.Yellow ? 0xe0a020 : 0x2fbf5a;
    out.push(part(new THREE.CylinderGeometry(0.11 * k, 0.11 * k, 0.06, 10).rotateX(Math.PI / 2), color, mat, x, y + h * k, z + 0.15 * k));
  }
  return out;
}

function signal(): PropDef {
  // poste na esquina, braço sobre a via (para −x local), focos olhando para +z
  const near = merge([
    part(cyl(0.13, 0.1, 5.8, 8), 0x3a3e42, PMAT.Metal),
    part(box(3.6, 0.12, 0.12), 0x3a3e42, PMAT.Metal, -1.8, 5.5, 0),
    ...signalHead(-3.2, 4.6, 0.05, true),
    ...signalHead(0, 2.3, 0.12, false),
  ]);
  const mid = merge([
    part(box(0.2, 5.8, 0.2), 0x3a3e42, PMAT.Metal),
    part(box(3.6, 0.15, 0.15), 0x3a3e42, PMAT.Metal, -1.8, 5.5, 0),
    ...signalHead(-3.2, 4.6, 0.05, true),
  ]);
  return { lods: [near, mid, null], dist: [260, 1100, 0], radius: 5 };
}

function bench(): PropDef {
  const wood = 0x8a6440, iron = 0x34383c;
  const near = merge([
    part(box(1.7, 0.07, 0.45), wood, PMAT.Plain, 0, 0.44, 0),
    part(box(1.7, 0.4, 0.06), wood, PMAT.Plain, 0, 0.55, -0.22),
    part(box(0.06, 0.45, 0.42), iron, PMAT.Metal, -0.75, 0, 0),
    part(box(0.06, 0.45, 0.42), iron, PMAT.Metal, 0.75, 0, 0),
  ]);
  return { lods: [near, null, null], dist: [150, 0, 0], radius: 1.2 };
}

function bin(): PropDef {
  const near = merge([part(cyl(0.24, 0.27, 0.9, 10), 0x3f5a46, PMAT.Metal), part(cyl(0.29, 0.29, 0.05, 10), 0x2c3a30, PMAT.Metal, 0, 0.9, 0)]);
  return { lods: [near, null, null], dist: [130, 0, 0], radius: 0.8 };
}

/** Vão de fios: três cabos de 0 a 1 em z (o shader estica até o próximo poste e faz a barriga). */
function wire(): PropDef {
  const strand = (x: number, y: number) => {
    const g = new THREE.BoxGeometry(0.035, 0.035, 1, 1, 1, 12).translate(x, y, 0.5);
    return part(g, 0x202224, PMAT.Wire);
  };
  const near = merge([strand(-0.75, WIRE_Y + 0.02), strand(0.75, WIRE_Y + 0.02), strand(0.25, WIRE_Y + 0.02), strand(-0.3, WIRE_Y - 0.9)]);
  return { lods: [near, null, null], dist: [90, 0, 0], radius: 40 };
}

/** Placa: poste e as faces de todas as variantes (cada vértice sabe a sua; o shader mostra só a da instância). */
function sign(): PropDef {
  const v = (k: number) => PMAT.Sign0 + k;
  const disk = (r: number) => new THREE.CylinderGeometry(r, r, 0.02, 20).rotateX(Math.PI / 2);
  const tri = (r: number) => new THREE.CylinderGeometry(r, r, 0.02, 3).rotateX(Math.PI / 2).rotateZ(Math.PI);
  const parts = [
    part(cyl(0.04, 0.04, 2.6, 6), 0x8a8e92, PMAT.Metal),
    // velocidade: disco vermelho, miolo branco, "60" em barras
    part(disk(0.34), 0xc8241c, v(SIGN.Speed), 0, 2.25, 0.03),
    part(disk(0.27), 0xf2f2ee, v(SIGN.Speed), 0, 2.25, 0.045),
    part(box(0.05, 0.24, 0.01), 0x1a1a1a, v(SIGN.Speed), -0.08, 2.13, 0.056),
    part(box(0.07, 0.24, 0.01), 0x1a1a1a, v(SIGN.Speed), 0.08, 2.13, 0.056),
    // dê a preferência: triângulo vermelho, miolo branco
    part(tri(0.42), 0xc8241c, v(SIGN.Yield), 0, 2.2, 0.03),
    part(tri(0.3), 0xf2f2ee, v(SIGN.Yield), 0, 2.2, 0.045),
    // pare: octógono vermelho com faixa branca
    part(new THREE.CylinderGeometry(0.36, 0.36, 0.02, 8).rotateX(Math.PI / 2).rotateZ(Math.PI / 8), 0xc8241c, v(SIGN.Stop), 0, 2.2, 0.03),
    part(box(0.44, 0.1, 0.01), 0xf2f2ee, v(SIGN.Stop), 0, 2.2, 0.046),
    // proibido estacionar: disco azul com aro e faixa vermelhos
    part(disk(0.34), 0xc8241c, v(SIGN.NoParking), 0, 2.25, 0.03),
    part(disk(0.27), 0x1f4f9a, v(SIGN.NoParking), 0, 2.25, 0.045),
    part(box(0.5, 0.06, 0.01).rotateZ(Math.PI / 4), 0xc8241c, v(SIGN.NoParking), 0, 2.15, 0.056),
    // sentido proibido: disco vermelho com barra branca
    part(disk(0.34), 0xc8241c, v(SIGN.NoEntry), 0, 2.25, 0.03),
    part(box(0.46, 0.1, 0.01), 0xf2f2ee, v(SIGN.NoEntry), 0, 2.2, 0.046),
    // pedestres e escola: losango amarelo com figura preta
    part(box(0.5, 0.5, 0.02).rotateZ(Math.PI / 4), 0xf2c21a, v(SIGN.Pedestrian), 0, 1.9, 0.03),
    part(box(0.06, 0.24, 0.01), 0x161616, v(SIGN.Pedestrian), 0, 2.13, 0.045),
    part(box(0.5, 0.5, 0.02).rotateZ(Math.PI / 4), 0xf2c21a, v(SIGN.School), 0, 1.9, 0.03),
    part(box(0.06, 0.2, 0.01), 0x161616, v(SIGN.School), -0.07, 2.15, 0.045),
    part(box(0.06, 0.16, 0.01), 0x161616, v(SIGN.School), 0.08, 2.15, 0.045),
    // direção: placa verde larga
    part(box(1.2, 0.5, 0.03), 0x1d6b3a, v(SIGN.Direction), 0, 2.2, 0.03),
    part(box(0.9, 0.05, 0.01), 0xf2f2ee, v(SIGN.Direction), 0, 2.5, 0.05),
    part(box(0.7, 0.05, 0.01), 0xf2f2ee, v(SIGN.Direction), -0.1, 2.35, 0.05),
    // informação: placa azul
    part(box(0.6, 0.6, 0.03), 0x1f4f9a, v(SIGN.Info), 0, 2.0, 0.03),
    part(box(0.12, 0.3, 0.01), 0xf2f2ee, v(SIGN.Info), 0, 2.05, 0.05),
    // nome da rua: duas lâminas azuis cruzadas
    part(box(1.1, 0.22, 0.03), 0x1f4f9a, v(SIGN.Name), 0, 2.45, 0),
    part(box(0.03, 0.22, 1.1), 0x1f4f9a, v(SIGN.Name), 0, 2.2, 0),
    part(box(0.9, 0.05, 0.035), 0xf2f2ee, v(SIGN.Name), 0, 2.53, 0),
    // mão única: preta com seta branca
    part(box(0.75, 0.25, 0.02), 0x161616, v(SIGN.OneWay), 0, 2.2, 0.03),
    part(box(0.45, 0.06, 0.01), 0xf2f2ee, v(SIGN.OneWay), -0.04, 2.3, 0.042),
    part(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 3).rotateX(Math.PI / 2).rotateZ(-Math.PI / 2), 0xf2f2ee, v(SIGN.OneWay), 0.22, 2.325, 0.042),
  ];
  return { lods: [merge(parts), null, null], dist: [120, 0, 0], radius: 1.5 };
}

/** Poste de rede elétrica sem luminária (linhas desenhadas pelo jogador). */
function pole(): PropDef {
  const near = merge([
    part(cyl(0.17, 0.1, WIRE_Y + 0.4, 8), CONCRETE, PMAT.Plain),
    part(box(1.7, 0.12, 0.12), CONCRETE, PMAT.Plain, 0, WIRE_Y - 0.06, 0),
    ...[-0.75, 0.25, 0.75].map((x) => part(box(0.06, 0.14, 0.06), 0xe8e8e4, PMAT.Plain, x, WIRE_Y + 0.06, 0)),
  ]);
  const mid = merge([part(box(0.26, WIRE_Y + 0.4, 0.26), CONCRETE, PMAT.Plain), part(box(1.7, 0.14, 0.14), CONCRETE, PMAT.Plain, 0, WIRE_Y - 0.07, 0)]);
  return { lods: [near, mid, null], dist: [220, 750, 0], radius: 5 };
}

/** Mobiliário de calçada: todas as variantes na mesma malha (o shader mostra só a da instância). */
function furniture(): PropDef {
  const v = (k: number) => PMAT.Sign0 + k;
  const parts = [
    // hidrante vermelho
    part(cyl(0.16, 0.14, 0.62, 10), 0xc0261d, v(FURN.Hydrant)),
    part(ball(0.15, 1), 0xc0261d, v(FURN.Hydrant), 0, 0.64, 0),
    part(cyl(0.07, 0.07, 0.42, 6).rotateZ(Math.PI / 2), 0xa31f18, v(FURN.Hydrant), 0.21, 0.42, 0),
    // caixa de correio amarela
    part(cyl(0.06, 0.06, 0.8, 6), 0x5a5f63, v(FURN.Postbox)),
    part(box(0.48, 0.62, 0.38), 0xf2c21a, v(FURN.Postbox), 0, 0.8, 0),
    part(box(0.3, 0.04, 0.02), 0x1f4f9a, v(FURN.Postbox), 0, 1.25, 0.2),
    // orelhão: concha laranja num poste
    part(cyl(0.06, 0.06, 1.9, 6), 0x5a5f63, v(FURN.Phone)),
    part(ball(0.62, 1), 0xe46a1c, v(FURN.Phone), 0, 1.95, 0.12, 1, 1.15, 0.85),
    part(box(0.22, 0.32, 0.12), 0x2a2d30, v(FURN.Phone), 0, 1.45, 0.3),
    // boca de lobo: grelha no meio-fio
    part(box(0.9, 0.06, 0.5), 0x3c3f42, v(FURN.Drain), 0, -0.04, 0),
    // frade (balizador) de concreto
    part(cyl(0.16, 0.13, 0.75, 10), 0xb4b0a8, v(FURN.Bollard)),
    // floreira
    part(box(1.0, 0.5, 1.0), 0x9d8f7c, v(FURN.Planter)),
    part(ball(0.55, 1), 0x4f7a34, v(FURN.Planter), 0, 0.65, 0, 1, 0.7, 1),
  ];
  return { lods: [merge(parts), null, null], dist: [140, 0, 0], radius: 1.5 };
}

/** Muros, cercas, sebes, defensas e gradis: peça de z = 0 a 1 (o shader estica até o comprimento e inclina no desnível). */
function barrier(): PropDef {
  const v = (k: number) => PMAT.Sign0 + k;
  const near = merge([
    // cerca de madeira: mourão no começo, três tábuas
    part(box(0.12, 1.3, 0.12), 0x7a5a3a, v(BARRIER.Fence), 0, 0, 0.06),
    part(box(0.05, 0.12, 1), 0x8a6844, v(BARRIER.Fence), 0, 0.35, 0.5),
    part(box(0.05, 0.12, 1), 0x8a6844, v(BARRIER.Fence), 0, 0.7, 0.5),
    part(box(0.05, 0.12, 1), 0x8a6844, v(BARRIER.Fence), 0, 1.05, 0.5),
    // muro de alvenaria rebocado
    part(box(0.22, 1.9, 1), 0xd8d0c2, v(BARRIER.Wall), 0, 0, 0.5),
    part(box(0.3, 0.08, 1), 0xb8b0a2, v(BARRIER.Wall), 0, 1.9, 0.5),
    // sebe
    part(box(0.8, 1.3, 1), 0x3f6a2e, v(BARRIER.Hedge), 0, 0, 0.5),
    // defensa metálica (guard-rail)
    part(box(0.1, 0.75, 0.1), 0x8a8e92, v(BARRIER.Guardrail), 0, 0, 0.05),
    part(box(0.06, 0.32, 1), 0xb8bcc0, v(BARRIER.Guardrail), 0.06, 0.42, 0.5),
    // gradil urbano
    part(box(0.05, 1.1, 0.05), 0x2c3034, v(BARRIER.Railing), 0, 0, 0.03),
    part(box(0.04, 0.05, 1), 0x2c3034, v(BARRIER.Railing), 0, 1.05, 0.5),
    part(box(0.04, 0.05, 1), 0x2c3034, v(BARRIER.Railing), 0, 0.15, 0.5),
    ...[0.2, 0.4, 0.6, 0.8].map((z) => part(box(0.025, 0.9, 0.025), 0x2c3034, v(BARRIER.Railing), 0, 0.15, z)),
  ]);
  const mid = merge([
    part(box(0.05, 0.12, 1), 0x8a6844, v(BARRIER.Fence), 0, 0.7, 0.5),
    part(box(0.22, 1.95, 1), 0xd8d0c2, v(BARRIER.Wall), 0, 0, 0.5),
    part(box(0.8, 1.3, 1), 0x3f6a2e, v(BARRIER.Hedge), 0, 0, 0.5),
    part(box(0.06, 0.32, 1), 0xb8bcc0, v(BARRIER.Guardrail), 0.06, 0.42, 0.5),
    part(box(0.04, 1.0, 1), 0x2c3034, v(BARRIER.Railing), 0, 0.15, 0.5),
  ]);
  return { lods: [near, mid, null], dist: [180, 700, 0], radius: 4 };
}

/** Malhas de perto das árvores, para fotografar os impostores (na ordem das colunas do atlas). */
export function impostorSources(defs: PropDef[]): THREE.BufferGeometry[] {
  return [defs[PROP.Tree].lods[0]!, defs[PROP.Conifer].lods[0]!];
}

/** Carro estacionado: mesmas proporções dos carros da rua; a pintura vem da variante. */
function parkedCar(): PropDef {
  const P = 0xffffff, GL = 0x1a2430, TI = 0x161616;
  // o mesmo perfil dos carros da rua (render/vehicles.ts carModel): capô, para-brisa, teto, porta-malas
  const profile = (pts: Array<[number, number]>, width: number) => {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))), { depth: width, bevelEnabled: false, curveSegments: 1 });
    g.deleteAttribute('uv');
    return g.translate(0, 0, -width / 2).rotateY(-Math.PI / 2);
  };
  const near = merge([
    part(profile([[2.2, 0.3], [2.2, 0.68], [1.95, 0.8], [1.0, 0.88], [0.32, 1.4], [-1.05, 1.42], [-1.75, 0.98], [-2.18, 0.9], [-2.2, 0.3]], 1.76), P, PMAT.Paint),
    part(profile([[1.05, 0.9], [0.34, 1.41], [-1.04, 1.44], [-1.79, 0.99], [-1.6, 0.9]], 1.79), GL, PMAT.Metal),
    part(box(1.74, 0.22, 0.12), 0x2a2b2d, PMAT.Plain, 0, 0.22, 2.17), part(box(1.74, 0.22, 0.12), 0x2a2b2d, PMAT.Plain, 0, 0.22, -2.17),
    ...[[0.8, 1.38], [-0.8, 1.38], [0.8, -1.38], [-0.8, -1.38]].map(([x, z]) => part(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 8).rotateZ(Math.PI / 2), TI, PMAT.Plain, x, 0.33, z)),
  ]);
  const mid = merge([part(box(1.8, 1.4, 4.4), P, PMAT.Paint, 0, 0.05, 0)]);
  return { lods: [near, mid, null], dist: [200, 650, 0], radius: 3 };
}

/** Elementos do chão: as 11 variantes na mesma malha (o shader mostra só a da instância), um tufo de ~1,5 m. */
function ground(): PropDef {
  const v = (k: number) => PMAT.Sign0 + k;
  const parts: THREE.BufferGeometry[] = [];
  let seed = 7;
  const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const scatter = (n: number, make: (i: number, x: number, z: number) => void) => {
    for (let i = 0; i < n; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 1.4; make(i, Math.cos(a) * d, Math.sin(a) * d); }
  };
  scatter(5, (i, x, z) => parts.push(part(ball(0.18 + r() * 0.3, 0), [0x8a8782, 0x77736d, 0x9a958d][i % 3], v(0), x, 0.05, z, 1, 0.6, 1, r() * 6)));
  scatter(12, (i, x, z) => parts.push(part(ball(0.05 + r() * 0.05, 0), [0xb7b1a6, 0x8f8a82, 0xa39a8b][i % 3], v(1), x, 0.02, z, 1, 0.6, 1)));
  scatter(18, (i, x, z) => parts.push(part(box(0.07, 0.04, 0.06), [0x8d8577, 0x6f6a63][i % 2], v(2), x, 0, z, 1, 1, 1, r() * 6)));
  scatter(14, (i, x, z) => parts.push(part(box(0.16, 0.01, 0.1), [0xa0622d, 0xc4882f, 0x7d4a22][i % 3], v(3), x, 0.01, z, 1, 1, 1, r() * 6)));
  scatter(14, (i, x, z) => parts.push(part(cone(0.05, 0.3 + r() * 0.15, 3), [0x5f8f3a, 0x6f9d43][i % 2], v(4), x, 0, z)));
  scatter(12, (i, x, z) => parts.push(part(cone(0.06, 0.8 + r() * 0.4, 3), [0xa3a457, 0x8c9a4b][i % 2], v(5), x, 0, z)));
  scatter(5, (i, x, z) => parts.push(part(ball(0.32 + r() * 0.2, 0), [0x4b6a2f, 0x56743a][i % 2], v(6), x, 0.2, z, 1, 0.75, 1)));
  scatter(7, (i, x, z) => parts.push(part(box(0.12, 0.02, 0.7), 0x3f7a35, v(7), x, 0.25, z, 1, 1, 1, i * 0.9).rotateZ(0)));
  scatter(10, (i, x, z) => parts.push(part(ball(0.12, 0), [0x4c8a3a, 0x5a9944][i % 2], v(8), x, 0.04, z, 1, 0.4, 1)));
  scatter(8, (i, x, z) => {
    parts.push(part(cyl(0.012, 0.012, 0.35, 3), 0x4f7d34, v(9), x, 0, z));
    parts.push(part(ball(0.07, 0), [0xd63c3c, 0xf2c94c, 0x9b5de5, 0xffffff][i % 4], v(9), x, 0.37, z));
  });
  scatter(5, (i, x, z) => {
    parts.push(part(cyl(0.03, 0.025, 0.12, 5), 0xece3d0, v(10), x, 0, z));
    parts.push(part(cone(0.1, 0.08, 7), [0xc0392b, 0xb5835a][i % 2], v(10), x, 0.11, z));
  });
  // 11: palmeira (tronco curvo em gomos e leque de folhas)
  for (let k = 0; k < 7; k++) parts.push(part(cyl(0.2 - k * 0.012, 0.19 - k * 0.012, 1.15, 6), 0x8a6f4d, v(11), k * 0.07, k * 1.1, 0));
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2;
    parts.push(part(box(0.5, 0.06, 3.2).translate(0, 0, 1.6).rotateX(0.35), [0x4f8a3a, 0x5d9a42][k % 2], v(11), 0.5, 7.7, 0, 1, 1, 1, a));
  }
  return { lods: [merge(parts), null, null], dist: [260, 0, 0], radius: 6 };
}

/** Pessoa do criador: roupa pintada pela variante (paleta dos veículos), pele, cabelo e calça fixos. */
function person(): PropDef {
  const SKIN = 0xc68a62, HAIR = 0x2a1d14, PANTS = 0x2f3b48, SHOE = 0x1b1b1b;
  const near = merge([
    part(box(0.13, 0.08, 0.26), SHOE, PMAT.Plain, -0.11, 0, 0.03), part(box(0.13, 0.08, 0.26), SHOE, PMAT.Plain, 0.11, 0, 0.03),
    part(box(0.14, 0.8, 0.16), PANTS, PMAT.Plain, -0.11, 0.08, 0), part(box(0.14, 0.8, 0.16), PANTS, PMAT.Plain, 0.11, 0.08, 0),
    part(box(0.44, 0.62, 0.24), 0xffffff, PMAT.Paint, 0, 0.86, 0),
    part(box(0.11, 0.58, 0.12), 0xffffff, PMAT.Paint, -0.29, 0.9, 0), part(box(0.11, 0.58, 0.12), 0xffffff, PMAT.Paint, 0.29, 0.9, 0),
    part(box(0.09, 0.12, 0.1), SKIN, PMAT.Plain, -0.29, 0.79, 0), part(box(0.09, 0.12, 0.1), SKIN, PMAT.Plain, 0.29, 0.79, 0),
    part(box(0.1, 0.08, 0.1), SKIN, PMAT.Plain, 0, 1.48, 0),
    part(ball(0.13, 1), SKIN, PMAT.Plain, 0, 1.66, 0, 1, 1.12, 1),
    part(ball(0.135, 1), HAIR, PMAT.Plain, 0, 1.72, -0.02, 1.02, 0.85, 1.05),
  ]);
  const mid = merge([part(box(0.45, 1.75, 0.3), 0xffffff, PMAT.Paint, 0, 0, 0)]);
  return { lods: [near, mid, null], dist: [90, 260, 0], radius: 1 };
}

/** Todas as peças, na ordem dos tipos. */
export function buildPropDefs(): PropDef[] {
  const defs: PropDef[] = [];
  defs[PROP.Tree] = tree();
  defs[PROP.Conifer] = conifer();
  defs[PROP.Bush] = bush();
  defs[PROP.Lamp] = lamp(false);
  defs[PROP.LampDouble] = lamp(true);
  defs[PROP.Signal] = signal();
  defs[PROP.Bench] = bench();
  defs[PROP.Bin] = bin();
  defs[PROP.Wire] = wire();
  defs[PROP.Sign] = sign();
  defs[PROP.ParkedCar] = parkedCar();
  defs[PROP.Furniture] = furniture();
  defs[PROP.Barrier] = barrier();
  defs[PROP.Pole] = pole();
  defs[PROP.Ground] = ground();
  defs[PROP.Person] = person();
  if (defs.length !== PROP_TYPES) throw new Error('tipos de peça');
  return defs;
}
