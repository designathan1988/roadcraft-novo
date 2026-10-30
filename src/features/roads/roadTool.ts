// Road tools: draw straight or curved roads one after another, roundabout, change
// profile and demolish. Every valid click becomes a command in the history.

import type * as THREE from 'three/webgpu';
import type { CommandStack } from '../../core/commands.ts';
import { RoadJournal, buildRoad, buildRoundabout, planPrice, roundaboutRefusal, changeProfile, changeProfiles, moveNode, splitAt, streetChain, planRoad, segPreview, snap, type Anchor, type RoadPlan } from '../../roads/build.ts';
import { bez, type Quad } from '../../roads/geometry.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import { registerVariant, type RoadOptions } from '../../roads/roadVariant.ts';
import { SegFlag } from '../../roads/flags.ts';
import type { RoadPreview } from '../../render/preview.ts';
import type { Hud, Tool } from '../../ui/hud.ts';
import { heightAt } from '../../world/heights.ts';
import { demolishTarget, targetAt, type Target } from '../demolition/demolish.ts';
import { lotToWorld } from '../../world/lotEdit.ts';
import type { World } from '../../world/world.ts';
import { money, t } from '../../shared/i18n/index.ts';
import { NO_NODE, NO_SEG } from '../../core/ids.ts';

const p2 = new Float64Array(2);

export class RoadTool {
  mode: Tool = 'road';
  /** The profile roads are drawn with: the road picked, or its variant by the options below. */
  profile = 0;
  /** The road picked (catalogue, eyedropper, class card). */
  base = 0;
  /** Lanes, total width and parking the next road is drawn with (Roadcraft 4.0's road tool options); null: the road's own. */
  readonly options: RoadOptions = { lanes: null, width: null, parking: null };
  elevation = 0;
  ringRadius = 22;
  private start: Anchor | null = null;
  private control: { x: number; z: number } | null = null;
  private plan: RoadPlan | null = null;
  private hoverSeg = NO_SEG;
  private hoverT = 0.5;
  private target: Target = null;
  /** Snapping: 0 off, 1 angles of 15°, 2 angles and a 1 m grid. */
  snapMode = 0;
  /** Street furniture of new roads: 0 full, 1 basic, 2 none. */
  furniture = 0;
  /** Cut with a retaining wall (otherwise a slope). */
  cutWalls = false;
  /** Blocks at once: columns, rows, block side (m) and turn (degrees). */
  blocks = { cols: 3, rows: 3, size: 100, angle: 0 };
  /** Shift is held (the roundabout preview shows whether it may cut roads in). */
  shiftHeld = false;
  /** Move node: the node being dragged (−1 = none). */
  moving = NO_NODE;
  private world: World;
  private commands: CommandStack;
  private preview: RoadPreview;
  private hud: Hud;

  constructor(world: World, commands: CommandStack, preview: RoadPreview, hud: Hud) {
    this.world = world;
    this.commands = commands;
    this.preview = preview;
    this.hud = hud;
  }

  setMode(m: Tool): void {
    this.mode = m;
    this.cancel();
  }

  cancel(): void {
    this.start = null;
    this.control = null;
    this.plan = null;
    this.moving = NO_NODE;
    this.freePts = [];
    this.preview.hideAll();
    this.updateHint();
  }

  get busy(): boolean { return this.start !== null; }

  private updateHint(): void {
    const h = this.hud;
    switch (this.mode) {
      case 'road': h.setHint(this.start ? 'Clique para terminar o trecho (continua a partir dele). Esc encerra.' : 'Clique para começar a via.'); break;
      case 'curve': h.setHint(!this.start ? 'Clique para começar a curva.' : !this.control ? 'Clique para o ponto de controle da curva.' : 'Clique para terminar a curva.'); break;
      case 'roundabout': h.setHint(`Clique para pôr uma rotatória (raio ${this.ringRadius} m; [ e ] mudam o raio).`); break;
      case 'upgrade': h.setHint(`Clique numa via para trocar para "${PROFILE_INFO[this.profile].name}" (Shift: a rua inteira; Alt: copiar o perfil da via).`); break;
      case 'bulldoze': h.setHint('Clique numa via, prédio, item ou muro para demolir; arraste para demolir tudo num retângulo.'); break;
      case 'move': h.setHint(this.moving >= 0 ? 'Solte onde o nó deve ficar; as vias ligadas acompanham. Esc cancela.' : 'Arraste um nó (ponta ou cruzamento) para mudá-lo de lugar.'); break;
      case 'free': h.setHint('Arraste para desenhar a via livre: ela segue o cursor em curvas suaves; solte para construir.'); break;
      case 'blocks': h.setHint('Clique para construir a grade de quarteirões com o perfil escolhido (colunas, linhas, quadra e giro no painel).'); break;
      case 'split': h.setHint('Clique numa via para dividi-la em duas naquele ponto.'); break;
      default: h.setHint('');
    }
  }

