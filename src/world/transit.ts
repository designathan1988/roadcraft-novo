// The player's bus lines: stops (points on the sidewalk, in order) and
// how many buses run on each line. The simulation receives the whole list on
// every change (it is small). Editing is a command with undo.

import type { Command } from '../core/commands.ts';

/** Line mode: bus, train or metro (train and metro run on rails). */
export const Mode = { Bus: 0, Train: 1, Metro: 2 } as const;

/** A line. Bus lines run out and back (Roadcraft) unless `loop` (a ring: last stop → first). */
export interface Line { id: number; color: number; buses: number; stops: number[]; mode?: number; loop?: boolean }

/** Line colours (indices into the vehicle palette: PAINTS in render/vehicles.ts). */
export const LINE_COLORS = [7, 5, 11, 8, 14, 15, 6, 4];

export class Transit {
  readonly lines: Line[] = [];
  /** Terminals: points (x, z) where buses wait longer and turn around. */
  terminals: number[] = [];
  private nextId = 1;
  version = 0;

  line(id: number): Line | undefined { return this.lines.find((l) => l.id === id); }

  private touch(): void { this.version++; }

  /** New empty line (command). */
  addLine(mode: number = Mode.Bus): { cmd: Command; id: number } {
    const id = this.nextId++;
    const color = LINE_COLORS[(id - 1) % LINE_COLORS.length];
    const line: Line = { id, color, buses: mode === Mode.Bus ? 3 : 2, stops: [], mode };
    const cmd: Command = {
      label: 'cmd.place.newLine',
      apply: () => { this.lines.push({ ...line, stops: [...line.stops] }); this.touch(); },
      invert: () => { const i = this.lines.findIndex((l) => l.id === id); if (i >= 0) this.lines.splice(i, 1); this.touch(); },
    };
    return { cmd, id };
  }

  removeLine(id: number): Command | null {
    const i = this.lines.findIndex((l) => l.id === id);
    if (i < 0) return null;
    const saved = { ...this.lines[i], stops: [...this.lines[i].stops] };
    return {
      label: 'cmd.demolish.line',
      apply: () => { const k = this.lines.findIndex((l) => l.id === id); if (k >= 0) this.lines.splice(k, 1); this.touch(); },
      invert: () => { this.lines.splice(Math.min(i, this.lines.length), 0, { ...saved, stops: [...saved.stops] }); this.touch(); },
    };
  }

  /** Puts a stop at (x, z) at position `at` in the line (the end, by default). */
  addStop(id: number, x: number, z: number, at = -1): Command | null {
    const l = this.line(id);
    if (!l) return null;
    const k = at < 0 ? l.stops.length / 2 : at;
    return {
      label: 'cmd.place.stop',
      apply: () => { this.line(id)?.stops.splice(k * 2, 0, x, z); this.touch(); },
      invert: () => { this.line(id)?.stops.splice(k * 2, 2); this.touch(); },
    };
  }

  removeStop(id: number, k: number): Command | null {
    const l = this.line(id);
    if (!l || k * 2 >= l.stops.length) return null;
    const x = l.stops[k * 2], z = l.stops[k * 2 + 1];
    return {
      label: 'cmd.demolish.stop',
      apply: () => { this.line(id)?.stops.splice(k * 2, 2); this.touch(); },
      invert: () => { this.line(id)?.stops.splice(k * 2, 0, x, z); this.touch(); },
    };
  }

  setBuses(id: number, n: number): Command | null {
    const l = this.line(id);
    if (!l) return null;
    const before = l.buses, after = Math.max(0, Math.min(40, n));
    if (before === after) return null;
    return {
      label: 'cmd.place.bus',
      apply: () => { const x = this.line(id); if (x) x.buses = after; this.touch(); },
      invert: () => { const x = this.line(id); if (x) x.buses = before; this.touch(); },
    };
  }

  /** Line colour (index into the vehicle palette, LINE_COLORS) as a command. */
  setColor(id: number, color: number): Command | null {
    const l = this.line(id);
    if (!l || l.color === color) return null;
    const before = l.color;
    return {
      label: 'cmd.place.lineColour',
      apply: () => { const x = this.line(id); if (x) x.color = color; this.touch(); },
      invert: () => { const x = this.line(id); if (x) x.color = before; this.touch(); },
    };
  }

  /** Ring line (last stop → first) or out and back, as a command. */
  setLoop(id: number, loop: boolean): Command | null {
    const l = this.line(id);
    if (!l || !!l.loop === loop) return null;
    return {
      label: loop ? 'cmd.place.loopLine' : 'cmd.place.outAndBackLine',
      apply: () => { const x = this.line(id); if (x) x.loop = loop; this.touch(); },
      invert: () => { const x = this.line(id); if (x) x.loop = !loop; this.touch(); },
    };
  }

  /** Toggles the terminal at the point (command). */
  toggleTerminal(x: number, z: number): Command {
    const i = this.terminalNear(x, z, 9);
    const before = [...this.terminals];
    const after = i >= 0 ? before.filter((_, k) => k !== i * 2 && k !== i * 2 + 1) : [...before, x, z];
    return {
      label: 'cmd.place.terminal',
      apply: () => { this.terminals = [...after]; this.touch(); },
      invert: () => { this.terminals = [...before]; this.touch(); },
    };
  }

  /** Terminal near (x, z), or −1. */
  terminalNear(x: number, z: number, r: number): number {
    for (let k = 0; k * 2 < this.terminals.length; k++) if (Math.hypot(this.terminals[k * 2] - x, this.terminals[k * 2 + 1] - z) <= r) return k;
    return -1;
  }

  /** Indices of the line's stops that are terminals. */
  terminalStops(l: Line): number[] {
    const out: number[] = [];
    for (let k = 0; k * 2 < l.stops.length; k++) if (this.terminalNear(l.stops[k * 2], l.stops[k * 2 + 1], 9) >= 0) out.push(k);
    return out;
  }

  /** Nearest stop to (x, z) within the radius: [line, index]. */
  stopNear(x: number, z: number, r: number): [number, number] | null {
    let best: [number, number] | null = null, bd = r * r;
    for (const l of this.lines) {
      for (let k = 0; k * 2 < l.stops.length; k++) {
        const d = (l.stops[k * 2] - x) ** 2 + (l.stops[k * 2 + 1] - z) ** 2;
        if (d < bd) { bd = d; best = [l.id, k]; }
      }
    }
    return best;
  }

  clear(): void { this.lines.length = 0; this.terminals = []; this.nextId = 1; this.touch(); }

  /** Simple binary for the save: [n, (id, colour, buses, stops, x, z...)...]. */
  encode(): Float64Array {
    const out: number[] = [this.lines.length, this.nextId];
    // mode is packed with the colour (colour + mode × 256): old saves read as bus
    // ring lines add 4096 (older saves read as out-and-back)
    for (const l of this.lines) out.push(l.id, l.color + (l.mode ?? 0) * 256 + (l.loop ? 4096 : 0), l.buses, l.stops.length / 2, ...l.stops);
    return new Float64Array(out);
  }

  decode(a: Float64Array): void {
    this.lines.length = 0;
    let o = 0;
    const n = a[o++];
    this.nextId = a[o++];
    for (let i = 0; i < n; i++) {
      const id = a[o++], color = a[o++], buses = a[o++], k = a[o++];
      this.lines.push({ id, color: color % 256, mode: Math.floor(color / 256) % 16, loop: color >= 4096, buses, stops: Array.from(a.subarray(o, o + k * 2)) });
      o += k * 2;
    }
    this.touch();
  }
}
