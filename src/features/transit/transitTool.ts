// The transit tool: the line being edited and the tab's mode (bus or rail), a click that puts or takes a stop (a bus
// stop on the nearest sidewalk, a station on the track; Shift on a stop turns its terminal on or off), the lines'
// buses and their removal, and keeping the simulation and the lines panel in step. The feature owns the selection and
// the mode; the lines themselves are the world's (world/transit.ts) and every change is a command.

import type { Command } from '../../core/commands.ts';
import { bez, bezD } from '../../roads/geometry.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import type { RoadNetwork } from '../../roads/network.ts';
import type { Transit } from '../../world/transit.ts';
import type { DirtyCells } from '../../core/grid.ts';
import { t } from '../../shared/i18n/index.ts';
import type { LineRow } from '../../ui/drawers.ts';

/** What the simulation reports of each line (FromSim 'stats'.lines). */
export interface LineStat { id: number; buses: number; perHour: number; waiting: number }

export interface TransitHost {
  readonly transit: Transit;
  readonly roads: RoadNetwork;
  readonly heights: Float32Array;
  readonly dirty: DirtyCells;
  /** The stops, stations and line paths drawn (render/transit.ts TransitRenderer). */
  readonly view: { update(transit: Transit, net: RoadNetwork, heights: Float32Array, version: number, dirty?: DirtyCells): void };
  run(cmd: Command): void;
  toast(text: string): void;
  /** A line was made (the achievement). */
  lineMade(): void;
  /** Sends the lines to the simulation (ToSim 'lines'). */
  sendLines(lines: Array<{ id: number; color: number; buses: number; stops: number[]; mode: number; term: number[]; loop: boolean }>): void;
  /** Shows the lines in the panel. */
  showLines(rows: LineRow[], current: number): void;
}

const p2 = new Float64Array(2), d2 = new Float64Array(2);

export class TransitTool {
  /** The line being edited (0: none). */
  selected = 0;
  /** The tab's mode: 0 bus, otherwise rail. */
  mode = 0;
  private sent = -1;
  private shownKey = '';
  private shownStats: readonly LineStat[] | null = null;
  private host: TransitHost;

  constructor(host: TransitHost) { this.host = host; }

  /** Starts a new line of the tab's mode and selects it. */
  newLine(): void {
    this.host.lineMade();
    const { cmd, id } = this.host.transit.addLine(this.mode);
    this.host.run(cmd);
    this.selected = id;
  }

  /** The tab's mode; the selection moves to the newest line of that mode (or none). */
  setMode(m: number): void {
    this.mode = m;
    const tr = this.host.transit;
    if ((tr.line(this.selected)?.mode ?? 0) !== m) {
      let pick = 0;
      for (let i = tr.lines.length - 1; i >= 0; i--) if ((tr.lines[i].mode ?? 0) === m) { pick = tr.lines[i].id; break; }
      this.selected = pick;
    }
  }

  /** Adds or takes buses from the selected line. */
  buses(delta: number): void {
    const tr = this.host.transit, l = tr.line(this.selected);
    const c = l && tr.setBuses(l.id, l.buses + delta);
    if (c) this.host.run(c);
  }

  /** The selected line's colour (an index into the vehicle palette). */
  setColor(color: number): void { const c = this.host.transit.setColor(this.selected, color); if (c) this.host.run(c); }

  /** The selected line as a ring (true) or out and back. */
  setLoop(loop: boolean): void { const c = this.host.transit.setLoop(this.selected, loop); if (c) this.host.run(c); }

  /** Deletes the selected line; the first one left is selected. */
  deleteLine(): void {
    const tr = this.host.transit, c = tr.removeLine(this.selected);
    if (c) { this.host.run(c); this.selected = tr.lines[0]?.id ?? 0; }
  }

