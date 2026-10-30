// Part of the R40 building mesh pipeline (split by responsibility).
import { resolveBlocks } from '../../world/buildings/blocks.ts';
import { lotSurfaces } from '../../world/buildings/lots.ts';
import { deriveSpaces } from '../../world/buildings/spaces.ts';
import { spaceSeed } from './lightSlots.ts';
import { buildingFrame, frameX, frameY, letGoLayout, bayWidth, closedBlocks, coveredSpans, facadeBays, levelElevation, levelHeight, projectionRect, volumeElevation, volumeHeight, volumeLift } from '../../world/buildings/geometry.ts';
import { FURNITURE_KINDS, type Furniture, type FurnitureKind, interiorAt, letGoInterior } from '../../world/buildings/interior.ts';
import { ROOM_FLOATS, roomsOfStorey } from './roomBehind.ts';
import { edgeFrame, localFootprint } from '../../world/buildings/footprints.ts';
import { BufferAttribute, BufferGeometry, Color, Group, InstancedBufferAttribute, InstancedInterleavedBuffer, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, Mesh, Sphere, Vector3, Box3 } from 'three';
import { type Bounds, type CellArrays, type CellSelection, FACADE_BYTES, FACADE_FLOATS, FACADE_GRID, FINISH_ATTRIBUTE, type KitBoxes, NORMAL_SHORTS, type ShellGrid, PAINT_ATTRIBUTE, SHELL_MESH, SHELL_NORMAL, cellArrays } from './cellArrays.ts';
import { COVER_INSET, GROUND_ATTRIBUTE, LOOK_FLOATS, NO_GROUND, SHELL_PART_FACES, SHELL_PART_KINDS } from './shellParts.ts';
import { partLook } from './fade.ts';
import { m } from '../../world/units.ts';
import { type Entrance, type Foundation, type GroundAt, type PavedAt, PLINTH_BURY, STEP_RUN, foundationOf, floorHeight } from '../../world/buildings/foundation.ts';
import { FINISHES, type Finish, paletteOf, plinthMaterial, roofMaterial, trimMaterial, wallMaterial } from '../../world/buildings/materials.ts';
import { FOLLOWS_GROUND, followPieces } from '../../world/buildings/elements.ts';
import { type BayComponent, type Building, type BuildingElement, type FaceId, type Volume, volumeTop } from '../../world/buildings/types.ts';
import { type BuildingKit, PART_KINDS, type PartKind } from './kit.ts';
import { gpuOnlyAttributes } from '../mesh/gpuOnly.ts';
import { machineRooms } from './roofPlan.ts';
import type { FlagInstance } from './flagLayer.ts';
import type { BuildingChunk, LotGround, PartBatch, RunChunk, ShellChunk } from './chunk.ts';
import { drawsSignature } from './signature.ts';
import { type Cover, type PartyWalls, hiddenByCovers } from './partyWalls.ts';
import { POSE_FLOATS, letGoPosed, partPoseDepth, poseMatrixInto, posedCopy } from './partPose.ts';
import { partBandings } from './partFiling.ts';
import { Shell, Emitter, bayKey, openingOf, REVEAL, paint, shaded, sideFrame, PLINTH_RISE, PLINTH_GROW, sideFrameInto, FLAT_DEPTH, slotOfBay, BAND_OUT, BAND_H, ROOF_PLANT, flagOf, partSink, setFlagSink, ShellPart, type PartSink, type FurnitureSink, type SlotAllocator, type Opening, type Paint, type V3, type BayFace } from './meshCore.ts';
import { emitPlinth, streakOf, emitBay, emitFacadeRuns, emitRelief, emitRecessedFlight, type FarBay } from './facadeEmit.ts';
import { bothCovered, band, flushBand, emitRoof, emitRoofDetails } from './roofMesh.ts';
import { emitInterior } from './interiorMesh.ts';
import { emitLots, lotGroundOf } from './lotMesh.ts';
import { emitLot, looseParts, elementPaint, emitElement } from './elementMesh.ts';