  private snapRadius(): number { return Math.max(8, PROFILE_INFO[this.profile].right + 2); }

  private anchorY(a: Anchor): number {
    const net = this.world.roads;
    if (a.node >= 0) return net.nodes.cols.y[a.node];
    return heightAt(this.world.heights, a.x, a.z);
  }

  /** Updates the preview with the cursor at hit (or nothing). */
  hover(hit: THREE.Vector3 | null): void {
    const pv = this.preview;
    if (!hit) { pv.hideAll(); return; }
    const net = this.world.roads;
    if (this.mode === 'blocks') {
      const { cols, rows, size } = this.blocks;
      pv.hide(); pv.marker.visible = false;
      pv.showCircle(hit.x, heightAt(this.world.heights, hit.x, hit.z), hit.z, Math.hypot(cols, rows) * size / 2, true);
      return;
    }
    if (this.mode === 'move') {
      const nc = net.nodes.cols;
      pv.hide();
      if (this.moving >= 0) {
        pv.showCircle(hit.x, heightAt(this.world.heights, hit.x, hit.z), hit.z, 6, true);
        pv.showMarker(nc.x[this.moving], nc.y[this.moving], nc.z[this.moving], 1.2, 'node');
        return;
      }
      const n = net.nearestNode(hit.x, hit.z, 14);
      pv.circle.visible = false;
      if (n >= 0) pv.showMarker(nc.x[n], nc.y[n], nc.z[n], 1.6, 'node'); else pv.marker.visible = false;
      return;
    }
    if (this.mode === 'split') {
      const s = net.nearestSeg(hit.x, hit.z, 14);
      this.hoverSeg = s ? s[0] : NO_SEG;
      if (s) { this.hoverT = s[1]; const p = new Float64Array(2); bez(net.quad(s[0]), s[1], p); pv.showMarker(p[0], heightAt(this.world.heights, p[0], p[1]) + 0.3, p[1], 1.4, 'seg'); }
      else pv.marker.visible = false;
      pv.hide();
      return;
    }
    if (this.mode === 'bulldoze') {
      // an item or wall nearby, a building, or a road: what the click takes away
      const t = this.target = targetAt(this.world, hit.x, hit.z);
      pv.marker.visible = false; pv.circle.visible = false;
      if (!t) { pv.hide(); return; }
      if (t.kind === 'seg') { const sp = segPreview(net, t.id); pv.show(sp.quad, sp.half, [0, 1], [sp.ya, sp.yb], true, 0xe2564b); return; }
      pv.hide();
      if (t.kind === 'item') { const c = this.world.items.t.cols; pv.showMarker(c.x0[t.id], heightAt(this.world.heights, c.x0[t.id], c.z0[t.id]) + 0.5, c.z0[t.id], 1.4, 'free'); return; }
      const col = this.world.buildings.cols, r = { x: col.x[t.id], z: col.z[t.id], rot: col.rot[t.id] };
      const [fx, fz] = lotToWorld(r, 0, col.d[t.id] / 2), [bx, bz] = lotToWorld(r, 0, -col.d[t.id] / 2);
      const H = (x: number, z: number) => heightAt(this.world.heights, x, z) + 0.8;
      pv.show({ x0: fx, z0: fz, cx: r.x, cz: r.z, x1: bx, z1: bz }, col.w[t.id] / 2 + 1, [0, 1], [H(fx, fz), H(bx, bz)], true, 0xe2564b);
      return;
    }
    if (this.mode === 'upgrade') {
      const s = net.nearestSeg(hit.x, hit.z, 14);
      this.hoverSeg = s ? s[0] : NO_SEG;
      pv.marker.visible = false;
      if (this.hoverSeg < 0) { pv.hide(); return; }
      const sp = segPreview(net, this.hoverSeg);
      const half = PROFILE_INFO[this.profile].right;
      pv.show(sp.quad, half, [0, 1], [sp.ya, sp.yb], true, 0x5aa8ff);
      return;
    }
    if (this.mode === 'roundabout') {
      const a = snap(net, hit.x, hit.z, 14);
      pv.hide();
      pv.showCircle(a.x, this.anchorY(a), a.z, this.ringRadius, !roundaboutRefusal(this.world, a.x, a.z, this.ringRadius, a.node >= 0 || this.shiftHeld));
      pv.showMarker(a.x, this.anchorY(a), a.z, 1.2, a.node >= 0 ? 'node' : a.seg >= 0 ? 'seg' : 'free');
      return;
    }
    // road: straight or curved
    const a = this.guide(snap(net, hit.x, hit.z, this.snapRadius()));
    const ay = this.anchorY(a);
    pv.showMarker(a.x, ay, a.z, PROFILE_INFO[this.profile].right * 0.6, a.node >= 0 ? 'node' : a.seg >= 0 ? 'seg' : 'free');
    if (!this.start) { pv.hide(); this.plan = null; return; }
    if (this.mode === 'curve' && !this.control) {
      // still choosing the control point: shows the straight line to the cursor
      this.plan = planRoad(this.world, this.start, null, { ...a, node: NO_NODE, seg: NO_SEG }, this.profile, this.elevation);
    } else {
      this.plan = planRoad(this.world, this.start, this.control, a, this.profile, this.elevation);
    }
    const p = this.plan;
    pv.show(p.quad, PROFILE_INFO[this.profile].right, p.profile.at, p.profile.y, p.ok);
    // what it will cost, while the player aims (the same pieces and build kinds as the journal will charge)
    if (p.ok && (this.mode !== 'curve' || this.control)) this.hud.setHint(t('road.preview.cost', { price: money(this.world.unlimited ? 0 : planPrice(this.world, p, this.profile)) }));
  }

