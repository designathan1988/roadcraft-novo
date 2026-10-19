// Malhas das peças (perto, meio, longe), montadas uma vez na carga a partir de
// primitivas. Cor por vértice; o canal alfa diz o acabamento:
// 0 liso, 1 folhagem, 2 vidro de luminária, 3/4/5 lâmpadas vermelha/amarela/verde, 6 casca, 7 metal.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BARRIER, FURN, PROP, PROP_TYPES, SIGN, WIRE_Y } from '../jobs/props.ts';
import { impostorQuad } from './impostor.ts';
import { cypressTree, floweringBush, hedge, ipeTree, mixedTree, oakTree, palmTree, shrub } from './treeMeshes.ts';

export const PMAT = { Plain: 0, Leaf: 1, Glass: 2, Red: 3, Yellow: 4, Green: 5, Bark: 6, Metal: 7, Wire: 8, Sign0: 9, Atlas: 25, LeafCard: 26, Impostor: 30, Paint: 31 } as const;
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
  /** Other models of the type, drawn for the variants MODELS maps to them (index 1, 2…). */
  alts?: PropDef[];
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
  // atlas uv and billboard corner (only the tree cards use it; zero elsewhere)
  ng.setAttribute('pext', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
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

const POLE = 0x6d7276, GLASS = 0xfff2cc;

/** Trees in Roadcraft's card style (treeMeshes.ts): near, mid, and the octahedral impostor (column = IMP column). */
function cardTree(build: (lod: 0 | 1) => THREE.BufferGeometry, column: number, radius: number): PropDef {
  return { lods: [build(0), build(1), impostorQuad(PMAT.Impostor, column)], dist: [200, 650, 3600], radius };
}
const tree = () => cardTree(mixedTree, 0, 6);
const conifer = () => cardTree(cypressTree, 1, 6);
const oak = () => cardTree(oakTree, 2, 7);
const palm = () => cardTree(palmTree, 3, 7);

function bush(): PropDef {
  return {
    lods: [shrub(0), shrub(1), null], dist: [130, 420, 0], radius: 1.6,
    alts: [
      { lods: [floweringBush(0), floweringBush(1), null], dist: [130, 420, 0], radius: 1.6 },
      { lods: [hedge(0), hedge(1), null], dist: [150, 480, 0], radius: 2 },
    ],
  };
}

/** The ipê of Roadcraft 4.0: impostor columns 4 (yellow) and 5 (pink). */
const ipe = (bloom: 'yellow' | 'pink', column: number): PropDef => cardTree((lod) => ipeTree(lod, bloom), column, 8);

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

/**
 * Signal head as Roadcraft's (`signals.ts`): housing, lenses with a hood over each on BOTH faces (seen from the
 * approach and from across the junction), and on the front a black backplate with a white border.
 */
function signalHead(x: number, y: number, z: number, big: boolean, detail = true): THREE.BufferGeometry[] {
  const k = big ? 1 : 0.8;
  const out = [part(box(0.36 * k, 1.0 * k, 0.28 * k), 0x23262a, PMAT.Metal, x, y, z)];
  if (detail) {
    out.push(part(box(0.62 * k, 1.22 * k, 0.02), 0xe8e8e4, PMAT.Plain, x, y - 0.11 * k, z - 0.155 * k));
    out.push(part(box(0.56 * k, 1.16 * k, 0.02), 0x15171a, PMAT.Plain, x, y - 0.08 * k, z - 0.14 * k));
  }
  const bulbs: Array<[number, number]> = [[PMAT.Red, 0.78], [PMAT.Yellow, 0.5], [PMAT.Green, 0.22]];
  for (const face of detail ? [1, -1] : [1]) {
    for (const [mat, h] of bulbs) {
      const color = mat === PMAT.Red ? 0xd03a2a : mat === PMAT.Yellow ? 0xe0a020 : 0x2fbf5a;
      const lz = z + face * 0.15 * k;
      out.push(part(new THREE.CylinderGeometry(0.11 * k, 0.11 * k, 0.06, 10).rotateX(Math.PI / 2), color, mat, x, y + h * k, lz));
      if (detail) {
        // hood: half a tube over the lens
        const hood = new THREE.CylinderGeometry(0.135 * k, 0.135 * k, 0.2 * k, 10, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
        out.push(part(hood, 0x1b1d20, PMAT.Metal, x, y + h * k, lz + face * 0.1 * k));
      }
    }
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
    ...signalHead(-3.2, 4.6, 0.05, true, false),
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

/** Sign atlas: COLS × ROWS cells of CELL px, drawn once at load (`buildSignAtlas`). */
export const SIGN_ATLAS = { COLS: 8, ROWS: 3, CELL: 128 } as const;
/** Atlas cells: speed limits 20…120 km/h in cells 0…10, then the other faces. */
export const ATLAS_CELL = { Stop: 11, Yield: 12, NoParking: 13, NoEntry: 14, Pedestrian: 15, School: 16, Direction: 17, Info: 18, OneWay: 19 } as const;
/**
 * Face of each sign variant (by SIGN): half width, half height, centre height (m) and atlas cell (−1 = speed, from
 * the key; −2 = no atlas face, the street-name blades are geometry). The face is one quad cut by the atlas' alpha.
 */
export const SIGN_FACES: Array<[number, number, number, number]> = (() => {
  const f: Array<[number, number, number, number]> = Array.from({ length: 16 }, () => [0, 0, 0, -2]);
  f[SIGN.Speed] = [0.36, 0.36, 2.25, -1];
  f[SIGN.Yield] = [0.44, 0.44, 2.2, ATLAS_CELL.Yield];
  f[SIGN.Stop] = [0.38, 0.38, 2.2, ATLAS_CELL.Stop];
  f[SIGN.NoParking] = [0.36, 0.36, 2.25, ATLAS_CELL.NoParking];
  f[SIGN.NoEntry] = [0.36, 0.36, 2.25, ATLAS_CELL.NoEntry];
  f[SIGN.Pedestrian] = [0.4, 0.4, 2.0, ATLAS_CELL.Pedestrian];
  f[SIGN.School] = [0.4, 0.4, 2.0, ATLAS_CELL.School];
  f[SIGN.Direction] = [0.66, 0.3, 2.25, ATLAS_CELL.Direction];
  f[SIGN.Info] = [0.32, 0.32, 2.05, ATLAS_CELL.Info];
  f[SIGN.OneWay] = [0.42, 0.14, 2.2, ATLAS_CELL.OneWay];
  return f;
})();

/** Draws the sign faces (Brazilian CTB look: R-1 stop, R-2 yield, R-19 speed…), alpha = the sign's outline. */
export function buildSignAtlas(): THREE.Texture {
  const { COLS, ROWS, CELL } = SIGN_ATLAS;
  const cv = document.createElement('canvas');
  cv.width = COLS * CELL; cv.height = ROWS * CELL;
  const g = cv.getContext('2d')!;
  const RED = '#c8241c', WHITE = '#f4f4f0', BLACK = '#161616', YELLOW = '#f2c21a', BLUE = '#1f4f9a', GREEN = '#1d6b3a';
  const cell = (k: number, aspect: number, draw: (w: number, h: number) => void) => {
    const x = (k % COLS) * CELL, y = Math.floor(k / COLS) * CELL;
    g.save();
    // the quad shows the whole cell: a wide sign is drawn squeezed and stretched back on the quad
    g.translate(x + CELL / 2, y + CELL / 2);
    g.scale(1, aspect);
    draw(CELL, CELL);
    g.restore();
  };
  const disc = (r: number, fill: string) => { g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); };
  const poly = (n: number, r: number, rot: number, fill: string) => {
    g.beginPath();
    for (let i = 0; i < n; i++) { const a = rot + i * Math.PI * 2 / n; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fillStyle = fill; g.fill();
  };
  const text = (s: string, size: number, fill: string, dy = 0) => {
    g.fillStyle = fill; g.font = `bold ${size}px Arial, Helvetica, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(s, 0, dy);
  };
  const walker = (s: number, fill: string, dx = 0) => {
    g.fillStyle = fill; g.strokeStyle = fill; g.lineWidth = 5 * s; g.lineCap = 'round';
    g.beginPath(); g.arc(dx, -22 * s, 6 * s, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(dx, -14 * s); g.lineTo(dx - 2 * s, 6 * s);
    g.moveTo(dx - 2 * s, 6 * s); g.lineTo(dx - 10 * s, 24 * s); g.moveTo(dx - 2 * s, 6 * s); g.lineTo(dx + 8 * s, 24 * s);
    g.moveTo(dx - 12 * s, -2 * s); g.lineTo(dx, -10 * s); g.lineTo(dx + 12 * s, -4 * s); g.stroke();
  };
  for (let i = 0; i <= 10; i++) cell(i, 1, () => { disc(62, RED); disc(48, WHITE); text(String(20 + i * 10), i >= 8 ? 40 : 50, BLACK, 2); });
  cell(ATLAS_CELL.Stop, 1, () => { poly(8, 62, Math.PI / 8, WHITE); poly(8, 56, Math.PI / 8, RED); text('PARE', 34, WHITE, 2); });
  cell(ATLAS_CELL.Yield, 1, () => {
    // R-2: inverted triangle, red border, white inside
    g.translate(0, -8); poly(3, 70, Math.PI / 2, RED); poly(3, 44, Math.PI / 2, WHITE);
  });
  cell(ATLAS_CELL.NoParking, 1, () => {
    disc(62, RED); disc(48, WHITE); text('E', 58, BLACK, 3);
    g.strokeStyle = RED; g.lineWidth = 11; g.beginPath(); g.moveTo(-34, -34); g.lineTo(34, 34); g.stroke();
  });
  cell(ATLAS_CELL.NoEntry, 1, () => { disc(62, RED); g.fillStyle = WHITE; g.fillRect(-44, -11, 88, 22); });
  cell(ATLAS_CELL.Pedestrian, 1, () => { g.rotate(Math.PI / 4); g.fillStyle = BLACK; g.fillRect(-45, -45, 90, 90); g.fillStyle = YELLOW; g.fillRect(-41, -41, 82, 82); g.rotate(-Math.PI / 4); walker(1.3, BLACK); });
  cell(ATLAS_CELL.School, 1, () => { g.rotate(Math.PI / 4); g.fillStyle = BLACK; g.fillRect(-45, -45, 90, 90); g.fillStyle = YELLOW; g.fillRect(-41, -41, 82, 82); g.rotate(-Math.PI / 4); walker(1.0, BLACK, -14); walker(0.8, BLACK, 16); });
  cell(ATLAS_CELL.Direction, 0.45, () => {
    g.fillStyle = WHITE; g.fillRect(-64, -64, 128, 128); g.fillStyle = GREEN; g.fillRect(-60, -60, 120, 120);
    text('Centro', 30, WHITE, -18);
    g.fillStyle = WHITE; g.fillRect(-30, 18, 50, 12); poly(3, 18, 0, WHITE); g.translate(28, 24); poly(3, 16, 0, WHITE);
  });
  cell(ATLAS_CELL.Info, 1, () => { g.fillStyle = BLUE; g.fillRect(-60, -60, 120, 120); g.fillStyle = WHITE; g.fillRect(-56, -56, 112, 112); g.fillStyle = BLUE; g.fillRect(-52, -52, 104, 104); text('i', 80, WHITE, 6); });
  cell(ATLAS_CELL.OneWay, 0.34, () => {
    g.fillStyle = WHITE; g.fillRect(-64, -64, 128, 128); g.fillStyle = BLACK; g.fillRect(-60, -58, 120, 116);
    g.fillStyle = WHITE; g.fillRect(-44, -14, 70, 28); g.translate(34, 0); poly(3, 34, 0, WHITE);
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * Sign: post, the face as one quad per side (front from the atlas, back the same outline in grey metal: the shader
 * sizes it per variant from SIGN_FACES and hides it for the street-name blades), and the street-name blades.
 */
function sign(): PropDef {
  const quad = (back: boolean) => {
    const g = new THREE.PlaneGeometry(2, 2);
    if (back) g.rotateY(Math.PI);
    g.translate(0, 0, back ? 0.03 : 0.045);
    return part(g, back ? 0x7d8287 : 0xffffff, PMAT.Atlas);
  };
  const v = (k: number) => PMAT.Sign0 + k;
  const parts = [
    part(cyl(0.04, 0.04, 2.6, 6), 0x8a8e92, PMAT.Metal),
    quad(false), quad(true),
    // street name: two crossed blue blades with a white rule (geometry, only on that variant)
    part(box(1.1, 0.22, 0.03), 0x1f4f9a, v(SIGN.Name), 0, 2.45, 0),
    part(box(0.03, 0.22, 1.1), 0x1f4f9a, v(SIGN.Name), 0, 2.2, 0),
    part(box(0.9, 0.05, 0.035), 0xf2f2ee, v(SIGN.Name), 0, 2.53, 0),
  ];
  return { lods: [merge(parts), null, null], dist: [140, 0, 0], radius: 1.5 };
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
    // ---- peças de fachada dos prédios (sessão prédios): origem no pé da parede, +z para fora
    // ar-condicionado de parede (condensadora com grade e mãos-francesas)
    part(box(0.8, 0.55, 0.3), 0xe4e4e0, v(FURN.WallAc), 0, 0.04, 0.17),
    part(box(0.36, 0.36, 0.02), 0x8d9296, v(FURN.WallAc), 0.14, 0.13, 0.33),
    part(box(0.04, 0.04, 0.34), 0x8a8e92, v(FURN.WallAc), -0.3, 0, 0.17),
    part(box(0.04, 0.04, 0.34), 0x8a8e92, v(FURN.WallAc), 0.3, 0, 0.17),
    // condensadora de telhado (caixa com ventilador em cima)
    part(box(1.2, 0.9, 0.9), 0xd4d4d0, v(FURN.RoofAc), 0, 0, 0),
    part(box(1.22, 0.5, 0.92), 0xbfc1c0, v(FURN.RoofAc), 0, 0.15, 0),
    part(cyl(0.34, 0.34, 0.06, 14), 0x3c3f42, v(FURN.RoofAc), 0, 0.9, 0),
    part(box(0.05, 0.12, 0.7), 0x8a8e92, v(FURN.RoofAc), 0, 0.92, 0),
    // vaso de barro com planta
    part(cyl(0.16, 0.22, 0.38, 10), 0xa65a3c, v(FURN.Vase)),
    part(ball(0.3, 1), 0x4f7a34, v(FURN.Vase), 0, 0.62, 0, 1, 0.9, 1),
    // varal de chão com roupa (ao longo da parede)
    part(box(0.03, 1.4, 0.03), 0xc9ccce, v(FURN.Clothesline), -0.9, 0, 0),
    part(box(0.03, 1.4, 0.03), 0xc9ccce, v(FURN.Clothesline), 0.9, 0, 0),
    ...[-0.12, 0, 0.12].map((z) => part(box(1.8, 0.015, 0.015), 0xd8dadc, v(FURN.Clothesline), 0, 1.38, z)),
    part(box(0.42, 0.55, 0.02), 0xf2f2ee, v(FURN.Clothesline), -0.5, 0.83, 0),
    part(box(0.36, 0.45, 0.02), 0x3d6aa0, v(FURN.Clothesline), 0.05, 0.93, 0.12),
    part(box(0.3, 0.6, 0.02), 0xc8402c, v(FURN.Clothesline), 0.55, 0.78, -0.12),
    // antena parabólica
    part(box(0.05, 0.75, 0.05), 0x8a8e92, v(FURN.Dish), 0, 0, 0),
    part(ball(0.38, 1), 0xe8e8e4, v(FURN.Dish), 0, 0.85, 0.12, 1, 1, 0.22),
    part(box(0.03, 0.03, 0.35), 0x8a8e92, v(FURN.Dish), 0, 0.85, 0.3),
    // exaustor eólico (cano e turbina)
    part(cyl(0.12, 0.12, 0.6, 8), 0xa9adb0, v(FURN.Vent)),
    part(ball(0.22, 1), 0xc9ccce, v(FURN.Vent), 0, 0.72, 0, 1, 0.75, 1),
    // cadeira de plástico
    part(box(0.45, 0.05, 0.45), 0xf2f2ee, v(FURN.Chair), 0, 0.42, 0),
    part(box(0.45, 0.45, 0.04), 0xf2f2ee, v(FURN.Chair), 0, 0.47, -0.21),
    ...[[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].map(([x, z]) => part(box(0.035, 0.42, 0.035), 0xe6e6e2, v(FURN.Chair), x, 0, z)),
    // caixa d'água de fibra (azul) com tampa
    part(cyl(0.62, 0.72, 0.85, 14), 0x2f6fb5, v(FURN.Tank)),
    part(cyl(0.64, 0.64, 0.07, 14), 0x285e98, v(FURN.Tank), 0, 0.85, 0),
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
  return [defs[PROP.Tree].lods[0]!, defs[PROP.Conifer].lods[0]!, defs[PROP.Oak].lods[0]!, defs[PROP.Palm].lods[0]!,
    defs[PROP.Tree].alts![0].lods[0]!, defs[PROP.Oak].alts![0].lods[0]!];
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
  defs[PROP.Tree] = { ...tree(), alts: [ipe('yellow', 4)] };
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
  defs[PROP.Oak] = { ...oak(), alts: [ipe('pink', 5)] };
  defs[PROP.Palm] = palm();
  if (defs.length !== PROP_TYPES) throw new Error('tipos de peça');
  return defs;
}

/** One thing the renderer draws: a prop type, or one variant (or group of variants) of a type whose variants are
 *  different meshes. */
export interface PropKind {
  type: number;
  /** Mesh per level (null = not drawn). */
  lods: Array<THREE.BufferGeometry | null>;
  dist: [number, number, number];
  radius: number;
}

/** Variants a type's instance can have (4 bits in the pose). */
export const VARIANTS = 16;

/**
 * Types whose variants are different meshes, and the kind each variant draws with (index into that type's kinds).
 * Everything in one mesh, the shader collapsing the wrong ones, made every instance process the vertices of all of
 * them: ~3,624 per furniture piece, ~5,860 per ground piece.
 */
const SPLIT: Record<number, number[]> = {
  [PROP.Furniture]: Array.from({ length: VARIANTS }, (_, v) => v),
  [PROP.Ground]: Array.from({ length: VARIANTS }, (_, v) => Math.min(v, 11)),
  [PROP.Barrier]: Array.from({ length: VARIANTS }, (_, v) => Math.min(v, 4)),
  // signs share the post and the face quads; only the street-name blades are a mesh of their own
  [PROP.Sign]: Array.from({ length: VARIANTS }, (_, v) => (v === SIGN.Name ? 1 : 0)),
};

/**
 * Types whose variants are other models (PropDef.alts): variant → model (0 = the type's own). The generator gives trees
 * and bushes variants 0..3: tree 3 is the yellow ipê, oak 3 the pink ipê, bush 2 the flowering bush, bush 3 the hedge.
 */
const MODELS: Record<number, number[]> = {
  [PROP.Tree]: Array.from({ length: VARIANTS }, (_, v) => (v === 3 ? 1 : 0)),
  [PROP.Oak]: Array.from({ length: VARIANTS }, (_, v) => (v === 3 ? 1 : 0)),
  [PROP.Bush]: Array.from({ length: VARIANTS }, (_, v) => (v === 2 ? 1 : v === 3 ? 2 : 0)),
};

/** Kind of each (type, variant): index = type × VARIANTS + variant. The same table on the CPU and in the cull pass. */
export function propKindTable(): { kindOf: Uint32Array; count: number } {
  const kindOf = new Uint32Array(PROP_TYPES * VARIANTS);
  let k = 0;
  for (let t = 0; t < PROP_TYPES; t++) {
    const split = SPLIT[t] ?? MODELS[t];
    const subs = split ? Math.max(...split) + 1 : 1;
    for (let v = 0; v < VARIANTS; v++) kindOf[t * VARIANTS + v] = k + (split ? split[v] : 0);
    k += subs;
  }
  return { kindOf, count: k };
}

/** The part of a mesh a group of variants draws: its own variant parts plus the shared parts (other materials). */
function variantPart(g: THREE.BufferGeometry | null, keep: (variant: number) => boolean): THREE.BufferGeometry | null {
  if (!g) return null;
  const col = g.attributes.pcol as THREE.BufferAttribute;
  const tris: number[] = [];
  for (let t = 0; t < col.count / 3; t++) {
    const mat = Math.round(col.getW(t * 3) * 255);
    const variant = mat >= PMAT.Sign0 && mat <= FACE_LAST ? mat - PMAT.Sign0 : -1;
    if (variant < 0 || keep(variant)) tris.push(t);
  }
  if (tris.length === 0) return null;
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name] as THREE.BufferAttribute, n = a.itemSize;
    const arr = new Float32Array(tris.length * 3 * n);
    tris.forEach((t, i) => arr.set((a.array as Float32Array).subarray(t * 3 * n, (t + 1) * 3 * n), i * 3 * n));
    out.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  return out;
}

/**
 * How far a kind's meshes reach from the instance's origin at scale 1 (m): the farthest vertex, plus the corner offset
 * of the leaf cards (they turn to the camera round their centre). Impostor quads are the photo of the near mesh.
 */
function reachOf(lods: Array<THREE.BufferGeometry | null>): number {
  let r = 0;
  for (const g of lods) {
    if (!g) continue;
    const p = g.attributes.position as THREE.BufferAttribute, e = g.attributes.pext as THREE.BufferAttribute, c = g.attributes.pcol as THREE.BufferAttribute;
    if (Math.round(c.getW(0) * 255) === PMAT.Impostor) continue;
    for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)) + Math.hypot(e.getZ(i), e.getW(i)));
  }
  return r;
}

/** How a kind's scale bits stretch it: 0 uniform scale, 1 wire span (m), 2 wall length (dm). */
export function propStretch(k: PropKind): number {
  return k.type === PROP.Wire ? 1 : k.type === PROP.Barrier ? 2 : 0;
}

/**
 * Cull radius of one instance (m), the same as the cull pass computes it: the kind's reach times the instance's scale,
 * or plus the span for wires and walls (their z runs 0..1 and the shader stretches it).
 */
export function propCullRadius(k: PropKind, poseW: number): number {
  const bits = (poseW >>> 16) & 63, mode = propStretch(k);
  return mode === 1 ? k.radius + bits : mode === 2 ? k.radius + bits * 0.1 : k.radius * (bits / 42 + 0.5);
}

/** The kinds the renderer draws, in kind order (`propKindTable`). */
export function buildPropKinds(defs: PropDef[]): { kinds: PropKind[]; kindOf: Uint32Array } {
  const { kindOf } = propKindTable();
  const kinds: PropKind[] = [];
  defs.forEach((d, type) => {
    const split = SPLIT[type];
    if (MODELS[type]) {
      for (const m of [d, ...(d.alts ?? [])]) kinds.push({ type, lods: m.lods, dist: m.dist, radius: reachOf(m.lods) });
      return;
    }
    if (!split) { kinds.push({ type, lods: d.lods, dist: d.dist, radius: reachOf(d.lods) }); return; }
    const subs = Math.max(...split) + 1;
    for (let s = 0; s < subs; s++) {
      const lods = d.lods.map((g) => variantPart(g, (v) => split[v] === s));
      kinds.push({ type, lods, dist: d.dist, radius: reachOf(lods) });
    }
  });
  return { kinds, kindOf };
}

/** Below this height (m) a prop lies on the ground: its sun shadow is under it, too small to see. */
const FLAT_PROP = 0.3;

/**
 * Whether a kind's level casts a sun shadow: the near level only, never the wires (thin lines that alias in the map)
 * nor what lies on the ground (pebbles, leaves, drain grates: they cast shadows before).
 */
export function propCastsShadow(k: PropKind, level: number): boolean {
  const g = k.lods[level];
  if (level !== 0 || !g || k.type === PROP.Wire) return false;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox!.max.y - Math.max(0, g.boundingBox!.min.y) >= FLAT_PROP;
}
