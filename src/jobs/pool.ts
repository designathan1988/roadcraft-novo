// Sistema de tarefas único com prioridade, rodando num pool de workers.
// A página nunca espera: envia e recebe por callback. Resultado de versão
// velha (mesma chave reenviada depois) é descartado.

import type { FromWorker, JobKind, JobPayloads, JobResults, SharedWorld, ToWorker } from './protocol.ts';
import { MAP_TAG } from '../config.ts';

interface Pending {
  seq: number;
  kind: JobKind;
  key: string | null;
  priority: number;
  payload: unknown;
  transfer: Transferable[];
  done: (r: unknown) => void;
  cancelled: boolean;
}

/** Heap binário mínimo por (prioridade, seq). */
class Heap {
  items: Pending[] = [];
  private less(a: Pending, b: Pending) { return a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq); }
  push(p: Pending) {
    const a = this.items; a.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (!this.less(a[i], a[j])) break;
      [a[i], a[j]] = [a[j], a[i]]; i = j;
    }
  }
  pop(): Pending | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.items.length; }
}

export interface SubmitOptions {
  /** Chave de deduplicação: um novo envio com a mesma chave invalida o anterior. */
  key?: string;
  /** Menor = antes. */
  priority?: number;
  transfer?: Transferable[];
}

export class JobPool {
  private workers: Worker[] = [];
  private busy: (Pending | null)[] = [];
  private queue = new Heap();
  private latest = new Map<string, number>();
  private queuedByKey = new Map<string, Pending>();
  private seq = 0;
  private idleWaiters: Array<() => void> = [];
  readonly size: number;

  /** Mesma mensagem para todos os workers (chega antes dos trabalhos enviados depois). */
  broadcast(msg: ToWorker): void { for (const w of this.workers) w.postMessage(msg); }

  constructor(shared: SharedWorld, count = workerCount()) {
    this.size = count;
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `jobs-${i} ${MAP_TAG}` });
      w.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(i, e.data);
      w.onerror = (e) => console.error('worker', i, e.message);
      w.postMessage({ type: 'init', shared } satisfies ToWorker);
      this.workers.push(w);
      this.busy.push(null);
    }
  }

  submit<K extends JobKind>(kind: K, payload: JobPayloads[K], done: (r: JobResults[K]) => void, opt: SubmitOptions = {}): void {
    const seq = ++this.seq;
    const key = opt.key ?? null;
    if (key) {
      this.latest.set(key, seq);
      const old = this.queuedByKey.get(key);
      if (old) old.cancelled = true;
    }
    const p: Pending = {
      seq, kind, key, priority: opt.priority ?? 0, payload,
      transfer: opt.transfer ?? [], done: done as (r: unknown) => void, cancelled: false,
    };
    if (key) this.queuedByKey.set(key, p);
    this.queue.push(p);
    this.pump();
  }

  /** Promessa para quando não houver nada na fila nem rodando (tela de carga). */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  isIdle(): boolean { return this.queue.size === 0 && this.busy.every((b) => b === null); }

  get queued(): number { return this.queue.size; }

  private pump(): void {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i]) continue;
      let p: Pending | undefined;
      while ((p = this.queue.pop()) && p.cancelled);
      if (!p) break;
      if (p.key && this.queuedByKey.get(p.key) === p) this.queuedByKey.delete(p.key);
      this.busy[i] = p;
      this.workers[i].postMessage({ type: 'job', id: p.seq, kind: p.kind, payload: p.payload } satisfies ToWorker, p.transfer);
    }
    if (this.isIdle() && this.idleWaiters.length) {
      const w = this.idleWaiters; this.idleWaiters = [];
      for (const fn of w) fn();
    }
  }

  private onMessage(i: number, msg: FromWorker): void {
    const p = this.busy[i];
    this.busy[i] = null;
    if (p && p.seq === msg.id) {
      if (msg.type === 'error') console.error(`tarefa ${p.kind} falhou:`, msg.message);
      else if (!p.key || this.latest.get(p.key) === p.seq) p.done(msg.result);
    }
    this.pump();
  }
}

/** Workers do pool: núcleos − 2, ou ?workers=N (fotos e testes que não devem tomar a máquina). */
function workerCount(): number {
  const asked = Number(new URLSearchParams(globalThis.location?.search ?? '').get('workers'));
  return asked > 0 ? Math.floor(asked) : Math.max(1, (navigator.hardwareConcurrency || 4) - 2);
}
