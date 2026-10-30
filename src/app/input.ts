// The page's input: pointer drags for the camera and every tool, the wheel, and the one key table (ui/keys.ts).
// The state it reads and writes belongs to Game (the owner), through InputHost; no rule of the world lives here.

import * as THREE from 'three/webgpu';
import type { Lifecycle } from './lifecycle.ts';
import type { LotEditing } from './lotEditing.ts';
import { attachPinch } from '../ui/touch.ts';
import { installKeys } from '../ui/keys.ts';
import { GROUND_TOOLS, TERRAIN_TOOLS, ROAD_TOOLS, type SkyToolState, type Tool } from '../ui/hudActions.ts';
import { BrushStroke, LANDFORM_ROCK, type BrushParams } from '../world/brush.ts';
import { GroundStroke } from '../world/ground.ts';
import { ElementStroke } from '../world/items.ts';
import { deleteLotsAlong } from '../world/lotEdit.ts';
import { demolishBox } from '../features/demolition/demolish.ts';
import { clickTool, type ClickHost } from './clicks.ts';
import { duplicateRoad } from '../roads/build.ts';
import { loose, money, plural, t } from '../shared/i18n/index.ts';
import type { Ambient } from '../platform/audio.ts';
import type { CameraRig } from '../render/cameraRig.ts';
import type { CommandStack } from '../core/commands.ts';
import type { HealthPanel } from '../ui/health.ts';
import type { Hud } from '../ui/hud.ts';
import type { InsideView } from '../render/inside.ts';
import type { Inspector } from '../ui/inspector.ts';
import type { ItemTool } from '../features/streetscape/itemTool.ts';
import type { OptionsPanel } from '../ui/options.ts';
import type { RoadPreview } from '../render/preview.ts';
import type { RoadTool } from '../features/roads/roadTool.ts';
import type { StartMenu } from '../ui/menu.ts';
import type { VehicleRenderer } from '../render/vehicles.ts';
import type { World } from '../world/world.ts';
import type { ZoneTool } from '../features/zones/zoneTool.ts';
import { NO_SEG } from '../core/ids.ts';

export interface InputHost {
  /** The game's lifecycle: world tools act only while the world is editable (app/lifecycle.ts). */
  readonly life: Lifecycle;
  readonly canvas: HTMLCanvasElement;
  readonly ambient: Ambient;
  readonly commands: CommandStack;
  readonly rig: CameraRig;
  readonly hud: Hud;
  readonly world: World;
  readonly preview: RoadPreview;
  readonly roadTool: RoadTool;
  readonly itemTool: ItemTool;
  readonly zoneTool: ZoneTool;
  readonly inspector: Inspector;
  readonly health: HealthPanel;
  readonly optionsPanel: OptionsPanel;
  readonly startMenu: StartMenu | null;
  readonly inside: InsideView;
  readonly vehicles: VehicleRenderer;
  readonly developer: boolean;
  readonly selected: number;
  readonly tool: Tool;
  readonly brush: BrushParams;
  readonly skyTool: SkyToolState;
  readonly forestOne: boolean;
  readonly zoneBlock: boolean;
  readonly simSpeed: number;
  readonly paused: boolean;
  readonly homeView: Float64Array | null;
  readonly riverPts: Array<[number, number]>;
  /** The lot tool (its state: mode, points under way, corner dragged). */
  readonly editing: LotEditing;
  readonly insideId: number;
  readonly cloudGrab: number;
  pointer: { x: number; y: number; inside: boolean };
  stroke: BrushStroke | GroundStroke | null;
  rockStroke: GroundStroke | null;
  elemStroke: ElementStroke | null;
  ndcX(): number;
  ndcY(): number;
  clickHost(): ClickHost;
  grabCloud(hit: THREE.Vector3 | null): boolean;
  dropCloud(hit: THREE.Vector3 | null): void;
  grabCorner(hit: THREE.Vector3 | null): boolean;
  dropCorner(hit: THREE.Vector3 | null): void;
  finishRiver(): void;
  finishPoly(): void;
  insideCmd(c: 'toggle' | 'up' | 'down'): void;
  setTool(t: Tool): void;
  setSpeed(n: number): void;
  setView(v: 'persp' | 'iso' | 'top'): void;
  toggleTrafficView(): void;
  toggleFollow(): void;
  toolKey(e: KeyboardEvent): boolean;
  history(redo: boolean): void;
  save(): Promise<boolean> | void;
}

export type Drag = 'none' | 'pan' | 'rotate' | 'brush' | 'click' | 'zone' | 'node' | 'box' | 'row' | 'free' | 'lots';

/** The pointer gesture under way: what kind of drag, where a box or row started, the stroke of a lots deletion. */
export class Gesture {
  drag: Drag = 'none';
  boxStart: THREE.Vector3 | null = null;
  lotStroke: Array<[number, number]> = [];
}

