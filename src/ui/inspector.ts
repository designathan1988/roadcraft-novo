// The inspector in the selection column (Roadcraft's road, node and junction panels). A road: its profile drawn
// from above, lanes, length, live traffic (vehicles, speed, queue), and its actions (duplicate, demolish, split,
// reverse, zebra and signal crossings, U-turn, parking by side, name and numbering, eyedropper, whole street). A
// node of two roads: height, join, crossings. A junction: control, rule of each leg, signal phases, offset, green
// wave, bus priority, lane connectors (blue comes in, green goes out), movements, height, lock the automatic
// choice. Every change is a command (undoable). The panel is built when the selection or the network changes;
// the live numbers only rewrite their own text.

import type { CommandStack } from '../core/commands.ts';
import { NO_NODE, NO_SEG, type NodeId, type SegId } from '../core/ids.ts';
import { RoadJournal, addCrossing, addHeightPoint, addUTurn, bendRoad, bulbAt, changeProfile, changeProfiles, upgradeStep, roadBetweenJunctions, demolishSeg, duplicateRoad, joinAt, reverseRoad, splitAt, streetChain } from '../roads/build.ts';
import { Ctl, Rule, dirOut, effectiveControl, signalStages, type JunctionSpec } from '../roads/control.ts';
import { PROFILES, PROFILE_INFO, Surface, withParking } from '../roads/profiles.ts';
import { armAngle } from '../roads/geometry.ts';
import { armOf, junctionRetreats } from '../roads/junction.ts';
import { laneExits } from '../roads/laneLinks.ts';
import { streetName, streetOf } from '../roads/streetNames.ts';
import type { World } from '../world/world.ts';
import { el } from './dom.ts';
import { svg } from './icons.ts';
import { fmtDec, fmtInt, money, plural, t } from '../shared/i18n/index.ts';
import { profileName, sectionSvg } from './roadCatalog.ts';

export interface InspectActions {
  /** Asks the simulation for the road's live numbers (the answer comes back in showProbe). */
  probe(seg: SegId): void;
  /** Asks for the node's pass counter (answer in showNodeProbe). */
  probeNode(node: NodeId): void;
  /** Draw with this profile (the eyedropper). */
  useProfile(id: number): void;
  toast(text: string): void;
  /** Marks what is inspected (node or road; −1 = nothing). */
  mark(node: NodeId, seg: SegId): void;
  /** Names the whole street of a road (one undo step). */
  nameStreet(seg: SegId, name: string): void;
  /** The street name the gameplay front gives a point (generated names), when it has one. */
  streetName?(x: number, z: number): string;
  /** Opens the section editor on a profile; what it gives back (a registered profile id) goes to `apply`. */
  editProfile?(profile: number, apply: (id: number) => void): void;
  /** World (x, z) to the screen (y down), so the junction's plan and its legs' names follow the camera. */
  project?(x: number, z: number): { x: number; y: number };
}

const CHOICES: Array<[number, string]> = [[Ctl.Auto, 'junction.control.auto'], [Ctl.Signal, 'junction.control.signal'], [Ctl.Priority, 'junction.control.priority'],
  [Ctl.AllStop, 'junction.control.stop'], [Ctl.YieldAll, 'junction.control.yield'], [Ctl.Mini, 'junction.control.mini'], [Ctl.None, 'junction.control.none']];
