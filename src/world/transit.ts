// Linhas de ônibus do jogador: paradas (pontos na calçada, em ordem) e
// quantos ônibus rodam em cada linha. A simulação recebe a lista inteira a
// cada mudança (é pequena). Edição é comando com desfazer.

import type { Command } from '../core/commands.ts';

/** Modo da linha: ônibus, trem ou metrô (trem e metrô andam nos trilhos). */
export const Mode = { Bus: 0, Train: 1, Metro: 2 } as const;
export const MODE_NAMES = ['Ônibus', 'Trem', 'Metrô'];

export interface Line { id: number; color: number; buses: number; stops: number[]; mode?: number }

/** Cores das linhas (índices da paleta dos veículos: PAINTS em render/vehicles.ts). */
export const LINE_COLORS = [7, 5, 11, 8, 14, 15, 6, 4];

export class Transit {
  readonly lines: Line[] = [];
  /** Terminais: pontos (x, z) onde os ônibus esperam mais e dão a volta. */
  terminals: number[] = [];
  private nextId = 1;
  version = 0;

  line(id: number): Line | undefined { return this.lines.find((l) => l.id === id); }

  private touch(): void { this.version++; }

  /** Nova linha vazia (comando). */
  addLine(mode: number = Mode.Bus): { cmd: Command; id: number } {
    const id = this.nextId++;
    const color = LINE_COLORS[(id - 1) % LINE_COLORS.length];
    const line: Line = { id, color, buses: mode === Mode.Bus ? 3 : 2, stops: [], mode };
    const cmd: Command = {
      label: 'nova linha',
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
      label: 'apagar linha',
      apply: () => { const k = this.lines.findIndex((l) => l.id === id); if (k >= 0) this.lines.splice(k, 1); this.touch(); },
      invert: () => { this.lines.splice(Math.min(i, this.lines.length), 0, { ...saved, stops: [...saved.stops] }); this.touch(); },
    };
  }

  /** Põe uma parada em (x, z) na posição `at` da linha (fim, por padrão). */
  addStop(id: number, x: number, z: number, at = -1): Command | null {
    const l = this.line(id);
    if (!l) return null;
    const k = at < 0 ? l.stops.length / 2 : at;
    return {
      label: 'parada',
      apply: () => { this.line(id)?.stops.splice(k * 2, 0, x, z); this.touch(); },
      invert: () => { this.line(id)?.stops.splice(k * 2, 2); this.touch(); },
    };
  }

  removeStop(id: number, k: number): Command | null {
    const l = this.line(id);
    if (!l || k * 2 >= l.stops.length) return null;
    const x = l.stops[k * 2], z = l.stops[k * 2 + 1];
    return {
      label: 'tirar parada',
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
      label: 'ônibus',
      apply: () => { const x = this.line(id); if (x) x.buses = after; this.touch(); },
      invert: () => { const x = this.line(id); if (x) x.buses = before; this.touch(); },
    };
  }

  /** Liga ou desliga o terminal no ponto (comando). */
  toggleTerminal(x: number, z: number): Command {
    const i = this.terminalNear(x, z, 9);
    const before = [...this.terminals];
    const after = i >= 0 ? before.filter((_, k) => k !== i * 2 && k !== i * 2 + 1) : [...before, x, z];
    return {
      label: 'terminal',
      apply: () => { this.terminals = [...after]; this.touch(); },
      invert: () => { this.terminals = [...before]; this.touch(); },
    };
  }

  /** Terminal perto de (x, z), ou −1. */
  terminalNear(x: number, z: number, r: number): number {
    for (let k = 0; k * 2 < this.terminals.length; k++) if (Math.hypot(this.terminals[k * 2] - x, this.terminals[k * 2 + 1] - z) <= r) return k;
    return -1;
  }

  /** Índices das paradas da linha que são terminais. */
  terminalStops(l: Line): number[] {
    const out: number[] = [];
    for (let k = 0; k * 2 < l.stops.length; k++) if (this.terminalNear(l.stops[k * 2], l.stops[k * 2 + 1], 9) >= 0) out.push(k);
    return out;
  }

  /** Parada mais perto de (x, z) dentro do raio: [linha, índice]. */
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

  /** Binário simples para o salvamento: [n, (id, cor, ônibus, paradas, x, z...)...]. */
  encode(): Float64Array {
    const out: number[] = [this.lines.length, this.nextId];
    // modo vai junto com a cor (cor + modo × 256): salvamentos antigos leem como ônibus
    for (const l of this.lines) out.push(l.id, l.color + (l.mode ?? 0) * 256, l.buses, l.stops.length / 2, ...l.stops);
    return new Float64Array(out);
  }

  decode(a: Float64Array): void {
    this.lines.length = 0;
    let o = 0;
    const n = a[o++];
    this.nextId = a[o++];
    for (let i = 0; i < n; i++) {
      const id = a[o++], color = a[o++], buses = a[o++], k = a[o++];
      this.lines.push({ id, color: color % 256, mode: Math.floor(color / 256), buses, stops: Array.from(a.subarray(o, o + k * 2)) });
      o += k * 2;
    }
    this.touch();
  }
}
