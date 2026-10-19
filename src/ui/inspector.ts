// The inspector in the selection column (Roadcraft's road, node and junction panels). A road: its profile drawn
// from above, lanes, length, live traffic (vehicles, speed, queue), and its actions (duplicate, demolish, split,
// reverse, zebra and signal crossings, U-turn, parking by side, name and numbering, eyedropper, whole street). A
// node of two roads: height, join, crossings. A junction: control, rule of each leg, signal phases, offset, green
// wave, bus priority, lane connectors (blue comes in, green goes out), movements, height, lock the automatic
// choice. Every change is a command (undoable). The panel is built when the selection or the network changes;
// the live numbers only rewrite their own text.

import type { CommandStack } from '../core/commands.ts';
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
import { fmtDec, fmtInt, money, plural, t } from './i18n.ts';
import { profileName, sectionSvg } from './roadCatalog.ts';

export interface InspectActions {
  /** Asks the simulation for the road's live numbers (the answer comes back in showProbe). */
  probe(seg: number): void;
  /** Asks for the node's pass counter (answer in showNodeProbe). */
  probeNode(node: number): void;
  /** Draw with this profile (the eyedropper). */
  useProfile(id: number): void;
  toast(text: string): void;
  /** Marks what is inspected (node or road; −1 = nothing). */
  mark(node: number, seg: number): void;
  /** Names the whole street of a road (one undo step). */
  nameStreet(seg: number, name: string): void;
  /** The street name the gameplay front gives a point (generated names), when it has one. */
  streetName?(x: number, z: number): string;
  /** Opens the section editor on a profile; what it gives back (a registered profile id) goes to `apply`. */
  editProfile?(profile: number, apply: (id: number) => void): void;
}

const CHOICES: Array<[number, string]> = [[Ctl.Auto, 'junction.control.auto'], [Ctl.Signal, 'junction.control.signal'], [Ctl.Priority, 'junction.control.priority'],
  [Ctl.AllStop, 'junction.control.stop'], [Ctl.YieldAll, 'junction.control.yield'], [Ctl.Mini, 'junction.control.mini'], [Ctl.None, 'junction.control.none']];
