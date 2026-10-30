// The river tool: the player clicks the river's course point by point (Backspace takes the last one back, Escape
// drops them, Enter or the API lays it); laying it is one undoable RiverCommand. The feature owns the points and the
// width; the page passes the clicks, the keys and the hover.

import type { Command } from '../../core/commands.ts';
import type { RoadPreview } from '../../render/preview.ts';
import { RiverCommand } from '../../world/ground.ts';
import { heightAt } from '../../world/heights.ts';
import type { World } from '../../world/world.ts';
import { t } from '../../shared/i18n/index.ts';

export interface RiverHost {
  readonly world: World;
  readonly preview: RoadPreview;
  run(cmd: Command): void;
  toast(text: string): void;
}

export class RiverTool {
  /** The course clicked so far (one array for the tool's whole life: the input reads this same one). */
  readonly points: Array<[number, number]> = [];
  width = 14;
  private host: RiverHost;

  constructor(host: RiverHost) { this.host = host; }

  /** The segment from the last point to the pointer, drawn as the river's width. */
  hover(hit: { x: number; z: number } | null): void {
    const pv = this.host.preview, h = this.host.world.heights;
    if (!hit || this.points.length === 0) { pv.hide(); return; }
    const [ax, az] = this.points[this.points.length - 1];
    pv.show({ x0: ax, z0: az, cx: (ax + hit.x) / 2, cz: (az + hit.z) / 2, x1: hit.x, z1: hit.z }, this.width / 2, [0, 1],
      [heightAt(h, ax, az) + 0.3, heightAt(h, hit.x, hit.z) + 0.3], true, 0x3d8fd0);
  }

  /** Lays the river along the points (two at least) and starts a new course. */
  finish(): void {
    if (this.points.length >= 2) {
      const c = new RiverCommand(this.host.world, this.points, this.width, Math.min(4, 1.2 + this.width / 12));
      if (!c.empty) { this.host.run(c); this.host.toast(t('game.toast.river')); }
    }
    this.points.length = 0;
    this.host.preview.hideAll();
  }

  /** Lays a whole course at once (the API and the checks). */
  lay(points: ReadonlyArray<readonly [number, number]>, width: number): void {
    this.points.length = 0;
    for (const [x, z] of points) this.points.push([x, z]);
    this.width = width;
    this.finish();
  }
}