export interface BuildingMeshes {
  readonly group: Group;
  readonly triangles: number;
  /** Shown or hidden as a whole. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface AssemblySelection {
  readonly parts: ReadonlySet<PartKind>;
  readonly shells: boolean;
  readonly furniture: boolean;
}

export function emitBuilding(
  b: Building,
  groundAt: GroundAt,
  shell: Shell,
  parts: PartSink,
  pavedAt?: PavedAt,
  furniture: FurnitureSink = {},
  onLot?: (el: BuildingElement) => boolean,
  designedFloor?: number,
  slots: SlotAllocator = spaceSeed,
  /** The neighbours' blocks a party wall stands against (`partyWalls.ts`): a bay inside them is not laid. */
  covers: readonly Cover[] = [],
): Foundation {
  const e = new Emitter(b, shell, parts, furniture);
  // Put in the world off the layout kept for the blocks (`bayLayout`): the flights' feet and the like buildings of the job read the same one.
  const bays = facadeBays(b);
  const f: Foundation = foundationOf(b, groundAt, bays, pavedAt, designedFloor);
  const floor = f.floor;
  shell.ground = floor;
  const entrances = new Map<number, Entrance>();
  for (const x of f.entrances) entrances.set(bayKey(x.volume, 0, x.side, x.index), x);
  /** The opening of an entrance, in its bay's face frame. */
  const entranceOpening = (x: Entrance): Opening =>
    openingOf(x.component, x.width, levelHeight(b, 0)) ??
    { a0: x.width * 0.2, a1: x.width * 0.8, h0: 0, h1: levelHeight(b, 0) * 0.7, depth: REVEAL };
  /** Where an entrance's bay starts along its side. */
  const entranceStart = (x: Entrance, v: Volume): number => x.index * bayWidth(b, v, x.side);
  // A small, stable shade per building, so a street of one preset is not a single flat colour.
  const shade = 0.93 + (((b.id * 2654435761) >>> 0) % 1000) / 1000 * 0.12;
  const wallOf = (v: Volume, side: FaceId, storey?: number): Paint => paint(wallMaterial(b, v, side, storey), shade);
  // Mouldings - bands, cornices, copings, reveals - are smooth: a finish with a pattern
  const trimSpec = trimMaterial(b);
  const frameTrim = paint({ finish: trimSpec.finish === 'metal' ? 'metal' : 'plaster', colour: trimSpec.colour });
  // Mouldings - cornices, string courses, copings, the heads of reliefs - are masonry
  const trim = trimSpec.finish === 'metal' && b.materials?.wall
    ? shaded(paint({ finish: 'plaster', colour: b.materials.wall.colour }), 1.1) : frameTrim;
  const plinth = paint(plinthMaterial(b));
  const awning = new Color().setHex(paletteOf(b).awning);

  // ---- plinth: from below the lowest ground up to the floor
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    const top = floor + volumeLift(v);
    const notches = new Map<FaceId, { a0: number; a1: number; recess: number }[]>();
    for (const x of f.entrances) {
      if (x.volume !== v.id || x.recess <= 0) continue;
      const o = entranceOpening(x);
      const frame = sideFrame(v, x.side, entranceStart(x, v));
      const start = x.side === 0 || x.side === 2 ? frame.ax : frame.ay;
      const list = notches.get(x.side) ?? [];
      list.push({ a0: start + o.a0, a1: start + o.a1, recess: x.recess });
      notches.set(x.side, list);
    }
    // Its ledge a little over the floor (`PLINTH_RISE`), so a yard laid at the floor's level meets its face, not its top.
    const ledge = top + PLINTH_RISE;
    emitPlinth(e, b, v, Math.min(f.bottom, top - PLINTH_BURY), ledge, plinth, notches);
    // A projection standing on the ground stands on the plinth too.
    for (const r of v.reliefs ?? []) {
      const rect = r.storey0 === 0 ? projectionRect(b, v, r) : null;
      if (!rect) continue;
      const g = PLINTH_GROW;
      if (v.outline) {
        const frame = edgeFrame(v, r.side), width = bayWidth(b, v, r.side);
        const a0 = r.bay0 * width - g, a1 = (r.bay1 + 1) * width + g;
        const at = (a: number, depth: number, z: number): V3 =>
          e.L(frame.x + frame.tx * a + frame.nx * depth, frame.y + frame.ty * a + frame.ny * depth, z);
        e.shell.face([at(a0, r.depth + g, f.bottom), at(a1, r.depth + g, f.bottom), at(a1, r.depth + g, ledge), at(a0, r.depth + g, ledge)], e.N(frame.nx, frame.ny), plinth);
        e.shell.face([at(a0, -g, ledge), at(a1, -g, ledge), at(a1, r.depth + g, ledge), at(a0, r.depth + g, ledge)], [0, 0, 1], plinth);
      } else {
        e.box(rect[0] - g, rect[1] - g, rect[2] + g, rect[3] + g, f.bottom, ledge, plinth);
      }
    }
  }

  // The spaces of each floor, for which room a window lights.
  const spacesOf = deriveSpaces(b);
  // ---- facades, bay by bay: only outside walls are in `bays`
  const componentAt = new Map<number, BayComponent>();
  for (const bay of bays) componentAt.set(bayKey(bay.volume, bay.level, bay.side, bay.index), bay.component);
  const volumes = new Map(b.volumes.map((v) => [v.id, v]));
  // The rooms behind the windows, a type of floor of a block at a time: the interior the cut-open view draws (`interiorAt`, furnished once a type for the blocks).
  const roomsOf = new Map<readonly Furniture[], Map<number, ReturnType<typeof roomsOfStorey>>>();
  // The far level's bays, laid as runs once all are known.
  const farBays: FarBay[] = [];
  // One face written again for each bay (nothing keeps it past its bay: `e.room` is let go with it).
  const face: BayFace = { ax: 0, ay: 0, tx: 0, ty: 0, nx: 0, ny: 0, z0: 0, W: 0, H: 0 };
  for (const bay of bays) {
    const v = volumes.get(bay.volume) as Volume;
    sideFrameInto(face, v, bay.side, bay.start, bay.push);
    face.z0 = floor + bay.z; face.W = bay.width; face.H = bay.height;
    if (covers.length > 0) {
      const [x, y] = e.L(face.ax, face.ay, 0), [tx, ty] = e.N(face.tx, face.ty), [nx, ny] = e.N(face.nx, face.ny);
      if (hiddenByCovers(covers, x, y, tx, ty, nx, ny, face.W, face.z0, face.z0 + face.H)) continue;
    }
    const left = componentAt.get(bayKey(bay.volume, bay.level, bay.side, bay.index - 1));
    const right = componentAt.get(bayKey(bay.volume, bay.level, bay.side, bay.index + 1));
    const recess = bay.level === 0 ? entrances.get(bayKey(bay.volume, 0, bay.side, bay.index))?.recess ?? 0 : 0;
    const composition = v.storeys[bay.storey]?.facade;
    const grammar = composition?.patterns?.[bay.side] ?? composition?.pattern ?? v.facadePattern;
    const controls = v.facadeGeometry?.[bay.side];
    if (grammar === 'observation' && bay.component === 'wideWindow') {
      const mullion = Math.min(m(0.12), face.W * .12);
      const head = Math.min(m(0.25), face.H * .12);
      const glass = paint({ finish: 'glass', colour: 0x526b73 });
      const frame = paint({ finish: 'metal', colour: 0xd5d5ca });
      e.rect(face, mullion, face.W - mullion, head, face.H - head, -m(.11), e.N(face.nx, face.ny), glass);
      e.rect(face, 0, mullion, 0, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, face.W - mullion, face.W, 0, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, 0, face.W, 0, head, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, 0, face.W, face.H - head, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      continue;
    }
    // Cut open, the floor seen is walled as The Sims walls it
    if (b.cutaway !== undefined && bay.level === b.cutaway && b.cutView) {
      const n = e.N(face.nx, face.ny);
      const inner = paint({ finish: 'plaster', colour: 0xeee8dc });
      if (n[0] * b.cutView.x + n[1] * b.cutView.y < 0) {
        const low = Math.min(m(0.9), face.H);
        e.rect(face, 0, face.W, 0, low, 0, n, wallOf(v, bay.side, bay.storey));
        e.rect(face, 0, face.W, 0, low, m(0.25), e.N(-face.nx, -face.ny), inner);
        e.shell.face([e.P(face, 0, low, 0), e.P(face, face.W, low, 0), e.P(face, face.W, low, m(0.25)), e.P(face, 0, low, m(0.25))], [0, 0, 1], inner);
        continue;
      }
      e.rect(face, 0, face.W, 0, face.H, m(0.25), e.N(-face.nx, -face.ny), inner);
    }
    const opening = shell.far && bay.component !== 'pillar' && recess <= 0 ? openingOf(bay.component, bay.width, bay.height, controls) : undefined;
    if (opening !== undefined && (opening === null || opening.depth <= FLAT_DEPTH)) {
      // The far level: the bay's wall is laid with its storey's run (`emitFacadeRuns`), its opening drawn by the shader;
      // what stands out of it (balconies, awnings, canopies, sills, shutters' leaves) is put as in the detail.
      const wall = wallOf(v, bay.side, bay.storey);
      farBays.push({ bay, wall, opening, ground: floor + volumeLift(v), streak: streakOf(bay.component, opening, wall) });
      shell.ground = floor + volumeLift(v);
      e.flat = true;
      emitBay(e, face, bay, wallOf(v, bay.side, bay.storey), frameTrim, awning, left, right, recess, controls);
      e.flat = false;
      shell.ground = floor;
    } else {
      e.slot = slotOfBay(b, v, bay, spacesOf, slots);
      if (b.id >= 0 && b.cutaway === undefined) {
        // The levels of one type share their pieces (`interiorAt`), and so their rooms, a pane alike looked at once.
        const inside = interiorAt(b, bay.level);
        let byBlock = roomsOf.get(inside.furniture);
        if (!byBlock) roomsOf.set(inside.furniture, byBlock = new Map());
        let look = byBlock.get(v.id);
        if (!look) byBlock.set(v.id, look = roomsOfStorey(b, v, inside, bay.level));
        const behind = look;
        e.room = (a, h) => behind(face.ax, face.ay, face.tx, face.ty, face.nx, face.ny, a, h, face.H - m(0.3));
      }
      // The base weathered at the block's own foot (a split level stands at its own floor).
      shell.ground = floor + volumeLift(v);
      emitBay(e, face, bay, wallOf(v, bay.side, bay.storey), frameTrim, awning, left, right, recess, controls);
      shell.ground = floor;
      e.slot = -1;
      e.room = null;
    }
    const ribDepth = controls?.pierDepth ?? (grammar === 'artDecoCrown' ? m(.65) : grammar === 'artDeco' ? m(.3) : 0);
    if (ribDepth > 0 && bay.index % (controls?.pierEvery ?? 1) === 0) {
      // Shallow, continuous-looking stone pilasters give every mass a vertical rhythm while retaining individually editable
      const width = Math.min(controls?.pierWidth ?? (grammar === 'artDecoCrown' ? m(.65) : m(.36)), face.W * .3);
      const a0 = width * 0.35, a1 = a0 + width;
      const depth = -ribDepth;
      // The building's own skin, a little lighter (catching the light)
      const stone = shaded(wallOf(v, bay.side, bay.storey), 1.08);
      // On the ground floor from the plinth's ledge up, not through it.
      const foot = bay.storey === 0 && v.base === 0 ? PLINTH_RISE : 0;
      e.rect(face, a0, a1, foot, face.H, depth, e.N(face.nx, face.ny), stone);
      e.jamb(face, a0, foot, face.H, 0, depth, e.N(-face.tx, -face.ty), stone);
      e.jamb(face, a1, foot, face.H, depth, 0, e.N(face.tx, face.ty), stone);
    }
  }
  if (farBays.length > 0) emitFacadeRuns(e, volumes, floor, farBays, frameTrim);

  // ---- reliefs: the cheeks, head and sill of every face region pushed in or out
  for (const v of b.volumes) {
    for (const r of v.reliefs ?? []) emitRelief(e, b, v, r, floor, wallOf(v, r.side, r.storey0), trim);
  }

  // ---- storey bands and cornices, per volume
  for (const v of b.volumes) {
    const lines = v.dress?.lines ?? 'every';
    if (lines === 'none') continue;
    for (let k = 1; k < v.storeys.length; k++) {
      const level = v.base + k;
      if (level === 0) continue;
      const z = floor + volumeElevation(b, v, level);
      // Not where another block stands against the wall over and under the line
      const hidden = (side: FaceId): [number, number][] => bothCovered(coveredSpans(b, v, side, level - 1), coveredSpans(b, v, side, level));
      if (lines === 'every') band(e, v, z, BAND_OUT, BAND_H, trim, hidden);
      // One string course over the ground floor: the base read from the body.
      else if (lines === 'base') { if (level === 1) band(e, v, z, m(0.12), m(0.32), trim, hidden); }
      // The floor slabs shown flush, a thin line of the wall's own render, darker.
      else flushBand(e, v, z, m(0.03), m(0.24), shaded(wallOf(v, 0), 0.86), hidden);
    }
  }

  // ---- roofs (none over a floor cut open to look inside)
  for (const v of b.volumes) {
    if (b.cutaway !== undefined && volumeTop(v) === b.cutaway + 1) continue;
    emitRoof(e, b, v, floor, (side) => wallOf(v, side), trim, paint(roofMaterial(b, v)));
    emitRoofDetails(e, b, v, floor);
  }
  if (b.cutaway !== undefined) emitInterior(e, b, floor, b.cutaway);

  // ---- entrance steps: outside, down to the ground in front
  for (const entrance of f.entrances) {
    if (entrance.steps <= 0) continue;
    const v = volumes.get(entrance.volume) as Volume;
    const frame = sideFrame(v, entrance.side, entranceStart(entrance, v), entrance.push);
    // The floor the door opens from: its own block's, on a split level.
    const level = entrance.floor;
    const face: BayFace = { ...frame, z0: level, W: entrance.width, H: 1 };
    const opening = entranceOpening(entrance);
    const n = e.N(face.nx, face.ny);
    const bottom = Math.min(entrance.ground, level) - m(0.4);
    // Every riser the same: the flight spans exactly ground to floor.
    const riser = (level - entrance.ground) / entrance.steps;
    if (entrance.recess > 0) {
      emitRecessedFlight(e, face, opening.a0, opening.a1, entrance, level, bottom, riser, plinth);
      continue;
    }
    const halfW = (opening.a1 - opening.a0 + m(0.5)) / 2;
    for (let j = 0; j < entrance.steps; j++) {
      const top = level - j * riser;
      const d0 = -(j === 0 ? 0 : STEP_RUN * (j + 1));
      const d1 = -STEP_RUN * (j + 2);
      const a0 = entrance.width / 2 - halfW;
      const a1 = entrance.width / 2 + halfW;
      // Front, top and the two cheeks of this step's block.
      e.rect(face, a0, a1, bottom - level, top - level, d1, n, plinth);
      shell.face([e.P(face, a0, top - level, d0), e.P(face, a1, top - level, d0), e.P(face, a1, top - level, d1), e.P(face, a0, top - level, d1)], [0, 0, 1], plinth);
      const tv = e.N(face.tx, face.ty);
      shell.face([e.P(face, a1, bottom - level, d0), e.P(face, a1, bottom - level, d1), e.P(face, a1, top - level, d1), e.P(face, a1, top - level, d0)], tv, plinth);
      shell.face([e.P(face, a0, bottom - level, d1), e.P(face, a0, bottom - level, d0), e.P(face, a0, top - level, d0), e.P(face, a0, top - level, d1)], [-tv[0], -tv[1], 0], plinth);
    }
  }

  // ---- the lot: a paved apron round the base, and a path to the street
  emitLot(e, b, f, groundAt, pavedAt);

  // ---- free elements: stairs, ramps, pillars, canopies, walls, slabs
  const loose = looseParts(b);
  for (const el of b.elements ?? []) {
    // Whatever stands on the building's open lot is laid with the lot.
    if (onLot?.(el) || loose?.has(el.id)) continue;
    // Cut open, what hangs above the cut floor (a clock, a canopy) goes with the floors above.
    if (b.cutaway !== undefined && el.z >= levelElevation(b, b.cutaway + 1) - 1e-6) continue;
    const look = el.material ? paint(el.material) : elementPaint(b, el.kind);
    if (!FOLLOWS_GROUND.has(el.kind)) {
      emitElement(e, el, floor, f.bottom, look);
      continue;
    }
    // On the land: each step of it on the ground under it, its foot below that.
    for (const piece of followPieces(el)) {
      const w = e.L(piece.x, piece.y, 0);
      const ground = groundAt(w[0], w[1]);
      emitElement(e, piece, ground, ground - m(0.3), look);
    }
  }

  // ---- cores: a lift overrun on the highest flat roof over the core (`roofPlan.ts`)
  for (const { volume: best, x0, y0, x1, y1 } of machineRooms(b)) {
    const z = floor + volumeHeight(b, best);
    // The machine room clad in the building's own skin: a white box on every tower top read as a separate thing set on it.
    const skin = best.dress ? wallOf(best, 0) : trim;
    e.box(x0, y0, x1, y1, z, z + m(3), skin.finish === 'glass' ? MACHINE_ROOM : skin, ROOF_PLANT);
  }
  return f;
}