  /** Eyedropper: takes the profile of the road under the cursor. Returns the id, or -1. */
  pick(hit: THREE.Vector3 | null): number {
    if (!hit) return -1;
    const s = this.world.roads.nearestSeg(hit.x, hit.z, 14);
    if (!s || (this.world.roads.segs.cols.flags[s[0]] & 1)) return -1;
    const p = this.world.roads.segs.cols.profile[s[0]];
    this.setProfile(p);
    return p;
  }

  click(hit: THREE.Vector3 | null, shift = false): void {
    if (!hit) return;
    const net = this.world.roads;
    if (this.mode === 'bulldoze') {
      const t = this.target ?? targetAt(this.world, hit.x, hit.z);
      this.target = null;
      if (!t) return;
      const alive = t.kind === 'item' ? this.world.items.t.alive[t.id] : t.kind === 'building' ? this.world.buildings.alive[t.id] : net.segs.alive[t.id];
      if (!alive) return;
      const { cmd, charge } = demolishTarget(this.world, t);
      this.commands.push(cmd);
      if (charge < 0) this.hud.toast(`Devolvido R$ ${(-charge).toLocaleString('pt-BR')}`);
      this.preview.hideAll();
      return;
    }
    if (this.mode === 'blocks') { this.buildBlocks(hit.x, hit.z); return; }
    if (this.mode === 'split') {
      if (this.hoverSeg >= 0 && net.segs.alive[this.hoverSeg]) {
        const j = splitAt(this.world, this.hoverSeg, this.hoverT);
        if (j.empty) this.hud.toast('Perto demais da ponta: clique mais para o meio.'); else this.commit(j);
      }
      return;
    }
    if (this.mode === 'upgrade') {
      if (this.hoverSeg >= 0 && net.segs.alive[this.hoverSeg]) {
        // Shift: the whole street (follows it through the junctions)
        const j = shift ? changeProfiles(this.world, streetChain(this.world, this.hoverSeg), this.profile) : changeProfile(this.world, this.hoverSeg, this.profile);
        this.commit(j);
      }
      return;
    }
    if (this.mode === 'roundabout') {
      const a = snap(net, hit.x, hit.z, 14);
      // on vacant ground it brings its own approaches; roads in the circle are cut in only when asked: Shift, or a
      // click on a junction (turning it into a roundabout)
      const cut = shift || a.node >= 0;
      const why = roundaboutRefusal(this.world, a.x, a.z, this.ringRadius, cut);
      const j = why ? null : buildRoundabout(this.world, a.x, a.z, this.ringRadius, cut);
      if (!j) this.hud.toast(why || 'Já existe uma rotatória aqui.');
      else this.commit(j);
      return;
    }
    const a = this.guide(snap(net, hit.x, hit.z, this.snapRadius()));
    if (!this.start) { this.start = a; this.updateHint(); return; }
    if (this.mode === 'curve' && !this.control) { this.control = { x: a.x, z: a.z }; this.updateHint(); return; }
    const plan = planRoad(this.world, this.start, this.control, a, this.profile, this.elevation);
    if (!plan.ok) { this.hud.toast(`Não dá para construir aqui: ${plan.reason}.`); return; }
    const j = buildRoad(this.world, plan, this.start, a, this.profile, this.segFlags());
    if (!this.commit(j)) return;
    // goes on from the end of the segment
    const q: Quad = plan.quad;
    bez(q, 1, p2);
    this.start = snap(net, p2[0], p2[1], 1.5);
    this.control = null;
    this.updateHint();
  }

