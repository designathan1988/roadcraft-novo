// Single job system with priority, running on a pool of workers.
// The page never waits: it sends and receives by callback. A stale result
// (same key resubmitted later) is discarded. Every job ends: with its result, or
// with `fail` (the worker's error, superseded by a newer job of the same key, a
// message that could not be sent or read, or a worker that died).

import type { FromWorker, JobKind, JobPayloads, JobResults, SharedWorld, ToWorker } from '../shared/contracts/worker.ts';
import { MAP_TAG } from '../config.ts';

interface Pending {
  seq: number;
  kind: JobKind;
  key: string | null;
  priority: number;
  payload: unknown;
  transfer: Transferable[];
  done: (r: unknown) => void;
  fail: ((message: string) => void) | null;
  cancelled: boolean;
}

/** Binary min-heap by (priority, seq). */
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
  /** Deduplication key: a new submit with the same key invalidates the previous one. */
  key?: string;
  /** Lower = sooner. */
  priority?: number;
  /** Called instead of `done` when the job does not complete: the worker's error, or a newer job of the same key. */
  fail?: (message: string) => void;
  transfer?: Transferable[];
}

/** How many times one worker slot is replaced after its worker died, before the slot is given up. */
const RESTARTS = 3;

export class JobPool {
  /** null: the slot's worker died too often and is not replaced again. */
  private workers: (Worker | null)[] = [];
  private busy: (Pending | null)[] = [];
  private restarts: number[] = [];
  private queue = new Heap();
  private latest = new Map<string, number>();
  private queuedByKey = new Map<string, Pending>();
  private seq = 0;
  private idleWaiters: Array<() => void> = [];
  /** The last broadcast of each type, sent again to a worker that replaces a dead one. */
  private broadcasts = new Map<string, ToWorker>();
  private readonly shared: SharedWorld;
  private readonly make: (i: number) => Worker;
  readonly size: number;

  /** Same message to all workers (arrives before jobs sent later). */
  broadcast(msg: ToWorker): void {
    this.broadcasts.set(msg.type, msg);
    for (const w of this.workers) w?.postMessage(msg);
  }

  /** `make`: how a worker is created (tests pass a stand-in; the game uses the module worker). */
  constructor(shared: SharedWorld, count = workerCount(), make: (i: number) => Worker = moduleWorker) {
    this.size = count;
    this.shared = shared;
    this.make = make;
    for (let i = 0; i < count; i++) {
      this.workers.push(this.spawn(i));
      this.busy.push(null);
      this.restarts.push(0);
    }
  }

  /** A worker for slot `i`, given the shared world and the broadcasts so far. */
  private spawn(i: number): Worker {
    const w = this.make(i);
    // events of a worker that was replaced are ignored
    w.onmessage = (e: MessageEvent<FromWorker>) => { if (this.workers[i] === w) this.onMessage(i, e.data); };
    w.onerror = (e) => { if (this.workers[i] === w) this.onDeath(i, e.message || 'worker error'); };
    w.onmessageerror = () => { if (this.workers[i] === w) this.onUnreadable(i); };
    w.postMessage({ type: 'init', shared: this.shared } satisfies ToWorker);
    for (const m of this.broadcasts.values()) w.postMessage(m);
    return w;
  }

  submit<K extends JobKind>(kind: K, payload: JobPayloads[K], done: (r: JobResults[K]) => void, opt: SubmitOptions = {}): void {
    const seq = ++this.seq;
    const key = opt.key ?? null;
    if (key) {
      this.latest.set(key, seq);
      const old = this.queuedByKey.get(key);
      if (old) { old.cancelled = true; this.tell(old, 'superseded'); }
    }
    const p: Pending = {
      seq, kind, key, priority: opt.priority ?? 0, payload,
      transfer: opt.transfer ?? [], done: done as (r: unknown) => void, fail: opt.fail ?? null, cancelled: false,
    };
    if (key) this.queuedByKey.set(key, p);
    this.queue.push(p);
    this.pump();
  }

  /** A job as a promise: resolves with its result, rejects when it fails or is superseded. */
  run<K extends JobKind>(kind: K, payload: JobPayloads[K], opt: Omit<SubmitOptions, 'fail'> = {}): Promise<JobResults[K]> {
    return new Promise((resolve, reject) => this.submit(kind, payload, resolve, { ...opt, fail: (m) => reject(new Error(m)) }));
  }

