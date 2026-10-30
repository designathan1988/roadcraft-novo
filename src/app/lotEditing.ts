// Lot and building editing: the lot tool (rectangle, polygon, split, join, front, corner, delete), the
// building under the click and its edits, the inside view and the creator's design. The world and its commands
// belong to Game (the owner), read through LotEditHost; the methods here only build commands and hints.

import * as THREE from 'three/webgpu';
import type { CommandStack } from '../core/commands.ts';
import { Rng } from '../core/rng.ts';
import { heightAt } from '../world/heights.ts';
import { floorsFor, type Growth } from '../world/growth.ts';
import { curveLotSide, deleteLot, joinLots, lotAt, lotFits, lotOutlineWorld, lotToWorld, moveSharedCorner, nearestCorner, polygonLot, polygonRect, setLotFront, splitLot, splitLotsByLine } from '../world/lotEdit.ts';
import { RoadJournal } from '../roads/build.ts';
import { addressAt } from '../roads/streetNames.ts';
import { RoadPreview } from '../render/preview.ts';
import { CameraRig } from '../render/cameraRig.ts';
import { InsideView, insideTarget } from '../render/inside.ts';
import type { Hud, LotMode, Tool } from '../ui/hud.ts';
import type { LotFeatureActions } from './featureActions.ts';
import type { World } from '../world/world.ts';
import type { Transit } from '../world/transit.ts';
import { encodeDesign, type Design } from '../world/design.ts';
import { loose, t } from '../shared/i18n/index.ts';

export interface LotEditHost {
  readonly world: World;
  readonly preview: RoadPreview;
  readonly hud: Hud;
  readonly commands: CommandStack;
  readonly growth: Growth;
  readonly selected: number;
  readonly rig: CameraRig;
  readonly inside: InsideView;
  insideId: number;
  insideFloor: number;
  readonly transit: Transit;
  unsaved: boolean;
  select(id: number): void;
  setTool(t: Tool): void;
  showSelection(): void;
}

export class LotEditing {
  private readonly h: LotEditHost;
  // ---- the lot tool's own state (tool → sub-mode → points of the gesture under way)
  lotMode: LotMode = 'edit';
  /** Rectangle lot: the front's two corners clicked so far (null outside the rectangle mode). */
  lotPts: Array<[number, number]> | null = null;
  /** Polygon lot: the corners clicked so far. */
  polyPts: Array<[number, number]> = [];
  /** Join: the first lot picked (-1 none). */
  joinFirst = -1;
  /** Corner being dragged. */
  cornerDrag: { id: number; k: number } | null = null;
  /** Split by line or curve side: the active extra mode and the points clicked so far. */
  lotExtra: 'line' | 'curve' | null = null;
  lotExtraPts: Array<[number, number]> = [];
  splitKind: 'side' | 'depth' = 'side';
  splitParts = 2;
  /** What the next lot is: its use, style and civic function (-1 / 0: chosen by the growth). */
  lotUse = 1;
  newArch = -1;
  newFn = 0;

  constructor(h: LotEditHost) { this.h = h; }

  /** The building tool is left: the points of a lot being drawn, a join or a corner under way are dropped. */
  exit(): void {
    if (this.lotPts) this.lotPts.length = 0;
    this.polyPts.length = 0;
    this.joinFirst = -1;
    this.cornerDrag = null;
    this.lotExtra = null;
    this.lotExtraPts = [];
  }

  lotRect(c: [number, number]): { x: number; z: number; w: number; d: number; rot: number } | null {
    const [a, b] = this.lotPts!;
    const ex = b[0] - a[0], ez = b[1] - a[1], W = Math.hypot(ex, ez);
    if (W < 6) return null;
    // normal of the front, toward the side of the third point
    let nx = -ez / W, nz = ex / W;
    let D = (c[0] - a[0]) * nx + (c[1] - a[1]) * nz;
    if (D < 0) { nx = -nx; nz = -nz; D = -D; }
    D = Math.min(120, Math.max(6, D));
    // the building front (local +z) points at line A-B: (sin rot, cos rot) = −n
    return { x: (a[0] + b[0]) / 2 + nx * D / 2, z: (a[1] + b[1]) / 2 + nz * D / 2, w: Math.min(160, W), d: D, rot: Math.atan2(-nx, -nz) };
  }