export const MACHINE_ROOM = paint({ finish: 'concrete', colour: 0xa7a49c });

export function fliesFlag(b: Building): boolean {
  return b.volumes.some((v) => (v.roofDetails ?? []).some((d) => (d.kind === 'spire' || d.kind === 'lantern') && flagOf(d) !== null));
}

export function signatureFloorOf(b: Building, naturalAt: GroundAt, pavedAt?: PavedAt): number | undefined {
  if (!drawsSignature(b)) return undefined;
  const resolved = resolveBlocks(b);
  return resolved.volumes.some((v) => !v.open) ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
}

export function letGoEmitted(b: Building): void {
  const closed = closedBlocks(resolveBlocks(b).volumes);
  letGoInterior(closed);
  letGoLayout(closed);
}

export class ShellWriter {
  private readonly shell = new Shell();
  /** The parts' and the furniture's rows, written again the same way. */
  readonly parts = partSink();
  readonly furniture: FurnitureSink = {};
  constructor() { this.shell.reused = true; }
  /** The shell and the rows emptied for the next building. */
  next(): Shell {
    this.shell.clear();
    for (const kind of PART_KINDS) this.parts[kind].clear();
    for (const kind of FURNITURE_KINDS) this.furniture[kind]?.clear();
    return this.shell;
  }
}

