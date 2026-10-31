// Streetscape (objects on the sidewalk or the ground) and Barriers (runs of wall, fence,
// hedge, guardrail and railing). Near a road the point snaps to the sidewalk:
// objects next to the curb, barriers at the back of the sidewalk.

import type * as THREE from 'three/webgpu';
import type { Command, CommandStack } from '../../core/commands.ts';
import { SIGN_STOP, signRuleCommand } from '../../roads/signRule.ts';
import { addressAt } from '../../roads/streetNames.ts';
import { bez, bezD } from '../../roads/geometry.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import { SegFlag } from '../../roads/flags.ts';
import type { RoadPreview } from '../../render/preview.ts';
import type { Hud } from '../../ui/hud.ts';
import { heightAt } from '../../world/heights.ts';
import { waterAt } from '../../world/ground.ts';
import { Item, ItemsCommand, MAX_RUN, isBarrier, isEffect } from '../../world/items.ts';
import { RoadGround, roadGroundAt } from '../../roads/ground.ts';
import { t } from '../../shared/i18n/index.ts';
import type { World } from '../../world/world.ts';
import { NO_SEG, type SegId } from '../../core/ids.ts';

const p2 = new Float64Array(2), d2 = new Float64Array(2);

/** Every this many metres the drawn line is checked against the ground and the water (the wire is continuous too). */
const POLE_CHECK = 4;

/** Two commands already applied, as one undo step. */
function both(a: Command, b: Command): Command {
  return { label: a.label, apply: () => { a.apply(); b.apply(); }, invert: () => { b.invert(); a.invert(); } };
}
const isElement = isEffect;

interface Spot { x: number; z: number; y: number; yaw: number; onWalk: boolean }

export class ItemTool {
  mode: 'streetscape' | 'barrier' = 'streetscape';
  item: number = Item.Tree;
  sign = 4;
  /** Text of the next sign (street name, information, direction). */
  signText = '';
  /** Called when a sign with text is placed (text, position, nearest segment). */
  onText: ((text: string, x: number, z: number, seg: SegId, street: boolean) => void) | null = null;
  barrier: number = Item.Fence;
  /** Lights on the wired poles: 0 none, 1 on alternate poles, 2 on all. */
  poleLights = 0;
  private last: { x: number; z: number } | null = null;
  /** Runs of the open trace, newest last, each with the point it started from (Backspace takes them back). */
  private runs: Array<{ cmd: Command; from: { x: number; z: number } }> = [];
  private world: World;
  private commands: CommandStack;
  private preview: RoadPreview;
  private hud: Hud;

  constructor(world: World, commands: CommandStack, preview: RoadPreview, hud: Hud) {
    this.world = world; this.commands = commands; this.preview = preview; this.hud = hud;
  }

  setMode(m: 'streetscape' | 'barrier'): void { this.mode = m; this.cancel(); }

  /** A wall is being traced: its first point is down and Enter, Esc or a double click ends it. */
  get open(): boolean { return this.last !== null; }

  cancel(showHint = true): void {
    if (this.last) this.commands.endGroup();
    this.last = null;
    this.runs.length = 0;
    this.preview.hideAll();
    if (showHint) this.hint();
  }

  hint(): void {
    if (this.mode === 'streetscape') this.hud.setHint('Clique numa calçada (ou no chão) para pôr o item escolhido; arraste ao longo dela para uma fileira. Shift+clique remove.');
    else this.hud.setHint(this.last ? 'Clique para continuar o traço; Enter ou Esc termina, Backspace volta um ponto.' : 'Clique para começar o traço. Perto de uma via ele vai para as costas da calçada. Shift+clique remove.');
  }