  /**
   * Jobs whose key starts with `prefix` are dropped: queued ones fail at once, and the result of one already running is
   * not delivered (it fails as cancelled). For the results of a city that is being replaced (its lots, for one).
   */
  cancel(prefix: string): void {
    for (const p of this.queue.items) if (!p.cancelled && p.key?.startsWith(prefix)) { p.cancelled = true; this.queuedByKey.delete(p.key); this.tell(p, 'cancelled'); }
    for (const p of this.busy) if (p?.key?.startsWith(prefix) && this.latest.get(p.key) === p.seq) this.latest.set(p.key, -p.seq);
  }

  /** Promise for when nothing is queued or running (loading screen). */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  isIdle(): boolean { return this.queue.size === 0 && this.busy.every((b) => b === null); }

  get queued(): number { return this.queue.size; }

  private pump(): void {
    const alive = this.workers.some((w) => w !== null);
    for (let i = 0; i < this.workers.length || !alive; i++) {
      const w = alive ? this.workers[i] : null;
      if (alive && (!w || this.busy[i])) continue;
      let p: Pending | undefined;
      while ((p = this.queue.pop()) && p.cancelled);
      if (!p) break;
      if (p.key && this.queuedByKey.get(p.key) === p) this.queuedByKey.delete(p.key);
      // every worker died: nothing will ever run the job
      if (!w) { this.tell(p, 'no worker left to run the job'); continue; }
      this.busy[i] = p;
      try {
        w.postMessage({ type: 'job', id: p.seq, kind: p.kind, payload: p.payload } satisfies ToWorker, p.transfer);
      } catch (err) {
        // a payload that cannot be cloned (or a buffer already transferred): the job fails, the worker stays free
        this.busy[i] = null;
        console.error(`job ${p.kind} could not be sent:`, err);
        this.tell(p, `the job could not be sent to a worker (${(err as Error)?.message ?? String(err)})`);
        i--;
      }
    }
    if (this.isIdle() && this.idleWaiters.length) {
      const w = this.idleWaiters; this.idleWaiters = [];
      for (const fn of w) fn();
    }
  }

  /**
   * The worker of slot `i` raised an error it did not handle (a worker that failed to start or crashed): its job
   * fails and a new worker takes the slot, up to RESTARTS times; after that the slot is given up.
   */
  private onDeath(i: number, message: string): void {
    console.error('worker', i, 'died:', message);
    const p = this.busy[i];
    this.busy[i] = null;
    this.workers[i]?.terminate();
    this.workers[i] = this.restarts[i]++ < RESTARTS ? this.spawn(i) : null;
    if (p) this.tell(p, `the worker died (${message})`);
    this.pump();
  }

  /** The answer of slot `i` could not be read on the page: its job fails; the worker itself is fine. */
  private onUnreadable(i: number): void {
    const p = this.busy[i];
    this.busy[i] = null;
    if (p) { console.error(`job ${p.kind}: the worker's answer could not be read`); this.tell(p, "the worker's answer could not be read"); }
    this.pump();
  }

  private onMessage(i: number, msg: FromWorker): void {
    const p = this.busy[i];
    this.busy[i] = null;
    if (p && p.seq === msg.id) {
      if (msg.type === 'error') {
        console.error(`job ${p.kind} failed:`, msg.message);
        this.tell(p, msg.message);
      } else if (p.key && this.latest.get(p.key) === -p.seq) {
        this.tell(p, 'cancelled');
      } else if (!p.key || this.latest.get(p.key) === p.seq) {
        // a callback that throws is logged; the pool goes on with the next job
        try { p.done(msg.result); } catch (err) { console.error(`job ${p.kind}: the result's callback threw`, err); }
      } else this.tell(p, 'superseded');
    }
    this.pump();
  }

  /** Tells a job's sender that it did not complete (never throws into the pool). */
  private tell(p: Pending, message: string): void {
    if (!p.fail) return;
    try { p.fail(message); } catch (err) { console.error(`job ${p.kind}: the failure's callback threw`, err); }
  }

}

function moduleWorker(i: number): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `jobs-${i} ${MAP_TAG}` });
}

/** Pool workers: cores − 2, or ?workers=N (photos and tests that must not hog the machine). */
function workerCount(): number {
  const asked = Number(new URLSearchParams(globalThis.location?.search ?? '').get('workers'));
  return asked > 0 ? Math.floor(asked) : Math.max(1, (navigator.hardwareConcurrency || 4) - 2);
}