export function emitChunk(b: Building, groundAt: GroundAt, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt, slots: SlotAllocator = spaceSeed, far = false, apart = true,
  party?: PartyWalls, writer?: ShellWriter): BuildingChunk {
  const shell = writer ? writer.next() : new Shell();
  shell.decay = b.decay ?? 0;
  shell.far = far;
  shell.apart = apart;
  const parts = writer ? writer.parts : partSink();
  // The blocks as drawn: unions, cuts and intersections resolved, the stored blocks untouched (`world/buildings/blocks.ts`).
  const resolved = resolveBlocks(b);
  // Open blocks are lots: laid on the ground, not built.
  const lots = resolved.volumes.filter((v) => v.open);
  // One list for the blocks: their bays laid out and their floors furnished once (`bayLayout`, `interiorAt`) for every reader and like building.
  const closed = closedBlocks(resolved.volumes);
  const furnished: FurnitureSink = writer ? writer.furniture : {};
  const inLot = (el: BuildingElement): boolean =>
    lots.some((v) => el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d);
  // The terrain is graded from this natural-ground floor.
  const designedFloor = party ? party.floorOf(b) : closed.length > 0 ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
  const flags: FlagInstance[] = [];
  setFlagSink(flags);
  // A signature building's body is drawn with its own parts (`signature.ts`).
  const signature = closed.length > 0 && drawsSignature(b);
  const body = !signature && closed.length > 0
    ? emitBuilding({ ...resolved, volumes: closed }, groundAt, shell, parts, pavedAt, furnished, inLot, designedFloor, slots, party?.coversNear(b))
    : undefined;
  const floor = signature ? designedFloor : body?.floor;
  setFlagSink(null);
  const lotGround = emitLots(resolved, lots, closed.length === 0, groundAt, shell, parts, floor, pavedAt, inLot, body?.entrances);
  const batches = {} as Record<PartKind, PartBatch>;
  for (const kind of PART_KINDS) batches[kind] = parts[kind].batch();
  const shells = shellChunks(shell);
  let furniture: Partial<Record<FurnitureKind, PartBatch>> | undefined;
  for (const kind of FURNITURE_KINDS) {
    const rows = furnished[kind];
    if (!rows || rows.count === 0) continue;
    (furniture ??= {})[kind] = rows.batch();
  }
  const runs = runChunks(shell);
  const laid = runs ? { shells, runs } : { shells };
  const out = furniture ? { ...laid, parts: batches, furniture } : { ...laid, parts: batches };
  const withGround = lotGround ? { ...out, lotGround } : out;
  const withSignature = signature && floor !== undefined ? { ...withGround, signatureFloor: floor } : withGround;
  return flags.length ? { ...withSignature, flags } : withSignature;
}