  hoverLot(hit: THREE.Vector3 | null): void {
    const pts = this.lotPts!;
    if (!hit) return;
    const H = (x: number, z: number) => heightAt(this.h.world.heights, x, z) + 0.6;
    if (pts.length === 0) { this.h.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true); return; }
    if (pts.length === 1) {
      const [a] = pts;
      this.h.preview.show({ x0: a[0], z0: a[1], cx: (a[0] + hit.x) / 2, cz: (a[1] + hit.z) / 2, x1: hit.x, z1: hit.z }, 0.4, [0, 1], [H(a[0], a[1]), H(hit.x, hit.z)], true, 0xffd36b);
      return;
    }
    const r = this.lotRect([hit.x, hit.z]);
    if (!r) return;
    // strip along the lot axis with the width of the front: covers the rectangle
    const c = Math.cos(r.rot), s = Math.sin(r.rot), fx = s * r.d / 2, fz = c * r.d / 2;
    this.h.preview.show({ x0: r.x + fx, z0: r.z + fz, cx: r.x, cz: r.z, x1: r.x - fx, z1: r.z - fz }, r.w / 2, [0, 1], [H(r.x + fx, r.z + fz), H(r.x - fx, r.z - fz)], true, 0x5aa8ff);
  }

  clickLot(hit: THREE.Vector3 | null): void {
    if (!hit || !this.lotPts) return;
    const pts = this.lotPts;
    if (pts.length < 2) { pts.push([hit.x, hit.z]); return; }
    const r = this.lotRect([hit.x, hit.z]);
    if (!r) { this.h.hud.toast(t('game.toast.lotNarrow')); pts.length = 0; return; }
    const fits = lotFits(this.h.world, [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => lotToWorld(r, u * r.w / 2, v * r.d / 2)));
    if (fits) { this.h.hud.toast(fits[0].toUpperCase() + fits.slice(1) + '.'); pts.length = 0; this.h.preview.hide(); return; }
    const seed = (Math.random() * 2 ** 31) >>> 0;
    const zone = this.lotUse;
    const rec = {
      ...r, h: 0, color: 0, seed, zone, fn: this.newFn,
      floors: floorsFor(zone, 0, new Rng(seed)),
      style: this.newArch >= 0 ? 128 + this.newArch : seed & 127,
    };
    const j = new RoadJournal(this.h.world, 'lote desenhado');
    const id = j.addBuilding(rec);
    this.h.commands.push(j);
    pts.length = 0;
    this.h.preview.hide();
    this.h.select(id);
  }

  setLotMode(m: LotMode): void {
    this.lotMode = m;
    this.lotExtra = null; this.lotExtraPts = [];
    this.lotPts = m === 'rect' ? [] : null;
    this.polyPts.length = 0; this.joinFirst = -1; this.cornerDrag = null;
    this.h.preview.hideAll();
    if (m !== 'edit') this.h.select(-1);
    this.h.hud.lotModeChanged();
    const hints: Record<LotMode, string> = {
      edit: t('game.hint.lot.edit'),
      rect: t('game.hint.lot.rect'),
      poly: t('game.hint.lot.poly'),
      split: t('game.hint.lot.split'),
      join: t('game.hint.lot.join'),
      delete: t('game.hint.lot.delete'),
      front: t('game.hint.lot.front'),
      corner: t('game.hint.lot.corner'),
    };
    this.h.hud.setHint(hints[m]);
  }

  /** Outline of a lot (record) on the ground. */
  showLot(id: number, color: number): void {
    const col = this.h.world.buildings.cols;
    const r = { x: col.x[id], z: col.z[id], rot: col.rot[id] };
    const [fx, fz] = lotToWorld(r, 0, col.d[id] / 2), [bx, bz] = lotToWorld(r, 0, -col.d[id] / 2);
    const H = (x: number, z: number) => heightAt(this.h.world.heights, x, z) + 0.7;
    this.h.preview.show({ x0: fx, z0: fz, cx: r.x, cz: r.z, x1: bx, z1: bz }, col.w[id] / 2, [0, 1], [H(fx, fz), H(bx, bz)], true, color);
  }

  hoverLotTool(hit: THREE.Vector3 | null): void {
    // split by line, curve side: the line from the first click to the cursor (yellow), or the point to click
    if (this.lotExtra) {
      if (!hit) return;
      const H = (x: number, z: number) => heightAt(this.h.world.heights, x, z) + 0.7;
      const p = this.lotExtraPts[0];
      if (p) this.h.preview.show({ x0: p[0], z0: p[1], cx: (p[0] + hit.x) / 2, cz: (p[1] + hit.z) / 2, x1: hit.x, z1: hit.z }, 0.4, [0, 1], [H(p[0], p[1]), H(hit.x, hit.z)], true, 0xffd36b);
      else { this.h.preview.hide(); this.h.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true); }
      return;
    }
    if (this.lotMode === 'edit') { this.h.showSelection(); return; }
    if (this.lotMode === 'rect') { if (this.lotPts) this.hoverLot(hit); return; }
    if (!hit) return;
    const H = (x: number, z: number) => heightAt(this.h.world.heights, x, z) + 0.7;
    if (this.lotMode === 'poly') {
      const pts: Array<[number, number]> = [...this.polyPts, [hit.x, hit.z]];
      const r = pts.length >= 3 ? polygonRect(pts) : null;
      if (r) {
        const [fx, fz] = lotToWorld(r, 0, r.d / 2), [bx, bz] = lotToWorld(r, 0, -r.d / 2);
        this.h.preview.show({ x0: fx, z0: fz, cx: r.x, cz: r.z, x1: bx, z1: bz }, r.w / 2, [0, 1], [H(fx, fz), H(bx, bz)], true, 0x5aa8ff);
      } else if (pts.length === 2) {
        const [a, b] = pts;
        this.h.preview.show({ x0: a[0], z0: a[1], cx: (a[0] + b[0]) / 2, cz: (a[1] + b[1]) / 2, x1: b[0], z1: b[1] }, 0.4, [0, 1], [H(a[0], a[1]), H(b[0], b[1])], true, 0xffd36b);
      } else this.h.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true);
      return;
    }
    if (this.cornerDrag) {
      this.showLot(this.cornerDrag.id, 0x5aa8ff);
      this.h.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true);
      return;
    }
    const id = lotAt(this.h.world, hit.x, hit.z);
    if (id < 0) { this.h.preview.hide(); return; }
    this.showLot(id, this.lotMode === 'delete' ? 0xe2564b : this.lotMode === 'join' && this.joinFirst >= 0 ? 0x4cd28a : 0x5aa8ff);
  }

  clickLotTool(hit: THREE.Vector3): void {
    if (this.lotMode === 'poly') { this.polyPts.push([hit.x, hit.z]); return; }
    const id = lotAt(this.h.world, hit.x, hit.z);
    if (id < 0) { this.h.hud.toast(t('game.toast.noLot')); return; }
    let r: RoadJournal | string | null = null;
    if (this.lotMode === 'split') r = splitLot(this.h.world, id, this.splitKind, this.splitParts);
    else if (this.lotMode === 'delete') r = deleteLot(this.h.world, id);
    else if (this.lotMode === 'front') { r = setLotFront(this.h.world, id, hit.x, hit.z); if (!r) { this.h.hud.toast(t('game.toast.alreadyFront')); return; } }
    else if (this.lotMode === 'join') {
      if (this.joinFirst < 0 || !this.h.world.buildings.alive[this.joinFirst]) { this.joinFirst = id; this.h.hud.setHint(t('game.hint.lot.joinSecond')); return; }
      r = joinLots(this.h.world, this.joinFirst, id);
      this.joinFirst = -1;
      this.h.hud.setHint(t('game.hint.lot.join'));
    }
    if (!r) return;
    if (typeof r === 'string') { this.h.hud.toast(r[0].toUpperCase() + r.slice(1) + '.'); return; }
    this.h.commands.push(r);
    this.h.preview.hide();
    this.h.hud.toast(this.lotMode === 'split' ? t('game.toast.lotSplit') : this.lotMode === 'join' ? t('game.toast.lotsJoined') : this.lotMode === 'front' ? t('game.toast.frontSet') : t('game.toast.deleted'));
  }

  finishPoly(): void {
    const r = polygonLot(this.polyPts, this.h.world);
    this.polyPts.length = 0;
    this.h.preview.hideAll();
    if (typeof r === 'string') { this.h.hud.toast(r[0].toUpperCase() + r.slice(1) + '.'); return; }
    const seed = (Math.random() * 2 ** 31) >>> 0, zone = this.lotUse;
    const j = new RoadJournal(this.h.world, 'lote desenhado');
    j.addBuilding({ ...r, h: 0, color: 0, seed, zone, fn: this.newFn, floors: floorsFor(zone, 0, new Rng(seed)), style: this.newArch >= 0 ? 128 + this.newArch : seed & 127 });
    this.h.commands.push(j);
    this.h.hud.toast(t('game.toast.lotCreated'));
  }

  grabCorner(hit: THREE.Vector3 | null): boolean {
    if (!hit) return false;
    const id = lotAt(this.h.world, hit.x, hit.z);
    if (id < 0) return false;
    const [k, d] = nearestCorner(this.h.world, id, hit.x, hit.z);
    if (d > 8) return false;
    this.cornerDrag = { id, k };
    return true;
  }

  dropCorner(hit: THREE.Vector3 | null): void {
    const c = this.cornerDrag;
    this.cornerDrag = null;
    this.h.preview.hideAll();
    if (!c || !hit || !this.h.world.buildings.alive[c.id]) return;
    const [cx, cz] = lotOutlineWorld(this.h.world, c.id)[c.k];
    const r = moveSharedCorner(this.h.world, cx, cz, hit.x, hit.z);
    if (typeof r === 'string') { this.h.hud.toast(t('game.toast.notChanged', { why: loose(r) })); return; }
    this.h.commands.push(r);
  }

  featureActions(): LotFeatureActions {
    const hints = { line: t('game.hint.lot.line'), curve: t('game.hint.lot.curve') };
    const enter = (m: 'line' | 'curve') => { this.h.setTool('building'); this.lotExtra = m; this.lotExtraPts = []; this.h.hud.setHint(hints[m]); };
    return {
      lotLine: () => enter('line'),
      lotCurve: () => enter('curve'),
      lotExtraOff: () => { this.lotExtra = null; this.lotExtraPts = []; },
      renovate: () => this.renovate(this.h.selected),
      decayOf: () => this.h.selected >= 0 && this.h.world.buildings.alive[this.h.selected] ? this.h.world.buildings.cols.decay[this.h.selected] / 10 : -1,
      addressOf: () => {
        const id = this.h.selected, w = this.h.world, c = w.buildings.cols;
        if (id < 0 || !w.buildings.alive[id]) return '';
        // the door: middle of the lot's front
        const [x, z] = lotToWorld({ x: c.x[id], z: c.z[id], rot: c.rot[id] }, 0, c.d[id] / 2);
        const a = addressAt(w, x, z);
        return a ? `${a.name}, ${a.number}` : '';
      },
      streetNameAt: (x, z) => { const a = addressAt(this.h.world, x, z, 30); return a ? a.name : ''; },
      impossibleNodes: () => this.h.world.impossible.count,
      impossibleAngle: (n) => this.h.world.impossible.angleAt(n),
      impossibleList: () => { const nc = this.h.world.roads.nodes.cols, out: number[] = []; for (const [n, a] of this.h.world.impossible.nodes) out.push(n, nc.x[n], nc.z[n], a); return out; },
    };
  }

  /** Split by line or curve side: the second click does it. */
  clickLotExtra(hit: THREE.Vector3): void {
    const pts = this.lotExtraPts;
    pts.push([hit.x, hit.z]);
    if (pts.length < 2) return;
    const [[ax, az], [bx, bz]] = pts;
    this.lotExtraPts = [];
    let r: RoadJournal | string;
    if (this.lotExtra === 'line') {
      // the lot the line crosses: under its middle, or under either end
      r = splitLotsByLine(this.h.world, ax, az, bx, bz);
    } else {
      const id = lotAt(this.h.world, ax, az);
      r = id < 0 ? t('game.refuse.curveFirst') : curveLotSide(this.h.world, id, ax, az, bx, bz);
    }
    if (typeof r === 'string') { this.h.hud.toast(r[0].toUpperCase() + r.slice(1) + '.'); return; }
    this.h.commands.push(r);
    this.h.hud.toast(this.lotExtra === 'line' ? t('game.toast.lotSplitLine') : t('game.toast.sideCurved'));
  }

  /** Renovation (Roadcraft Shift+click): the building is new again; undo brings the old age back. */
  renovate(id: number): void {
    const w = this.h.world;
    if (id < 0 || !w.buildings.alive[id] || w.buildings.cols.floors[id] === 0) { this.h.hud.toast(t('game.toast.renovatePick')); return; }
    const before = w.buildings.cols.built[id], now = w.clock;
    if (w.buildings.cols.decay[id] === 0 && now - before < 1) { this.h.hud.toast(t('game.toast.alreadyNew')); return; }
    this.h.commands.run({
      label: 'reformar prédio',
      apply: () => { if (w.buildings.alive[id]) w.setBuilt(id, now); },
      invert: () => { if (w.buildings.alive[id]) w.setBuilt(id, before); },
    });
    this.h.hud.toast(t('game.toast.renovated'));
  }

  clickBuilding(hit: THREE.Vector3 | null, shift = false): void {
    if (!hit) return;
    if (this.lotExtra) { this.clickLotExtra(hit); return; }
    if (this.lotMode !== 'edit' && this.lotMode !== 'rect') { this.clickLotTool(hit); return; }
    if (this.lotPts) { this.clickLot(hit); return; }
    // building under the click?
    const col = this.h.world.buildings.cols;
    let best = -1, bd = Infinity;
    this.h.world.buildingIndex.query(hit.x - 40, hit.z - 40, hit.x + 40, hit.z + 40, (id) => {
      const dx = hit.x - col.x[id], dz = hit.z - col.z[id];
      const s = Math.sin(col.rot[id]), c = Math.cos(col.rot[id]);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= col.w[id] / 2 + 1 && Math.abs(lz) <= col.d[id] / 2 + 1) {
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = id; }
      }
    });
    if (best >= 0) { if (shift) this.renovate(best); this.h.select(best); return; }
    // free lot: build
    const lot = this.h.growth.lotAt(hit.x, hit.z);
    if (!lot) { this.h.hud.toast(t('game.toast.buildWhere')); return; }
    const j = new RoadJournal(this.h.world, 'construir prédio');
    // the style and function chosen for the next building (the Build panel) win over the neighbourhood's
    const rec = this.h.growth.recordFor(lot.lots, lot.i);
    if (this.newArch >= 0) rec.style = 128 + this.newArch;
    if (this.newFn > 0) rec.fn = this.newFn;
    const id = j.addBuilding(rec);
    this.h.commands.push(j);
    this.h.select(id);
  }

  /** Changes floors, style (−1 = automatic) and function of the selected building. */
  editSelected(dFloors: number, arch?: number, fn?: number): void {
    const id = this.h.selected;
    if (id < 0 || !this.h.world.buildings.alive[id]) return;
    const col = this.h.world.buildings.cols;
    const from = [col.floors[id], col.style[id], col.fn[id]];
    const style = arch === undefined ? col.style[id] : arch < 0 ? col.seed[id] & 127 : 128 + arch;
    const to = [Math.max(1, Math.min(60, col.floors[id] + dFloors)), style, fn ?? col.fn[id]];
    if (from.every((v, i) => v === to[i])) return;
    const world = this.h.world;
    this.h.commands.run({
      label: 'editar prédio',
      apply: () => { if (world.buildings.alive[id]) world.editBuilding(id, to[0], to[1], to[2]); },
      invert: () => { if (world.buildings.alive[id]) world.editBuilding(id, from[0], from[1], from[2]); },
    });
    this.h.select(id);
  }

  /** Inside view: the selected building, or the one at the centre of the screen; floor up and down. */
  insideCmd(c: 'toggle' | 'up' | 'down'): void {
    const w = this.h.world, col = w.buildings.cols;
    if (c === 'toggle' && this.h.inside.on) { this.h.inside.hide(); this.h.insideId = -1; this.h.hud.setInside(-1); return; }
    if (c === 'toggle') {
      // the selected building when it is in view; otherwise the one at the centre of the screen; otherwise the
      // selected one, and the camera goes to it
      const { id, go } = insideTarget(w, this.h.selected, this.h.rig.target.x, this.h.rig.target.z, this.h.rig.dist);
      if (go) { const s = this.h.rig.state(); s[0] = col.x[id]; s[1] = col.z[id]; this.h.rig.restore(s); }
      if (id < 0 || col.floors[id] === 0) { this.h.hud.toast(t('game.toast.insideNone')); return; }
      this.h.insideId = id;
      this.h.insideFloor = 0;
    } else if (!this.h.inside.on) return;
    else this.h.insideFloor += c === 'up' ? 1 : -1;
    // the storeys, the footprint and the floor height of that building as the generator lays it out
    if (!this.h.inside.showBuilding(w, this.h.insideId, Math.max(0, this.h.insideFloor))) { this.h.insideId = -1; this.h.hud.setInside(-1); return; }
    this.h.insideFloor = this.h.inside.plan!.floor;
    this.h.hud.setInside(this.h.insideFloor);
  }

  /** Creator: puts (or removes) the design on the selected building; optional floors (ready-made model). */
  applyDesign(d: Design | null, floors?: number): void {
    const id = this.h.selected;
    if (id < 0 || !this.h.world.buildings.alive[id]) { this.h.hud.toast(t('game.toast.selectFirst')); return; }
    const col = this.h.world.buildings.cols, w = this.h.world;
    const before = [col.color[id], col.h[id], col.floors[id]];
    const enc = d ? encodeDesign(d) : { color: 0, h: 0 };
    const after = [enc.color, enc.h, Math.max(1, Math.min(60, floors ?? col.floors[id]))];
    if (before.every((v, i) => v === after[i])) return;
    this.h.commands.run({
      label: 'projeto do prédio',
      apply: () => { if (w.buildings.alive[id]) w.setDesign(id, after[0], after[1], after[2]); },
      invert: () => { if (w.buildings.alive[id]) w.setDesign(id, before[0], before[1], before[2]); },
    });
    this.h.select(id);
  }

  demolishSelected(): void {
    const id = this.h.selected;
    if (id < 0 || !this.h.world.buildings.alive[id]) return;
    const j = new RoadJournal(this.h.world, 'demolir prédio');
    j.removeBuilding(id);
    this.h.commands.push(j);
    this.h.select(-1);
  }

}