  /** Charges and records; without the money it undoes itself and says so. */
  private commit(j: RoadJournal): boolean {
    if (j.empty) return true;
    const price = j.price;
    if (!j.settle()) { this.hud.toast(`Dinheiro insuficiente: custa R$ ${price.toLocaleString('pt-BR')}.`); return false; }
    this.commands.push(j);
    if (j.charge !== 0) this.hud.toast(j.charge > 0 ? `− R$ ${j.charge.toLocaleString('pt-BR')}` : `Devolvido R$ ${(-j.charge).toLocaleString('pt-BR')}`);
    return true;
  }

  /** Bits of new roads: furniture and cut. */
  segFlags(): number { return (this.furniture << SegFlag.FurnShift) | (this.cutWalls ? SegFlag.Wall : 0); }

  /** Snapping of a free point: whole-metre length and a heading in steps of 15° from the start; with no start, to the grid. */
  private guide(a: Anchor): Anchor {
    if (this.snapMode === 0 || a.node >= 0 || a.seg >= 0) return a;
    if (!this.start) return this.snapMode === 2 ? { ...a, x: Math.round(a.x), z: Math.round(a.z) } : a;
    const sx = this.start.x, sz = this.start.z;
    const step = Math.PI / 12;
    const ang = Math.round(Math.atan2(a.z - sz, a.x - sx) / step) * step;
    let L = Math.hypot(a.x - sx, a.z - sz);
    if (this.snapMode === 2) L = Math.round(L);
    return { ...a, x: sx + Math.cos(ang) * L, z: sz + Math.sin(ang) * L };
  }

  /** Free drawing: the points of the drag (every ~24 m). */
  private freePts: Array<[number, number]> = [];

  freeBegin(hit: THREE.Vector3 | null): boolean {
    if (!hit) return false;
    const a = snap(this.world.roads, hit.x, hit.z, this.snapRadius());
    this.freePts = [[a.x, a.z]];
    return true;
  }

  freeMove(hit: THREE.Vector3 | null): void {
    if (!hit || !this.freePts.length) return;
    const [lx, lz] = this.freePts[this.freePts.length - 1];
    if (Math.hypot(hit.x - lx, hit.z - lz) >= 24) this.freePts.push([hit.x, hit.z]);
    // preview: the last piece up to the cursor
    const net = this.world.roads;
    const a = { x: lx, z: lz, node: NO_NODE, seg: NO_SEG, t: 0 };
    const b = snap(net, hit.x, hit.z, this.snapRadius());
    const plan = planRoad(this.world, a, null, { ...b, node: NO_NODE, seg: NO_SEG }, this.profile, this.elevation);
    this.preview.show(plan.quad, PROFILE_INFO[this.profile].right, plan.profile.at, plan.profile.y, plan.ok);
  }

