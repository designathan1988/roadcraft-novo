// Prop meshes (near, mid, far), built once at load from
// primitives. Colour per vertex; the alpha channel holds the finish:
// 0 plain, 1 foliage, 2 lamp glass, 3/4/5 red/yellow/green lamps, 6 bark, 7 metal.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BARRIER, FURN, PROP, PROP_TYPES, SIGN, WIRE_Y } from '../jobs/props.ts';
import { impostorQuad } from './impostor.ts';
import { MOVER_LAYER, MOVER_SMALL_LAYER, SMALL_CASTER, SMALL_CASTER_LAYER } from './sun.ts';
import { buildCarBody, buildCarSilhouette, type CarArchetype, type CarStyle, type Lamp } from './carBody.ts';
import { BRISE_BLADE, FRAME_BAR, SHELL_PARTS, partGeometries, partTopGeometries } from '../r40/api.ts';
import { markThin, partCardGeometries, THIN_PARTS } from './partCards.ts';
import { PART_BASE, PART_DIST, PART_PROP, PART_TYPES, POOL_PARTS, SHARED_MODEL_TYPES, VARIANT_TYPES } from '../jobs/parts40.ts';
import { cypressTree, floweringBush, hedge, ipeTree, mixedTree, oakTree, palmTree, shrub } from './treeMeshes.ts';
import { parkMiller } from '../core/rng.ts';

export const PMAT = { Plain: 0, Leaf: 1, Glass: 2, Red: 3, Yellow: 4, Green: 5, Bark: 6, Metal: 7, Wire: 8, Sign0: 9, Atlas: 25, LeafCard: 26, Impostor: 30, Paint: 31 } as const;
/** Faces per variant: Sign0 … Sign0 + 15. */
export const FACE_LAST = PMAT.Sign0 + 15;

export interface PropDef {
  /** Mesh per level (null = not drawn). */
  lods: Array<THREE.BufferGeometry | null>;
  /** End of each level (m, at 1080p). */
  dist: [number, number, number];
  /** Radius for culling. */
  radius: number;
  /** Other models of the type, drawn for the variants MODELS maps to them (index 1, 2…). */
  alts?: PropDef[];
  /** A 4.0 building-part type: the part kind each variant draws (index = variant; one name for a type of one model). */
  partNames?: string[];
}

/**
 * A 4.0 building part's size rules, judged per instance by the cull pass at its own scale (Roadcraft 4.0 partCells.ts
 * levelAt): its model's box (under a pixel across its diagonal it is not drawn), how far it reaches from its origin (its
 * cull sphere), its bars (a frame's rails and stiles, a railing's, a brise's blades: under half a pixel across it is not
 * drawn; none for a solid part) and whether its far level is a shell part's top (switched to once the half of its
 * smaller side that the sides stand for is under PART_ERROR_PX).
 */
export interface PartMeta {
  extent: readonly [number, number, number];
  reach: readonly [number, number, number];
  pieces: ReadonlyArray<readonly [number, number, number]>;
  topLevel: boolean;
  /** A thin kind's far level is its card (render/partCards.ts): what the card leaves out, in its unit model's axes. */
  card?: readonly [number, number, number];
}

/** A part's bars, in its unit model's axes (Roadcraft 4.0 kit.ts `pieces`; the values of R5's own models, r40 kit.ts). */
const PART_PIECES: Readonly<Record<string, ReadonlyArray<readonly [number, number, number]>>> = {
  frame: [[1, FRAME_BAR, 1], [FRAME_BAR, 1, 1]],
  railing: [[1, 0.06, 0.05], [0.05, 0.06, 1], [0.015, 0.94, 0.015]],
  roofRailing: [[1, 0.06, 0.05], [0.02, 0.94, 0.02]],
  brise: [[BRISE_BLADE, 1, 1]],
};

/** Below this, in pixels, the error a part's far level makes passes unseen (Roadcraft 4.0 kit.ts PART_ERROR_PX). */
export const PART_ERROR_PX = 1.5;
/** A part made of bars leaves the drawing once its widest bar is under this many pixels across (4.0 partCells.ts BAR_PIXELS). */
export const BAR_PIXELS = 0.5;

