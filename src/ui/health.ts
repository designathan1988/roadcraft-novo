// Game health (F9): errors from the page and the workers, and slow frames in the last 30 s, with what the player
// was doing. Keeps only a short list (a ring); nothing runs per frame beyond one comparison.

import { t } from './i18n.ts';

interface Entry { t: number; kind: 'error' | 'slow'; text: string }

const KEEP = 60;
const WINDOW_MS = 30000;

export class HealthPanel {
  private entries: Entry[] = [];
  private root: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  /** What the player was doing (the tool), kept with each entry. */
  context = '';

  constructor(parent: HTMLElement) {
    const r = document.createElement('div');
    r.className = 'health hidden';
    const h = document.createElement('h3'); h.textContent = t('health.title');
    this.status = document.createElement('div'); this.status.className = 'health-status';
    this.list = document.createElement('div'); this.list.className = 'health-list';
    const copy = document.createElement('button'); copy.className = 'v2-btn'; copy.textContent = t('health.copy');
    copy.addEventListener('click', () => {
      const txt = this.entries.map((e) => `${new Date(e.t).toLocaleTimeString()} ${this.kindName(e.kind)}: ${e.text}`).join('\n') || t('health.empty');
      navigator.clipboard?.writeText(txt).then(() => { copy.textContent = t('health.copied'); }, () => { copy.textContent = t('health.copyFailed'); });
      setTimeout(() => { copy.textContent = t('health.copy'); }, 1500);
    });
    const close = document.createElement('button'); close.className = 'v2-btn'; close.textContent = t('v2.close');
    close.addEventListener('click', () => this.toggle());
    const row = document.createElement('div'); row.className = 'row'; row.append(copy, close);
    r.append(h, this.status, this.list, row);
    r.addEventListener('pointerdown', (e) => e.stopPropagation());
    r.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    parent.append(r);
    this.root = r;
    window.addEventListener('error', (e) => this.add('error', e.message || t('health.msg.noMessage')));
    window.addEventListener('unhandledrejection', (e) => this.add('error', t('health.msg.rejected', { reason: String((e.reason as Error)?.message ?? e.reason) })));
  }

  private kindName(k: Entry['kind']): string { return t(k === 'error' ? 'ui.health.error' : 'ui.health.slow'); }

  /** Records an entry (a worker error, for example). */
  add(kind: Entry['kind'] | 'erro' | 'lento', text: string): void {
    const k: Entry['kind'] = kind === 'erro' || kind === 'error' ? 'error' : 'slow';
    this.entries.push({ t: Date.now(), kind: k, text: this.context ? `${text} (${t('health.context')}: ${this.context})` : text });
    if (this.entries.length > KEEP) this.entries.shift();
    if (this.open) this.render();
  }

  /** A frame's duration: above 100 ms it is recorded. */
  frame(ms: number): void { if (ms > 100) this.add('slow', t('ui.health.frame', { ms: Math.round(ms) })); }

  get open(): boolean { return !this.root.classList.contains('hidden'); }

  toggle(): void { this.root.classList.toggle('hidden'); if (this.open) this.render(); }

  close(): boolean { if (!this.open) return false; this.root.classList.add('hidden'); return true; }

  private render(): void {
    const now = Date.now();
    const recent = this.entries.filter((e) => now - e.t < WINDOW_MS);
    const broken = recent.some((e) => e.kind === 'error'), slow = recent.some((e) => e.kind === 'slow');
    this.status.textContent = t(broken ? 'health.status.broken' : slow ? 'health.status.slow' : 'health.status.ok');
    this.status.className = `health-status ${broken ? 'bad' : slow ? 'warn' : 'ok'}`;
    this.list.replaceChildren();
    if (!this.entries.length) { this.list.textContent = t('health.empty'); return; }
    for (const e of [...this.entries].reverse().slice(0, 20)) {
      const d = document.createElement('div');
      d.textContent = `${new Date(e.t).toLocaleTimeString()} · ${this.kindName(e.kind)} · ${e.text}`;
      this.list.append(d);
    }
  }
}