/** What the page keeps of the input: the gesture (read by the frame) and how to end it when the tool changes. */
export interface InputControl {
  readonly gesture: Gesture;
  /** Leaves the gesture under way: what is already in the world (brush, ground, elements, zone) is one undo step; what waits for the release (box, row, lots stroke, free road, a corner or cloud held) is dropped. */
  cancel(): void;
}

/** Binds the page's input; `gs` is the gesture it drives (made by the caller, `none` until a pointer goes down). */
export function bindInput(h: InputHost, gs: Gesture = new Gesture()): InputControl {
    const c = h.canvas;
    const down = { x: 0, y: 0, button: -1 };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // two fingers zoom (src/ui/touch.ts runs before the listeners below)
    attachPinch(c, h.rig);
    c.addEventListener('pointerdown', (e) => {
      h.ambient.start();
      c.setPointerCapture(e.pointerId);
      h.pointer.x = e.offsetX; h.pointer.y = e.offsetY;
      down.x = e.offsetX; down.y = e.offsetY; down.button = e.button;
      if (e.button === 2) gs.drag = 'rotate';
      else if (e.button === 1 || (e.button === 0 && h.tool === 'camera')) {
        gs.drag = 'pan';
        h.rig.beginPan(h.ndcX(), h.ndcY());
      } else if (e.button === 0 && h.tool !== 'inspect' && !h.life.worldEditable) {
        // the city on screen is being rebuilt or is half built (a failed opening or generation): no tool changes it
        h.hud.toast(t('game.toast.saveBlocked'));
      } else if (e.button === 0 && TERRAIN_TOOLS.includes(h.tool)) {
        gs.drag = 'brush';
        h.stroke = new BrushStroke(h.world);
        h.rockStroke = LANDFORM_ROCK[h.brush.mode] !== undefined ? new GroundStroke(h.world) : null;
      } else if (e.button === 0 && h.tool === 'sky' && h.skyTool.fog !== 'none') {
        gs.drag = 'brush';
        h.elemStroke = new ElementStroke(h.world.items);
      } else if (e.button === 0 && h.tool === 'sky' && h.skyTool.cloud === 'move' && h.grabCloud(h.rig.pick(h.ndcX(), h.ndcY()))) {
        gs.drag = 'node';
      } else if (e.button === 0 && h.tool === 'elements') {
        gs.drag = 'brush';
        h.elemStroke = new ElementStroke(h.world.items);
      } else if (e.button === 0 && h.tool === 'forest' && h.forestOne) {
        gs.drag = 'click';
      } else if (e.button === 0 && GROUND_TOOLS.includes(h.tool)) {
        gs.drag = 'brush';
        h.stroke = new GroundStroke(h.world);
      } else if (e.button === 0 && h.tool === 'free' && h.roadTool.freeBegin(h.rig.pick(h.ndcX(), h.ndcY()))) {
        gs.drag = 'free';
      } else if (e.button === 0 && h.tool === 'move' && h.roadTool.grab(h.rig.pick(h.ndcX(), h.ndcY()))) {
        gs.drag = 'node';
      } else if (e.button === 0 && h.tool === 'building' && h.editing.lotMode === 'corner' && h.grabCorner(h.rig.pick(h.ndcX(), h.ndcY()))) {
        gs.drag = 'node';
      } else if (e.button === 0 && h.tool === 'building' && h.editing.lotMode === 'delete' && !h.editing.lotExtra) {
        const hit = h.rig.pick(h.ndcX(), h.ndcY());
        gs.drag = 'lots';
        gs.lotStroke = hit ? [[hit.x, hit.z]] : [];
      } else if (e.button === 0 && h.tool === 'zone' && !h.zoneBlock) {
        gs.drag = 'zone';
        h.zoneTool.begin();
      } else if (e.button === 0) {
        gs.drag = 'click'; // becomes a camera drag if it moves
      }
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const dx = e.offsetX - h.pointer.x, dy = e.offsetY - h.pointer.y;
      h.pointer.x = e.offsetX; h.pointer.y = e.offsetY;
      h.pointer.inside = true;
      h.roadTool.shiftHeld = e.shiftKey;
      if (gs.drag === 'click' && (h.tool === 'bulldoze' || h.tool === 'streetscape') && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5) {
        const px = h.pointer.x, py = h.pointer.y;
        h.pointer.x = down.x; h.pointer.y = down.y;
        gs.boxStart = h.rig.pick(h.ndcX(), h.ndcY());
        h.pointer.x = px; h.pointer.y = py;
        if (gs.boxStart) gs.drag = h.tool === 'streetscape' ? 'row' : 'box';
      }
      if (gs.drag === 'click' && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5) {
        gs.drag = 'pan';
        h.pointer.x = down.x; h.pointer.y = down.y;
        h.rig.beginPan(h.ndcX(), h.ndcY());
        h.pointer.x = e.offsetX; h.pointer.y = e.offsetY;
      }
      if (gs.drag === 'rotate') h.rig.rotate(dx, dy);
      else if (gs.drag === 'pan') h.rig.pan(h.ndcX(), h.ndcY());
      else if (gs.drag === 'lots') {
        const hit = h.rig.pick(h.ndcX(), h.ndcY()), last = gs.lotStroke[gs.lotStroke.length - 1];
        if (hit && (!last || Math.hypot(hit.x - last[0], hit.z - last[1]) > 2)) gs.lotStroke.push([hit.x, hit.z]);
      }
    });
    // what a drag already put in the world (a brush of ground or elements, a zone) becomes one undo step
    const commitStrokes = () => {
      if (gs.drag === 'brush' && h.elemStroke) {
        if (!h.elemStroke.cmd.empty) h.commands.push(h.elemStroke.cmd);
        h.elemStroke = null;
      }
      if (gs.drag === 'brush' && h.stroke) {
        const rock = h.rockStroke;
        h.rockStroke = null;
        if (h.stroke.finish()) {
          // landform: the terrain and the painted rock are a single undo step
          const terr = h.stroke;
          if (rock && rock.finish()) h.commands.push({ label: 'relevo', apply: () => { terr.apply(); rock.apply(); }, invert: () => { rock.invert(); terr.invert(); } });
          else h.commands.push(terr);
        }
        h.stroke = null;
      }
      if (gs.drag === 'zone') h.zoneTool.end();
    };
    const finishDrag = (e: PointerEvent) => {
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      const still = Math.hypot(e.offsetX - down.x, e.offsetY - down.y) <= 5;
      commitStrokes();
      if (gs.drag === 'lots') {
        const r = gs.lotStroke.length ? deleteLotsAlong(h.world, gs.lotStroke) : null;
        gs.lotStroke = [];
        if (typeof r === 'string') h.hud.toast(r[0].toUpperCase() + r.slice(1) + '.');
        else if (r) { h.commands.push(r); h.hud.toast(t('game.toast.deleted')); }
      }
      if (gs.drag === 'free') h.roadTool.freeEnd(h.rig.pick(h.ndcX(), h.ndcY()));
      if (gs.drag === 'row' && gs.boxStart) {
        const b = h.rig.pick(h.ndcX(), h.ndcY());
        if (b) h.itemTool.row(gs.boxStart.x, gs.boxStart.z, b.x, b.z);
        h.preview.hideAll();
        gs.boxStart = null;
      }
      if (gs.drag === 'box' && gs.boxStart) {
        const b = h.rig.pick(h.ndcX(), h.ndcY());
        const r = b ? demolishBox(h.world, gs.boxStart.x, gs.boxStart.z, b.x, b.z) : null;
        h.preview.hideAll();
        if (r) { h.commands.push(r.cmd); h.hud.toast((plural('game.toast.demolished', r.count) + (r.charge < 0 ? t('game.toast.refunded', { money: money(-r.charge) }) : '') + '.')); }
        gs.boxStart = null;
      }
      if (gs.drag === 'node' && h.cloudGrab >= 0) { h.dropCloud(h.rig.pick(h.ndcX(), h.ndcY())); }
      else if (gs.drag === 'node' && h.editing.cornerDrag) h.dropCorner(h.rig.pick(h.ndcX(), h.ndcY()));
      else if (gs.drag === 'node') h.roadTool.drop(h.rig.pick(h.ndcX(), h.ndcY()));
      if (gs.drag === 'click' && still && e.type === 'pointerup') {
        clickTool(h.clickHost(), h.rig.pick(h.ndcX(), h.ndcY()), e.shiftKey, e.altKey);
      }
      if (gs.drag === 'rotate' && still && ROAD_TOOLS.includes(h.tool)) h.roadTool.cancel();
      if (gs.drag === 'pan') h.rig.endPan();
      gs.drag = 'none';
    };
    // whatever the tool does on release, the drag always ends (an error must not leave the next move panning the camera)
    const end = (e: PointerEvent) => {
      try { finishDrag(e); } catch (err) {
        console.error(err);
        h.hud.toast(t('tool.failed', { message: (err as Error)?.message ?? String(err) }));
      } finally { gs.drag = 'none'; if (h.commands.holding) h.zoneTool.end(); }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('dblclick', () => {
      if (h.tool === 'river') h.finishRiver();
      if (h.tool === 'building' && h.editing.lotMode === 'poly') h.finishPoly();
      // the building picked by the first click: see it inside (the hint of "See inside" says so)
      else if (h.tool === 'building' && h.editing.lotMode === 'edit' && !h.editing.lotExtra && h.selected >= 0 && !(h.inside.on && h.insideId === h.selected)) h.insideCmd('toggle');
      // a wall ends (the barrier hint: double click or Enter)
      if (h.tool === 'barrier' && h.itemTool.open) h.itemTool.cancel();
    });
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { h.pointer.inside = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      h.rig.zoomAt(Math.exp(delta * 0.0012), h.ndcX(), h.ndcY());
    }, { passive: false });

    // every key in one table (src/ui/keys.ts); the tool reads its own keys in toolKey
    installKeys({
      tool: () => h.tool,
      setTool: (t) => h.setTool(t),
      openCategory: (c) => h.hud.openCategory(c),
      dialog: () => h.optionsPanel.isOpen || h.hud.aboutOpen || !!h.startMenu?.open,
      closeDialog: () => { if (h.optionsPanel.isOpen) h.optionsPanel.close(); else if (h.hud.aboutOpen) h.hud.closeAbout(); else h.startMenu?.hide(); },
      closeMenu: () => h.hud.escape(),
      closePanel: () => {
        if (h.optionsPanel.isOpen) { h.optionsPanel.close(); return true; }
        if (h.health.close()) return true;
        if (h.hud.catalog.editor.isOpen) { h.hud.catalog.editor.close(); return true; }
        if (h.inspector.isOpen) { h.inspector.close(); return true; }
        return false;
      },
      cancelStroke: () => {
        if (h.vehicles.follow) { h.vehicles.follow = null; return true; }
        // a wall being traced ends and the tool stays (the next Esc puts it down)
        if (h.tool === 'barrier' && h.itemTool.open) { h.itemTool.cancel(); return true; }
        if (h.tool === 'building' && h.editing.lotExtraPts.length) { h.editing.lotExtraPts = []; h.preview.hideAll(); return true; }
        if (h.tool === 'building' && (h.editing.lotPts?.length || h.editing.polyPts.length || h.editing.joinFirst >= 0)) { if (h.editing.lotPts) h.editing.lotPts.length = 0; h.editing.polyPts.length = 0; h.editing.joinFirst = -1; h.preview.hideAll(); return true; }
        if (h.tool === 'river' && h.riverPts.length) { h.riverPts.length = 0; h.preview.hideAll(); return true; }
        if (ROAD_TOOLS.includes(h.tool) && h.roadTool.busy) { h.roadTool.cancel(); return true; }
        return false;
      },
      toolKey: (e) => h.toolKey(e),
      undo: () => h.history(false),
      redo: () => h.history(true),
      save: () => void h.save(),
      help: () => h.hud.toggleHelp(),
      health: () => h.health.toggle(),
      changes: () => h.health.show('world'),
      developer: () => h.developer,
      openMap: () => h.hud.openFile(),
      duplicate: () => {
        const s = h.inspector.isOpen ? h.inspector.seg : NO_SEG;
        const j = s >= 0 ? duplicateRoad(h.world, s) : null;
        if (!j) return;
        if (typeof j === 'string') { h.hud.toast(loose(j)); return; }
        if (!j.empty && j.settle()) h.commands.push(j);
      },
      home: () => { if (h.homeView) h.rig.restore(h.homeView); },
      // as Q (−1) or E (+1), a quarter at once
      quarterTurn: (d) => h.rig.turnTo(h.rig.yaw - d * Math.PI / 2),
      pause: () => h.setSpeed(h.paused ? h.simSpeed : 0),
      nextSpeed: () => h.setSpeed(h.paused ? h.simSpeed : h.simSpeed === 1 ? 2 : h.simSpeed === 2 ? 4 : 1),
      toggleIso: () => h.setView(h.rig.mode === 'iso' ? 'persp' : 'iso'),
      congestion: () => h.toggleTrafficView(),
      follow: () => h.toggleFollow(),
      wake: () => h.ambient.start(),
      camera: h.rig,
    });

    // the tool changes in the middle of a drag (a key, the toolbar): the gesture is left, never finished on the new tool
    const cancel = () => {
      if (gs.drag === 'none') return;
      commitStrokes();
      if (gs.drag === 'node') {
        if (h.cloudGrab >= 0) h.dropCloud(null);
        else if (h.editing.cornerDrag) h.dropCorner(null);
        else h.roadTool.drop(null);
      }
      if (gs.drag === 'free') h.roadTool.cancel();
      if (gs.drag === 'pan') h.rig.endPan();
      if (gs.drag === 'box' || gs.drag === 'row') h.preview.hideAll();
      gs.boxStart = null;
      gs.lotStroke = [];
      gs.drag = 'none';
    };
    return { gesture: gs, cancel };
}
