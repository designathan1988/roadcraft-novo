// The 4.0 building parts' unit models (a window frame, a railing, a door leaf, a louvred shutter, an awning, the lot's
// boxes...), posed per instance by the props pool (jobs/building40.ts, jobs/parts40.ts). Nothing else of 4.0's kit is
// here: its materials, night schedule, far models and simplified levels were WebGL code never run by this engine.
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, PlaneGeometry } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FACADE_PROP_KINDS } from './facadeProps.ts';
import type { PartKind } from './chunk.ts';
import { createFacadePropGeometries } from './facadePropModels.ts';
import { m } from '../../world/units.ts';
import { SHELL_PART_FACES, SHELL_PART_KINDS, type ShellPartFace, type ShellPartKind } from './shellParts.ts';

export type { PartKind } from './chunk.ts';

export const PART_KINDS: readonly PartKind[] = [
  'glass',
  'frame',
  'concrete',
  'door',
  'shutter',
  'railing',
  'roofRailing',
  'awning',
  'column',
  'glassDark',
  'water',
  'lamp',
  'wash',
  'fin',
  'louvre',
  'glassRail',
  'brise',
  ...FACADE_PROP_KINDS,
  ...SHELL_PART_KINDS,
];

/** The lantern beside a front door: width, height and depth out of the wall; its gap from the door's edge. */
export const PORCH_LAMP = { w: m(0.16), h: m(0.26), d: m(0.12), gap: m(0.4) } as const;
/** How far the wash of its light (the `wash` part, placed at the lantern's centre) stands out of the wall. */
const WASH_OUT = m(0.01);

/** A box of the given size whose centre is at (x, y, z). */
function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** A box's faces in three's order (`BoxGeometry`: +x, -x, +y, -y, +z, -z), two triangles each. */
const BOX_FACES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;

/** A box without the faces another piece covers in the same plane: never drawn, and never two surfaces in one plane (`coplanar.spec.ts`). */
function boxWithout(w: number, h: number, d: number, x: number, y: number, z: number, covered: readonly (typeof BOX_FACES)[number][]): BufferGeometry {
  const g = box(w, h, d, x, y, z);
  const index = g.getIndex()!;
  const kept: number[] = [];
  BOX_FACES.forEach((face, k) => { if (!covered.includes(face)) for (let i = 6 * k; i < 6 * k + 6; i++) kept.push(index.getX(i)); });
  g.setIndex(kept);
  return g;
}

/** A window frame's bar across the unit square. */
export const FRAME_BAR = 0.045;

/** Window frame: outer border, a mullion and a transom, in a unit square */
// The sides', the mullion's and the transom's ends lie in the border's outer faces: left out, 60 triangles where 72 drew the same.
function frameGeometry(): BufferGeometry {
  const t = FRAME_BAR;
  const parts = [
    box(1, t, 1, 0, 0.5 - t / 2, 0),
    box(1, t, 1, 0, -0.5 + t / 2, 0),
    boxWithout(t, 1, 1, 0.5 - t / 2, 0, 0, ['+y', '-y']),
    boxWithout(t, 1, 1, -0.5 + t / 2, 0, 0, ['+y', '-y']),
    boxWithout(t * 0.8, 1, 1, 0, 0, 0, ['+y', '-y']),
    boxWithout(1, t * 0.8, 1, 0, 0.18, 0, ['+x', '-x']),
  ];
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A balcony railing: top rail and balusters on three sides, z from 0 (wall) to 1. */
function railingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [
    box(1, 0.06, 0.05, 0, 0.97, 1),
    box(0.05, 0.06, 1, -0.5, 0.97, 0.5),
    box(0.05, 0.06, 1, 0.5, 0.97, 0.5),
    box(1, 0.04, 0.03, 0, 0.12, 1),
  ];
  for (let i = 0; i <= 10; i++) parts.push(box(0.015, 0.94, 0.015, -0.5 + i / 10, 0.5, 1));
  for (let i = 1; i < 4; i++) {
    parts.push(box(0.015, 0.94, 0.015, -0.5, 0.5, i / 4));
    parts.push(box(0.015, 0.94, 0.015, 0.5, 0.5, i / 4));
  }
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A straight railing along a roof edge, centred at z = 0. */
function roofRailingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(1, 0.06, 0.05, 0, 0.97, 0), box(1, 0.04, 0.03, 0, 0.45, 0)];
  for (let i = 0; i <= 4; i++) parts.push(box(0.02, 0.94, 0.02, -0.5 + i / 4, 0.5, 0));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A door leaf in the component frame */
function doorGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(1, 1, 0.6, 0, 0, -0.2)];
  for (const x of [-0.24, 0.24]) {
    parts.push(box(0.36, 0.5, 0.35, x, 0.2, 0.25));
    parts.push(box(0.36, 0.3, 0.35, x, -0.3, 0.25));
  }
  // The handle, at hand height, near the lock stile.
  parts.push(box(0.1, 0.035, 1.6, 0.4, -0.04, 0.9));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A shop awning: a sloped canvas from the wall (y 0, z 0) down and out, with a valance. */
