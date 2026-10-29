// Game health, a developer's panel (F9; F8 opens it on the world's changes): errors from the page and the workers
// and slow frames in the last 30 s, with what the player was doing; the world's recent changes; the game's state now.
// It is not in the player's top bar. Keeps only short lists (rings); while open it refreshes once a second, and
// nothing runs per frame beyond one comparison.

import { el } from './dom.ts';
import { onLanguageChange, t } from '../shared/i18n/index.ts';

interface Entry { t: number; kind: 'error' | 'slow'; text: string }
export type HealthTab = 'health' | 'world' | 'state';

/** What the World and State tabs show, as [name, value] rows (the game gives them). */
export interface HealthSources {
  /** The latest changes to the world, newest first: [when and what, detail]. */
  world(): Array<[string, string]>;
  /** The game's state now. */
  state(): Array<[string, string]>;
}

const KEEP = 60;
const WINDOW_MS = 30000;

export class HealthPanel {
  readonly root: HTMLElement;
  private entries: Entry[] = [];
  private tabs = new Map<HealthTab, HTMLButtonElement>();
  private body: HTMLElement;
  private status: HTMLElement;
  private tab: HealthTab = 'health';
  private timer = 0;
  private sources: HealthSources;
  /** What the player was doing (the tool), kept with each entry. */
  context = '';

  constructor(parent: HTMLElement, sources: HealthSources) {
    this.sources = sources;
    const r = el('div', 'health hidden');
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-label', t('health.title'));
    const head = el('div', 'health-tabs');
    head.setAttribute('role', 'tablist');
    for (const id of ['health', 'world', 'state'] as const) {
      const b = el('button', 'v2-tab', t(`health.tab.${id}`));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      b.addEventListener('click', () => this.show(id));
      this.tabs.set(id, b);
      head.append(b);
    }
    this.status = el('div', 'health-status');
    this.body = el('div', 'health-list');
    const copy = el('button', 'v2-btn', t('health.copy'));
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const lines = [
        ...this.entries.map((e) => `${new Date(e.t).toLocaleTimeString()} ${this.kindName(e.kind)}: ${e.text}`),
        '', ...this.sources.world().map(([a, b]) => `${a} ${b}`), '', ...this.sources.state().map(([a, b]) => `${a}: ${b}`),
      ];
      navigator.clipboard?.writeText(lines.join('\n')).then(() => { copy.textContent = t('health.copied'); }, () => { copy.textContent = t('health.copyFailed'); });
      setTimeout(() => { copy.textContent = t('health.copy'); }, 1500);
    });
    const close = el('button', 'v2-btn', t('v2.close'));
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    const row = el('div', 'row');
    row.append(copy, close);
    r.append(el('h3', '', t('health.title')), head, this.status, this.body, row);
    r.addEventListener('pointerdown', (e) => e.stopPropagation());
    r.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    parent.append(r);
    this.root = r;
    // another language: the names written again (developer's panel; what was recorded stays as it was written)
    const title = r.querySelector('h3')!;
    onLanguageChange(() => {
      r.setAttribute('aria-label', t('health.title')); title.textContent = t('health.title');
      for (const [id, b] of this.tabs) b.textContent = t(`health.tab.${id}`);
      copy.textContent = t('health.copy'); close.textContent = t('v2.close');
      if (this.open) this.render();
    });
    window.addEventListener('error', (e) => this.add('error', e.message || t('health.msg.noMessage')));
    window.addEventListener('unhandledrejection', (e) => this.add('error', t('health.msg.rejected', { reason: String((e.reason as Error)?.message ?? e.reason) })));
  }

  private kindName(k: Entry['kind']): string { return t(k === 'error' ? 'ui.health.error' : 'ui.health.slow'); }

  /** Records an entry (a worker error, for example). */
  add(kind: Entry['kind'] | 'erro' | 'lento', text: string): void {
    const k: Entry['kind'] = kind === 'erro' || kind === 'error' ? 'error' : 'slow';
    this.entries.push({ t: Date.now(), kind: k, text: this.context ? `${text} (${t('health.context')}: ${this.context})` : text });
    if (this.entries.length > KEEP) this.entries.shift();
    if (this.open && this.tab === 'health') this.render();
  }

  /** A frame's duration: above 100 ms it is recorded. */
  frame(ms: number): void { if (ms > 100) this.add('slow', t('ui.health.frame', { ms: Math.round(ms) })); }

  get open(): boolean { return !this.root.classList.contains('hidden'); }
  get shownTab(): HealthTab { return this.tab; }

  toggle(): void { if (this.open) this.close(); else this.show(this.tab); }

  /** Opens on a tab (or switches to it); refreshed once a second while open. */
  show(tab: HealthTab): void {
    this.tab = tab;
    for (const [id, b] of this.tabs) { b.classList.toggle('on', id === tab); b.setAttribute('aria-selected', String(id === tab)); }
    this.root.classList.remove('hidden');
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.render(), 1000);
    this.render();
  }

  close(): boolean {
    if (!this.open) return false;
    this.root.classList.add('hidden');
    clearInterval(this.timer);
    return true;
  }

  /** The last 30 s: broken (an error), slow (a slow frame) or ok — the dot on the panel's button. */
  level(): 'ok' | 'slow' | 'broken' {
    const now = Date.now();
    let slow = false;
    for (let i = this.entries.length - 1; i >= 0 && now - this.entries[i].t < WINDOW_MS; i--) { if (this.entries[i].kind === 'error') return 'broken'; slow = true; }
    return slow ? 'slow' : 'ok';
  }

  private render(): void {
    if (!this.open) return;
    const now = Date.now();
    const recent = this.entries.filter((e) => now - e.t < WINDOW_MS);
    const broken = recent.some((e) => e.kind === 'error'), slow = recent.some((e) => e.kind === 'slow');
    this.status.textContent = t(broken ? 'health.status.broken' : slow ? 'health.status.slow' : 'health.status.ok');
    this.status.className = `health-status ${broken ? 'bad' : slow ? 'warn' : 'ok'}`;
    const rows: string[] = this.tab === 'health'
      ? [...this.entries].reverse().slice(0, 20).map((e) => `${new Date(e.t).toLocaleTimeString()} · ${this.kindName(e.kind)} · ${e.text}`)
      : (this.tab === 'world' ? this.sources.world() : this.sources.state()).map(([a, b]) => (b ? `${a} · ${b}` : a));
    if (!rows.length) { this.body.textContent = t('health.empty'); return; }
    // the same rows: nothing written
    if (this.body.childElementCount === rows.length && rows.every((r, i) => this.body.children[i].textContent === r)) return;
    this.body.replaceChildren(...rows.map((r) => el('div', '', r)));
  }
}
