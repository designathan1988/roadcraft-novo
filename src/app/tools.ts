// The active tool and the hints of the tool panels. The state stays in the Game; this module only reads and writes
// it through an explicit host, so switching tools has one place and no hidden duplicate.
import { zoneOverlayU } from '../render/roads.ts';
import { ROAD_TOOLS, TERRAIN_TOOLS } from '../ui/hud.ts';
import { t } from '../shared/i18n/index.ts';
import type { BrushMode, BrushParams } from '../world/brush.ts';
import type { InsideView } from '../render/inside.ts';
import type { RoadPreview } from '../render/preview.ts';
import type { TransitRenderer } from '../render/transit.ts';
import type { Hud } from '../ui/hud.ts';
import type { LotMode, SkyToolState, Tool } from '../ui/hudActions.ts';
import type { RoadTool } from '../tools/roadTool.ts';
import type { ItemTool } from '../tools/itemTool.ts';
import type { Inspector } from '../ui/inspector.ts';
import type { Creator } from '../ui/creator.ts';
import type { HealthPanel } from '../ui/health.ts';
import type { Ambient } from '../platform/audio.ts';

/** What switching tools needs from the Game; every mutable field is an accessor, never a copy. */
export interface ToolHost {
  tool: Tool;
  wallOpen: boolean;
  readonly zoneLayer: boolean;
  readonly brush: BrushParams;
  readonly landformMode: BrushMode;
  readonly lotMode: LotMode;
  readonly skyTool: SkyToolState;
  readonly riverPts: Array<[number, number]>;
  readonly roadTool: RoadTool;
  readonly itemTool?: ItemTool;
  readonly inspector?: Inspector;
  readonly transitView: TransitRenderer;
  readonly preview: RoadPreview;
  readonly creator?: Creator;
  readonly inside: InsideView;
  insideId: number;
  readonly hud: Hud;
  readonly health?: HealthPanel;
  readonly canvas: HTMLCanvasElement;
  readonly ambient: Ambient;
  select(id: number): void;
  setLotMode(mode: LotMode): void;
}

/** Changes the tool, cancelling what the previous one left open and setting its hint. */
export function setTool(host: ToolHost, tool: Tool): void {
  if (tool !== host.tool) host.ambient.sfx('click');
  host.wallOpen = false;
  host.tool = tool;
  zoneOverlayU.value = tool === 'zone' || host.zoneLayer ? 1 : 0;
  if (TERRAIN_TOOLS.includes(tool)) host.brush.mode = tool === 'landform' ? host.landformMode : tool as BrushParams['mode'];
  if (ROAD_TOOLS.includes(tool)) host.roadTool.setMode(tool);
  else { host.roadTool.cancel(); host.hud.setHint(''); }
  if (tool === 'zone') host.hud.setHint(t('game.hint.zone'));
  if (tool === 'building') { host.select(-1); host.setLotMode(host.lotMode); }
  if (tool !== 'inspect') host.inspector?.close();
  if (tool === 'streetscape' || tool === 'barrier') host.itemTool?.setMode(tool); else host.itemTool?.cancel(false);
  if (tool === 'inspect') host.hud.setHint(t('game.hint.inspect'));
  if (tool === 'paint') host.hud.setHint(t('game.hint.paint'));
  if (tool === 'forest') host.hud.setHint(t('game.hint.forest'));
  if (tool === 'elements') host.hud.setHint(t('game.hint.elements'));
  if (tool === 'landform') host.hud.setHint(t('game.hint.landform'));
  if (tool === 'sky') skyHint(host);
  if (tool === 'person') host.hud.setHint(t('game.hint.person'));
  if (tool === 'pistol') host.hud.setHint(t('game.hint.pistol'));
  if (tool === 'bomb') host.hud.setHint(t('game.hint.bomb'));
  if (tool === 'weather') host.hud.setHint(t('game.hint.weather'));
  if (tool === 'river') host.hud.setHint(t('game.hint.river'));
  if (tool !== 'river') host.riverPts.length = 0;
  if (tool === 'transit') host.hud.setHint(t('game.hint.transit'));
  host.transitView.showPaths = tool === 'transit';
  if (tool !== 'building') {
    host.preview.circle.visible = false;
    if (host.creator) host.creator.el.style.display = 'none';
    if (host.inside.on) { host.inside.hide(); host.insideId = -1; host.hud.setInside(-1); }
  }
  host.hud.setTool(tool);
  if (host.health) host.health.context = `ferramenta ${tool}`;
  host.canvas.style.cursor = tool === 'camera' ? 'grab' : 'crosshair';
}

/** The hint of the sky tool's current mode. */
export function skyHint(host: Pick<ToolHost, 'skyTool' | 'hud'>): void {
  const s = host.skyTool;
  host.hud.setHint(s.fog === 'lay' ? t('game.hint.fog.lay') : s.fog === 'erase' ? t('game.hint.fog.erase')
    : s.cloud === 'add' ? t('game.hint.cloud.add')
      : s.cloud === 'move' ? t('game.hint.cloud.move') : s.cloud === 'edit' ? t('game.hint.cloud.edit')
        : s.cloud === 'remove' ? t('game.hint.cloud.remove') : t('game.hint.sky'));
}