/** A louvred shutter leaf: a stile-and-rail frame round slats tilted to shed rain */
function louvreGeometry(): BufferGeometry {
  const t = 0.09;
  // The stiles' ends lie in the rails' outer faces, the middle rail's in the stiles': left out (`boxWithout`).
  const parts: BufferGeometry[] = [
    box(1, t, 1, 0, 0.5 - t / 2, 0), box(1, t, 1, 0, -0.5 + t / 2, 0),
    boxWithout(t, 1, 1, 0.5 - t / 2, 0, 0, ['+y', '-y']), boxWithout(t, 1, 1, -0.5 + t / 2, 0, 0, ['+y', '-y']),
    boxWithout(1, 0.6 * t, 0.6, 0, 0, -0.2, ['+x', '-x']),
  ];
  for (let k = 0; k < 9; k++) {
    const y = -0.42 + k * 0.105;
    // A slat tilted within the frame's height ends in the stiles' inner faces; the outer ones reach past it and keep their ends.
    const inside = Math.abs(y) + (0.7 * Math.sin(0.6) + 0.07 * Math.cos(0.6)) / 2 <= 0.5;
    const slat = boxWithout(1 - 2 * t, 0.07, 0.7, 0, 0, 0, inside ? ['+x', '-x'] : []);
    slat.rotateX(-0.6);
    slat.translate(0, y, -0.1);
    parts.push(slat);
  }
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A glass parapet: a clear pane the full width standing on the slab, a slim metal cap along its top. */
function glassRailGeometry(): BufferGeometry {
  const pane = box(1, 0.92, 0.02, 0, 0.48, 0);
  const merged = mergeGeometries([pane]) as BufferGeometry;
  pane.dispose();
  return merged;
}

/** A bay's rack of sun fins: six vertical blades across the unit width, the storey's height, standing out of the wall */
const BRISE_FINS = 6;
/** A blade's thickness across the unit width. */
export const BRISE_BLADE = 0.035;
function briseGeometry(): BufferGeometry {
  const t = BRISE_BLADE;
  const parts: BufferGeometry[] = [];
  for (let k = 0; k < BRISE_FINS; k++) parts.push(box(t, 1, 1, -0.5 + t / 2 + (k * (1 - t)) / (BRISE_FINS - 1), 0, 0));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

function awningGeometry(): BufferGeometry {
  const canvas = new BoxGeometry(1, 0.04, 1.08);
  canvas.rotateX(Math.atan2(0.75, 1));
  canvas.translate(0, -0.38, 0.5);
  // The valance hangs from the canvas's front edge, overlapping it a little
  canvas.computeBoundingBox();
  const edge = canvas.boundingBox!;
  const valance = box(1, 0.28, 0.025, 0, edge.min.y + 0.03 - 0.14, edge.max.z - 0.0125);
  const merged = mergeGeometries([canvas, valance]) as BufferGeometry;
  canvas.dispose();
  valance.dispose();
  return merged;
}

/** A shell part's model (`shellParts.ts`) in three's axes (plan x, up, -plan y): each face's corners in its order, fanned and wound as `Shell.face` winds it; white, its uv.x marking a paving's inset sides. */
function shellPartGeometry(faces: readonly ShellPartFace[]): BufferGeometry {
  const position: number[] = [], normal: number[] = [], uv: number[] = [], colour: number[] = [], index: number[] = [];
  for (const f of faces) {
    const base = position.length / 3;
    const n = [f.n[0], f.n[2], -f.n[1]] as const;
    for (const [u, v, w] of f.points) {
      position.push(u, w, -v);
      normal.push(n[0], n[1], n[2]);
      uv.push(f.inset ? 1 : 0, 0);
      colour.push(1, 1, 1);
    }
    const p = (k: number): readonly [number, number, number] => [f.points[k]![0], f.points[k]![2], -f.points[k]![1]];
    const p0 = p(0), p1 = p(1), p2 = p(2);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const forward = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] >= 0;
    for (let k = 1; k + 1 < f.points.length; k++) {
      if (forward) index.push(base, base + k, base + k + 1);
      else index.push(base, base + k + 1, base + k);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colour), 3));
  g.setIndex(index);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Each shell part's far model: its upward faces alone (null for a part with none). From where its sides are under a pixel
 * its top draws it, 2 triangles where the whole part draws 8-10 (Roadcraft 4.0's lot parts from afar); the props pool
 * switches to it per instance by the error it makes (render/props.ts).
 */
export function partTopGeometries(): Record<ShellPartKind, BufferGeometry | null> {
  return Object.fromEntries(SHELL_PART_KINDS.map((kind) => {
    const up = SHELL_PART_FACES[kind].filter((f) => f.n[2] > 0);
    return [kind, up.length ? shellPartGeometry(up) : null];
  })) as Record<ShellPartKind, BufferGeometry | null>;
}

/** The parts' models (unit-sized, posed per instance): what the kit draws with, and what a worker lays out of the parts (Roadcraft 5: jobs/building40.ts). */
export function partGeometries(): Record<PartKind, BufferGeometry> {
  const unitBox = new BoxGeometry(1, 1, 1);
  const glassPlane = new PlaneGeometry(1, 1);
  return {
    glass: glassPlane,
    frame: frameGeometry(),
    concrete: unitBox,
    door: doorGeometry(),
    shutter: unitBox,
    railing: railingGeometry(),
    roofRailing: roofRailingGeometry(),
    awning: awningGeometry(),
    // Open-ended: an arcade's column runs floor to soffit, its ends never seen (`emitBay` pillar).
    column: new CylinderGeometry(0.5, 0.5, 1, 12, 1, true),
    glassDark: glassPlane,
    water: unitBox,
    lamp: unitBox,
    // Placed at the lantern's centre (the same lot), the plane drawn back on the wall.
    wash: new PlaneGeometry(1, 1).translate(0, 0, -(PORCH_LAMP.d / 2 - WASH_OUT)),
    fin: unitBox,
    louvre: louvreGeometry(),
    glassRail: glassRailGeometry(),
    brise: briseGeometry(),
    ...createFacadePropGeometries(),
    ...(Object.fromEntries(SHELL_PART_KINDS.map((kind) => [kind, shellPartGeometry(SHELL_PART_FACES[kind])])) as Record<ShellPartKind, BufferGeometry>),
  };
}
