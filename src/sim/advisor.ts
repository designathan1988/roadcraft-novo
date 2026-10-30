// Controle automático pelo fluxo (roadcraft controlAdvisor): cada cruzamento no automático conta quem
// chega por braço (micro e meso), a taxa vira média móvel de alguns minutos e, com histerese, o nó ganha
// ou perde o semáforo. Uma fatia fixa de nós por passo (nunca o mapa inteiro), tudo em arrays por nó.

import { Flow, warrantedControl } from '../roads/control.ts';
import type { SimNet } from './lanes.ts';
import { asNode, type NodeId } from '../core/ids.ts';

/** Média móvel do fluxo (s): o controle só muda por uma tendência, não por um pelotão. */
export const TREND = 300;
/** Tempo mínimo entre duas trocas no mesmo nó, e de medida antes da primeira (s). */
export const SETTLE = 600;
/** Nós avaliados por passo, e trocas por passo (cada troca refaz o nó; o resto troca na volta seguinte). */
const PER_STEP = 64, CHANGES_PER_STEP = 2;

export class FlowAdvisor {
  private readonly sim: SimNet;
  /** Chegadas por braço (nó * 8 + braço), desde sempre; e o valor na última avaliação. */
  pass = new Uint32Array((1 << 14) * 8);
  private seen = new Uint32Array((1 << 14) * 8);
  /** Fluxo por braço (veíc./h, média móvel). */
  rate = new Float32Array((1 << 14) * 8);
  /** Última avaliação e começo da medida (ou última troca) de cada nó. */
  private lastT = new Float64Array(1 << 14);
  private since = new Float64Array(1 << 14).fill(-1);
  private cursor = 0;
  /**
   * Limiares do roadcraft vezes isto. Com 1 o automático punha ~700 semáforos na cidade gerada de 16 km e o
   * centro caía 1-2 km/h (aqui o cruzamento com placas escoa mais que um semáforo); com 2 troca ~200 nós
   * (põe onde o fluxo é muito alto, tira onde a importância das vias pedia e quase ninguém passa).
   */
  scale = 2;
  /** Trocas feitas (para o diagnóstico). */
  changes = 0;
  /** Nó trocou (para avisar a página). */
  onChange: (node: NodeId, flow: number) => void = () => {};

  constructor(sim: SimNet) {
    this.sim = sim;
    sim.net.nodes.onGrow((cap) => {
      this.pass = grow(this.pass, cap * 8); this.seen = grow(this.seen, cap * 8); this.rate = grow(this.rate, cap * 8);
      this.lastT = grow(this.lastT, cap); this.since = grow(this.since, cap, -1);
    });
  }

  /** Nó novo ou com controle escolhido: mede de novo. */
  reset(n: number): void {
    for (let a = 0; a < 8; a++) { this.pass[n * 8 + a] = 0; this.seen[n * 8 + a] = 0; this.rate[n * 8 + a] = 0; }
    this.since[n] = -1;
  }

  /** Avalia a próxima fatia de nós. */
  step(time: number): void {
    const sim = this.sim, nodes = sim.net.nodes, end = nodes.end;
    if (end === 0) return;
    let changes = 0;
    for (let i = 0; i < PER_STEP && changes < CHANGES_PER_STEP; i++) {
      if (this.cursor >= end) this.cursor = 0;
      const n = this.cursor++;
      if (!nodes.alive[n] || !sim.nodeAuto[n]) continue;
      if (this.since[n] < 0) { this.since[n] = time; this.lastT[n] = time; for (let a = 0; a < 8; a++) this.seen[n * 8 + a] = this.pass[n * 8 + a]; continue; }
      const dt = time - this.lastT[n];
      if (dt <= 0) continue;
      this.lastT[n] = time;
      // média móvel exponencial da taxa de cada braço
      const w = Math.min(1, dt / TREND), main = sim.armMain[n], deg = nodes.cols.deg[n];
      let major = 0, minorMax = 0, minorTotal = 0;
      for (let a = 0; a < deg; a++) {
        const k = n * 8 + a;
        const inst = (this.pass[k] - this.seen[k]) / dt * 3600;
        this.seen[k] = this.pass[k];
        this.rate[k] += (inst - this.rate[k]) * w;
        if (main & (1 << a)) major += this.rate[k];
        else { minorMax = Math.max(minorMax, this.rate[k]); minorTotal += this.rate[k]; }
      }
      if (time - this.since[n] < SETTLE) continue;
      const current = sim.nodePhases[n] > 0 ? 'signal' : 'priority';
      const k = this.scale;
      const want = warrantedControl(major / k, minorMax / k, minorTotal / k, current);
      const flow = want === 'signal' ? Flow.Signal : Flow.Signs;
      if ((want === 'signal') === (current === 'signal')) continue;
      const node = asNode(n);
      sim.setFlow(node, flow);
      this.since[n] = time;
      this.changes++; changes++;
      this.onChange(node, flow);
    }
  }
}

function grow<T extends Uint32Array | Float32Array | Float64Array>(a: T, cap: number, fill = 0): T {
  if (cap <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.fill(fill);
  b.set(a);
  return b;
}