  /** Snapped point: on the sidewalk (curb side for objects, back for barriers) or free on the ground. */
  private spot(x: number, z: number, back: boolean): Spot {
    const net = this.world.roads, sc = net.segs.cols, nc = net.nodes.cols;
    const near = net.nearestSeg(x, z, 30);
    const ground = heightAt(this.world.heights, x, z);
    if (near && !(sc.flags[near[0]] & SegFlag.Ring)) {
      const s = near[0], t = near[1];
      const q = net.quad(s);
      bez(q, t, p2); bezD(q, t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      const tx = d2[0] / l, tz = d2[1] / l, lx = tz, lz = -tx;
      const u = (x - p2[0]) * lx + (z - p2[1]) * lz;
      const info = PROFILE_INFO[sc.profile[s]];
      const e = u > 0 ? info.edges[info.edges.length - 1] : info.edges[0];
      const outer = u > 0 ? e.u1 : e.u0;
      if (Math.abs(u) < Math.abs(outer) + (back ? 5 : 1.5) && e.strip.kind === 'sidewalk') {
        const wu = back ? outer - Math.sign(u) * 0.25 : (u > 0 ? e.u0 + 0.5 : e.u1 - 0.5);
        const y = nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * t + (e.strip.flush ? 0 : 0.15);
        // objects face the street; a sign faces traffic coming on that side
        const yaw = this.item === Item.Sign && !back ? (u > 0 ? Math.atan2(tx, tz) : Math.atan2(-tx, -tz)) : Math.atan2(-lx * Math.sign(u), -lz * Math.sign(u));
        return { x: p2[0] + lx * wu, z: p2[1] + lz * wu, y, yaw, onWalk: true };
      }
    }
    return { x, z, y: ground, yaw: 0, onWalk: false };
  }

  hover(hit: THREE.Vector3 | null): void {
    const pv = this.preview;
    if (!hit) { pv.hideAll(); return; }
    const sp = this.spot(hit.x, hit.z, this.mode === 'barrier');
    pv.showMarker(sp.x, sp.y, sp.z, 0.8, sp.onWalk ? 'seg' : 'free');
    if (this.mode === 'barrier' && this.last) {
      const a = this.last;
      const ya = heightAt(this.world.heights, a.x, a.z);
      pv.show({ x0: a.x, z0: a.z, cx: (a.x + sp.x) / 2, cz: (a.z + sp.z) / 2, x1: sp.x, z1: sp.z }, 0.3, [0, 1], [ya + 0.5, sp.y + 0.5], true, 0xffd36b);
    } else pv.hide();
  }

  click(hit: THREE.Vector3 | null, shift: boolean): void {
    if (!hit) return;
    const items = this.world.items;
    if (shift) {
      const id = items.nearest(hit.x, hit.z, 3);
      if (id >= 0 && isBarrier(items.t.cols.type[id]) === (this.mode === 'barrier')) {
        const ic = items.t.cols, sx = ic.x0[id], sz = ic.z0[id], kind = ic.type[id], variant = ic.variant[id];
        const c = new ItemsCommand(items, 'remover item');
        c.remove(id);
        // a Stop/Give-way sign taken away gives its junction arm back to the automatic rule
        const rule = kind === Item.Sign ? signRuleCommand(this.world, sx, sz, variant, false) : '';
        if (typeof rule !== 'string') { rule.apply(); this.commands.push(both(c, rule)); } else this.commands.push(c);
      }
      return;
    }
    if (this.mode === 'streetscape') {
      const sp = this.spot(hit.x, hit.z, false);
      if (this.onCarriageway(sp)) { this.hud.toast(t('tools.item.notOnRoad')); return; }
      const c = new ItemsCommand(items, 'pôr item');
      // objects: x1 = heading, z1 = height (0 = from the ground)
      // elements (smoke, fire…): variant = strength
      c.add([sp.x, sp.z, sp.yaw, sp.onWalk ? sp.y : 0, this.item, this.item === Item.Sign ? this.sign : isElement(this.item) ? 4 : 0]);
      // "a sign is a rule": a Stop/Give-way sign next to a junction arm sets that arm's rule (one undo for both)
      const rule = this.item === Item.Sign ? signRuleCommand(this.world, sp.x, sp.z, this.sign, true) : '';
      if (typeof rule !== 'string') { rule.apply(); this.commands.push(both(c, rule)); this.hud.toast(this.sign === SIGN_STOP ? 'Placa de Pare: quem chega por esta via para no cruzamento.' : 'Dê a preferência: quem chega por esta via dá a vez no cruzamento.'); }
      else { this.commands.push(c); if (rule) this.hud.toast(rule[0].toUpperCase() + rule.slice(1) + '.'); }
      if (this.item === Item.Sign && this.signText.trim()) {
        const near = this.world.roads.nearestSeg(sp.x, sp.z, 30);
        this.onText?.(this.signText.trim().slice(0, 32), sp.x, sp.z, near ? near[0] : NO_SEG, this.sign === 2);
      } else if (this.item === Item.Sign && this.sign === 2) {
        // street sign without a typed name: it shows the street's name (generated or the one the player gave)
        const name = addressAt(this.world, sp.x, sp.z, 30)?.name;
        if (name) this.onText?.(name, sp.x, sp.z, NO_SEG, false);
      }
      return;
    }
    const sp = this.spot(hit.x, hit.z, true);
    if (!this.last) {
      if (this.barrier === Item.PoleLine && !this.poleGround(sp)) return;
      this.last = { x: sp.x, z: sp.z }; this.hint(); return;
    }
    const a = this.last;
    const L = Math.hypot(sp.x - a.x, sp.z - a.z);
    if (L < 0.5) return;
    if (this.barrier === Item.PoleLine) {
      if (!this.poleGround(sp) || !this.poleRunGround(a, sp)) return;
      // The run keeps its ends on the footway; the props job puts a pole every 32 m and the wires between them.
      const c = new ItemsCommand(items, 'postes com fios');
      c.add([a.x, a.z, sp.x, sp.z, Item.PoleLine, this.poleLights]);
      this.commands.push(c);
      this.runs.push({ cmd: c, from: a });
      this.last = { x: sp.x, z: sp.z };
      return;
    }
    const c = new ItemsCommand(items, 'muro');
    const n = Math.ceil(L / MAX_RUN);
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      c.add([a.x + (sp.x - a.x) * t0, a.z + (sp.z - a.z) * t0, a.x + (sp.x - a.x) * t1, a.z + (sp.z - a.z) * t1, this.barrier, 0]);
    }
    this.commands.push(c);
    this.runs.push({ cmd: c, from: a });
    this.last = { x: sp.x, z: sp.z };
  }