  /** Release: the road through the points, curving through the midpoints (each piece runs midpoint to midpoint, control at the point). */
  freeEnd(hit: THREE.Vector3 | null): void {
    const pts = this.freePts;
    this.freePts = [];
    this.preview.hideAll();
    if (hit) { const [lx, lz] = pts[pts.length - 1] ?? [hit.x, hit.z]; if (Math.hypot(hit.x - lx, hit.z - lz) > 6) pts.push([hit.x, hit.z]); }
    if (pts.length < 2) return;
    const net = this.world.roads;
    const total = new RoadJournal(this.world, 'construir via');
    const mid = (i: number): [number, number] => [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    // pieces: p0 → m0 (straight), m(i-1) → m(i) with control p(i), m(n-2) → p(n-1) (straight)
    const pieces: Array<[[number, number], [number, number] | null, [number, number]]> = [];
    if (pts.length === 2) pieces.push([pts[0], null, pts[1]]);
    else {
      pieces.push([pts[0], null, mid(0)]);
      for (let i = 1; i < pts.length - 1; i++) pieces.push([mid(i - 1), pts[i], mid(i)]);
      pieces.push([mid(pts.length - 2), null, pts[pts.length - 1]]);
    }
    for (const [p, c, q] of pieces) {
      const a = snap(net, p[0], p[1], 2.5), b = snap(net, q[0], q[1], pieces[pieces.length - 1][2] === q ? this.snapRadius() : 2.5);
      const plan = planRoad(this.world, a, c ? { x: c[0], z: c[1] } : null, b, this.profile, this.elevation);
      if (!plan.ok) { total.invert(); this.hud.toast(`Não dá para construir aqui: ${plan.reason}.`); return; }
      total.append(buildRoad(this.world, plan, a, b, this.profile, this.segFlags()));
    }
    this.commit(total);
  }

  /** Grid of blocks centred on (x, z): all the streets in a single command. */
  private buildBlocks(x: number, z: number): void {
    const { cols, rows, size, angle } = this.blocks;
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    const W = cols * size, D = rows * size;
    const P = (u: number, v: number): [number, number] => [x + (u - W / 2) * c - (v - D / 2) * s, z + (u - W / 2) * s + (v - D / 2) * c];
    const lines: Array<[[number, number], [number, number]]> = [];
    for (let i = 0; i <= rows; i++) lines.push([P(0, i * size), P(W, i * size)]);
    for (let k = 0; k <= cols; k++) lines.push([P(k * size, 0), P(k * size, D)]);
    const total = new RoadJournal(this.world, 'quarteirões');
    const net = this.world.roads;
    for (const [[ax, az], [bx, bz]] of lines) {
      const a = snap(net, ax, az, 6), b = snap(net, bx, bz, 6);
      const plan = planRoad(this.world, a, null, b, this.profile, 0);
      if (!plan.ok) { total.invert(); this.hud.toast(`Não dá para construir aqui: ${plan.reason}.`); return; }
      total.append(buildRoad(this.world, plan, a, b, this.profile, this.segFlags(), 'quarteirões'));
    }
    if (this.commit(total)) this.hud.toast(`Quarteirões construídos: ${cols} × ${rows}.`);
  }

  /** Move node: grabs the node near the point (true if it did). */
  grab(hit: THREE.Vector3 | null): boolean {
    if (!hit) return false;
    this.moving = this.world.roads.nearestNode(hit.x, hit.z, 14);
    this.updateHint();
    return this.moving >= 0;
  }

  /** Move node: drops it at `hit`. */
  drop(hit: THREE.Vector3 | null): void {
    const n = this.moving;
    this.moving = NO_NODE;
    this.preview.hideAll();
    this.updateHint();
    if (n < 0 || !hit || !this.world.roads.nodes.alive[n]) return;
    const nc = this.world.roads.nodes.cols;
    if (Math.hypot(hit.x - nc.x[n], hit.z - nc.z[n]) < 1) return;
    const r = moveNode(this.world, n, hit.x, hit.z);
    if (typeof r === 'string') { this.hud.toast(`Não movido: ${r}.`); return; }
    this.commit(r);
  }

  /** A road picked: drawn as it is (the options go back to the road's own). */
  setProfile(p: number): void {
    this.base = p; this.profile = p;
    this.options.lanes = null; this.options.width = null; this.options.parking = null;
    this.updateHint();
  }

  /** Lanes, width or parking chosen: the road picked, varied (roads/roadVariant.ts). False when the map has no room for one more profile. */
  setOptions(o: Partial<RoadOptions>): boolean {
    const next = { ...this.options, ...o };
    const id = registerVariant(this.base, next);
    if (id < 0) return false;
    Object.assign(this.options, next);
    this.profile = id;
    this.updateHint();
    return true;
  }

  setElevation(e: number): void { this.elevation = Math.max(-12, Math.min(16, e)); }

  ringBy(f: number): void {
    this.ringRadius = Math.round(Math.max(14, Math.min(60, this.ringRadius * f)));
    this.updateHint();
  }
}