/** A part kind's rules from the model it draws (its level 0) and its 4.0 name. */
function partMeta(name: string, g: THREE.BufferGeometry, topLevel: boolean, card: boolean): PartMeta {
  if (!g.boundingBox) g.computeBoundingBox();
  const b = g.boundingBox!;
  return {
    extent: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z],
    reach: [Math.max(-b.min.x, b.max.x), Math.max(-b.min.y, b.max.y), Math.max(-b.min.z, b.max.z)],
    pieces: PART_PIECES[name] ?? [],
    topLevel,
    ...(card && THIN_PARTS[name] ? { card: THIN_PARTS[name].cardError } : {}),
  };
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
  // atlas uv and billboard corner (the tree cards), a thin part's bar, tone and card (render/partCards.ts); zero elsewhere
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
  // on the sidewalk: concrete utility pole with crossarm (wires along the road) and the lamp arm
  const utility = double ? [] : [
    part(cyl(0.17, 0.1, WIRE_Y + 0.4, 8), CONCRETE, PMAT.Plain),
    part(box(1.7, 0.12, 0.12), CONCRETE, PMAT.Plain, 0, WIRE_Y - 0.06, 0),
    part(box(0.5, 0.5, 0.5), 0x5c6064, PMAT.Metal, 0, 6.6, -0.32), // small transformer
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
  // pole at the corner, arm over the road (towards local −x), lights facing +z
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

/** Wire span: three cables from 0 to 1 in z (the shader stretches it to the next pole and makes the sag). */
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

/** Utility pole without a lamp (lines drawn by the player). */
function pole(): PropDef {
  const near = merge([
    part(cyl(0.17, 0.1, WIRE_Y + 0.4, 8), CONCRETE, PMAT.Plain),
    part(box(1.7, 0.12, 0.12), CONCRETE, PMAT.Plain, 0, WIRE_Y - 0.06, 0),
    ...[-0.75, 0.25, 0.75].map((x) => part(box(0.06, 0.14, 0.06), 0xe8e8e4, PMAT.Plain, x, WIRE_Y + 0.06, 0)),
  ]);
  const mid = merge([part(box(0.26, WIRE_Y + 0.4, 0.26), CONCRETE, PMAT.Plain), part(box(1.7, 0.14, 0.14), CONCRETE, PMAT.Plain, 0, WIRE_Y - 0.07, 0)]);
  return { lods: [near, mid, null], dist: [220, 750, 0], radius: 5 };
}

/** Sidewalk furniture: all variants in the same mesh (the shader shows only the instance's). */
function furniture(): PropDef {
  const v = (k: number) => PMAT.Sign0 + k;
  const parts = [
    // red hydrant
    part(cyl(0.16, 0.14, 0.62, 10), 0xc0261d, v(FURN.Hydrant)),
    part(ball(0.15, 1), 0xc0261d, v(FURN.Hydrant), 0, 0.64, 0),
    part(cyl(0.07, 0.07, 0.42, 6).rotateZ(Math.PI / 2), 0xa31f18, v(FURN.Hydrant), 0.21, 0.42, 0),
    // yellow postbox
    part(cyl(0.06, 0.06, 0.8, 6), 0x5a5f63, v(FURN.Postbox)),
    part(box(0.48, 0.62, 0.38), 0xf2c21a, v(FURN.Postbox), 0, 0.8, 0),
    part(box(0.3, 0.04, 0.02), 0x1f4f9a, v(FURN.Postbox), 0, 1.25, 0.2),
    // payphone: orange shell on a post
    part(cyl(0.06, 0.06, 1.9, 6), 0x5a5f63, v(FURN.Phone)),
    part(ball(0.62, 1), 0xe46a1c, v(FURN.Phone), 0, 1.95, 0.12, 1, 1.15, 0.85),
    part(box(0.22, 0.32, 0.12), 0x2a2d30, v(FURN.Phone), 0, 1.45, 0.3),
    // storm drain: grate at the kerb
    part(box(0.9, 0.06, 0.5), 0x3c3f42, v(FURN.Drain), 0, -0.04, 0),
    // concrete bollard
    part(cyl(0.16, 0.13, 0.75, 10), 0xb4b0a8, v(FURN.Bollard)),
    // planter
    part(box(1.0, 0.5, 1.0), 0x9d8f7c, v(FURN.Planter)),
    part(ball(0.55, 1), 0x4f7a34, v(FURN.Planter), 0, 0.65, 0, 1, 0.7, 1),
    // ---- building facade pieces (buildings session): origin at the foot of the wall, +z outwards
    // wall air conditioner (condenser with grille and brackets)
    part(box(0.8, 0.55, 0.3), 0xe4e4e0, v(FURN.WallAc), 0, 0.04, 0.17),
    part(box(0.36, 0.36, 0.02), 0x8d9296, v(FURN.WallAc), 0.14, 0.13, 0.33),
    part(box(0.04, 0.04, 0.34), 0x8a8e92, v(FURN.WallAc), -0.3, 0, 0.17),
    part(box(0.04, 0.04, 0.34), 0x8a8e92, v(FURN.WallAc), 0.3, 0, 0.17),
    // rooftop condenser (box with a fan on top)
    part(box(1.2, 0.9, 0.9), 0xd4d4d0, v(FURN.RoofAc), 0, 0, 0),
    part(box(1.22, 0.5, 0.92), 0xbfc1c0, v(FURN.RoofAc), 0, 0.15, 0),
    part(cyl(0.34, 0.34, 0.06, 14), 0x3c3f42, v(FURN.RoofAc), 0, 0.9, 0),
    part(box(0.05, 0.12, 0.7), 0x8a8e92, v(FURN.RoofAc), 0, 0.92, 0),
    // clay pot with a plant
    part(cyl(0.16, 0.22, 0.38, 10), 0xa65a3c, v(FURN.Vase)),
    part(ball(0.3, 1), 0x4f7a34, v(FURN.Vase), 0, 0.62, 0, 1, 0.9, 1),
    // standing clothesline with clothes (along the wall)
    part(box(0.03, 1.4, 0.03), 0xc9ccce, v(FURN.Clothesline), -0.9, 0, 0),
    part(box(0.03, 1.4, 0.03), 0xc9ccce, v(FURN.Clothesline), 0.9, 0, 0),
    ...[-0.12, 0, 0.12].map((z) => part(box(1.8, 0.015, 0.015), 0xd8dadc, v(FURN.Clothesline), 0, 1.38, z)),
    part(box(0.42, 0.55, 0.02), 0xf2f2ee, v(FURN.Clothesline), -0.5, 0.83, 0),
    part(box(0.36, 0.45, 0.02), 0x3d6aa0, v(FURN.Clothesline), 0.05, 0.93, 0.12),
    part(box(0.3, 0.6, 0.02), 0xc8402c, v(FURN.Clothesline), 0.55, 0.78, -0.12),
    // satellite dish
    part(box(0.05, 0.75, 0.05), 0x8a8e92, v(FURN.Dish), 0, 0, 0),
    part(ball(0.38, 1), 0xe8e8e4, v(FURN.Dish), 0, 0.85, 0.12, 1, 1, 0.22),
    part(box(0.03, 0.03, 0.35), 0x8a8e92, v(FURN.Dish), 0, 0.85, 0.3),
    // wind-driven roof vent (pipe and turbine)
    part(cyl(0.12, 0.12, 0.6, 8), 0xa9adb0, v(FURN.Vent)),
    part(ball(0.22, 1), 0xc9ccce, v(FURN.Vent), 0, 0.72, 0, 1, 0.75, 1),
    // plastic chair
    part(box(0.45, 0.05, 0.45), 0xf2f2ee, v(FURN.Chair), 0, 0.42, 0),
    part(box(0.45, 0.45, 0.04), 0xf2f2ee, v(FURN.Chair), 0, 0.47, -0.21),
    ...[[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].map(([x, z]) => part(box(0.035, 0.42, 0.035), 0xe6e6e2, v(FURN.Chair), x, 0, z)),
    // fibreglass water tank (blue) with lid
    part(cyl(0.62, 0.72, 0.85, 14), 0x2f6fb5, v(FURN.Tank)),
    part(cyl(0.64, 0.64, 0.07, 14), 0x285e98, v(FURN.Tank), 0, 0.85, 0),
  ];
  return { lods: [merge(parts), null, null], dist: [140, 0, 0], radius: 1.5 };
}

/** Walls, fences, hedges, guardrails and railings: piece from z = 0 to 1 (the shader stretches it to length and tilts it on slopes). */
function barrier(): PropDef {
  const v = (k: number) => PMAT.Sign0 + k;
  const near = merge([
    // wooden fence: post at the start, three boards
    part(box(0.12, 1.3, 0.12), 0x7a5a3a, v(BARRIER.Fence), 0, 0, 0.06),
    part(box(0.05, 0.12, 1), 0x8a6844, v(BARRIER.Fence), 0, 0.35, 0.5),
    part(box(0.05, 0.12, 1), 0x8a6844, v(BARRIER.Fence), 0, 0.7, 0.5),
    part(box(0.05, 0.12, 1), 0x8a6844, v(BARRIER.Fence), 0, 1.05, 0.5),
    // rendered masonry wall
    part(box(0.22, 1.9, 1), 0xd8d0c2, v(BARRIER.Wall), 0, 0, 0.5),
    part(box(0.3, 0.08, 1), 0xb8b0a2, v(BARRIER.Wall), 0, 1.9, 0.5),
    // hedge
    part(box(0.8, 1.3, 1), 0x3f6a2e, v(BARRIER.Hedge), 0, 0, 0.5),
    // metal crash barrier (guard-rail)
    part(box(0.1, 0.75, 0.1), 0x8a8e92, v(BARRIER.Guardrail), 0, 0, 0.05),
    part(box(0.06, 0.32, 1), 0xb8bcc0, v(BARRIER.Guardrail), 0.06, 0.42, 0.5),
    // urban railing
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

/** Near meshes of the trees, to photograph the impostors (in the order of the atlas columns). */
export function impostorSources(defs: PropDef[]): THREE.BufferGeometry[] {
  return [defs[PROP.Tree].lods[0]!, defs[PROP.Conifer].lods[0]!, defs[PROP.Oak].lods[0]!, defs[PROP.Palm].lods[0]!,
    defs[PROP.Tree].alts![0].lods[0]!, defs[PROP.Oak].alts![0].lods[0]!];
}

/**
 * Parked car: roadcraft 4.0's body (render/carBody.ts buildCarBody, the street cars' own) near the camera, its coarse
 * silhouette (buildCarSilhouette) in the middle distance; the paint comes from the variant. Variants pick the style
 * (MODELS): sedan, hatchback, SUV.
 */
const PARKED: Array<[CarStyle, CarArchetype]> = [
  ['sedan', { length: 4.4, width: 1.84, height: 1.45, wheelRadius: 0.33 }],
  ['hatch', { length: 3.9, width: 1.72, height: 1.48, wheelRadius: 0.31 }],
  ['suv', { length: 4.6, width: 1.95, height: 1.78, wheelRadius: 0.37 }],
];

/** A 4.0 car geometry (x forward, z right, white where painted) as prop parts: z forward, the paint where it was white. */
function carParts(g: THREE.BufferGeometry, mat: number, colour?: number): THREE.BufferGeometry {
  const ng = (g.index ? g.toNonIndexed() : g.clone()).rotateY(-Math.PI / 2);
  if (!ng.getAttribute('normal')) ng.computeVertexNormals();
  const src = ng.getAttribute('color') as THREE.BufferAttribute | undefined;
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 4);
  const fixed = colour === undefined ? null : new THREE.Color(colour).convertSRGBToLinear();
  for (let i = 0; i < n; i++) {
    const r = src ? src.getX(i) : 1, gg = src ? src.getY(i) : 1, b = src ? src.getZ(i) : 1;
    const white = r > 0.99 && gg > 0.99 && b > 0.99;
    col[i * 4] = fixed ? fixed.r : r; col[i * 4 + 1] = fixed ? fixed.g : gg; col[i * 4 + 2] = fixed ? fixed.b : b;
    col[i * 4 + 3] = (mat === PMAT.Paint && !white ? PMAT.Plain : mat) / 255;
  }
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal') ng.deleteAttribute(k);
  ng.setAttribute('pcol', new THREE.BufferAttribute(col, 4));
  ng.setAttribute('pext', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  return ng;
}

function parkedCarOf(style: CarStyle, a: CarArchetype): PropDef {
  const TI = 0x161616, RIM = 0x9a9ea3;
  const wheels = (sides: number): THREE.BufferGeometry[] => [a.length * 0.31, -a.length * 0.31].flatMap((ax) => [a.width / 2 - 0.14, -(a.width / 2 - 0.14)].flatMap((x) => [
    part(new THREE.CylinderGeometry(a.wheelRadius, a.wheelRadius, 0.22, sides).rotateZ(Math.PI / 2), TI, PMAT.Plain, x, a.wheelRadius, ax),
    part(new THREE.CircleGeometry(a.wheelRadius * 0.62, sides).rotateY(x > 0 ? Math.PI / 2 : -Math.PI / 2), RIM, PMAT.Metal, x + Math.sign(x) * 0.112, a.wheelRadius, ax),
  ]));
  const body = buildCarBody(a, style, 12, 4, 2);
  // (shaped to the body, carBody.ts lampFace: a box at one x stood out of the rounded corners)
  const lamp = (l: Lamp, c: number) => (l.face ? part(l.face.clone().rotateY(-Math.PI / 2), c, PMAT.Plain, 0, 0, 0) : part(new THREE.BoxGeometry(l.sz, l.sy, l.sx), c, PMAT.Plain, -l.z, l.y, l.x));
  const near = merge([
    carParts(body.shell, PMAT.Paint), carParts(body.glass, PMAT.Glass, 0x1a2430), carParts(body.trim, PMAT.Plain),
    ...body.headlamps.map((l) => lamp(l, 0xe8e2cf)), ...body.taillamps.map((l) => lamp(l, 0x7a1414)),
    ...body.indicators.map((l) => lamp(l, 0xb8741a)), ...body.plates.map((l) => lamp(l, 0xe9e9e2)),
    ...wheels(12),
  ]);
  const mid = merge([carParts(buildCarSilhouette(a, style, 12), PMAT.Paint), ...wheels(6).filter((_, i) => i % 2 === 0)]);
  return { lods: [near, mid, null], dist: [55, 320, 0], radius: 3 };
}

function parkedCar(): PropDef {
  const [first, ...rest] = PARKED.map(([s, a]) => parkedCarOf(s, a));
  return { ...first, alts: rest };
}

/** Ground elements: the 11 variants in the same mesh (the shader shows only the instance's), a ~1.5 m clump. */
function ground(): PropDef {
  const v = (k: number) => PMAT.Sign0 + k;
  const parts: THREE.BufferGeometry[] = [];
  const r = parkMiller(7);
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
  // 11: palm (curved segmented trunk and a fan of fronds)
  for (let k = 0; k < 7; k++) parts.push(part(cyl(0.2 - k * 0.012, 0.19 - k * 0.012, 1.15, 6), 0x8a6f4d, v(11), k * 0.07, k * 1.1, 0));
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2;
    parts.push(part(box(0.5, 0.06, 3.2).translate(0, 0, 1.6).rotateX(0.35), [0x4f8a3a, 0x5d9a42][k % 2], v(11), 0.5, 7.7, 0, 1, 1, 1, a));
  }
  return { lods: [merge(parts), null, null], dist: [260, 0, 0], radius: 6 };
}

/** Creator's person: clothes painted by the variant (vehicle palette), fixed skin, hair and trousers. */
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

/**
 * The Roadcraft 4.0 building parts (jobs/parts40.ts): each type's mesh from the 4.0 kit's unit models (kit.ts
 * partGeometries), in the kit's colours; a type that holds several kinds keeps each kind's vertices as its variant (the
 * shader drops the others). Scale per axis and colour come with each instance.
 */
function buildingPartDefs(models: Readonly<Record<string, THREE.BufferGeometry>>): Map<number, PropDef> {
  const byType = new Map<number, { near: THREE.BufferGeometry[]; far: THREE.BufferGeometry[]; names: string[] }>();
  // the shell parts' far level: their tops (Roadcraft 4.0: a lot's box, rail or slab from afar)
  const tops = partTopGeometries() as Readonly<Record<string, THREE.BufferGeometry | null>>;
  // the thin kinds' far level: their cards (Roadcraft 4.0: a frame's or a railing's bars drawn by the pixel shader)
  const cards = partCardGeometries();
  /** A model posed as a part of the pool, in the kit's colour and with the model's own tones (the facade props). */
  const posed = (g: THREE.BufferGeometry, rgb: number, mat: number): THREE.BufferGeometry => {
    const one = part(g, rgb, mat);
    const tones = g.getAttribute('color');
    if (tones) {
      const flat = g.index ? g.toNonIndexed() : g;
      const t = flat.getAttribute('color'), col = one.getAttribute('pcol');
      for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * t.getX(i), col.getY(i) * t.getY(i), col.getZ(i) * t.getZ(i));
    }
    return one;
  };
  for (const [kind, [type, variant]] of Object.entries(POOL_PARTS)) {
    const g = models[kind];
    if (!g) continue;
    const entry = byType.get(type) ?? { near: [], far: [], names: [] };
    byType.set(type, entry);
    if (SHARED_MODEL_TYPES.has(type)) {
      // one model draws all the type's kinds (their colours come with the instances, parts40.ts poolTint)
      if (entry.near.length === 0) entry.near.push(posed(g, 0xffffff, PMAT.Plain));
      else if (models[entry.names[0]] !== g) throw new Error(`[props] part ${kind} does not draw the model ${entry.names[0]} does`);
      entry.names.push(kind);
      continue;
    }
    const [rgb, metal] = PART_BASE[kind] ?? [0xffffff, false];
    const mat = VARIANT_TYPES.has(type) ? PMAT.Sign0 + variant : metal ? PMAT.Metal : PMAT.Plain;
    entry.near.push(markThin(posed(g, rgb, mat), kind, false));
    const top = tops[kind], card = cards[kind];
    if (top) entry.far.push(posed(top, rgb, mat));
    else if (card) entry.far.push(markThin(posed(card, rgb, mat), kind, true));
    entry.names[VARIANT_TYPES.has(type) ? variant : 0] = kind;
  }
  const defs = new Map<number, PropDef>();
  for (const [type, e] of byType) {
    const d = PART_DIST[type] ?? 100;
    const far = e.far.length ? merge(e.far) : null;
    defs.set(type, { lods: [merge(e.near), far, null], dist: [d, far ? d : 0, 0], radius: 5, partNames: e.names });
  }
  return defs;
}

/** The 4.0 building parts' unit models (r40 kit.ts), built once by their owner (render/props.ts) and read by the props pool and the ruins. */
export function buildingPartModels(): Readonly<Record<string, THREE.BufferGeometry>> {
  return partGeometries() as unknown as Record<string, THREE.BufferGeometry>;
}

/** All props, in type order; `partModels` from `buildingPartModels`. */
export function buildPropDefs(partModels: Readonly<Record<string, THREE.BufferGeometry>>): PropDef[] {
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
  // 18..23: the roads/vegetation work's, empty for now; 24..29 the 4.0 building parts
  const parts = buildingPartDefs(partModels);
  for (let t = PROP.Palm + 1; t < PROP_TYPES; t++) defs[t] = parts.get(t) ?? { lods: [null, null, null], dist: [0, 0, 0], radius: 0 };
  if (defs.length !== PROP_TYPES) throw new Error(`prop types: ${defs.length} definitions for ${PROP_TYPES} types`);
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
  /** A 4.0 building part's size rules (judged per instance in the cull pass); none for the other props. */
  part?: PartMeta;
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
// The 4.0 building-part types carry a variant too. Derive their split from POOL_PARTS so a new variant cannot fall
// back into a mesh that makes every instance process all of them.
const PART_VARIANT_MAX: Record<number, number> = {};
for (const [type, variant] of Object.values(POOL_PARTS)) if (VARIANT_TYPES.has(type)) PART_VARIANT_MAX[type] = Math.max(PART_VARIANT_MAX[type] ?? 0, variant);
for (const type of VARIANT_TYPES) SPLIT[type] = Array.from({ length: VARIANTS }, (_, v) => Math.min(v, PART_VARIANT_MAX[type] ?? 0));

/**
 * Types whose variants are other models (PropDef.alts): variant → model (0 = the type's own). The generator gives trees
 * and bushes variants 0..3: tree 3 is the yellow ipê, oak 3 the pink ipê, bush 2 the flowering bush, bush 3 the hedge.
 */
const MODELS: Record<number, number[]> = {
  [PROP.Tree]: Array.from({ length: VARIANTS }, (_, v) => (v === 3 ? 1 : 0)),
  [PROP.Oak]: Array.from({ length: VARIANTS }, (_, v) => (v === 3 ? 1 : 0)),
  [PROP.Bush]: Array.from({ length: VARIANTS }, (_, v) => (v === 2 ? 1 : v === 3 ? 2 : 0)),
  [PROP.ParkedCar]: Array.from({ length: VARIANTS }, (_, v) => v % 3),
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

/** A part kind's rules, by its type's part names and its sub-kind (variant), from the model it draws. */
function kindPart(d: PropDef, sub: number, lods: Array<THREE.BufferGeometry | null>): PartMeta | undefined {
  const name = d.partNames?.[sub] ?? d.partNames?.[0];
  const g = lods[0];
  const far = lods[1] !== null && lods[1] !== undefined;
  return name && g ? partMeta(name, g, far && (SHELL_PARTS as ReadonlySet<string>).has(name), far && THIN_PARTS[name] !== undefined) : undefined;
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
    if (!split) { kinds.push({ type, lods: d.lods, dist: d.dist, radius: reachOf(d.lods), part: kindPart(d, 0, d.lods) }); return; }
    const subs = Math.max(...split) + 1;
    for (let s = 0; s < subs; s++) {
      const lods = d.lods.map((g) => variantPart(g, (v) => split[v] === s));
      kinds.push({ type, lods, dist: d.dist, radius: reachOf(lods), part: kindPart(d, s, lods) });
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

/**
 * Whether a kind's near level casts into the sun's cascades: what is tall enough (`propCastsShadow`) and, of the 4.0
 * building parts, only the boxes (sills, fins, shutters) and the lot pieces; thin frames, railings and the small parts
 * none (each cascade would draw them again for a shadow under its texel). Read by the kind's TYPE: kinds are not numbered
 * as types (a type split by model or variant shifts every kind after it), and testing the kind's index against the part
 * types let all the frames, railings, doors and balcony props cast into the three cascades (61 kinds below the parts).
 */
export function propKindCasts(k: PropKind): boolean {
  return propCastsShadow(k, 0) && (!PART_TYPES.includes(k.type) || k.type === PART_PROP.BBox || k.type === PART_PROP.BLot);
}

/** A kind whose near model has leaves: they sway in the wind (render/props.ts), so its shadow moves. */
export function propSways(k: PropKind): boolean {
  const c = k.lods[0]?.attributes.pcol as THREE.BufferAttribute | undefined;
  if (!c) return false;
  for (let i = 0; i < c.count; i += 3) {
    const m = Math.round(c.getW(i) * 255);
    if (m === PMAT.Leaf || m === PMAT.LeafCard) return true;
  }
  return false;
}

/**
 * The layer a kind's level is drawn on: a low prop's, the views and the near cascade only (its shadow is under a texel of
 * the far ones); a leafy kind's near level, the movers' (drawn over the cascades' still casters each frame, sun.ts).
 */
export function propLayer(k: PropKind, level: number): number {
  const small = propIsSmallCaster(k);
  if (level === 0 && propSways(k)) return small ? MOVER_SMALL_LAYER : MOVER_LAYER;
  return small ? SMALL_CASTER_LAYER : 0;
}

/** A prop low enough to cast only into the near cascade (sun.ts SMALL_CASTER_LAYER). */
export function propIsSmallCaster(k: PropKind): boolean {
  const g = k.lods[0] ?? k.lods[1];
  if (!g) return true;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox!.max.y - Math.max(0, g.boundingBox!.min.y) < SMALL_CASTER;
}
