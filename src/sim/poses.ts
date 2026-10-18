// Poses compartilhadas entre o worker de simulação e a página, em buffer triplo
// sem trava. O escritor publica trocando seu buffer pelo do meio; o leitor
// pega o do meio quando há um novo. Ninguém espera ninguém.
//
// Cada registro guarda a pose anterior e a atual, para a página interpolar.

export const POSE_STRIDE = 10; // px, py, pz, pyaw, x, y, z, yaw, tipo*256+cor, opacidade
export const MAX_AGENTS = 1 << 17; // 131 072 carros + pessoas na janela micro

const STATE = 0; // bits 0-1: índice do meio; bit 2: novo
const NEW = 4;
const HEADER_INTS = 4;

export interface PoseBuffers {
  sab: SharedArrayBuffer;
  ctl: Int32Array; // [estado]
  /** Por buffer: [contagem, tick] em Float64 (t do tick em ms, dt em ms). */
  meta: Float64Array; // 3 × 4
  data: Float32Array[]; // 3 buffers
}

export function createPoseBuffers(): SharedArrayBuffer {
  const bytes = HEADER_INTS * 4 + 3 * 4 * 8 + 3 * MAX_AGENTS * POSE_STRIDE * 4;
  return new SharedArrayBuffer(bytes);
}

export function viewPoseBuffers(sab: SharedArrayBuffer): PoseBuffers {
  const ctl = new Int32Array(sab, 0, HEADER_INTS);
  const meta = new Float64Array(sab, HEADER_INTS * 4, 12);
  const off = HEADER_INTS * 4 + 12 * 8;
  const data = [0, 1, 2].map((i) => new Float32Array(sab, off + i * MAX_AGENTS * POSE_STRIDE * 4, MAX_AGENTS * POSE_STRIDE));
  return { sab, ctl, meta, data };
}

/** Lado da simulação. */
export class PoseWriter {
  back: number;
  private b: PoseBuffers;
  constructor(b: PoseBuffers) {
    this.b = b;
    // estado inicial: meio = 1, escritor = 0, leitor = 2
    Atomics.store(b.ctl, STATE, 1);
    this.back = 0;
  }
  get data(): Float32Array { return this.b.data[this.back]; }
  publish(count: number, tickTimeMs: number, dtMs: number, tick: number): void {
    const m = this.back * 4;
    this.b.meta[m] = count;
    this.b.meta[m + 1] = tickTimeMs;
    this.b.meta[m + 2] = dtMs;
    this.b.meta[m + 3] = tick;
    this.back = Atomics.exchange(this.b.ctl, STATE, this.back | NEW) & 3;
  }
}

/** Lado da página. */
export class PoseReader {
  front = 2;
  private b: PoseBuffers;
  constructor(b: PoseBuffers) { this.b = b; }
  /** Pega o buffer mais novo, se houver. Devolve true quando trocou. */
  acquire(): boolean {
    if ((Atomics.load(this.b.ctl, STATE) & NEW) === 0) return false;
    this.front = Atomics.exchange(this.b.ctl, STATE, this.front) & 3;
    return true;
  }
  get data(): Float32Array { return this.b.data[this.front]; }
  get count(): number { return this.b.meta[this.front * 4]; }
  get tickTime(): number { return this.b.meta[this.front * 4 + 1]; }
  get dt(): number { return this.b.meta[this.front * 4 + 2]; }
  get tick(): number { return this.b.meta[this.front * 4 + 3]; }
}
