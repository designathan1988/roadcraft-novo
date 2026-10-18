// Edição é comando: apply e invert. Desfazer aplica o inverso.
// Nada de clonar ou serializar o mundo.

export interface Command {
  readonly label: string;
  apply(): void;
  invert(): void;
  /** Tenta absorver um comando seguinte (ex.: pinceladas do mesmo traço). */
  merge?(next: Command): boolean;
}

export class CommandStack {
  private done: Command[] = [];
  private undone: Command[] = [];
  /** Comando aberto que ainda aceita junções (traço de pincel em curso). */
  private open: Command | null = null;
  readonly limit: number;
  onChange: () => void = () => {};
  /** Um comando novo entrou (não chamado ao juntar, desfazer ou refazer). */
  onPush: (cmd: Command) => void = () => {};

  constructor(limit = 500) { this.limit = limit; }

  /** Aplica e registra. */
  run(cmd: Command): void {
    cmd.apply();
    this.push(cmd);
  }

  /** Registra um comando que já foi aplicado (ex.: edição incremental). */
  push(cmd: Command): void {
    this.undone.length = 0;
    if (this.open && this.open.merge?.(cmd)) { this.onChange(); return; }
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.onPush(cmd);
    this.onChange();
  }

  /** Começa um grupo que junta comandos até endGroup. */
  beginGroup(cmd: Command): void {
    this.push(cmd);
    this.open = cmd;
  }

  endGroup(): void { this.open = null; }

  undo(): boolean {
    this.open = null;
    const c = this.done.pop();
    if (!c) return false;
    c.invert();
    this.undone.push(c);
    this.onChange();
    return true;
  }

  redo(): boolean {
    this.open = null;
    const c = this.undone.pop();
    if (!c) return false;
    c.apply();
    this.done.push(c);
    this.onChange();
    return true;
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }

  clear(): void { this.done.length = 0; this.undone.length = 0; this.open = null; this.onChange(); }
}