export function chunkSummary(b: Building, groundAt: GroundAt, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt, party?: PartyWalls): Pick<BuildingChunk, 'flags' | 'lotGround' | 'signatureFloor'> {
  const resolved = resolveBlocks(b);
  if (fliesFlag(resolved)) return emitChunk(b, groundAt, pavedAt, naturalAt, undefined, false, true, party);
  const lots = resolved.volumes.filter((v) => v.open);
  const closed = closedBlocks(resolved.volumes);
  const floor = party ? party.floorOf(b) : closed.length > 0 ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
  const signature = closed.length > 0 && drawsSignature(b);
  let lotGround: LotGround | undefined;
  if (lots.length === 0) lotGround = lotGroundOf(resolved, [], floor, false);
  else {
    // The level `emitLots` lays the lots at: the building's floor, else the highest ground of the lots a little over.
    let level = floor;
    if (level === undefined) {
      const f = buildingFrame(resolved);
      let top = -Infinity;
      for (const v of lots) {
        for (const q of localFootprint(v)) top = Math.max(top, groundAt(frameX(f, q.x, q.y), frameY(f, q.x, q.y)));
        top = Math.max(top, groundAt(frameX(f, v.x + v.w / 2, v.y + v.d / 2), frameY(f, v.x + v.w / 2, v.y + v.d / 2)));
      }
      level = top + m(0.12);
    }
    lotGround = lotGroundOf(resolved, lotSurfaces(resolved, level, pavedAt), level, true);
  }
  const out = lotGround ? { lotGround } : {};
  return signature && floor !== undefined ? { ...out, signatureFloor: floor } : out;
}

export const shellChunkOf = (part: ShellPart, copy: boolean): ShellChunk => (copy
  ? { position: part.position.copy(), normal: part.normal.copy(), paint: part.paint.copy(), index: part.index.copy() }
  : { position: part.position.view(), normal: part.normal.view(), paint: part.paint.view(), index: part.index.view() });

export function shellChunks(shell: Shell): Partial<Record<Finish, ShellChunk>> {
  const shells: Partial<Record<Finish, ShellChunk>> = {};
  for (const finish of shell.order) { const part = shell.parts.get(finish)!; if (part.index.length > 0) shells[finish] = shellChunkOf(part, shell.reused); }
  return shells;
}

export function runChunks(shell: Shell): Partial<Record<Finish, RunChunk>> | undefined {
  let runs: Partial<Record<Finish, RunChunk>> | undefined;
  for (const finish of shell.runOrder) {
    const part = shell.runs.get(finish)!;
    if (part.index.length === 0 || !part.facade || !part.grid || !part.opening) continue;
    (runs ??= {})[finish] = shell.reused
      ? { ...shellChunkOf(part, true), facade: part.facade.copy(), grid: part.grid.copy(), opening: part.opening.copy() }
      : { ...shellChunkOf(part, false), facade: part.facade.view(), grid: part.grid.view(), opening: part.opening.view() };
  }
  return runs;
}

export const SHELL_PART_MATRIX = new Float32Array(16);