const CTL_KEY: Record<number, string> = Object.fromEntries(CHOICES.map(([c, k]) => [c, k]));
const DIRS = ['compass.n', 'compass.ne', 'compass.e', 'compass.se', 'compass.s', 'compass.sw', 'compass.w', 'compass.nw'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

/** A leg named by where it goes (compass: −z is north). */
function legName(world: World, n: number, s: number, withProfile = false): string {
  const [dx, dz] = dirOut(world.roads, n, s);
  const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  const k = Math.round(a / 45) % 8;
  const dir = t(DIRS[k]);
  const base = `${ARROWS[k]} ${dir.charAt(0).toUpperCase()}${dir.slice(1)}`;
  return withProfile ? `${base} · ${profileName(PROFILE_INFO[world.roads.segs.cols.profile[s]])}` : base;
}

export class Inspector {
  readonly el: HTMLElement;
  node = -1;
  seg = -1;
  private world: World;
  private commands: CommandStack;
  private a: InspectActions;
  private probeTimer = 0;
  private live: Record<string, HTMLElement> = {};
  private flowFirst: { passed: number; time: number } | null = null;
  /** The incoming lane picked in the connectors: [road, lane]. */
  private laneIn: [number, number] | null = null;

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
    if (n >= 0 && (nc.deg[n] >= 3 || (nc.deg[n] === 2 && Math.hypot(nc.x[n] - x, nc.z[n] - z) < 6))) { this.node = n; this.seg = -1; }
    else {
      const s = net.nearestSeg(x, z, 14);
      this.node = -1; this.seg = s ? s[0] : -1;
    }
    this.laneIn = null;
    this.render();
  }

  close(): void {
    this.node = -1; this.seg = -1; this.laneIn = null;
    this.el.classList.add('hidden');
    this.a.mark(-1, -1);
    clearInterval(this.probeTimer);
    this.live = {};
  }

  /** Something changed (undo, an edit): rebuilt if the target still exists. */
  refresh(): void {
    const net = this.world.roads;
    if (this.node >= 0 && (!net.nodes.alive[this.node] || net.nodes.cols.deg[this.node] < 2)) this.node = -1;
    if (this.seg >= 0 && !net.segs.alive[this.seg]) this.seg = -1;
    if (this.node < 0 && this.seg < 0) { if (!this.el.classList.contains('hidden')) this.close(); return; }
    this.render();
  }

  private setLive(key: string, text: string): void { const e = this.live[key]; if (e && e.textContent !== text) e.textContent = text; }

  /** The junction's flow: the difference of its counter between two readings (vehicles an hour). */
  showNodeProbe(p: { node: number; passed: number; time: number }): void {
    if (p.node !== this.node) return;
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

  private apply(spec: JunctionSpec | null, label = 'controle do cruzamento'): void {
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
      if (sp0 && sp0.ctl === Ctl.UTurn) box.append(note(t('hint.uturn.placed')), actions(btn(t('ui.insp.closeUturn'), () => this.apply(null, 'fechar retorno'))));
      if (sp0 && (sp0.ctl === Ctl.Zebra || sp0.ctl === Ctl.PedSignal)) {
        box.append(note(t(sp0.ctl === Ctl.Zebra ? 'inspector.crossingZebra' : 'inspector.crossingSignal')), actions(btn(t('inspector.removeCrossing'), () => this.apply(null, 'remover faixa'))));
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
          this.apply(next && (next.end || next.ctl !== Ctl.Auto) ? next : null, 'ponta da via');
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
    // the numbers
    const grid = el('div', 'inspect-grid');
    grid.append(cardOf(t('inspector.control'), t(CTL_KEY[eff.ctl] ?? 'control.none')), cardOf(t('inspector.volume'), '…', (e) => { this.live.flow = e; }));
    box.append(grid, height, mouths());
    this.flowFirst = null;
    this.a.probeNode(n);
    this.probeTimer = window.setInterval(() => { if (this.node === n) this.a.probeNode(n); else clearInterval(this.probeTimer); }, 2000);

    // control
    box.append(section(t('junction.control')));
    box.append(select(CHOICES.map(([c, k]) => [c, t(k)]), spec?.ctl ?? Ctl.Auto, (v) => {
      if (v === Ctl.Auto) this.apply(null); else this.apply({ ...this.spec(), ctl: v });
    }));
    if (!spec || spec.ctl === Ctl.Auto) {
      box.append(note(t('ui.insp.autoChoice', { choice: t(CTL_KEY[eff.ctl] ?? 'control.none').toLowerCase() })));
      box.append(actions(btn(t('ui.insp.lock'), () => this.apply({ ...this.spec(), ctl: eff.ctl }, 'travar controle'))));
    } else box.append(note(t('junction.locked')), actions(btn(t('junction.unlock'), () => this.apply(null))));

    // rule of each leg (signs)
    if (eff.ctl === Ctl.Priority || eff.ctl === Ctl.AllStop) {
      box.append(section(t('junction.legs')));
      for (const s of segs) {
        const r = eff.legs.get(s) ?? Rule.Free;
        box.append(row(label(legName(this.world, n, s, true)), select([[Rule.Main, t('junction.rule.priority')], [Rule.Yield, t('junction.rule.yield')], [Rule.Stop, t('junction.rule.stop')]], r, (v) => {
          const sp = this.spec();
          if (sp.ctl === Ctl.Auto) sp.ctl = eff.ctl;
          sp.legs = [...(sp.legs ?? []).filter(([x]) => x !== s), [s, v]];
          this.apply(sp, 'regra da via');
        })));
      }
    }

    // signal
    if (eff.ctl === Ctl.Signal) {
      const stages: number[] = [];
      const count = signalStages(segs.map((s) => dirOut(net, n, s)), stages);
      box.append(section(t('junction.signal')));
      box.append(row(label(t('junction.signalMode')), select([[0, t('junction.mode.adaptive')], [1, t('junction.mode.fixed')]], spec?.fixed ? 1 : 0, (v) => {
        const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal;
        sp.fixed = v === 1; this.apply(sp, 'tempos do semáforo');
      })));
      for (let k = 0; k < count; k++) {
        const legs = segs.filter((_, i) => stages[i] === k).map((s) => legName(this.world, n, s)).join(' · ');
        const g = spec?.greens?.[k] ?? 20;
        const setG = (d: number): void => {
          const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal;
          sp.fixed = true;
          const greens = Array.from({ length: count }, (_, i) => sp.greens?.[i] ?? 20);
          greens[k] = Math.max(6, Math.min(90, greens[k] + d));
          sp.greens = greens; this.apply(sp, 'verde do semáforo');
        };
        box.append(row(label(`${t('junction.stage', { n: k + 1 })} (${legs})`), btn('−', () => setG(-5), '', t('junction.shorter')), value(`${g} s`), btn('+', () => setG(5), '', t('junction.longer'))));
      }
      const off = spec?.offset ?? 0;
      const setOff = (d: number): void => { const sp = this.spec(); sp.ctl = Ctl.Signal; sp.fixed = true; sp.offset = off + d; this.apply(sp, 'defasagem'); };
      box.append(row(label(t('junction.offset')), btn('−', () => setOff(-2), '', t('junction.earlier')), value(`${off} s`), btn('+', () => setOff(2), '', t('junction.later'))));
      box.append(actions(btn(t('junction.greenWave'), () => this.greenWave())));
      const bus = el('label', 'check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!spec?.bus;
      cb.addEventListener('change', () => { const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal; sp.bus = cb.checked; this.apply(sp, 'prioridade ao ônibus'); });
      bus.append(cb, el('span', '', t('junction.busPriority')));
      box.append(bus);
    }

    // lane connectors: the lanes coming in (blue), then where the picked one may go (green)
    box.append(section(`${t('connectors.title')} · ${t(spec?.lanes?.length ? 'connectors.custom' : 'connectors.auto')}`));
    const ins = el('div', 'legs');
    let any = false;
    for (const from of segs) {
      const ex = laneExits(net, n, from, spec);
      if (!ex.length) continue;
      any = true;
      const r = row(label(legName(this.world, n, from)));
      ex.forEach((lane, li) => {
        const on = this.laneIn !== null && this.laneIn[0] === from && this.laneIn[1] === li;
        const c = chip(`${t('profile.element.lane')} ${li + 1}`, `in${on ? ' on' : ''}`, () => { this.laneIn = on ? null : [from, li]; this.render(); });
        c.title = lane.exits.map(([s]) => legName(this.world, n, s)).join(', ');
        r.append(c);
      });
      ins.append(r);
    }
    if (!any) box.append(note(t('connectors.none')));
    else {
      box.append(ins);
      if (!this.laneIn) box.append(note(t('connectors.pickIn')));
      else {
        const [from, li] = this.laneIn;
        const lane = laneExits(net, n, from, spec)[li];
        if (lane) {
          box.append(note(t('connectors.pickOut')));
          const outs = row(label(`${legName(this.world, n, from)} · ${t('profile.element.lane')} ${li + 1} →`));
          for (const to of segs) {
            if (to === from) continue;
            const isOn = lane.exits.some(([s2]) => s2 === to);
            outs.append(chip(legName(this.world, n, to), `out${isOn ? '' : ' off'}`, () => {
              const sp = this.spec();
              const now = lane.exits.map(([s2]) => s2);
              const next = isOn ? now.filter((s2) => s2 !== to) : [...now, to];
              if (!next.length) { this.a.toast(t('connectors.lastExit')); return; }
              sp.lanes = [...(sp.lanes ?? []).filter(([s2, i2]) => !(s2 === from && i2 === li)), [from, li, next]];
              this.apply(sp, 'conexão de faixa');
            }));
          }
          box.append(outs);
        }
      }
      if (spec?.lanes?.length) box.append(actions(btn(t('connectors.reset'), () => { const sp = this.spec(); delete sp.lanes; this.apply(sp, 'conexões automáticas'); })));
    }

    // movements
    box.append(section(t('junction.movements')));
    for (const from of segs) {
      const r = row(label(legName(this.world, n, from)));
      for (const to of segs) {
        if (to === from) continue;
        const ban = (spec?.bans ?? []).some((_, i, b) => i % 2 === 0 && b[i] === from && b[i + 1] === to);
        const c = chip(legName(this.world, n, to), `out${ban ? ' off' : ''}`, () => {
          const sp = this.spec();
          const bans = (sp.bans ?? []).slice();
          let found = -1;
          for (let i = 0; i + 1 < bans.length; i += 2) if (bans[i] === from && bans[i + 1] === to) found = i;
          if (found >= 0) bans.splice(found, 2); else bans.push(from, to);
          sp.bans = bans;
          this.apply(sp, 'movimento proibido');
        });
        c.title = t(ban ? 'junction.moveBlocked' : 'junction.moveAllowed');
        r.append(c);
      }
      box.append(r);
    }
  }

  /** Records a road edit (charged; without the money it is undone and said). */
  private edit(j: RoadJournal, ok: string): void {
    if (j.empty) return;
    const price = j.price;
    if (!j.settle()) { this.a.toast(t('ui.insp.noMoney', { price: money(price) })); return; }
    this.commands.push(j);
    this.a.toast(ok);
    this.refresh();
  }

  /** A pedestrian crossing in the middle of the road (one undo step). */
  private crossing(s: number, ctl: number): void {
    const r = addCrossing(this.world, s, 0.5, ctl);
    if (typeof r === 'string') { this.a.toast(r); return; }
    this.commands.push(r);
    this.a.toast(t(ctl === Ctl.Zebra ? 'inspector.crossingZebra' : 'inspector.crossingSignal'));
    this.close();
  }

  private raise(dy: number): void {
    const j = new RoadJournal(this.world, 'altura do nó');
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
    const nodes = new Set<number>();
    for (const s of chain) { nodes.add(sc.a[s]); nodes.add(sc.b[s]); }
    const base = this.spec();
    const greens = base.greens ?? [20, 20, 20, 20];
    const speed = PROFILE_INFO[sc.profile[main]].speed / 3.6;
    const j = new RoadJournal(this.world, 'onda verde');
    let count = 0;
    for (const m of nodes) {
      if (nc.deg[m] < 3 || effectiveControl(net, m, net.junctions.get(m), net.flow.get(m)).ctl !== Ctl.Signal) continue;
      const d = Math.hypot(nc.x[m] - nc.x[n], nc.z[m] - nc.z[n]);
      const old = net.junctions.get(m);
      j.setJunction(m, { ...(old ?? {}), ctl: Ctl.Signal, fixed: true, greens, offset: -Math.round(d / speed) });
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
    for (const [n, key] of [[sc.a[s], 'inspector.heightStart'], [sc.b[s], 'inspector.heightEnd']] as Array<[number, string]>) {
      const v = nc.y[n];
      box.append(row(label(t(key)), stepper(`${fmtDec(v)} m`, () => this.raiseNode(n, -0.5), () => this.raiseNode(n, 0.5))));
    }
    // a dead end's shape (4.0 :175-181, :248, :302-304): automatic, a turning bulb or plain
    for (const [n, key] of [[sc.a[s], 'inspector.endStart'], [sc.b[s], 'inspector.endEnd']] as Array<[number, string]>) {
      if (nc.deg[n] !== 1) continue;
      const now = net.junctions.get(n)?.end ?? 'auto';
      const sel = select([[0, t('insp.end.auto')], [1, t('inspector.end.bulb')], [2, t('insp.end.plain')]], now === 'bulb' ? 1 : now === 'plain' ? 2 : 0, (v) => {
        const end = v === 1 ? 'bulb' as const : v === 2 ? 'plain' as const : undefined;
        const s0 = net.junctions.get(n);
        const next: JunctionSpec | null = s0 ? { ...s0, end } : end ? { ctl: Ctl.Auto, end } : null;
        if (next && !next.end) delete next.end;
        const j = new RoadJournal(w, 'ponta da via');
        j.setJunction(n, next && (next.end || next.ctl !== Ctl.Auto) ? next : null);
        this.commands.push(j);
        this.render();
      });
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
        })));
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
        this.commands.push(r); this.a.toast(t('hint.uturn.placed')); this.close();
      })] : []),
      btn(t('inspector.addHeightPoint'), () => {
        const r = addHeightPoint(w, s);
        if (typeof r === 'string') { this.a.toast(r); return; }
        if (!r.journal.settle()) return;
        this.commands.push(r.journal);
        // the new point's own panel: its height steppers
        this.node = r.node; this.seg = -1; this.render();
      }),
      btn(t('inspector.demolish'), () => {
        const j = demolishSeg(w, s);
        if (j.settle()) { this.commands.push(j); if (j.charge) this.a.toast(t('ui.insp.refund', { value: money(-j.charge) })); }
        this.close();
      }, 'danger'),
    ));
  }

  /** A node raised or lowered by `dy` (half a metre a step), from the road's panel. */
  private raiseNode(n: number, dy: number): void {
    const j = new RoadJournal(this.world, 'altura do nó');
    j.moveNodeY(n, this.world.roads.nodes.cols.y[n] + dy);
    if (j.settle()) this.commands.push(j);
    this.render();
  }

  /** The road bent to the curvature and position chosen (roads/build.ts bendRoad). */
  private bend(s: number, t0: number, h: number): void {
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
function select(opts: Array<[number, string]>, v: number, fn: (v: number) => void): HTMLSelectElement {
  const s = el('select');
  for (const [k, text] of opts) { const o = el('option', '', text); o.value = String(k); s.append(o); }
  s.value = String(v);
  s.addEventListener('change', () => { fn(Number(s.value)); s.blur(); });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}
