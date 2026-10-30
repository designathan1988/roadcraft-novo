// The people table's layout (src/sim/peds.ts owns the table): its columns, and the waypoints each person keeps.
// Its own module so the pedestrian modules (peds.ts, pedCrowd.ts) read it without importing each other.

import { idColumn, type SegId } from '../core/ids.ts';

/** Waypoints kept per person (`ways`: 4 numbers each). */
export const WAYS = 12;

export const pedSchema = {
  // route
  rLen: Uint8Array, rIdx: Uint8Array,
  // the network edit (SimNet.epoch) its route was planned at
  repoch: Uint32Array,
  // current segment (sidewalk): from da to db metres from node a, on side `side` (+1 = u+)
  seg: idColumn<SegId>(), side: Int8Array, da: Float32Array, db: Float32Array,
  // current step: 0 sidewalk, 1 straight line between points, 2 waiting
  mode: Uint8Array, wIdx: Uint8Array, wLen: Uint8Array,
  // its place to wait at a kerb (`waitSpot`): 0 none, 1 walking to it, 2 standing there; where it is
  spotSt: Uint8Array, sx: Float32Array, sz: Float32Array,
  t0: Float64Array, dur: Float32Array, at: Float64Array,
  // node it is walking to (window list)
  node: Int32Array, next: Int32Array, prev: Int32Array,
  speed: Float32Array, color: Uint8Array,
  // appearance id (16 bits) for the people renderer: drawn when the pedestrian is born, published at pose index 10
  look: Uint16Array,
  // last published position (for interpolation) and the publication it was in; `pyaw` is the heading it stands with
  // (waiting, standing), `syaw` the body's heading as last published (it turns at a person's rate, `writePoses`)
  px: Float32Array, py: Float32Array, pz: Float32Array, pyaw: Float32Array, syaw: Float32Array, has: Uint8Array, wf: Uint32Array,
  // bus trip: line (-1 = on foot only), boarding stop and alighting stop, and the boarding stop on the sidewalk
  tLine: Int16Array, tFrom: Uint8Array, tTo: Uint8Array, tx: Float32Array, tz: Float32Array,
  // by bicycle (rides on the bike lane)
  bike: Uint8Array,
  // where it enters the first sidewalk segment (0-1; someone leaving a door enters mid-way)
  enter: Float32Array,
  // near the camera (`seeEachOther`): the step aside (m, + = right), where it is heading, and how long it has held its pace
  lat: Float32Array, latT: Float32Array, hold: Float32Array,
  // its speed now (near the camera), and when it last chose its stripe
  vNow: Float32Array, aimAt: Float64Array,
  // and the share of its pace it walked in the last step (1 = free)
  pace: Float32Array,
  // the first point of the corner after this sidewalk stretch (`aheadPoint`): 0 not worked out yet, 1 known, 2 none
  ax: Float32Array, az: Float32Array, aOk: Uint8Array,
};