export function shellPartFaces(parts: Readonly<Record<PartKind, PartBatch>>): Partial<Record<Finish, ShellChunk>> {
  const shell = new Shell();
  for (const kind of SHELL_PART_KINDS) {
    const batch = parts[kind];
    if (!batch?.count || !batch.looks || !batch.colours) continue;
    const { poses, colours, looks } = batch;
    const e = SHELL_PART_MATRIX, o = 0;
    for (let i = 0; i < batch.count; i++) {
      // The instance's matrix as the GPU makes it from its pose (`partPose.ts`).
      poseMatrixInto(poses, i * POSE_FLOATS, e, 0);
      const sx = poses[i * POSE_FLOATS + 5]!, sz = poses[i * POSE_FLOATS + 7]!;
      // A model point (three's axes) through the matrix, then into the map's (x, y north, z up).
      const at = (x: number, y: number, z: number, w: number): V3 => {
        const X = e[o]! * x + e[o + 4]! * y + e[o + 8]! * z + e[o + 12]! * w;
        const Y = e[o + 1]! * x + e[o + 5]! * y + e[o + 9]! * z + e[o + 13]! * w;
        const Z = e[o + 2]! * x + e[o + 6]! * y + e[o + 10]! * z + e[o + 14]! * w;
        return [X, -Z, Y];
      };
      const ground = looks[i * LOOK_FLOATS + 2]!;
      shell.decay = looks[i * LOOK_FLOATS + 1]!;
      shell.ground = ground > NO_GROUND / 2 ? ground : Number.NaN;
      const paint: Paint = { rgb: [colours[i * 3]!, colours[i * 3 + 1]!, colours[i * 3 + 2]!], finish: FINISHES[looks[i * LOOK_FLOATS]!]! };
      for (const f of SHELL_PART_FACES[kind]) {
        const points = f.points.map(([u, v, w]): V3 => {
          // A paving's side stands in from its top's edge by `COVER_INSET`, whatever its size.
          const x = f.inset ? Math.sign(u) * Math.max(0.5 - COVER_INSET / sx, 0) : u;
          const z = f.inset ? Math.sign(-v) * Math.max(0.5 - COVER_INSET / sz, 0) : -v;
          return at(x, w, z, 1);
        });
        shell.face(points, at(f.n[0], f.n[2], -f.n[1], 0), paint);
      }
    }
  }
  return shellChunks(shell);
}

export function withShellParts(chunk: BuildingChunk): BuildingChunk {
  const laid = shellPartFaces(chunk.parts);
  const shells: Partial<Record<Finish, ShellChunk>> = { ...chunk.shells };
  for (const [finish, add] of Object.entries(laid) as [Finish, ShellChunk][]) {
    const was = shells[finish];
    if (!was) { shells[finish] = add; continue; }
    const base = was.position.length / 3;
    // `b` after `a` (a part's faces are never a run of bays: the runs stay as they were).
    const joined = <T extends Float32Array | Int16Array | Uint16Array>(a: T, b: T, make: (n: number) => T): T => {
      const out = make(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    };
    const index = new Uint32Array(was.index.length + add.index.length);
    index.set(was.index);
    for (let k = 0; k < add.index.length; k++) index[was.index.length + k] = add.index[k]! + base;
    shells[finish] = {
      position: joined(was.position, add.position, (n) => new Float32Array(n)),
      normal: joined(was.normal, add.normal, (n) => new Int16Array(n)),
      paint: joined(was.paint, add.paint, (n) => new Uint16Array(n)),
      index,
    };
  }
  const none: PartBatch = { poses: new Float32Array(0), colours: new Float32Array(0), count: 0, looks: new Float32Array(0) };
  const parts = { ...chunk.parts } as Record<PartKind, PartBatch>;
  for (const kind of SHELL_PART_KINDS) parts[kind] = none;
  return { ...chunk, shells, parts };
}

export const KIT_BOXES = new WeakMap<BuildingKit, KitBoxes>();

export function kitBoxes(kit: BuildingKit): KitBoxes {
  let boxes = KIT_BOXES.get(kit);
  if (!boxes) {
    const boxOf = (g: BufferGeometry): number[] => {
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox!;
      return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
    };
    const furniture = kit.furniture();
    boxes = {
      parts: Object.fromEntries(PART_KINDS.map((kind) => [kind, boxOf(kit.geometry[kind])])) as Record<PartKind, number[]>,
      furniture: Object.fromEntries(FURNITURE_KINDS.map((kind) => [kind, boxOf(furniture.geometry[kind])])) as Record<FurnitureKind, number[]>,
    };
    KIT_BOXES.set(kit, boxes);
  }
  // The bandings as the kit's levels are now: a small prop's simplified levels come in once loaded.
  return { ...boxes, bandings: partBandings(kit.screen) };
}

export const WHOLE: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS, shells: true, furniture: true };

export function assembleBuildingMeshes(
  chunks: readonly BuildingChunk[],
  kit: BuildingKit,
  ghost = false,
  dim = false,
  selection?: AssemblySelection,
): BuildingMeshes {
  const take: CellSelection = { ...WHOLE, ...(selection ? { parts: [...selection.parts], shells: selection.shells, furniture: selection.furniture } : {}), ghost, dim };
  // A lost and restored WebGL context fills the meshes again from the chunks (`gpuOnly.ts`).
  return meshesOf(cellArrays(chunks, take, kitBoxes(kit)), kit, ghost, dim, () => cellArrays(chunks, take, kitBoxes(kit)));
}