/** Roadcraft 4.0 world/roads/rules.ts:28-29: a fixed green within 6..90 s, the offset within 0..300 s. */
const GREEN_MIN = 6, GREEN_MAX = 90, OFFSET_MAX = 300;
const CTL_KEY: Record<number, string> = Object.fromEntries(CHOICES.map(([c, k]) => [c, k]));
const DIRS = ['compass.n', 'compass.ne', 'compass.e', 'compass.se', 'compass.s', 'compass.sw', 'compass.w', 'compass.nw'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

/** A leg named by where it goes (compass: −z is north). */
function legName(world: World, n: NodeId, s: SegId, withProfile = false): string {
  const [dx, dz] = dirOut(world.roads, n, s);
  const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  const k = Math.round(a / 45) % 8;
  const dir = t(DIRS[k]);
  const base = `${ARROWS[k]} ${dir.charAt(0).toUpperCase()}${dir.slice(1)}`;
  return withProfile ? `${base} · ${profileName(PROFILE_INFO[world.roads.segs.cols.profile[s]])}` : base;
}

export class Inspector {
  readonly el: HTMLElement;
  node = NO_NODE;
  seg = NO_SEG;
  private world: World;
  private commands: CommandStack;
  private a: InspectActions;
  private probeTimer = 0;
  private live: Record<string, HTMLElement> = {};
  private flowFirst: { passed: number; time: number } | null = null;
  /** The lane end of the connector plan the keyboard was on, focused again once the panel is built again. */
  private focusEnd: string | null = null;
  /** The incoming lane picked in the connectors: [road, lane]. */
  private laneIn: [SegId, number] | null = null;

  constructor(world: World, commands: CommandStack, a: InspectActions) {
    this.world = world; this.commands = commands; this.a = a;
    this.el = el('div', 'inspector hidden');
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    (document.querySelector('.v2-side') ?? document.getElementById('hud')!).append(this.el);
  }

  get isOpen(): boolean { return this.node >= 0 || this.seg >= 0; }

  /** Picks what is under the cursor: a junction near it, else the road. */
  pick(x: number, z: number): void {
    const net = this.world.roads;
    const n = net.nearestNode(x, z, 16);
    const nc = net.nodes.cols;
    if (n >= 0 && (nc.deg[n] >= 3 || (nc.deg[n] === 2 && Math.hypot(nc.x[n] - x, nc.z[n] - z) < 6))) { this.node = n; this.seg = NO_SEG; }
    else {
      const s = net.nearestSeg(x, z, 14);
      this.node = NO_NODE; this.seg = s ? s[0] : NO_SEG;
    }
    this.laneIn = null;
    this.render();
  }

  close(): void {
    this.node = NO_NODE; this.seg = NO_SEG; this.laneIn = null;
    this.el.classList.add('hidden');
    this.a.mark(NO_NODE, NO_SEG);
    clearInterval(this.probeTimer);
    this.live = {};
  }

  /** Something changed (undo, an edit): rebuilt if the target still exists. */
  refresh(): void {
    const net = this.world.roads;
    if (this.node >= 0 && (!net.nodes.alive[this.node] || net.nodes.cols.deg[this.node] < 2)) this.node = NO_NODE;
    if (this.seg >= 0 && !net.segs.alive[this.seg]) this.seg = NO_SEG;
    if (this.node < 0 && this.seg < 0) { if (!this.el.classList.contains('hidden')) this.close(); return; }
    this.render();
  }

  private setLive(key: string, text: string): void { const e = this.live[key]; if (e && e.textContent !== text) e.textContent = text; }

  /** The junction's flow: the difference of its counter between two readings (vehicles an hour). */
  showNodeProbe(p: { node: number; passed: number; time: number; vehicles?: number; queue?: number; speed?: number; capacity?: number; stage?: number; legs?: Array<[number, number]> }): void {
    if (p.node !== this.node) return;
    // what the simulation counts at the junction, when it does (Roadcraft 4.0 ui/inspector.ts:356-370)
    if (p.vehicles !== undefined) this.setLive('nVehicles', fmtInt(p.vehicles));
    if (p.queue !== undefined) this.setLive('nQueue', fmtInt(p.queue));
    if (p.speed !== undefined) this.setLive('nSpeed', `${fmtInt(p.speed * 3.6)} km/h`);
    if (p.capacity !== undefined) this.setLive('nCapacity', plural('inspector.capacityValue', p.capacity));
    if (p.stage !== undefined) this.setLive('nPhase', t('junction.stage', { n: p.stage + 1 }));
    const flows = this.live.legFlows;
    if (p.legs && flows) for (const [s, perHour] of p.legs) { const e = flows.querySelector<HTMLElement>(`strong[data-segment="${s}"]`); if (e) e.textContent = t('junction.perHour', { n: fmtInt(perHour) }); }
    const f = this.flowFirst;
    if (!f || p.passed < f.passed) { this.flowFirst = { passed: p.passed, time: p.time }; return; }
    const dt = p.time - f.time;
    if (dt < 5) return;
    this.setLive('flow', t('junction.perHour', { n: fmtInt((p.passed - f.passed) / dt * 3600) }));
  }

  /** The road's live numbers (from the simulation). */
  showProbe(p: { seg: number; vehicles: number; speed: number; queue: number; capacity: number; volume?: number }): void {
    if (p.seg !== this.seg) return;
    this.setLive('vehicles', fmtInt(p.vehicles));
    this.setLive('speed', `${fmtInt(p.speed * 3.6)} km/h`);
    this.setLive('queue', fmtInt(p.queue));
    this.setLive('capacity', plural('inspector.capacityValue', p.capacity));
    // vehicles an hour through the road, when the simulation counts them
    if (p.volume !== undefined) this.setLive('volume', fmtInt(p.volume));
  }

  private apply(spec: JunctionSpec | null, label = 'cmd.place.junctionControl'): void {
    const j = new RoadJournal(this.world, label);
    j.setJunction(this.node, spec);
    this.commands.push(j);
    this.render();
  }

  private spec(): JunctionSpec { return { ...(this.world.roads.junctions.get(this.node) ?? { ctl: Ctl.Auto }) }; }

  private head(kind: string, title: string): void {
    const h = el('div', 'insp-head');
    const names = el('div');
    names.append(el('div', 'insp-kind', kind), el('h3', '', title));
    const close = el('button', 'v2-icon');
    close.type = 'button';
    close.title = t('inspector.close');
    close.innerHTML = svg('close', 16);
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    h.append(names, close);
    this.el.append(h);
  }

  private render(): void {
    const box = this.el;
    box.replaceChildren();
    this.live = {};
    clearInterval(this.probeTimer);
    if (this.node < 0 && this.seg < 0) { this.close(); return; }
    box.classList.remove('hidden');
    this.a.mark(this.node, this.seg);
    if (this.seg >= 0) { this.renderSeg(); return; }
    const net = this.world.roads, n = this.node;
    // the same counter-clockwise order of legs as the simulation (the phases count in it)
    const segs = net.segsOf(n, []).sort((a, b) => armAngle(...dirOut(net, n, a)) - armAngle(...dirOut(net, n, b)));
    const height = el('div');
    height.append(row(label(t('inspector.heightNode')), value(`${fmtDec(net.nodes.cols.y[n])} m`)),
      actions(btn(t('junction.lower'), () => this.raise(-0.5)), btn(t('junction.raise'), () => this.raise(0.5))));
    // roads meeting too sharply (roads/impossible.ts; Roadcraft 4.0 ui/inspector.ts:421-424): the junction cannot close
    const gap = this.world.impossible.angleAt(n);
    const impossible = (): void => {
      if (gap < 0) return;
      const warn = el('div', 'inspect-warning');
      warn.setAttribute('role', 'alert');
      warn.append(el('strong', '', t('inspector.impossible')), ` · ${t('inspector.impossibleGap', { angle: Math.round(gap) })}`, el('br'), t('inspector.impossibleBody'));
      box.append(warn);
    };
    /** How far each road stops short of the node (Roadcraft 4.0 ui/inspector.ts:405-407, :428): its junction setback. */
    const mouths = (): HTMLElement => {
      const sc = net.segs.cols, out = new Float64Array(16), order: number[] = [];
      junctionRetreats(segs.map((x) => armOf(net.quad(x), sc.profile[x], sc.a[x] === n ? 0 : 1)), segs.map((x) => sc.len[x]), out, order);
      return note(`${t('inspector.mouths')}: ${segs.map((_, i) => `${fmtDec(out[i])} m`).join(' · ')}`);
    };
    if (segs.length === 2) {
      this.head(t('inspector.node'), t('inspector.heightPoint'));
      impossible();
      box.append(height);
      const sp0 = net.junctions.get(n);
      if (sp0 && sp0.ctl === Ctl.UTurn) box.append(note(t('hint.uturn.placed')), actions(btn(t('ui.insp.closeUturn'), () => this.apply(null, 'cmd.place.closeUTurn'))));
      if (sp0 && (sp0.ctl === Ctl.Zebra || sp0.ctl === Ctl.PedSignal)) {
        box.append(note(t(sp0.ctl === Ctl.Zebra ? 'inspector.crossingZebra' : 'inspector.crossingSignal')), actions(btn(t('inspector.removeCrossing'), () => this.apply(null, 'cmd.demolish.crossing'))));
      }
      box.append(actions(btn(t('inspector.joinAligned'), () => {
        const j = joinAt(this.world, n);
        if (j.empty) { this.a.toast(t('ui.insp.joinFail')); return; }
        // charged and tidied like every road edit (names and junction settings follow the joined road)
        this.edit(j, t('ui.insp.joined'));
        this.close();
      }, 'primary')));
      return;
    }
    if (segs.length === 1) {
      // a dead end: its shape, chosen by the player or left to the automatic rule (Roadcraft node end)
      this.head(t('inspector.node'), t('insp.end.title'));
      box.append(height, section(t('insp.end.title')));
      const r = row(), now = net.junctions.get(n)?.end;
      for (const [end, key] of [[undefined, 'insp.end.auto'], ['bulb', 'inspector.end.bulb'], ['plain', 'insp.end.plain']] as Array<['bulb' | 'plain' | undefined, string]>) {
        r.append(chip(t(key), `out${now === end ? '' : ' off'}`, () => {
          const s0 = net.junctions.get(n);
          const next = s0 ? { ...s0, end } : end ? { ctl: Ctl.Auto, end } : null;
          if (next && !next.end) delete next.end;
          this.apply(next && (next.end || next.ctl !== Ctl.Auto) ? next : null, 'cmd.place.roadEnd');
        }));
      }
      box.append(r, note(t(bulbAt(net, n) ? 'insp.end.hasBulb' : 'insp.end.noBulb')));
      return;
    }
    this.head(t('inspector.junction'), plural('ui.insp.roads', segs.length));
    impossible();
    const spec = net.junctions.get(n);
    const eff = effectiveControl(net, n, net.junctions.get(n), net.flow.get(n));
    if (eff.ctl === Ctl.Ring) { box.append(note(t('ui.insp.ring'))); return; }
    const sc = net.segs.cols;
    const leg = (s: SegId): string => this.legOf(n, s);
    // the signal's fixed cycle as the simulation runs it (sim/traffic.ts: each stage its green, 3 s amber, 1.5 s all red)
    const stageLegs: number[] = [];
    const stageCount = eff.ctl === Ctl.Signal ? signalStages(segs.map((s) => dirOut(net, n, s)), stageLegs) : 0;
    const greensNow = Array.from({ length: stageCount }, (_, i) => spec?.greens?.[i] ?? 20);
    const cycle = greensNow.reduce((c, g) => c + Math.max(5, g) + 4.5, 0);

    // the numbers in cards (Roadcraft 4.0 ui/inspector.ts:346-370): what the simulation does not count yet shows "—"
    const movements = segs.reduce((k, from) => k + new Set(laneExits(net, n, from, spec).flatMap((l) => l.exits.map(([s]) => s))).size, 0);
    const grid = el('div', 'inspect-grid');
    grid.append(
      cardOf(t('inspector.control'), t(CTL_KEY[eff.ctl] ?? 'control.none')),
      cardOf(t('inspector.connections'), String(segs.length)),
      cardOf(t('inspector.movements'), String(movements)),
      cardOf(t('inspector.vehicles'), '—', (e) => { this.live.nVehicles = e; }),
      cardOf(t('inspector.queue'), '—', (e) => { this.live.nQueue = e; }),
      cardOf(t('inspector.meanSpeed'), '—', (e) => { this.live.nSpeed = e; }),
      cardOf(t('inspector.capacity'), '—', (e) => { this.live.nCapacity = e; }),
      cardOf(t('inspector.volume'), '…', (e) => { this.live.flow = e; }),
      ...(stageCount ? [
        cardOf(t('inspector.cycle'), spec?.fixed ? `${Math.round(cycle)} s` : '—', (e) => { this.live.nCycle = e; }),
        cardOf(t('inspector.phase'), '—', (e) => { this.live.nPhase = e; }),
      ] : []),
    );
    box.append(grid, height, mouths());
    this.flowFirst = null;
    this.a.probeNode(n);
    this.probeTimer = window.setInterval(() => { if (this.node === n) this.a.probeNode(n); else clearInterval(this.probeTimer); }, 2000);

    // the control as buttons (4.0 ui/roads/junctionPanel.ts:65-71); "yield at all" only when it is the one set
    box.append(section(t('junction.control')));
    const ctls = spec?.ctl === Ctl.YieldAll ? CHOICES : CHOICES.filter(([c]) => c !== Ctl.YieldAll);
    box.append(segmented(ctls.map(([c, k]) => [c, t(k)]), spec?.ctl ?? Ctl.Auto, (v) => {
      if (v === Ctl.Auto) this.apply(null); else this.apply({ ...this.spec(), ctl: v });
    }));
    if (!spec || spec.ctl === Ctl.Auto) {
      box.append(note(t('ui.insp.autoChoice', { choice: t(CTL_KEY[eff.ctl] ?? 'control.none').toLowerCase() })));
      box.append(actions(btn(t('ui.insp.lock'), () => this.apply({ ...this.spec(), ctl: eff.ctl }, 'cmd.place.lockControl'))));
    } else box.append(row(label(t('junction.locked')), btn(t('junction.unlock'), () => this.apply(null))));
    // the flow of each leg, the main road's marked (4.0 :90-106)
    const prio = (s: SegId) => PROFILE_INFO[sc.profile[s]].priority ?? 0;
    const top = Math.max(...segs.map(prio));
    const mains = segs.filter((s) => prio(s) === top);
    const flows = el('div', 'rp-flows');
    for (const s of segs) {
      const r = el('div', 'rp-flow');
      const v = el('strong', '', '—');
      v.dataset.segment = String(s);
      r.append(el('span', '', `${leg(s)}${mains.length <= 2 && mains.includes(s) && mains.length < segs.length ? ` · ${t('junction.mainRoad')}` : ''}`), v);
      flows.append(r);
    }
    this.live.legFlows = flows;
    box.append(flows);

    // each leg's rule, only under signs (4.0 :110-128), with the way back to the automatic rules
    if (eff.ctl === Ctl.Priority) {
      box.append(section(t('junction.legs')));
      for (const s of segs) {
        const r = eff.legs.get(s) ?? Rule.Free;
        box.append(row(label(leg(s)), segmented([[Rule.Main, t('junction.rule.priority')], [Rule.Yield, t('junction.rule.yield')], [Rule.Stop, t('junction.rule.stop')]], r, (v) => {
          const sp = this.spec();
          if (sp.ctl === Ctl.Auto) sp.ctl = eff.ctl;
          sp.legs = [...(sp.legs ?? []).filter(([x]) => x !== s), [s, v]];
          this.apply(sp, 'cmd.place.roadRule');
        })));
      }
      if (spec?.legs?.length) box.append(actions(btn(t('junction.rulesReset'), () => { const sp = this.spec(); delete sp.legs; this.apply(sp, 'cmd.place.autoRules'); })));
    }

    // the signal (4.0 :130-172): adaptive or fixed; in fixed time each stage's green in 2 s steps within 6..90 s and
    // the offset 0..300 s; the green wave; bus priority as a switch
    if (eff.ctl === Ctl.Signal) {
      box.append(section(t('junction.signal')));
      box.append(row(label(t('junction.signalMode')), segmented([[0, t('junction.mode.adaptive')], [1, t('junction.mode.fixed')]], spec?.fixed ? 1 : 0, (v) => {
        const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal;
        sp.fixed = v === 1;
        if (sp.fixed && !sp.greens) sp.greens = greensNow.map((g) => Math.round(g));
        this.apply(sp, 'cmd.place.signalTimes');
      })));
      if (spec?.fixed) {
        for (let k = 0; k < stageCount; k++) {
          const legs = segs.filter((_, i) => stageLegs[i] === k).map((s) => leg(s)).join(' · ');
          const g = greensNow[k];
          const setG = (d: number): void => {
            const sp = this.spec();
            const greens = greensNow.slice();
            greens[k] = Math.max(GREEN_MIN, Math.min(GREEN_MAX, g + d));
            sp.greens = greens; this.apply(sp, 'cmd.place.signalGreen');
          };
          box.append(row(label(`${t('junction.stage', { n: k + 1 })} (${legs})`), stepper(`${g} s`, () => setG(-2), () => setG(2))));
        }
        const off = Math.max(0, Math.min(OFFSET_MAX, spec.offset ?? 0));
        const setOff = (d: number): void => { const sp = this.spec(); sp.offset = Math.max(0, Math.min(OFFSET_MAX, off + d)); this.apply(sp, 'cmd.place.signalOffset'); };
        box.append(row(label(t('junction.offset')), stepper(`${off} s`, () => setOff(-2), () => setOff(2))));
      }
      box.append(actions(btn(t('junction.greenWave'), () => this.greenWave())));
      box.append(toggle(t('junction.busPriority'), !!spec?.bus, (on) => { const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal; sp.bus = on; this.apply(sp, 'cmd.place.busPriority'); }));
    }

    // the lane connectors as a plan of the junction turned as the player sees it (4.0 ui/roads/connectorPanel.ts:40-167)
    box.append(this.connectorPlan(n, segs, spec));

    // the movements allowed through it, a row per road they come from, each turn a chip (4.0 :174-204)
    box.append(section(t('junction.movements')));
    for (const from of segs) {
      const chips = el('div', 'rp-ctrls');
      for (const to of segs) {
        if (to === from) continue;
        const ban = (spec?.bans ?? []).some((_, i, b) => i % 2 === 0 && b[i] === from && b[i + 1] === to);
        const c = el('button', `rp-move${ban ? '' : ' on'}`, `${t(this.turnOf(n, from, to))} → ${leg(to)}`);
        c.type = 'button';
        c.setAttribute('aria-pressed', String(!ban));
        c.title = t(ban ? 'junction.moveBlocked' : 'junction.moveAllowed');
        c.addEventListener('click', (e) => {
          e.stopPropagation();
          const sp = this.spec();
          const bans = (sp.bans ?? []).slice();
          let found = -1;
          for (let i = 0; i + 1 < bans.length; i += 2) if (bans[i] === from && bans[i + 1] === to) found = i;
          if (found >= 0) bans.splice(found, 2); else bans.push(from, to);
          sp.bans = bans;
          this.apply(sp, 'cmd.place.bannedTurn');
        });
        chips.append(c);
      }
      box.append(row(label(t('junction.from', { leg: leg(from) })), chips));
    }
  }

  /** The turn from road `from` into road `to` at node n: through within 45°, a U-turn when it doubles back. */
  private turnOf(n: NodeId, from: SegId, to: SegId): string {
    const net = this.world.roads;
    const [ax, az] = dirOut(net, n, from), [bx, bz] = dirOut(net, n, to);
    const dot = -ax * bx - az * bz, cross = -ax * bz + az * bx;
    if (dot > Math.SQRT1_2) return 'turn.through';
    if (dot < -0.95) return 'turn.uturn';
    // heading east (+x) a left turn goes north (−z): a negative cross product
    return cross < 0 ? 'turn.left' : 'turn.right';
  }

  /** A leg named as the player sees it from the camera (4.0 junctionPanel.ts:27-45), or by the compass without one. */
  private legOf(n: NodeId, s: SegId): string {
    const p = this.a.project;
    if (!p) return legName(this.world, n, s);
    const net = this.world.roads, nc = net.nodes.cols;
    const [dx, dz] = dirOut(net, n, s);
    const a = p(nc.x[n], nc.z[n]), b = p(nc.x[n] + dx * 10, nc.z[n] + dz * 10);
    const k = ((Math.round(Math.atan2(b.x - a.x, -(b.y - a.y)) / (Math.PI / 4)) % 8) + 8) % 8;
    return t(`screenDir.${['up', 'upRight', 'right', 'downRight', 'down', 'downLeft', 'left', 'upLeft'][k]}`);
  }

  /**
   * The lane connector editor as a plan (Roadcraft 4.0 ui/roads/connectorPanel.ts:40-167): each lane arriving at the
   * junction a blue end on its road's mouth, each road leaving it a green end, the links drawn between them. Click
   * (or Enter / Space on the focused end) an arriving lane to see where it goes, then a leaving road to link or unlink
   * it. This engine links a lane to a road (the simulation picks the lane on it): a leaving road is one end.
   */
  private connectorPlan(n: NodeId, segs: SegId[], spec: JunctionSpec | undefined): HTMLElement {
    const net = this.world.roads, sc = net.segs.cols, nc = net.nodes.cols;
    const root = el('section', 'rp-summary rp-connectors');
    const head = el('div', 'rp-summary-head');
    head.append(el('span', '', t('connectors.title')), el('span', 'rp-sub', t(spec?.lanes?.length ? 'connectors.custom' : 'connectors.auto')));
    root.append(head);
    const view = (x: number, z: number): { x: number; y: number } => this.a.project ? this.a.project(x, z) : { x, y: z };
    const retreat = new Float64Array(16), order: number[] = [];
    junctionRetreats(segs.map((s) => armOf(net.quad(s), sc.profile[s], sc.a[s] === n ? 0 : 1)), segs.map((s) => sc.len[s]), retreat, order);
    type End = { key: string; x: number; y: number; dx: number; dy: number; seg: SegId; lane: number; arriving: boolean };
    const ends: End[] = [];
    segs.forEach((s, i) => {
      const [ox, oz] = dirOut(net, n, s);
      const info = PROFILE_INFO[sc.profile[s]];
      // the road's own frame: a → b, its left at +u
      const sx = sc.a[s] === n ? ox : -ox, sz = sc.a[s] === n ? oz : -oz, lx = sz, lz = -sx;
      const mx = nc.x[n] + ox * retreat[i], mz = nc.z[n] + oz * retreat[i];
      const at = (u: number, along: number) => view(mx + lx * u + ox * along, mz + lz * u + oz * along);
      // arriving at the node: at b the lanes going a → b, at a those going b → a
      const arriving = sc.b[s] === n ? info.fwd : info.back, leaving = sc.b[s] === n ? info.back : info.fwd;
      arriving.forEach((l, li) => {
        const p = at(l.u, 0), q = at(l.u, 8);
        ends.push({ key: `a${s}:${li}`, x: p.x, y: p.y, dx: p.x - q.x, dy: p.y - q.y, seg: s, lane: li, arriving: true });
      });
      if (leaving.length) {
        const u = leaving.reduce((k, l) => k + l.u, 0) / leaving.length, p = at(u, 0), q = at(u, 8);
        ends.push({ key: `l${s}`, x: p.x, y: p.y, dx: q.x - p.x, dy: q.y - p.y, seg: s, lane: -1, arriving: false });
      }
    });
    if (!ends.some((e) => e.arriving) || !ends.some((e) => !e.arriving)) { root.append(note(t('connectors.none'))); return root; }
    const minX = Math.min(...ends.map((e) => e.x)), maxX = Math.max(...ends.map((e) => e.x));
    const minY = Math.min(...ends.map((e) => e.y)), maxY = Math.max(...ends.map((e) => e.y));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, W = 300, H = 220, pad = 34;
    const k = Math.min((W - pad * 2) / Math.max(1e-6, maxX - minX), (H - pad * 2) / Math.max(1e-6, maxY - minY));
    const px = (x: number, y: number): [number, number] => [W / 2 + (x - cx) * k, H / 2 + (y - cy) * k];
    const lit = this.laneIn;
    const parts: string[] = [];
    for (const e of ends) {
      const [x, y] = px(e.x, e.y), len = Math.hypot(e.dx, e.dy) || 1, sg = e.arriving ? 1 : -1;
      parts.push(`<line x1="${(x - (e.dx / len) * 22 * sg).toFixed(1)}" y1="${(y - (e.dy / len) * 22 * sg).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="cn-stub"/>`);
    }
    const exitsOf = (s: SegId, li: number) => laneExits(net, n, s, spec)[li]?.exits.map(([o]) => o) ?? [];
    const [mx, my] = px(cx, cy);
    for (const e of ends) {
      if (!e.arriving) continue;
      for (const o of exitsOf(e.seg, e.lane)) {
        const b = ends.find((x) => !x.arriving && x.seg === o);
        if (!b) continue;
        const [x0, y0] = px(e.x, e.y), [x1, y1] = px(b.x, b.y);
        const on = lit && lit[0] === e.seg && lit[1] === e.lane;
        parts.push(`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}" class="cn-link${on ? ' on' : lit ? ' dim' : ''}"/>`);
      }
    }
    const litExits = lit ? exitsOf(lit[0], lit[1]) : [];
    for (const e of ends) {
      const [x, y] = px(e.x, e.y);
      const on = e.arriving ? !!lit && lit[0] === e.seg && lit[1] === e.lane : litExits.includes(e.seg);
      const name = e.arriving ? `${this.legOf(n, e.seg)} · ${t('profile.element.lane')} ${e.lane + 1}` : `→ ${this.legOf(n, e.seg)}`;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" class="cn-end ${e.arriving ? 'in' : 'out'}${on ? ' on' : ''}" data-end="${e.key}" role="button" tabindex="0" aria-label="${name}"><title>${name}</title></circle>`);
    }
    const art = el('div', 'rp-summary-art cn-art');
    art.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('connectors.title')}">${parts.join('')}</svg>`;
    const hint = el('div', 'rp-sub', t(lit ? 'connectors.pickOut' : 'connectors.pickIn'));
    hint.setAttribute('role', 'status');
    const press = (key: string): void => {
      const e = ends.find((x) => x.key === key);
      if (!e) return;
      if (e.arriving) { this.laneIn = lit && lit[0] === e.seg && lit[1] === e.lane ? null : [e.seg, e.lane]; this.focusEnd = key; this.render(); return; }
      if (!lit) return;
      const now = exitsOf(lit[0], lit[1]);
      const next = now.includes(e.seg) ? now.filter((s2) => s2 !== e.seg) : [...now, e.seg];
      if (!next.length) { hint.textContent = t('connectors.lastExit'); return; }
      const sp = this.spec();
      sp.lanes = [...(sp.lanes ?? []).filter(([s2, i2]) => !(s2 === lit[0] && i2 === lit[1])), [lit[0], lit[1], next]];
      this.focusEnd = key;
      this.apply(sp, 'cmd.place.laneLink');
    };
    art.addEventListener('click', (ev) => { const key = (ev.target as Element).closest('[data-end]')?.getAttribute('data-end'); if (key) { ev.stopPropagation(); press(key); } });
    art.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const key = (ev.target as Element).closest('[data-end]')?.getAttribute('data-end');
      if (!key) return;
      ev.preventDefault(); ev.stopPropagation();
      press(key);
    });
    root.append(art, hint);
    if (spec?.lanes?.length) root.append(actions(btn(t('connectors.reset'), () => { const sp = this.spec(); delete sp.lanes; this.laneIn = null; this.apply(sp, 'cmd.place.autoLaneLinks'); })));
    // the end the keyboard was on keeps the focus through the panel built again
    if (this.focusEnd) { const f = this.focusEnd; this.focusEnd = null; requestAnimationFrame(() => art.querySelector<SVGElement>(`[data-end="${f}"]`)?.focus()); }
    return root;
  }

  /** Records a road edit (settled: names and junction specs handed on, charged; without the money it is undone and said). True when recorded. */
  private edit(j: RoadJournal, ok: string): boolean {
    if (j.empty) return false;
    const price = j.price;
    if (!j.settle()) { this.a.toast(t('ui.insp.noMoney', { price: money(price) })); return false; }
    this.commands.push(j);
    this.a.toast(ok);
    this.refresh();
    return true;
  }

  /** A pedestrian crossing in the middle of the road (one undo step). */
  private crossing(s: SegId, ctl: number): void {
    const r = addCrossing(this.world, s, 0.5, ctl);
    if (typeof r === 'string') { this.a.toast(r); return; }
    if (this.edit(r, t(ctl === Ctl.Zebra ? 'inspector.crossingZebra' : 'inspector.crossingSignal'))) this.close();
  }

  private raise(dy: number): void {
    const j = new RoadJournal(this.world, 'cmd.place.nodeHeight');
    j.moveNodeY(this.node, this.world.roads.nodes.cols.y[this.node] + dy);
    if (j.settle()) this.commands.push(j);
    this.render();
  }

  /** Green wave: the main road's signals in fixed time, offset by the travel time. */
  private greenWave(): void {
    const net = this.world.roads, n = this.node, sc = net.segs.cols, nc = net.nodes.cols;
    const segs = net.segsOf(n, []);
    let main = segs[0];
    for (const s of segs) if ((PROFILE_INFO[sc.profile[s]].priority ?? 0) > (PROFILE_INFO[sc.profile[main]].priority ?? 0)) main = s;
    const chain = streetChain(this.world, main);
    const nodes = new Set<NodeId>();
    for (const s of chain) { nodes.add(sc.a[s]); nodes.add(sc.b[s]); }
    const base = this.spec();
    const greens = base.greens ?? [20, 20, 20, 20];
    const speed = PROFILE_INFO[sc.profile[main]].speed / 3.6;
    const j = new RoadJournal(this.world, 'cmd.place.greenWave');
    let count = 0;
    for (const m of nodes) {
      if (nc.deg[m] < 3 || effectiveControl(net, m, net.junctions.get(m), net.flow.get(m)).ctl !== Ctl.Signal) continue;
      const d = Math.hypot(nc.x[m] - nc.x[n], nc.z[m] - nc.z[n]);
      const old = net.junctions.get(m);
      // the travel time back from this node, as an offset within the cycle (sim/traffic.ts reads it mod the cycle;
      // Roadcraft 4.0 keeps offsets in 0..OFFSET_LIMIT)
      const stages = signalStages(net.segsOf(m, []).map((x) => dirOut(net, m, x)), []);
      const cyc = Array.from({ length: stages }, (_, i) => Math.max(5, greens[i] ?? 20) + 4.5).reduce((x, y) => x + y, 0) || 1;
      const offset = Math.min(OFFSET_MAX, ((-Math.round(d / speed)) % cyc + cyc) % cyc);
      j.setJunction(m, { ...(old ?? {}), ctl: Ctl.Signal, fixed: true, greens, offset: Math.round(offset) });
      count++;
    }
    if (count < 2) { this.a.toast(t('junction.greenWaveNone')); return; }
    this.commands.push(j);
    this.a.toast(t('ui.insp.greenWave', { n: count }));
    this.render();
  }

  private renderSeg(): void {
    const box = this.el, s = this.seg, w = this.world, net = w.roads, sc = net.segs.cols, nc = net.nodes.cols;
    const info = PROFILE_INFO[sc.profile[s]];
    const width = info.left + info.right;
    // the whole street, ordered from its start (roads/streetNames.ts): its name, typed or generated, and numbering
    const whole = streetOf(w, s);
    const street = streetName(w, s, whole);
    // Roadcraft 4.0 ui/inspector.ts:226-228: "street name · class"
    this.head(t('inspector.road'), `${street || t('inspector.road')} · ${profileName(info)}`);

    // the numbers in cards (4.0 :190-207): length, lanes (per direction), speed limit, live traffic, capacity, volume
    const lanes = info.lanesFwd + info.lanesBack;
    const grid = el('div', 'inspect-grid');
    grid.append(
      cardOf(t('inspector.length'), `${fmtInt(sc.len[s])} m`),
      cardOf(t('inspector.lanes'), info.oneWay ? t('inspector.lanesOneWay', { count: lanes }) : t('inspector.lanesTwoWay', { count: lanes, perSide: Math.max(info.lanesFwd, info.lanesBack) })),
      cardOf(t('inspector.speed'), `${info.speed} km/h`),
      cardOf(t('inspector.meanSpeed'), '…', (e) => { this.live.speed = e; }),
      cardOf(t('inspector.vehicles'), '…', (e) => { this.live.vehicles = e; }),
      cardOf(t('inspector.queue'), '…', (e) => { this.live.queue = e; }),
      cardOf(t('inspector.capacity'), '…', (e) => { this.live.capacity = e; }),
      cardOf(t('inspector.volume'), '—', (e) => { this.live.volume = e; }),
    );
    box.append(grid);
    this.a.probe(s);
    this.probeTimer = window.setInterval(() => { if (this.seg === s) this.a.probe(s); else clearInterval(this.probeTimer); }, 1000);

    // its street's numbering (4.0 :229, :241) and its name (typed; empty gives the generated one back)
    let from = 0;
    for (let k = 0; k < whole.segs.length && whole.segs[k] !== s; k++) from += whole.lens[k];
    box.append(note(t('inspector.numbers', { from: fmtInt(1 + Math.floor(from)), to: fmtInt(Math.ceil(from + sc.len[s])) })));
    const name = el('input', 'v2-search');
    name.type = 'text'; name.maxLength = 40; name.value = w.streetNames.get(s) ?? '';
    name.placeholder = street;
    name.setAttribute('aria-label', t('ui.insp.street'));
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
    // an empty name takes the typed one away (the generated name comes back)
    name.addEventListener('change', () => { const v = name.value.trim(); if (v !== (w.streetNames.get(s) ?? '')) this.a.nameStreet(s, v); });
    box.append(name);

    // the road's profile (4.0 ui/roads/profilePanel.ts:20-81): its section, "n lanes · paving · km/h", edit, draw with, whole street
    const anyChain = streetChain(w, s, true);
    const panel = el('section', 'rp-summary road-profile-panel');
    const ph = el('div', 'rp-summary-head');
    ph.append(el('span', '', t('profile.title')), el('span', 'rp-sub', t('profileEditor.totalWidth', { width: fmtDec(width) })));
    const art = el('div', 'rp-summary-art');
    art.innerHTML = sectionSvg(PROFILES[sc.profile[s]], { width: 300, height: 112, labels: false, title: t('profile.diagram') }).svg;
    const surface = info.surface === Surface.Concrete ? 'concrete' : info.surface === Surface.Cobble ? 'cobble' : 'asphalt';
    const facts = el('div', 'rp-sub rp-summary-facts', [plural('profile.summary.lanes', lanes), t(`profile.materialName.${surface}`), t('profileEditor.speedValue', { speed: info.speed })].join(' · '));
    panel.append(ph, art, facts, actions(
      btn(t('profileEditor.open'), () => this.a.editProfile?.(sc.profile[s], (id) => this.edit(changeProfile(w, s, id), t('ui.insp.profileApplied'))), 'primary'),
      btn(t('profile.drawWith'), () => this.a.useProfile(sc.profile[s]), '', t('profile.drawWithTip')),
      ...(anyChain.length > 1 ? [btn(t('profile.toStreet', { count: anyChain.length }), () => this.edit(changeProfiles(w, anyChain, sc.profile[s], s), t('hint.profile.toStreet')), '', t('profile.toStreetTip'))] : []),
    ));
    box.append(panel);

    // the heights of its two ends as steppers, half a metre a step (4.0 :245-247, :295-301, :514-519)
    for (const [n, key] of [[sc.a[s], 'inspector.heightStart'], [sc.b[s], 'inspector.heightEnd']] as Array<[NodeId, string]>) {
      const v = nc.y[n];
      box.append(row(label(t(key)), stepper(`${fmtDec(v)} m`, () => this.raiseNode(n, -0.5), () => this.raiseNode(n, 0.5))));
    }
    // a dead end's shape (4.0 :175-181, :248, :302-304): automatic, a turning bulb or plain
    for (const [n, key] of [[sc.a[s], 'inspector.endStart'], [sc.b[s], 'inspector.endEnd']] as Array<[NodeId, string]>) {
      if (nc.deg[n] !== 1) continue;
      const now = net.junctions.get(n)?.end ?? 'auto';
      const sel = select([[0, t('insp.end.auto')], [1, t('inspector.end.bulb')], [2, t('insp.end.plain')]], now === 'bulb' ? 1 : now === 'plain' ? 2 : 0, (v) => {
        const end = v === 1 ? 'bulb' as const : v === 2 ? 'plain' as const : undefined;
        const s0 = net.junctions.get(n);
        const next: JunctionSpec | null = s0 ? { ...s0, end } : end ? { ctl: Ctl.Auto, end } : null;
        if (next && !next.end) delete next.end;
        const j = new RoadJournal(w, 'cmd.place.roadEnd');
        j.setJunction(n, next && (next.end || next.ctl !== Ctl.Auto) ? next : null);
        this.commands.push(j);
        this.render();
      }, t(key));
      box.append(row(label(t(key)), sel));
    }
    // parking by side, a choice of what the road can carry (4.0 :183-187, :250-251): none or parallel to the kerb
    if (!info.ring && !info.rail && (info.priority ?? 0) < 4) {
      for (const [right, key] of [[false, 'inspector.parkingLeft'], [true, 'inspector.parkingRight']] as Array<[boolean, string]>) {
        const order = right ? info.strips : info.strips.slice().reverse();
        let k = 0;
        while (k < order.length && (order[k].kind === 'sidewalk' || order[k].kind === 'curb')) k++;
        const has = order[k]?.kind === 'parking';
        box.append(row(label(t(key)), select([[0, t('parking.none')], [1, t('parking.parallel')]], has ? 1 : 0, (v) => {
          if ((v === 1) === has) return;
          const to = withParking(sc.profile[s], right, v === 1);
          if (to < 0) { this.a.toast(t('ui.catalog.tooMany')); return; }
          this.edit(changeProfiles(w, roadBetweenJunctions(w, s), to, s), t(v === 1 ? 'ui.insp.parkingOn' : 'ui.insp.parkingOff'));
        }, t(key))));
      }
    }
    // curvature (up to 65 % of the length) and where along the road the curve sits, 15–85 % (4.0 :231-233, :253-254, :325-341)
    const a = sc.a[s], b = sc.b[s];
    const dx = nc.x[b] - nc.x[a], dz = nc.z[b] - nc.z[a], L = Math.hypot(dx, dz) || 1;
    const q = net.quad(s);
    const cwx = q.cx - nc.x[a], cwz = q.cz - nc.z[a];
    const tNow = (cwx * dx + cwz * dz) / (L * L), hNow = (cwx * dz - cwz * dx) / L;
    const maxCurve = Math.max(20, Math.min(280, sc.len[s] * 0.65));
    const bent = Math.abs(hNow) >= 0.5;
    const curveText = (h: number) => Math.abs(h) < 0.5 ? '0 m' : `${h > 0 ? '+' : '−'}${fmtInt(Math.abs(h))} m`;
    box.append(range(t('inspector.curvature'), -maxCurve, maxCurve, 1, Math.max(-maxCurve, Math.min(maxCurve, hNow)), curveText, (h) => this.bend(s, bent ? tNow : 0.5, Math.abs(h) < 0.5 ? 0 : h), !info.ring));
    box.append(range(t('inspector.curvePosition'), 0.15, 0.85, 0.01, Math.max(0.15, Math.min(0.85, tNow)), (v) => `${Math.round(v * 100)}%`, (v) => this.bend(s, v, hNow), bent));

    // actions (4.0 :255-266)
    box.append(section(t('ui.insp.actions')));
    const hasMedian = info.edges.some((e) => e.strip.kind === 'median') && !info.oneWay;
    const up = upgradeStep(sc.profile[s]);
    box.append(actions(
      btn(t('inspector.upgrade'), () => this.edit(changeProfile(w, s, up), t('ui.insp.profileApplied')), '', up >= 0 ? profileName(PROFILE_INFO[up]) : '', up < 0),
      ...(info.oneWay ? [btn(t('inspector.reverse'), () => this.edit(reverseRoad(w, s), t('ui.insp.reversed')))] : []),
      btn(t('inspector.duplicate'), () => {
        const r = duplicateRoad(w, s);
        if (typeof r === 'string') { this.a.toast(t('ui.insp.noDuplicate', { why: r })); return; }
        this.edit(r, t('ui.insp.duplicated'));
      }, '', t('inspector.duplicateHint')),
      btn(t('inspector.splitMiddle'), () => this.edit(splitAt(w, s, 0.5), t('ui.insp.split'))),
      btn(t('inspector.addZebra'), () => this.crossing(s, Ctl.Zebra)),
      btn(t('inspector.addSignalCrossing'), () => this.crossing(s, Ctl.PedSignal)),
      ...(hasMedian ? [btn(t('ui.insp.uturn'), () => {
        const r = addUTurn(w, s, 0.5);
        if (typeof r === 'string') { this.a.toast(r); return; }
        if (this.edit(r, t('hint.uturn.placed'))) this.close();
      })] : []),
      btn(t('inspector.addHeightPoint'), () => {
        const r = addHeightPoint(w, s);
        if (typeof r === 'string') { this.a.toast(r); return; }
        if (!r.journal.settle()) return;
        this.commands.push(r.journal);
        // the new point's own panel: its height steppers
        this.node = r.node; this.seg = NO_SEG; this.render();
      }),
      btn(t('inspector.demolish'), () => {
        const j = demolishSeg(w, s);
        if (j.settle()) { this.commands.push(j); if (j.charge) this.a.toast(t('ui.insp.refund', { value: money(-j.charge) })); }
        this.close();
      }, 'danger'),
    ));
  }

  /** A node raised or lowered by `dy` (half a metre a step), from the road's panel. */
  private raiseNode(n: NodeId, dy: number): void {
    const j = new RoadJournal(this.world, 'cmd.place.nodeHeight');
    j.moveNodeY(n, this.world.roads.nodes.cols.y[n] + dy);
    if (j.settle()) this.commands.push(j);
    this.render();
  }

  /** The road bent to the curvature and position chosen (roads/build.ts bendRoad). */
  private bend(s: SegId, t0: number, h: number): void {
    const r = bendRoad(this.world, s, t0, h);
    if (typeof r === 'string') { this.a.toast(t('ui.insp.noBend', { why: r })); this.render(); return; }
    if (!r.settle()) { this.render(); return; }
    this.commands.push(r);
    // the bent road is a segment made again between the same two nodes: follow it
    const net = this.world.roads, sc = net.segs.cols;
    const ends = [sc.a[s], sc.b[s]];
    const now = net.segsOf(ends[0], []).find((x) => (sc.a[x] === ends[1] || sc.b[x] === ends[1]));
    if (now !== undefined) this.seg = now;
    this.render();
  }
}

