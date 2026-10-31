// The click a tool gets on release: one dispatch, in the tool's order. The Game owns the tools and the world; this
// module only calls the ports of the host.
import { ROAD_TOOLS } from '../ui/hudActions.ts';
import { PROFILE_INFO, profileName } from '../roads/profiles.ts';
import { t } from '../shared/i18n/index.ts';
import type { Vector3 } from 'three/webgpu';
import type { Tool } from '../ui/hudActions.ts';
import type { Hud } from '../ui/hud.ts';
import type { Inspector } from '../ui/inspector.ts';
import type { ItemTool } from '../features/streetscape/itemTool.ts';
import type { RoadTool } from '../features/roads/roadTool.ts';
import type { ZoneTool } from '../features/zones/zoneTool.ts';

export interface ClickHost {
  readonly tool: Tool;
  readonly itemRemove: boolean;
  readonly forestOne: boolean;
  readonly zoneBlock: boolean;
  readonly transitTerminal: boolean;
  readonly inspector: Pick<Inspector, 'pick'>;
  readonly riverPts: Array<[number, number]>;
  readonly itemTool: ItemTool;
  readonly roadTool: RoadTool;
  readonly zoneTool: Pick<ZoneTool, 'fillBlock'>;
  readonly hud: Pick<Hud, 'toast' | 'setProfile'>;
  removePole(hit: Vector3 | null): void;
  clickBuilding(hit: Vector3 | null, shift: boolean): void;
  clickTransit(hit: Vector3 | null, terminal: boolean): void;
  clickSky(x: number, z: number): void;
  plantTree(x: number, z: number): void;
  placePerson(x: number, z: number): void;
  shoot(x: number, z: number): void;
  bomb(x: number, z: number): void;
  weatherStrike(hit: Vector3): void;
}

/** Dispatches a click with the same order and side effects the canvas release has always had. */
export function clickTool(host: ClickHost, hit: Vector3 | null, shift: boolean, alt: boolean): void {
  if (host.tool === 'inspect') { if (hit) host.inspector.pick(hit.x, hit.z); }
  else if (host.tool === 'river') { if (hit) host.riverPts.push([hit.x, hit.z]); }
  else if (host.tool === 'barrier' && host.itemRemove) host.removePole(hit);
  else if (host.tool === 'streetscape' || host.tool === 'barrier') host.itemTool.click(hit, shift);
  else if (host.tool === 'building') host.clickBuilding(hit, shift);
  else if (host.tool === 'transit') host.clickTransit(hit, shift || host.transitTerminal);
  else if (host.tool === 'forest' && host.forestOne) { if (hit) host.plantTree(hit.x, hit.z); }
  else if (host.tool === 'sky') { if (hit) host.clickSky(hit.x, hit.z); }
  else if (host.tool === 'person') { if (hit) host.placePerson(hit.x, hit.z); }
  else if (host.tool === 'pistol') { if (hit) host.shoot(hit.x, hit.z); }
  else if (host.tool === 'bomb') { if (hit) host.bomb(hit.x, hit.z); }
  else if (host.tool === 'weather') { if (hit) host.weatherStrike(hit); }
  else if (host.tool === 'zone' && host.zoneBlock) {
    if (hit) { const r = host.zoneTool.fillBlock(hit.x, hit.z); if (r !== 'ok') host.hud.toast(r); }
  } else if (alt && ROAD_TOOLS.includes(host.tool)) {
    const p = host.roadTool.pick(hit);
    if (p >= 0) { host.hud.setProfile(p); host.hud.toast(t('game.toast.profileCopied', { name: profileName(PROFILE_INFO[p]) })); }
  } else host.roadTool.click(hit, shift);
}