export function meshesOf(arrays: CellArrays, kit: BuildingKit, ghost: boolean, dim: boolean, refill?: () => CellArrays): BuildingMeshes {
  const group = new Group();
  group.name = ghost ? 'building-preview' : 'buildings';
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  const meshes: (Mesh | InstancedMesh)[] = [];
  let triangles = 0;

  // A restored context refills every piece from one batch made again, not one per piece (`gpuOnly.ts` `refillArrays` runs them in one go).
  let again: CellArrays | null = null;
  const refilled = (): CellArrays | null => {
    if (!again && refill) {
      again = refill();
      queueMicrotask(() => { again = null; });
    }
    return again;
  };
  // Every finish of a piece in one geometry, one draw: each vertex's finish picks its layer of the maps (`finishes.ts`).
  arrays.shells.forEach((shell, piece) => {
    const g = new BufferGeometry();
    // DO NOT wrap them in a Float32BufferAttribute or Uint32BufferAttribute: those copy the array they are given
    // Floats, or on the cell's grid: four unsigned shorts read normalised, the mesh's matrix putting them in place (`cellArrays.ts` `ShellGrid`).
    const place = shell.place;
    g.setAttribute('position', place ? new BufferAttribute(shell.position, 4, true) : new BufferAttribute(shell.position, 3));
    // Two signed shorts a vertex, the normal octahedral: unfolded by the shell's program (`finishes.ts` `SHELL_NORMAL`).
    const normal = new BufferAttribute(shell.normal, NORMAL_SHORTS, true);
    g.setAttribute(SHELL_NORMAL, normal);
    // Four unsigned shorts, normalised: the paint, and the finish id with the wear; the uv is the shader's (`finishes.ts`).
    g.setAttribute(PAINT_ATTRIBUTE, new BufferAttribute(shell.paint, 4, true));
    // The far level's window grid and openings, for its shader (`facadeLevel.ts`).
    const opening = shell.opening ? new InterleavedBuffer(shell.opening, FACADE_BYTES) : null;
    let far: { facade: BufferAttribute; grid: BufferAttribute; opening: InterleavedBuffer } | null = null;
    if (shell.facade && shell.grid && opening) {
      // The bay's width and storey's height in half floats: HALF_FLOAT where the attribute says so (r186 `WebGLAttributes.createBuffer`).
      far = { facade: Object.assign(new BufferAttribute(shell.facade, FACADE_FLOATS), { isFloat16BufferAttribute: true }), grid: new BufferAttribute(shell.grid, FACADE_GRID), opening };
      g.setAttribute('facadeSize', far.facade);
      g.setAttribute('facadeCell', far.grid);
      g.setAttribute('facadeOpening', new InterleavedBufferAttribute(opening, 4, 0, true));
      g.setAttribute('facadeTrim', new InterleavedBufferAttribute(opening, 4, 4, true));
    }
    g.setIndex(new BufferAttribute(shell.index, 1));
    // One Mesh a piece, its arrays let go once on the GPU (below).
    // The bounds in the mesh's own frame: on a grid, its points over its step from its origin.
    g.boundingBox = place ? boxOf(gridBounds(shell.bounds, place)) : boxOf(shell.bounds);
    g.boundingSphere = place ? sphereOf(gridBounds(shell.bounds, place)) : sphereOf(shell.bounds);
    const mesh = new Mesh(g, ghost ? kit.ghostShell : dim ? kit.dimShell : far ? kit.facade : kit.shellMaterial);
    if (place) {
      mesh.position.set(place.x, place.y, place.z);
      mesh.scale.setScalar(place.step * 65535);
    }
    // The town's shells live on the GPU only: their arrays are let go once uploaded
    if (!ghost) {
      const kept = {
        position: g.attributes.position as BufferAttribute, normal, paint: g.attributes[PAINT_ATTRIBUTE] as BufferAttribute, index: g.index!, ...(far ?? {}),
      };
      gpuOnlyAttributes(mesh, kept, () => {
        // The same chunks make the same pieces in the same order.
        const same = refilled()?.shells[piece];
        return same ? {
          position: same.position, normal: same.normal, paint: same.paint, index: same.index,
          ...(same.facade && same.grid && same.opening ? { facade: same.facade, grid: same.grid, opening: same.opening } : {}),
        } : {};
      });
    }
    mesh.name = ghost ? 'building-preview-shell' : SHELL_MESH;
    mesh.castShadow = !ghost;
    mesh.receiveShadow = !ghost;
    meshes.push(mesh);
    triangles += shell.index.length / 3;
  });

  for (const kind of PART_KINDS) {
    const part = arrays.parts[kind];
    if (!part) continue;
    const { count } = part;
    // Window panes carry their room's light slot, per instance, on their own copy of the pane geometry
    const glassy = part.litSlot !== undefined;
    // And the shell's parts their finish, wear and ground (`shellParts.ts`).
    const looked = part.looks !== undefined;
    // The kit's model with this batch's poses (`partPose.ts`): its own attributes shared, never copied.
    const poseBuffer = new InstancedInterleavedBuffer(part.poses, POSE_FLOATS);
    const geometry = posedCopy(kit.geometry[kind], poseBuffer);
    let roomBuffer: InstancedInterleavedBuffer | null = null;
    if (glassy) {
      geometry.setAttribute('litSlot', new InstancedBufferAttribute(part.litSlot!, 1));
      // And the room behind each, for the interior drawn through it (`kit.ts`).
      roomBuffer = new InstancedInterleavedBuffer(part.rooms!, ROOM_FLOATS);
      // Half floats: three uploads a Uint16Array as HALF_FLOAT where its buffer says so (r186 `WebGLAttributes.createBuffer`, an interleaved attribute by its buffer).
      (roomBuffer as InstancedInterleavedBuffer & { isFloat16BufferAttribute: boolean }).isFloat16BufferAttribute = true;
      geometry.setAttribute('roomA', new InterleavedBufferAttribute(roomBuffer, 4, 0));
      geometry.setAttribute('roomB', new InterleavedBufferAttribute(roomBuffer, 4, 4));
      geometry.setAttribute('roomC', new InterleavedBufferAttribute(roomBuffer, 4, 8));
    }
    const lookBuffer = looked ? new InstancedInterleavedBuffer(part.looks!, LOOK_FLOATS) : null;
    if (lookBuffer) {
      geometry.setAttribute(FINISH_ATTRIBUTE, new InterleavedBufferAttribute(lookBuffer, 1, 0));
      geometry.setAttribute('aDecay', new InterleavedBufferAttribute(lookBuffer, 1, 1));
      geometry.setAttribute(GROUND_ATTRIBUTE, new InterleavedBufferAttribute(lookBuffer, 1, 2));
    }
    // Faded, each kind as `fade.ts` fades it: the shell's parts with the shell. No matrix of three's (`posePart`): the poses are the instances.
    const material = ghost ? kit.ghostParts : partLook(kit, kind, dim).material;
    const mesh = new InstancedMesh(geometry, material, 0);
    mesh.count = count;
    mesh.userData['posedFrom'] = kit.geometry[kind];
    mesh.name = `building-${kind}${ghost ? '-preview' : ''}`;
    mesh.castShadow = !ghost && kit.castsShadow.has(kind);
    if (mesh.castShadow) mesh.customDepthMaterial = partPoseDepth(material);
    mesh.receiveShadow = !ghost;
    // Tints in half floats: HALF_FLOAT where the attribute says so (r186 `WebGLAttributes.createBuffer`).
    if (part.instanceColor) mesh.instanceColor = Object.assign(new InstancedBufferAttribute(part.instanceColor, 3), { isFloat16BufferAttribute: true });
    mesh.boundingBox = boxOf(part.bounds);
    mesh.boundingSphere = sphereOf(part.bounds);
    // DO NOT let go of the kit's model it draws: it is shared by every batch of the kind; only its own instance buffers go.
    if (!ghost) {
      const own: Record<string, BufferAttribute | InstancedInterleavedBuffer> = { poses: poseBuffer };
      if (mesh.instanceColor) own.instanceColor = mesh.instanceColor;
      if (glassy) {
        own.litSlot = geometry.getAttribute('litSlot') as BufferAttribute;
        own.rooms = roomBuffer!;
      }
      if (lookBuffer) own.looks = lookBuffer;
      gpuOnlyAttributes(mesh, own, () => {
        const again = refill?.().parts[kind];
        if (!again) return {};
        const out: Record<string, ArrayLike<number>> = { poses: again.poses };
        if (again.instanceColor) out.instanceColor = again.instanceColor;
        if (glassy) {
          out.litSlot = again.litSlot!;
          out.rooms = again.rooms!;
        }
        if (looked) out.looks = again.looks!;
        return out;
      });
    }
    meshes.push(mesh);
    const g = kit.geometry[kind];
    triangles += ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * count;
  }
  // Furniture, only where an interior is drawn: one batch per kind.
  // DO NOT read `arrays` in a closure here: V8 would keep it in this function's context, held by every closure of the batch (`setVisible`, the refills), and every cell's CPU arrays would outlive their upload.
  const pieces = arrays.furniture;
  const furnished: FurnitureKind[] = [];
  for (const kind of FURNITURE_KINDS) if (pieces[kind]) furnished.push(kind);
  if (furnished.length) {
    const furniture = kit.furniture();
    for (const kind of furnished) {
      const piece = pieces[kind]!;
      const poseBuffer = new InstancedInterleavedBuffer(piece.poses, POSE_FLOATS);
      const material = dim ? kit.dimParts : furniture.material;
      const mesh = new InstancedMesh(posedCopy(furniture.geometry[kind], poseBuffer), material, 0);
      mesh.count = piece.count;
      mesh.userData['posedFrom'] = furniture.geometry[kind];
      mesh.name = `building-furniture-${kind}`;
      mesh.castShadow = true;
      mesh.customDepthMaterial = partPoseDepth(material);
      mesh.receiveShadow = true;
      // Faded, white instance colours as every faded part has (`cellArrays.ts`): one program variant of `dimParts`.
      if (dim) mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(piece.count * 3).fill(1), 3);
      mesh.boundingBox = boxOf(piece.bounds);
      mesh.boundingSphere = sphereOf(piece.bounds);
      // On the GPU only, made again from the chunks (`mesh/gpuOnly.ts`).
      gpuOnlyAttributes(mesh, { poses: poseBuffer }, () => {
        const again = refill?.().furniture[kind];
        return again ? { poses: again.poses } : {};
      });
      meshes.push(mesh);
      const g = furniture.geometry[kind];
      triangles += ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * piece.count;
    }
  }
  // Shell vertices and part instance matrices are already in world space.
  for (const mesh of meshes) {
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  return {
    group,
    triangles,
    setVisible(visible) {
      group.visible = visible;
    },
    dispose() {
      for (const mesh of meshes) {
        // The shell geometry is this build's own; the part geometries are the kit's.
        if (mesh instanceof InstancedMesh) {
          // A part's posed copy of the kit's model: its own buffers freed, the model's kept (`partPose.ts`).
          letGoPosed(mesh.geometry, mesh.userData['posedFrom'] as BufferGeometry);
          mesh.dispose();
        } else mesh.geometry.dispose();
      }
      group.clear();
    },
  };
}

