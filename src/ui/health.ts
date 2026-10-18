// Saúde do jogo (F9): erros da página e dos workers e quadros lentos dos últimos 30 s, com o
// que estava acontecendo. Guarda só uma lista curta (anel); nada roda por quadro além de uma soma.

interface Entry { t: number; kind: 'erro' | 'lento'; text: string }

const KEEP = 60;
const WINDOW_MS = 30000;

export class HealthPanel {
  private entries: Entry[] = [];
  private root: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  /** O que o jogador estava fazendo (ferramenta), para cada registro. */
  context = '';

  constructor(parent: HTMLElement) {
    const r = document.createElement('div');
    r.className = 'health hidden';
    const h = document.createElement('h3'); h.textContent = 'Saúde do jogo';
    this.status = document.createElement('div'); this.status.className = 'health-status';
    this.list = document.createElement('div'); this.list.className = 'health-list';
    const copy = document.createElement('button'); copy.textContent = 'Copiar registro';
    copy.addEventListener('click', () => {
      const txt = this.entries.map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.kind}: ${e.text}`).join('\n') || 'Nada registrado';
      navigator.clipboard?.writeText(txt).then(() => { copy.textContent = 'Copiado'; }, () => { copy.textContent = 'Não foi possível copiar'; });
      setTimeout(() => { copy.textContent = 'Copiar registro'; }, 1500);
    });
    const close = document.createElement('button'); close.textContent = 'Fechar';
    close.addEventListener('click', () => this.toggle());
    const row = document.createElement('div'); row.className = 'row'; row.append(copy, close);
    r.append(h, this.status, this.list, row);
    r.addEventListener('pointerdown', (e) => e.stopPropagation());
    parent.append(r);
    this.root = r;
    window.addEventListener('error', (e) => this.add('erro', e.message || 'Erro sem mensagem'));
    window.addEventListener('unhandledrejection', (e) => this.add('erro', `Promessa rejeitada: ${String((e.reason as Error)?.message ?? e.reason)}`));
  }

  /** Registra (erro de worker, por exemplo). */
  add(kind: Entry['kind'], text: string): void {
    this.entries.push({ t: Date.now(), kind, text: this.context ? `${text} (fazendo: ${this.context})` : text });
    if (this.entries.length > KEEP) this.entries.shift();
    if (this.open) this.render();
  }

  /** Duração do quadro: acima de 100 ms vira registro. */
  frame(ms: number): void { if (ms > 100) this.add('lento', `quadro de ${Math.round(ms)} ms`); }

  get open(): boolean { return !this.root.classList.contains('hidden'); }

  toggle(): void { this.root.classList.toggle('hidden'); if (this.open) this.render(); }

  private render(): void {
    const now = Date.now();
    const recent = this.entries.filter((e) => now - e.t < WINDOW_MS);
    const broken = recent.some((e) => e.kind === 'erro'), slow = recent.some((e) => e.kind === 'lento');
    this.status.textContent = broken ? 'Algo quebrou nos últimos 30 s' : slow ? 'Houve quadro lento nos últimos 30 s' : 'Nada quebrou nem travou nos últimos 30 s';
    this.status.className = `health-status ${broken ? 'bad' : slow ? 'warn' : 'ok'}`;
    this.list.innerHTML = '';
    if (!this.entries.length) { this.list.textContent = 'Nada registrado'; return; }
    for (const e of [...this.entries].reverse().slice(0, 20)) {
      const d = document.createElement('div');
      d.textContent = `${new Date(e.t).toLocaleTimeString()} · ${e.kind} · ${e.text}`;
      this.list.append(d);
    }
  }
}
