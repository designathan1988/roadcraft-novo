// The player's clouds: their view, the sky tool's state and every edit (add, remove, adjust, move, scatter, clear) as
// an undoable command. The list is the map's (World.look.clouds, saved with it); the page only wires the tool's
// clicks and drags here.

import type { Command } from '../../core/commands.ts';
import { CloudPuffs, MAX_CLOUDS } from '../../render/cloudPuffs.ts';
import type { Cloud, MapLook } from '../../world/mapLook.ts';
import { heightAt } from '../../world/heights.ts';
import { t } from '../../shared/i18n/index.ts';
import type { SkyToolState } from '../../ui/hudActions.ts';

export interface CloudHost {
  readonly heights: Float32Array;
  /** The map's look: its clouds. */
  readonly look: MapLook;
  /** Runs a command and records it (CommandStack.run). */
  run(cmd: Command): void;
  toast(text: string): void;
  /** The map changed and has to be saved. */
  changed(): void;
  /** Where the camera looks: scattered clouds go round it. */
  target(): { x: number; z: number };
}

export class Clouds {
  readonly view = new CloudPuffs();
  tool: SkyToolState = { cloud: 'add', fog: 'none', size: 500, base: 900, density: 0.8, fogHeight: 6 };
  /** The cloud being dragged (the object, not its index: an undo during the drag replaces the list, D43). */
  private held: Cloud | null = null;
  private host: CloudHost;

  constructor(host: CloudHost) { this.host = host; }

  /** The map's clouds. */
  get list(): readonly Cloud[] { return this.host.look.clouds; }
  private get items(): readonly Cloud[] { return this.host.look.clouds; }
  /** The cloud being dragged, or -1. */
  get grabbed(): number { return this.held ? this.items.indexOf(this.held) : -1; }

  /** Shows the map's clouds (after a map is opened or made). */
  show(): void { this.view.set(this.items); }

  /** A click of the sky tool on the ground at (x, z). */
  click(x: number, z: number): void {
    const s = this.tool;
    if (s.fog !== 'none') return;
    const i = this.at(x, z);
    if (s.cloud === 'add') {
      if (this.items.length >= MAX_CLOUDS) { this.host.toast(t('game.toast.maxClouds', { n: MAX_CLOUDS })); return; }
      this.replace([...this.items, { x, z, y: this.ground(x, z) + s.base, size: s.size, density: s.density }], 'create cloud');
    } else if (s.cloud === 'remove' && i >= 0) this.replace(this.items.filter((_, k) => k !== i), 'remove cloud');
    else if (s.cloud === 'edit' && i >= 0) {
      const c = this.items[i];
      this.replace(this.items.map((d, k) => (k === i ? { ...c, size: s.size, density: s.density, y: this.ground(c.x, c.z) + s.base } : d)), 'adjust cloud');
    } else if (i < 0 && s.cloud !== 'none') this.host.toast(t('game.toast.noCloud'));
  }

  /** Starts dragging the cloud over (x, z); false when there is none. */
  grab(x: number, z: number): boolean { const i = this.at(x, z); this.held = i >= 0 ? this.items[i] : null; return i >= 0; }

  /** Drops the dragged cloud over (x, z), at the same height over the ground; null cancels. */
  drop(at: { x: number; z: number } | null): void {
    const i = this.held ? this.items.indexOf(this.held) : -1;
    this.held = null;
    // the list changed under the drag (undo, redo, another map): that cloud is gone, the move is dropped
    if (i < 0 || !at) return;
    const c = this.items[i], base = c.y - this.ground(c.x, c.z);
    this.replace(this.items.map((d, k) => (k === i ? { ...c, x: at.x, z: at.z, y: this.ground(at.x, at.z) + base } : d)), 'move cloud');
  }

  /** Scatters `n` clouds round the camera, size and base from the sliders varied by `variation`. */
  scatter(n: number, variation: number): void {
    const s = this.tool, out = this.items.slice(0, Math.max(0, MAX_CLOUDS - n)), c = this.host.target();
    for (let k = 0; k < n && out.length < MAX_CLOUDS; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 5000;
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      const vary = (v: number) => v * (1 + (Math.random() * 2 - 1) * variation);
      out.push({ x, z, y: this.ground(x, z) + vary(s.base), size: vary(s.size), density: Math.min(1, vary(s.density)) });
    }
    this.replace(out, 'scatter clouds');
  }

  /** Takes every cloud away (one command). */
  clear(): void { this.replace([], 'clear clouds'); }

  /** Replaces the list as a command: undo brings the previous one back. */
  private replace(next: Cloud[], label: string): void {
    const before = this.items.map((c) => ({ ...c })), after = next.map((c) => ({ ...c }));
    const set = (l: Cloud[]) => { this.host.look.clouds = l.map((c) => ({ ...c })); this.show(); this.host.changed(); };
    this.host.run({ label, apply: () => set(after), invert: () => set(before) });
  }

  /** The cloud whose shadow on the ground is near (x, z), or -1. */
  private at(x: number, z: number): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.items.length; i++) {
      const c = this.items[i], d = Math.hypot(c.x - x, c.z - z);
      if (d < c.size && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  private ground(x: number, z: number): number { return heightAt(this.host.heights, x, z); }
}