export function gridBounds(b: Bounds, grid: ShellGrid): Bounds {
  const span = grid.step * 65535;
  const at = (v: number, o: number): number => (v - o) / span;
  return Float64Array.of(at(b[0]!, grid.x), at(b[1]!, grid.y), at(b[2]!, grid.z), at(b[3]!, grid.x), at(b[4]!, grid.y), at(b[5]!, grid.z), at(b[6]!, grid.x), at(b[7]!, grid.y), at(b[8]!, grid.z), b[9]! / span);
}

export const boxOf = (b: Bounds): Box3 => new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));

export const sphereOf = (b: Bounds): Sphere => new Sphere(new Vector3(b[6], b[7], b[8]), b[9]);

export function buildBuildingMeshes(
  buildings: Iterable<Building>,
  groundAt: GroundAt,
  kit: BuildingKit,
  ghost = false,
  pavedAt?: PavedAt,
  naturalAt: GroundAt = groundAt,
): BuildingMeshes {
  return assembleBuildingMeshes([...buildings].map((b) => emitChunk(b, groundAt, pavedAt, naturalAt)), kit, ghost);
}

export type { BuildingChunk, LotGround, LotGroundRecipe, PartBatch,  } from './chunk.ts';
export { COLOURED_PARTS } from './cellArrays.ts';

export { FLAT_DEPTH } from './meshCore.ts';
export type { SlotAllocator } from './meshCore.ts';
export { lotGroundAgain } from './lotMesh.ts';
export { interiorFurniture } from './interiorMesh.ts';