  /** A click on the map: takes the stop there, or puts one on the nearest sidewalk (a station on the track); Shift on a stop turns its terminal on or off. */
  click(hit: { x: number; z: number } | null, shift = false): void {
    if (!hit) return;
    const tr = this.host.transit;
    if (shift) {
      const s = tr.stopNear(hit.x, hit.z, 9);
      if (!s) { this.host.toast(t('game.toast.terminalHow')); return; }
      const l = tr.line(s[0])!;
      const x = l.stops[s[1] * 2], z = l.stops[s[1] * 2 + 1];
      const was = tr.terminalNear(x, z, 9) >= 0;
      this.host.run(tr.toggleTerminal(x, z));
      this.host.toast(was ? t('game.toast.terminalOff') : t('game.toast.terminalOn'));
      return;
    }
    const near = tr.stopNear(hit.x, hit.z, 9);
    if (near) {
      const c = tr.removeStop(near[0], near[1]);
      if (c) this.host.run(c);
      this.selected = near[0];
      return;
    }
    const net = this.host.roads, sc = net.segs.cols;
    if (!tr.line(this.selected)) this.newLine();
    const rail = (tr.line(this.selected)!.mode ?? 0) > 0;
    const seg = net.nearestSeg(hit.x, hit.z, 30, (s) => PROFILE_INFO[sc.profile[s]].rail === rail);
    if (!seg) { this.host.toast(rail ? t('game.toast.stationOnTrack') : t('game.toast.stopNearRoad')); return; }
    const q = net.quad(seg[0]);
    bez(q, seg[1], p2); bezD(q, seg[1], d2);
    if (rail) {
      // a station: on the track's centre line
      const c = tr.addStop(this.selected, p2[0], p2[1]);
      if (c) this.host.run(c);
      return;
    }
    const info = PROFILE_INFO[sc.profile[seg[0]]];
    if (!info.strips.some((s) => s.kind === 'sidewalk')) { this.host.toast(t('game.toast.noSidewalk')); return; }
    const l = Math.hypot(d2[0], d2[1]) || 1, lx = d2[1] / l, lz = -d2[0] / l;
    const side = (hit.x - p2[0]) * lx + (hit.z - p2[1]) * lz > 0 ? 1 : -1;
    const e = side > 0 ? info.edges[info.edges.length - 1] : info.edges[0];
    const other = side > 0 ? info.edges[0] : info.edges[info.edges.length - 1];
    const sw = e.strip.kind === 'sidewalk' ? e : other;
    const u = (sw.u0 + sw.u1) / 2;
    const c = tr.addStop(this.selected, p2[0] + lx * u, p2[1] + lz * u);
    if (c) this.host.run(c);
  }

  /**
   * Draws the stops (TransitRenderer.update: it rebuilds only when the lines change or a road near a stop is edited),
   * keeps the simulation's lines in step (when the lines or the roads change: `roadsVersion`) and, while the tool is
   * open, the panel's list (only when the lines, the selection or the simulation's figures change: no list made
   * every frame).
   */
  sync(roadsVersion: number, toolOpen: boolean, stats: readonly LineStat[] | null): void {
    const tr = this.host.transit;
    // the stops: rebuilt when the lines change or a road is edited near a stop (not on every road edit)
    this.host.view.update(tr, this.host.roads, this.host.heights, tr.version, this.host.dirty);
    const v = tr.version * 100000 + roadsVersion;
    if (v !== this.sent) {
      this.sent = v;
      this.host.sendLines(tr.lines.map((l) => ({ id: l.id, color: l.color, buses: l.buses, stops: [...l.stops], mode: l.mode ?? 0, term: tr.terminalStops(l), loop: !!l.loop })));
    }
    if (!toolOpen) return;
    // no line chosen: the first of the tab's mode (none: the first click makes one)
    if (!tr.line(this.selected)) for (const l of tr.lines) if ((l.mode ?? 0) === this.mode) { this.selected = l.id; break; }
    const key = `${tr.version}:${this.selected}`;
    if (key === this.shownKey && stats === this.shownStats) return;
    this.shownKey = key; this.shownStats = stats;
    this.host.showLines(tr.lines.map((l) => {
      const q = stats?.find((x) => x.id === l.id);
      return { id: l.id, mode: l.mode ?? 0, color: l.color, loop: !!l.loop, buses: l.buses, stops: l.stops.length / 2, perHour: q ? q.perHour : 0, waiting: q ? q.waiting : 0 };
    }), this.selected);
  }
}
