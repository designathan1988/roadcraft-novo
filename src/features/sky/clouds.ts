// The player's clouds: the list (saved with the map), its view, the sky tool's state and every edit (add, remove,
// adjust, move, scatter, clear) as an undoable command. The feature owns this state; the page only wires the tool's
// clicks and drags to it and reads `list` when saving.

import type { Command } from '../../core/commands.ts';
import { CloudPuffs, MAX_CLOUDS, type Cloud } from '../../render/cloudPuffs.ts';
import { heightAt } from '../../world/heights.ts';
import { t } from '../../shared/i18n/index.ts';
import type { SkyToolState } from '../../ui/hudActions.ts';

export interface CloudHost {
  readonly heights: Float32Array;
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
  private items: Cloud[] = [];
  private held = -1;
  private host: CloudHost;

  constructor(host: CloudHost) { this.host = host; }

  /** The clouds as saved with the map. */
  get list(): readonly Cloud[] { return this.items; }
  /** The cloud being dragged, or -1. */
  get grabbed(): number { return this.held; }

  /** The clouds of a map just opened (or none for a new one): not an edit, no command. */
  load(list: readonly Cloud[]): void { this.items = list.map((c) => ({ ...c })); this.view.set(this.items); }

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
  grab(x: number, z: number): boolean { this.held = this.at(x, z); return this.held >= 0; }

  /** Drops the dragged cloud over (x, z), at the same height over the ground; null cancels. */
  drop(at: { x: number; z: number } | null): void {
    const i = this.held;
    this.held = -1;
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
    const set = (l: Cloud[]) => { this.load(l); this.host.changed(); };
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
