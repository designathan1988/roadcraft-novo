// The demolition feature's one entry for the page: the explosion's effect (blast/), the buildings that break (ruin/)
// and the bomb itself (bomb.ts), made once, compiled at load and stepped every frame at a fixed cost. game.ts only
// wires it.

import * as THREE from 'three/webgpu';
import type { Command } from '../../core/commands.ts';
import type { World } from '../../world/world.ts';
import { heightAt } from '../../world/heights.ts';
import { t } from '../../shared/i18n/index.ts';
import type { ToSim } from '../../sim/worker.ts';
import { Blast } from './blast/blast.ts';
import { struckItem, throwItem, throwVehicle } from './blast/thrown.ts';
import { Ruins } from './ruin/ruins.ts';
import { buildingDown, dropBomb } from './bomb.ts';

export interface DemolitionHost {
  world: World;
  /** The building parts' unit models, built once by the props pool (render/props.ts PropRenderer.partModels). */
  partModels: Readonly<Record<string, THREE.BufferGeometry>>;
  /** The vehicles' bodies by model and the ones near a point (render/vehicles.ts). */
  vehicles: { wreckModels: THREE.BufferGeometry[]; vehiclesNear(x: number, z: number, r: number, out: number[]): number };
  /** A burst of particles (render/particles.ts Particles.burst). */
  burst(x: number, y: number, z: number, kind: number, strength: number, seconds: number): void;
  push(cmd: Command): void;
  sim: { postMessage(msg: ToSim): void };
  hud: { toast(text: string): void };
  ambient: { sfx(kind: 'boom'): void };
  flash: { value: number };
}

export class Demolition {
  readonly group = new THREE.Group();
  readonly blast: Blast;
  readonly ruins: Ruins;
  private host: DemolitionHost;

  constructor(host: DemolitionHost) {
    this.host = host;
    const groundAt = (x: number, z: number) => heightAt(host.world.heights, x, z);
    this.blast = new Blast(host.vehicles.wreckModels, host.burst, groundAt);
    this.ruins = new Ruins({
      world: host.world,
      partModels: host.partModels,
      emit: host.burst,
      burn: (x, y, z, size, seconds) => this.blast.burn(x, y, z, size, seconds),
      down: (id) => {
        buildingDown(host.world, id, host.push, (b) => this.ruins.forget(b));
        host.hud.toast(t('game.toast.bombDown'));
      },
    });
    this.group.add(this.blast.group, this.ruins.draw.group);
  }

  /** A bomb of `force` on the ground point (x, z) under the pointer, seen from `eye`. */
  bomb(x: number, z: number, force: number, eye: { x: number; y: number; z: number }, setHitKind: (k: 'bomb') => void): void {
    const h = this.host;
    dropBomb({
      world: h.world, push: h.push, blast: this.blast, ruins: this.ruins, eye,
      thrown: {
        item: (type, ix, g, iz, bx, bz, r) => throwItem(this.blast, type, ix, g, iz, bx, bz, r),
        struck: struckItem,
        vehicle: (model, vx, vy, vz, yaw, paint, bx, bz, r) => throwVehicle(this.blast, model, vx, vy, vz, yaw, paint, bx, bz, r),
      },
      vehiclesNear: (vx, vz, r, out) => h.vehicles.vehiclesNear(vx, vz, r, out),
      sim: h.sim, hud: h.hud, ambient: h.ambient, flash: h.flash, force, setHitKind,
    }, x, z);
  }

  update(dt: number): void { this.blast.update(dt); this.ruins.update(dt); }
  /** How far the camera is shaken now (m). */
  shake(): number { return this.blast.shake(); }
  /** Anything moving, flashing or burning: the frame is drawn while it is. */
  active(): boolean { return this.blast.active() || this.ruins.moving(); }
  /** Anything casting a shadow moves: the shadow maps are redrawn while it does. */
  moving(): boolean { return this.blast.moving() || this.ruins.moving(); }
  /** Changes with what the feature draws (pieces redrawn, a ruin or a part shown or gone): what casts a shadow changed. */
  drawnVersion(): number { return this.blast.debris.drawn + this.ruins.draw.drawn; }
  /** Everything gone (a new city). */
  clear(): void { this.blast.clear(); this.ruins.clear(); }
  /** Every part drawn once at load (`on`), so no shader is compiled during play. */
  warm(on: boolean): void { this.blast.warm(on); this.ruins.draw.warm(on); }
}