function btn(text: string, fn: () => void, cls = '', title = '', disabled = false): HTMLButtonElement {
  const b = el('button', `ins-btn${cls ? ` ${cls}` : ''}`, text);
  b.type = 'button';
  if (title) b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); b.blur(); });
  return b;
}
function chip(text: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = el('button', `chip ${cls}`);
  b.type = 'button';
  b.append(el('i'), el('span', '', text));
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
function label(text: string): HTMLElement { return el('span', 'label', text); }
function value(text: string): HTMLElement { return el('span', 'value', text); }
function note(text: string): HTMLElement { return el('div', 'note', text); }
/** Choices as a row of buttons, the chosen one lit (4.0 ui/roads/junctionPanel.ts:275-290). */
function segmented(opts: Array<[number, string]>, v: number, fn: (v: number) => void): HTMLElement {
  const box = el('div', 'rp-seg dense');
  box.setAttribute('role', 'radiogroup');
  for (const [k, text] of opts) {
    const b = el('button', k === v ? 'on' : '', text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === v));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (k !== v) fn(k); });
    box.append(b);
  }
  return box;
}
/** An on/off switch (4.0 ui/roads/junctionPanel.ts:310-320). */
function toggle(text: string, on: boolean, fn: (on: boolean) => void): HTMLElement {
  const b = el('button', 'rp-switch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  const track = el('span', 'track'); track.append(el('span', 'knob'));
  b.append(track, el('span', 'txt', text));
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(!on); });
  return b;
}
/** A value between − and + buttons (Roadcraft 4.0 ui/inspector.ts:514-519, the interface's stepper). */
function stepper(text: string, down: () => void, up: () => void): HTMLElement {
  const e = el('div', 'rp-step');
  const minus = btn('−', down), plus = btn('+', up);
  minus.setAttribute('aria-label', t('junction.lower')); plus.setAttribute('aria-label', t('junction.raise'));
  e.append(minus, el('output', '', text), plus);
  return e;
}
/** A slider with its value written beside it; `commit` runs when it is let go (4.0 ui/inspector.ts:253-254, :325-341). */
function range(name: string, min: number, max: number, step: number, value: number, show: (v: number) => string, commit: (v: number) => void, enabled = true): HTMLElement {
  const l = el('label', 'inspect-range');
  // laid out here until the interface's stylesheet has the rule (4.0 ui/roads/roads.css)
  l.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;align-items:center;margin:6px 0;font-size:12px;width:100%;box-sizing:border-box;padding-right:6px';
  const out = el('output', '', show(value));
  const input = el('input');
  input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  input.disabled = !enabled;
  if (!enabled) l.dataset.disabled = '';
  input.addEventListener('input', () => { out.textContent = show(Number(input.value)); });
  input.addEventListener('change', () => commit(Number(input.value)));
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.style.cssText = 'grid-column:1 / -1;width:100%;min-width:0;margin:0;box-sizing:border-box';
  l.append(el('span', '', name), out, input);
  return l;
}
function section(text: string): HTMLElement { return el('h4', '', text); }
function row(...c: HTMLElement[]): HTMLElement { const e = el('div', 'ins-row'); e.append(...c); return e; }
function actions(...c: HTMLElement[]): HTMLElement { const e = el('div', 'inspect-actions'); e.append(...c); return e; }
function cardOf(name: string, text: string, keep?: (e: HTMLElement) => void): HTMLElement {
  const c = el('div', 'inspect-card');
  const v = el('strong', '', text);
  c.append(el('span', '', name), v);
  keep?.(v);
  return c;
}
function select(opts: Array<[number, string]>, v: number, fn: (v: number) => void, name = ''): HTMLSelectElement {
  const s = el('select');
  if (name) s.setAttribute('aria-label', name);
  for (const [k, text] of opts) { const o = el('option', '', text); o.value = String(k); s.append(o); }
  s.value = String(v);
  s.addEventListener('change', () => { fn(Number(s.value)); s.blur(); });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}