  /** Spacing between items in a row (m), by type. */
  private static spacing(t: number): number {
    const S: Record<number, number> = { [Item.Tree]: 9, [Item.Conifer]: 8, [Item.Palm]: 10, [Item.Bush]: 4, [Item.Bench]: 14, [Item.Bin]: 22, [Item.Lamp]: 25,
      [Item.Hydrant]: 60, [Item.Postbox]: 60, [Item.Phone]: 50, [Item.Drain]: 30, [Item.Bollard]: 2.5, [Item.Planter]: 6, [Item.Sign]: 40 };
    return S[t] ?? 10;
  }

  /** A pole must stand on the footway and above the water, never on the carriageway or in a river. */
  private poleGround(sp: Spot): boolean {
    if (!sp.onWalk) { this.hud.toast('Postes vão na calçada.'); return false; }
    const ground = heightAt(this.world.heights, sp.x, sp.z);
    if (waterAt(this.world.water, sp.x, sp.z) > ground - 0.5) { this.hud.toast('Não dá para pôr postes na água.'); return false; }
    return true;
  }

  /** Every pole and wire in the run must stay on firm footway, not only its two ends. */
  private poleRunGround(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / POLE_CHECK));
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (!this.poleGround(this.spot(x, z, true))) return false;
    }
    return true;
  }

  /** A pole run from the page/tests: same validation and command as the tool. */
  placePoleLine(ax: number, az: number, bx: number, bz: number, lights = 0): boolean {
    this.mode = 'barrier'; this.barrier = Item.PoleLine; this.poleLights = lights;
    const a = this.spot(ax, az, true), b = this.spot(bx, bz, true);
    if (!this.poleGround(a) || !this.poleGround(b) || !this.poleRunGround(a, b)) return false;
    const c = new ItemsCommand(this.world.items, 'postes com fios');
    c.add([a.x, a.z, b.x, b.z, Item.PoleLine, lights]);
    this.commands.push(c);
    return true;
  }

  /** Nothing stands on a carriageway (the owner, 2026-10-30): only a spot off the sidewalk can fall there. */
  private onCarriageway(sp: { x: number; z: number; onWalk: boolean }): boolean {
    return !sp.onWalk && roadGroundAt(this.world.roads, sp.x, sp.z) === RoadGround.Carriageway;
  }

  /** Row of the chosen item from a to b, each snapped to the sidewalk (a single command). */
  row(ax: number, az: number, bx: number, bz: number): number {
    const L = Math.hypot(bx - ax, bz - az);
    const step = ItemTool.spacing(this.item);
    const n = Math.max(1, Math.floor(L / step) + 1);
    const c = new ItemsCommand(this.world.items, 'fileira');
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i * step / L;
      const sp = this.spot(ax + (bx - ax) * t, az + (bz - az) * t, false);
      if (this.world.items.nearest(sp.x, sp.z, Math.min(1.5, step * 0.5)) >= 0 || this.onCarriageway(sp)) continue;
      c.add([sp.x, sp.z, sp.yaw, sp.onWalk ? sp.y : 0, this.item, this.item === Item.Sign ? this.sign : isElement(this.item) ? 4 : 0]);
    }
    if (!c.empty) { this.commands.push(c); this.hud.toast('Fileira posta ao longo da calçada.'); }
    return n;
  }

  /** Row preview: the line and the first point. */
  hoverRow(ax: number, az: number, hit: THREE.Vector3 | null): void {
    if (!hit) return;
    const a = this.spot(ax, az, false), b = this.spot(hit.x, hit.z, false);
    this.preview.show({ x0: a.x, z0: a.z, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, x1: b.x, z1: b.z }, 0.5, [0, 1], [a.y + 0.4, b.y + 0.4], true, 0x4cd28a);
  }

  /**
   * Backspace: takes back the trace's last run and goes on from where it began. Only the tool's own run: if another
   * command came after it, the trace just ends and nothing is undone.
   */
  back(): void {
    if (!this.last) return;
    const r = this.runs[this.runs.length - 1];
    if (!r || this.commands.top !== r.cmd) { this.runs.length = 0; this.last = null; this.hint(); return; }
    if (!this.commands.undo()) return;
    this.runs.pop();
    this.last = r.from;
    this.hint();
  }
}
