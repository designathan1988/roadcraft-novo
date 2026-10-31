// Part of the R40 building mesh pipeline (split by responsibility).
import { resolveBlocks } from '../../world/buildings/blocks.ts';
import { deriveSpaces } from '../../world/buildings/spaces.ts';
import { spaceSeed } from './lightSlots.ts';
import { letGoLayout, bayWidth, closedBlocks, coveredSpans, facadeBays, levelElevation, levelHeight, projectionRect, volumeElevation, volumeHeight, volumeLift } from '../../world/buildings/geometry.ts';
import { FURNITURE_KINDS, type Furniture, type FurnitureKind, interiorAt, letGoInterior } from '../../world/buildings/interior.ts';
import { roomsOfStorey } from './roomBehind.ts';
import { Color } from 'three/webgpu';
import { edgeFrame } from '../../world/buildings/footprints.ts';
import { m } from '../../world/units.ts';
import { PART_KINDS, type PartKind } from './kit.ts';
import { type Entrance, type Foundation, type GroundAt, type PavedAt, PLINTH_BURY, STEP_RUN, foundationOf, floorHeight } from '../../world/buildings/foundation.ts';
import { type Finish, paletteOf, plinthMaterial, roofMaterial, trimMaterial, wallMaterial } from '../../world/buildings/materials.ts';
import { FOLLOWS_GROUND, followPieces } from '../../world/buildings/elements.ts';
import { type BayComponent, type Building, type BuildingElement, type FaceId, type Volume, volumeTop } from '../../world/buildings/types.ts';
import { machineRooms } from './roofPlan.ts';
import type { FlagInstance } from './flagLayer.ts';
import type { BuildingChunk, PartBatch, RunChunk, ShellChunk } from './chunk.ts';
import { type Cover, type PartyWalls, hiddenByCovers } from './partyWalls.ts';
import { Shell, Emitter, bayKey, openingOf, REVEAL, paint, shaded, sideFrame, PLINTH_RISE, PLINTH_GROW, sideFrameInto, FLAT_DEPTH, slotOfBay, BAND_OUT, BAND_H, ROOF_PLANT, partSink, setFlagSink, ShellPart, type PartSink, type FurnitureSink, type SlotAllocator, type Opening, type Paint, type V3, type BayFace } from './meshCore.ts';
import { emitPlinth, streakOf, emitBay, emitFacadeRuns, emitRelief, emitRecessedFlight, type FarBay } from './facadeEmit.ts';
import { bothCovered, band, flushBand, emitRoof, emitRoofDetails } from './roofMesh.ts';
import { emitInterior } from './interiorMesh.ts';
import { emitLots } from './lotMesh.ts';
import { emitLot, looseParts, elementPaint, emitElement } from './elementMesh.ts';


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
  /** Whether the panes' rooms and light slots are worked out (the room behind each pane, ray cast through the plan;
   *  a slot per space): only for a reader of them. Roadcraft 5 reads neither (its panes map their rooms in the
   *  shader): the furnishing of every floor and a ray cast per pane were done for nothing, per lot per job. */
  rooms = true,
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
      e.slot = rooms ? slotOfBay(b, v, bay, spacesOf, slots) : -1;
      if (rooms && b.id >= 0 && b.cutaway === undefined) {
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

export function letGoEmitted(b: Building): void {
  const closed = closedBlocks(resolveBlocks(b).volumes);
  letGoInterior(closed);
  letGoLayout(closed);
}


export function emitChunk(b: Building, groundAt: GroundAt, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt, slots: SlotAllocator = spaceSeed, far = false, apart = true,
  party?: PartyWalls, rooms = true): BuildingChunk {
  const shell = new Shell();
  shell.decay = b.decay ?? 0;
  shell.far = far;
  shell.apart = apart;
  const parts = partSink();
  // The blocks as drawn: unions, cuts and intersections resolved, the stored blocks untouched (`world/buildings/blocks.ts`).
  const resolved = resolveBlocks(b);
  // Open blocks are lots: laid on the ground, not built.
  const lots = resolved.volumes.filter((v) => v.open);
  // One list for the blocks: their bays laid out and their floors furnished once (`bayLayout`, `interiorAt`) for every reader and like building.
  const closed = closedBlocks(resolved.volumes);
  const furnished: FurnitureSink = {};
  const inLot = (el: BuildingElement): boolean =>
    lots.some((v) => el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d);
  // The terrain is graded from this natural-ground floor.
  const designedFloor = party ? party.floorOf(b) : closed.length > 0 ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
  const flags: FlagInstance[] = [];
  setFlagSink(flags);
  const body = closed.length > 0
    ? emitBuilding({ ...resolved, volumes: closed }, groundAt, shell, parts, pavedAt, furnished, inLot, designedFloor, slots, party?.coversNear(b), rooms)
    : undefined;
  const floor = body?.floor;
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
  return flags.length ? { ...withGround, flags } : withGround;
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


export { interiorFurniture } from './interiorMesh.ts';
