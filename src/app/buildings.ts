// Selecting a building and showing its lot circle. The Game owns the world and the selection; this module only reads
// it through SelectionHost and writes the panels the selection feeds.
import { hasDesign, decodeDesign } from '../world/design.ts';
import { heightAt } from '../world/heights.ts';
import type { World } from '../world/world.ts';
import type { Hud } from '../ui/hud.ts';
import type { RoadPreview } from '../render/preview.ts';
import type { Creator } from '../ui/creator.ts';
import type { Tool } from '../ui/hudActions.ts';

export interface SelectionHost {
  selected: number;
  readonly world: World;
  readonly hud: Pick<Hud, 'setBuilding'>;
  readonly preview: Pick<RoadPreview, 'circle' | 'showCircle'>;
  readonly tool: Tool;
  readonly creator?: Creator;
  addressOf(): string;
}

/** Selects a building record (negative clears it) and fills the building panel and the creator. */
export function selectBuilding(host: SelectionHost, id: number): void {
  host.selected = id;
  const col = host.world.buildings.cols;
  if (id < 0 || !host.world.buildings.alive[id]) {
    host.selected = -1; host.hud.setBuilding(null); host.preview.circle.visible = false;
    if (host.creator) host.creator.el.style.display = 'none';
    return;
  }
  const z = col.zone[id];
  host.creator?.show(hasDesign(col.color[id]) ? decodeDesign(col.color[id], col.h[id]) : null, col.floors[id]);
  if (host.creator) host.creator.el.style.display = host.tool === 'building' && col.floors[id] > 0 ? '' : 'none';
  host.hud.setBuilding({ fn: col.fn[id], zone: z, floors: col.floors[id], arch: col.style[id] >= 128 ? col.style[id] - 128 : -1, address: host.addressOf(), decay: col.decay[id] });
}

/** Draws the selection circle on the selected building's lot, when there is one. */
export function showSelection(host: SelectionHost): void {
  const id = host.selected;
  if (id < 0 || !host.world.buildings.alive[id]) { host.preview.circle.visible = false; return; }
  const col = host.world.buildings.cols;
  const y = heightAt(host.world.heights, col.x[id], col.z[id]);
  host.preview.showCircle(col.x[id], y, col.z[id], Math.hypot(col.w[id], col.d[id]) / 2 + 2, true);
}
