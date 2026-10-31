// The page's link to the simulation worker: the network's changes go as one batch a frame, the whole network again
// when the worker's mirror failed to apply one, and on their own timers the demand (every 2 s), the camera (every
// 250 ms) and the doors and loading docks near the camera (every 3 s, when the camera moved 80 m or the city changed).
// The worker itself and the routing of its answers stay with the game (they reach many parts of it).

import { asNode, asSeg } from '../core/ids.ts';
import type { NetOp } from '../roads/network.ts';
import { Zone } from '../roads/zones.ts';
import { encodeOps } from '../sim/lanes.ts';
import type { ToSim } from '../sim/worker.ts';
import { demandFactor } from '../ui/readouts.ts';
import { lotToWorld } from '../world/lotEdit.ts';
import type { World } from '../world/world.ts';

export interface SimLinkHost {
  readonly world: World;
  /** Where the camera looks: the simulation's window follows it. */
  target(): { readonly x: number; readonly z: number };
  /** The city's hour (the demand's time of day). */
  hour(): number;
  /** The player's demand, traffic and people choices (undefined before the preferences are read). */
  demandChoice(): { demand?: string; traffic?: number; people?: number } | undefined;
  /** Bus lines exist: a change to the segments moves their stops (the lines are sent again). */
  hasLines(): boolean;
}

export class SimLink {
  private readonly h: SimLinkHost;
  private readonly worker: Worker;
  /** The network's changes since the last frame (`queue`). */
  private readonly ops: NetOp[] = [];
  /** Bumped when the roads the bus stops stand on changed: the lines are sent again. */
  private version = 0;
  private demandAt = 0;
  private camAt = 0;
  private doorsAt = 0;
  private doorsFrom = { x: Infinity, z: Infinity, count: -1 };

  constructor(host: SimLinkHost, worker: Worker) {
    this.h = host;
    this.worker = worker;
  }

  /** A change of the network (the game's road listener): it goes in the next batch. */
  queue(op: NetOp): void { this.ops.push(op); }

  /** The roads' version for the bus lines (`LinesSync.sync`). */
  get roadsVersion(): number { return this.version; }
  /** When the demand was last sent (ms; 0 = to be sent at the next frame). */
  get demandSentAt(): number { return this.demandAt; }

  /** The player changed the simulation's settings: the demand goes at the next frame. */
  demandNow(): void { this.demandAt = 0; }

  /**
   * The simulation's mirror of the network failed to apply a change: send it the whole network again (a 'clear', then
   * every node, segment and junction; pending changes are already in it). Its vehicles start over, and the flow-based
   * controls it had chosen are forgotten on both sides.
   */
  resync(reason: string): void {
    const net = this.h.world.roads, nc = net.nodes.cols, ops: NetOp[] = [{ t: 'clear' }];
    for (let i = 0; i < net.nodes.end; i++) { const n = asNode(i); if (net.nodes.alive[n]) ops.push({ t: 'addNode', rec: { id: n, x: nc.x[n], z: nc.z[n], y: nc.y[n] } }); }
    for (let i = 0; i < net.segs.end; i++) { const s = asSeg(i); if (net.segs.alive[s]) ops.push({ t: 'addSeg', rec: net.segRec(s) }); }
    for (const [id, spec] of net.junctions) ops.push({ t: 'junction', id, spec });
    for (const id of [...net.flow.keys()]) net.setFlow(id, 0);
    this.ops.length = 0;
    const extra: string[] = [];
    const enc = encodeOps(ops, extra);
    this.worker.postMessage({ type: 'ops', ops: enc, extra } satisfies ToSim, [enc.buffer]);
    this.version++;
    console.error('simulation: the whole network sent again', reason);
  }

  /** Sends the network changes, and on their timers the demand, the camera and the doors (`now`: ms). */
  sync(now: number): void {
    if (this.ops.length) {
      // the stops follow the roads: resend the lines only when segments changed (a zone dab or a junction control does not)
      if (this.h.hasLines() && this.ops.some((op) => op.t === 'addSeg' || op.t === 'remSeg' || op.t === 'profile' || op.t === 'clear')) this.version++;
      const extra: string[] = [];
      const ops = encodeOps(this.ops, extra);
      this.ops.length = 0;
      this.worker.postMessage({ type: 'ops', ops, extra } satisfies ToSim, [ops.buffer]);
    }
    if (now - this.demandAt > 2000) {
      this.demandAt = now;
      const st = this.h.demandChoice();
      this.worker.postMessage({ type: 'demand', hour: this.h.hour(), demand: demandFactor(st?.demand), traffic: st?.traffic ?? 1, people: st?.people ?? 1 } satisfies ToSim);
    }
    if (now - this.camAt > 250) {
      this.camAt = now;
      const t = this.h.target();
      this.worker.postMessage({ type: 'camera', x: t.x, z: t.z } satisfies ToSim);
    }
    if (now - this.doorsAt > 3000) this.sendDoors(now);
  }

  /**
   * Doors of the buildings near the camera (roadcraft `lotDoors`): the middle of the lot's front, facing the road.
   * Pedestrians spawned there walk out of them to the sidewalk. Only when the camera moved 80 m or the city changed.
   */
  private sendDoors(now: number): void {
    this.doorsAt = now;
    const t = this.h.target(), w = this.h.world, col = w.buildings.cols;
    const moved = Math.hypot(t.x - this.doorsFrom.x, t.z - this.doorsFrom.z) > 80;
    if (!moved && w.buildings.size === this.doorsFrom.count) return;
    this.doorsFrom = { x: t.x, z: t.z, count: w.buildings.size };
    const R = 450, pts: number[] = [], docks: number[] = [];
    w.buildingIndex.query(t.x - R, t.z - R, t.x + R, t.z + R, (id) => {
      if (pts.length >= 6000 || col.floors[id] === 0) return;
      const k = col.d[id] / 2 - 0.3, s = Math.sin(col.rot[id]), c = Math.cos(col.rot[id]);
      pts.push(col.x[id] + s * k, col.z[id] + c * k);
      // warehouse loading dock (trucks back into it): inside the gate, lot frame (−w/2 + 10, d/2 − 6), facing the street
      if (col.zone[id] === Zone.Industrial && docks.length < 1500) {
        const [dx, dz] = lotToWorld({ x: col.x[id], z: col.z[id], rot: col.rot[id] }, -col.w[id] / 2 + 10, col.d[id] / 2 - 6);
        docks.push(dx, dz, col.rot[id]);
      }
    });
    const arr = new Float32Array(pts), dk = new Float32Array(docks);
    this.worker.postMessage({ type: 'doors', pts: arr } satisfies ToSim, [arr.buffer]);
    this.worker.postMessage({ type: 'docks', pts: dk } satisfies ToSim, [dk.buffer]);
  }
}
