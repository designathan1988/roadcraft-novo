// Inspecionar: clique num cruzamento para escolher o controle (semáforo, placas,
// pare, preferência), as regras de cada via, os tempos do semáforo, a onda
// verde, a prioridade ao ônibus e os movimentos permitidos; clique numa via
// para ver o perfil, copiar ou demolir. Cada mudança é um comando (desfaz).

import type { CommandStack } from '../core/commands.ts';
import { RoadJournal, addCrossing, addUTurn, changeProfiles, roadBetweenJunctions, demolishSeg, duplicateRoad, joinAt, reverseRoad, splitAt, streetChain } from '../roads/build.ts';
import { CTL_NAMES, Ctl, Rule, RULE_NAMES, dirOut, effectiveControl, signalStages, type JunctionSpec } from '../roads/control.ts';
import { PROFILE_INFO, withParking } from '../roads/profiles.ts';
import { armAngle } from '../roads/geometry.ts';
import { laneExits } from '../roads/laneLinks.ts';
import type { World } from '../world/world.ts';

export interface InspectActions {
  /** Pede à simulação os números ao vivo do trecho (a resposta volta em showProbe). */
  probe(seg: number): void;
  /** Pede o contador de passagens do nó (resposta em showNodeProbe). */
  probeNode(node: number): void;
  /** Desenhar com o perfil da via. */
  useProfile(id: number): void;
  toast(t: string): void;
  /** Marca o que está sendo inspecionado (nó ou trecho; -1 = nada). */
  mark(node: number, seg: number): void;
}

const CHOICES = [Ctl.Auto, Ctl.Signal, Ctl.Priority, Ctl.AllStop, Ctl.YieldAll, Ctl.Mini, Ctl.None];

/** Nome curto de um braço pela direção (bússola: −z é norte). */
function legName(world: World, n: number, s: number): string {
  const [dx, dz] = dirOut(world.roads, n, s);
  const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  const names = ['Norte', 'Nordeste', 'Leste', 'Sudeste', 'Sul', 'Sudoeste', 'Oeste', 'Noroeste'];
  const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const k = Math.round(a / 45) % 8;
  return `${arrows[k]} ${names[k]} · ${PROFILE_INFO[world.roads.segs.cols.profile[s]].name}`;
}

export class Inspector {
  readonly el: HTMLElement;
  node = -1;
  seg = -1;
  private world: World;
  private commands: CommandStack;
  private a: InspectActions;

  constructor(world: World, commands: CommandStack, a: InspectActions) {
    this.world = world; this.commands = commands; this.a = a;
    this.el = document.createElement('div');
    this.el.className = 'inspector hidden';
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation());
    document.getElementById('hud')!.append(this.el);
  }

  /** Escolhe o que está sob o cursor: cruzamento perto, senão a via. */
  pick(x: number, z: number): void {
    const net = this.world.roads;
    const n = net.nearestNode(x, z, 16);
    const nc = net.nodes.cols;
    // cruzamento; ou nó de duas vias bem perto do clique (unir, altura)
    if (n >= 0 && (nc.deg[n] >= 3 || (nc.deg[n] === 2 && Math.hypot(nc.x[n] - x, nc.z[n] - z) < 6))) { this.node = n; this.seg = -1; }
    else {
      const s = net.nearestSeg(x, z, 14);
      this.node = -1; this.seg = s ? s[0] : -1;
    }
    this.render();
  }

  close(): void { this.node = -1; this.seg = -1; this.el.classList.add('hidden'); this.a.mark(-1, -1); clearInterval(this.probeTimer); this.probeEl = null; this.flowEl = null; }

  /** Algo mudou (desfazer, edição): refaz o painel se o alvo ainda existe. */
  refresh(): void {
    const net = this.world.roads;
    if (this.node >= 0 && (!net.nodes.alive[this.node] || net.nodes.cols.deg[this.node] < 2)) this.node = -1;
    if (this.seg >= 0 && !net.segs.alive[this.seg]) this.seg = -1;
    if (this.node < 0 && this.seg < 0) { this.close(); return; }
    this.render();
  }

  private flowEl: HTMLElement | null = null;
  private flowFirst: { passed: number; time: number } | null = null;

  /** Fluxo do cruzamento: diferença do contador entre duas leituras (veículos por hora). */
  showNodeProbe(p: { node: number; passed: number; time: number }): void {
    if (p.node !== this.node || !this.flowEl) return;
    const f = this.flowFirst;
    if (!f || p.passed < f.passed) { this.flowFirst = { passed: p.passed, time: p.time }; this.flowEl.textContent = 'Medindo o fluxo…'; return; }
    const dt = p.time - f.time;
    if (dt < 5) return;
    this.flowEl.textContent = `Fluxo: ${Math.round((p.passed - f.passed) / dt * 3600)} veíc./h (medido nos últimos ${Math.round(dt)} s)`;
  }

  private probeEl: HTMLElement | null = null;
  private probeTimer = 0;

  /** Números ao vivo do trecho inspecionado (vindos da simulação). */
  showProbe(p: { seg: number; vehicles: number; speed: number; queue: number; capacity: number }): void {
    if (p.seg !== this.seg || !this.probeEl) return;
    this.probeEl.textContent = `${p.vehicles} veículos agora · ${Math.round(p.speed * 3.6)} km/h · fila de ${p.queue} · cabem ${p.capacity}`;
  }

  private apply(spec: JunctionSpec | null, label = 'controle do cruzamento'): void {
    const j = new RoadJournal(this.world, label);
    j.setJunction(this.node, spec);
    this.commands.push(j);
    this.render();
  }

  private spec(): JunctionSpec { return { ...(this.world.roads.junctions.get(this.node) ?? { ctl: Ctl.Auto }) }; }

  private render(): void {
    const el = this.el;
    el.innerHTML = '';
    if (this.node < 0 && this.seg < 0) { this.close(); return; }
    el.classList.remove('hidden');
    this.a.mark(this.node, this.seg);
    const head = document.createElement('div');
    head.className = 'insp-head';
    const title = document.createElement('h3');
    head.append(title, btn('×', () => this.close(), '', 'Fechar (Esc)'));
    el.append(head);
    if (this.seg >= 0) { title.textContent = 'Via'; this.renderSeg(); return; }
    const net = this.world.roads, n = this.node;
    // mesma ordem anti-horária dos braços da simulação (as fases contam nela)
    const segs = net.segsOf(n, []).sort((a, b) => armAngle(...dirOut(net, n, a)) - armAngle(...dirOut(net, n, b)));
    if (segs.length === 2) {
      // nó no meio da via: altura e unir as duas
      title.textContent = 'Ponto da via';
      el.append(row(label(`Altura: ${net.nodes.cols.y[n].toFixed(1).replace('.', ',')} m`),
        btn('Descer 0,5 m', () => this.raise(-0.5)), btn('Subir 0,5 m', () => this.raise(0.5))));
      const sp0 = net.junctions.get(n);
      if (sp0 && sp0.ctl === Ctl.UTurn) {
        el.append(note('Retorno no canteiro.'));
        el.append(row(btn('Fechar o retorno', () => this.apply(null, 'fechar retorno'))));
      }
      if (sp0 && (sp0.ctl === Ctl.Zebra || sp0.ctl === Ctl.PedSignal)) {
        el.append(note(sp0.ctl === Ctl.Zebra ? 'Faixa de pedestres: zebra (pedestre tem preferência).' : 'Faixa de pedestres: com semáforo.'));
        el.append(row(btn('Remover faixa', () => this.apply(null, 'remover faixa'))));
      }
      el.append(row(btn('Unir as duas vias', () => {
        const j = joinAt(this.world, n);
        if (j.empty) { this.a.toast('Essas vias não se unem: perfis diferentes, sentidos opostos ou longas demais juntas.'); return; }
        this.commands.push(j); this.a.toast('Vias unidas.'); this.close();
      }, '', 'Junta as duas vias deste ponto numa só')));
      return;
    }
    title.textContent = `Cruzamento · ${segs.length} vias`;
    const spec = net.junctions.get(n);
    const eff = effectiveControl(net, n, net.junctions.get(n), net.flow.get(n));
    if (eff.ctl === Ctl.Ring) { el.append(note('Faz parte de uma rotatória: quem está no anel tem a preferência.')); return; }

    // altura do nó
    el.append(row(label(`Altura: ${net.nodes.cols.y[n].toFixed(1).replace('.', ',')} m`),
      btn('Descer 0,5 m', () => this.raise(-0.5)), btn('Subir 0,5 m', () => this.raise(0.5))));
    // controle
    el.append(section('Controle do cruzamento'));
    const sel = select(CHOICES.map((c) => [c, CTL_NAMES[c]]), spec?.ctl ?? Ctl.Auto, (v) => {
      if (v === Ctl.Auto) this.apply(null);
      else this.apply({ ...this.spec(), ctl: v });
    });
    el.append(sel);
    if (!spec || spec.ctl === Ctl.Auto) {
      el.append(note(`Escolhido pela importância das vias: ${CTL_NAMES[eff.ctl].toLowerCase()}.`));
      el.append(row(btn('Travar esta escolha', () => this.apply({ ...this.spec(), ctl: eff.ctl }, 'travar controle'), '', 'Fixa o controle atual: ele não muda mais se as vias em volta mudarem')));
    } else el.append(row(btn('Voltar ao automático', () => this.apply(null))));
    // fluxo medido na simulação (veículos por hora que passaram pelo nó)
    this.flowEl = note('Medindo o fluxo…');
    this.flowFirst = null;
    el.append(this.flowEl);
    clearInterval(this.probeTimer);
    this.a.probeNode(n);
    this.probeTimer = window.setInterval(() => { if (this.node === n) this.a.probeNode(n); else clearInterval(this.probeTimer); }, 2000);

    // regra de cada via (placas)
    if (eff.ctl === Ctl.Priority || eff.ctl === Ctl.AllStop) {
      el.append(section('Regra de cada via'));
      for (const s of segs) {
        const r = eff.legs.get(s) ?? Rule.Free;
        el.append(row(label(legName(this.world, n, s)), select([[Rule.Main, RULE_NAMES[Rule.Main]], [Rule.Yield, RULE_NAMES[Rule.Yield]], [Rule.Stop, RULE_NAMES[Rule.Stop]]], r, (v) => {
          const sp = this.spec();
          if (sp.ctl === Ctl.Auto) sp.ctl = eff.ctl;
          sp.legs = [...(sp.legs ?? []).filter(([x]) => x !== s), [s, v]];
          this.apply(sp, 'regra da via');
        })));
      }
    }

    // semáforo
    if (eff.ctl === Ctl.Signal) {
      const stages: number[] = [];
      const order = segs.map((s) => dirOut(net, n, s));
      const count = signalStages(order, stages);
      el.append(section('Semáforo'));
      el.append(row(label('Tempos'), select([[0, 'Adaptativo (pela fila)'], [1, 'Tempo fixo']], spec?.fixed ? 1 : 0, (v) => {
        const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal;
        sp.fixed = v === 1; this.apply(sp, 'tempos do semáforo');
      })));
      for (let k = 0; k < count; k++) {
        const legs = segs.filter((_, i) => stages[i] === k).map((s) => legName(this.world, n, s).split(' · ')[0]).join(' e ');
        const g = spec?.greens?.[k] ?? 20;
        const setG = (d: number) => {
          const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal;
          sp.fixed = true;
          const greens = Array.from({ length: count }, (_, i) => sp.greens?.[i] ?? 20);
          greens[k] = Math.max(6, Math.min(90, greens[k] + d));
          sp.greens = greens; this.apply(sp, 'verde do semáforo');
        };
        el.append(row(label(`Fase ${k + 1} (${legs})`), btn('−', () => setG(-5), '', 'Verde mais curto'), value(`${g} s`), btn('+', () => setG(5), '', 'Verde mais longo')));
      }
      const off = spec?.offset ?? 0;
      el.append(row(label('Defasagem'), btn('−', () => { const sp = this.spec(); sp.ctl = Ctl.Signal; sp.fixed = true; sp.offset = off - 2; this.apply(sp, 'defasagem'); }, '', 'Mais cedo'),
        value(`${off} s`), btn('+', () => { const sp = this.spec(); sp.ctl = Ctl.Signal; sp.fixed = true; sp.offset = off + 2; this.apply(sp, 'defasagem'); }, '', 'Mais tarde')));
      el.append(row(btn('Onda verde na via principal', () => this.greenWave())));
      const bus = document.createElement('label');
      bus.className = 'check';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!spec?.bus;
      cb.addEventListener('change', () => { const sp = this.spec(); if (sp.ctl === Ctl.Auto) sp.ctl = Ctl.Signal; sp.bus = cb.checked; this.apply(sp, 'prioridade ao ônibus'); });
      bus.append(cb, document.createTextNode(' Prioridade ao ônibus'));
      el.append(bus);
    }

    // conexões de faixa: cada faixa que chega e as saídas que ela pode tomar
    el.append(section('Conexões de faixa'));
    el.append(note(spec?.lanes?.length ? 'Ajustadas à mão. A seta pintada em cada faixa mostra as saídas dela.' : 'Automáticas (pelas setas de cada faixa). Clique numa saída para ligar ou desligar.'));
    for (const from of segs) {
      const ex = laneExits(net, n, from, spec);
      if (!ex.length) continue;
      ex.forEach((lane, a) => {
        const r = row(label(`${legName(this.world, n, from).split(' · ')[0]}, faixa ${a + 1}${ex.length > 1 ? (a === 0 ? ' (direita)' : a === ex.length - 1 ? ' (esquerda)' : '') : ''}:`));
        // todas as saídas possíveis do nó (as automáticas e as outras)
        for (const to of segs) {
          if (to === from) continue;
          const on = lane.exits.some(([s2]) => s2 === to);
          const b = btn(`${on ? '✓' : '·'} ${legName(this.world, n, to).split(' · ')[0]}`, () => {
            const sp = this.spec();
            const now = lane.exits.map(([s2]) => s2);
            const next = on ? now.filter((s2) => s2 !== to) : [...now, to];
            if (!next.length) { this.a.toast('Essa é a última saída da faixa: ela não pode ficar sem caminho.'); return; }
            sp.lanes = [...(sp.lanes ?? []).filter(([s2, i2]) => !(s2 === from && i2 === a)), [from, a, next]];
            this.apply(sp, 'conexão de faixa');
          }, on ? '' : 'banned', on ? 'Ligada: clique para desligar' : 'Desligada: clique para ligar');
          r.append(b);
        }
        el.append(r);
      });
    }
    if (spec?.lanes?.length) el.append(row(btn('Restaurar automáticas', () => { const sp = this.spec(); delete sp.lanes; this.apply(sp, 'conexões automáticas'); })));

    // movimentos
    el.append(section('Movimentos permitidos'));
    el.append(note('Clique para proibir ou permitir.'));
    for (const from of segs) {
      const r = row(label(`De ${legName(this.world, n, from).split(' · ')[0]}:`));
      for (const to of segs) {
        if (to === from) continue;
        const ban = (spec?.bans ?? []).some((_, i, b) => i % 2 === 0 && b[i] === from && b[i + 1] === to);
        const b = btn(`${ban ? '✕' : '✓'} ${legName(this.world, n, to).split(' · ')[0]}`, () => {
          const sp = this.spec();
          const bans = (sp.bans ?? []).slice();
          let found = -1;
          for (let i = 0; i + 1 < bans.length; i += 2) if (bans[i] === from && bans[i + 1] === to) found = i;
          if (found >= 0) bans.splice(found, 2); else bans.push(from, to);
          sp.bans = bans;
          this.apply(sp, 'movimento proibido');
        }, ban ? 'banned' : '', ban ? 'Proibido: clique para permitir' : 'Permitido: clique para proibir');
        r.append(b);
      }
      el.append(r);
    }
  }

  /** Registra uma edição de via (cobra; sem dinheiro desfaz e avisa). */
  private edit(j: RoadJournal, ok: string): void {
    if (j.empty) return;
    const price = j.price;
    if (!j.settle()) { this.a.toast(`Dinheiro insuficiente: custa R$ ${price.toLocaleString('pt-BR')}.`); return; }
    this.commands.push(j);
    this.a.toast(ok);
    this.refresh();
  }

  /** Faixa de pedestres no meio do trecho (um passo de desfazer). */
  private crossing(s: number, ctl: number): void {
    const r = addCrossing(this.world, s, 0.5, ctl);
    if (typeof r === 'string') { this.a.toast(r); return; }
    this.commands.push(r);
    this.a.toast(ctl === Ctl.Zebra ? 'Faixa zebra: pedestre tem preferência.' : 'Faixa com semáforo.');
    this.close();
  }

  private raise(dy: number): void {
    const j = new RoadJournal(this.world, 'altura do nó');
    j.moveNodeY(this.node, this.world.roads.nodes.cols.y[this.node] + dy);
    if (j.settle()) this.commands.push(j);
    this.render();
  }

  /** Onda verde: semáforos seguidos da via principal em tempo fixo, defasados pelo tempo de viagem. */
  private greenWave(): void {
    const net = this.world.roads, n = this.node, sc = net.segs.cols, nc = net.nodes.cols;
    const segs = net.segsOf(n, []);
    // via principal: a de maior preferência
    let main = segs[0];
    for (const s of segs) if ((PROFILE_INFO[sc.profile[s]].priority ?? 0) > (PROFILE_INFO[sc.profile[main]].priority ?? 0)) main = s;
    const chain = streetChain(this.world, main);
    // nós da cadeia em ordem ao longo da via
    const nodes = new Set<number>();
    for (const s of chain) { nodes.add(sc.a[s]); nodes.add(sc.b[s]); }
    const base = this.spec();
    const greens = base.greens ?? [20, 20, 20, 20];
    const speed = PROFILE_INFO[sc.profile[main]].speed / 3.6;
    const j = new RoadJournal(this.world, 'onda verde');
    let count = 0;
    for (const m of nodes) {
      if (nc.deg[m] < 3 || effectiveControl(net, m, net.junctions.get(m), net.flow.get(m)).ctl !== Ctl.Signal) continue;
      const d = Math.hypot(nc.x[m] - nc.x[n], nc.z[m] - nc.z[n]);
      const old = net.junctions.get(m);
      j.setJunction(m, { ...(old ?? {}), ctl: Ctl.Signal, fixed: true, greens, offset: -Math.round(d / speed) });
      count++;
    }
    if (count < 2) { this.a.toast('A via principal não tem outro semáforo para coordenar.'); return; }
    this.commands.push(j);
    this.a.toast(`Onda verde em ${count} semáforos.`);
    this.render();
  }

  private renderSeg(): void {
    const el = this.el, s = this.seg, net = this.world.roads, sc = net.segs.cols;
    const info = PROFILE_INFO[sc.profile[s]];
    const width = info.left + info.right;
    this.probeEl = note('Medindo o trânsito…');
    clearInterval(this.probeTimer);
    this.a.probe(s);
    this.probeTimer = window.setInterval(() => { if (this.seg === s) this.a.probe(s); else clearInterval(this.probeTimer); }, 1000);
    el.append(
      row(label('Trânsito')), this.probeEl,
      ...(this.world.streetNames.has(s) ? [row(label('Rua'), value(this.world.streetNames.get(s)!))] : []),
      row(label('Perfil'), value(info.name)),
      row(label('Largura'), value(`${width.toFixed(1).replace('.', ',')} m`)),
      row(label('Faixas'), value(`${info.lanesFwd + info.lanesBack} (${info.oneWay ? 'mão única' : 'mão dupla'})`)),
      row(label('Velocidade'), value(`${info.speed} km/h`)),
      row(label('Comprimento'), value(`${Math.round(sc.len[s])} m`)),
      row(label('Preço'), value(`R$ ${info.cost.toLocaleString('pt-BR')}/m`)),
      row(...(info.oneWay ? [btn('Inverter mão única', () => this.edit(reverseRoad(this.world, s), 'Sentido invertido.'), '', 'Os carros passam a andar no outro sentido nesta via (até os cruzamentos)')] : []),
        btn('Dividir no meio', () => this.edit(splitAt(this.world, s, 0.5), 'Via dividida em duas.'), '', 'Põe um ponto no meio do trecho'),
        ...(info.edges.some((e) => e.strip.kind === 'median') && !info.oneWay ? [btn('Retorno no canteiro', () => {
          const r = addUTurn(this.world, s, 0.5);
          if (typeof r === 'string') { this.a.toast(r); return; }
          this.commands.push(r); this.a.toast('Retorno aberto no canteiro.'); this.close();
        }, '', 'Abre o canteiro no meio do trecho: quem passou do destino faz o retorno ali')] : []),
        btn('Faixa zebra', () => this.crossing(s, Ctl.Zebra), '', 'Faixa de pedestres no meio do trecho: os carros dão a vez a quem atravessa'),
        btn('Faixa com semáforo', () => this.crossing(s, Ctl.PedSignal), '', 'Faixa de pedestres com semáforo no meio do trecho'),
        btn('Duplicar ao lado', () => {
          const r = duplicateRoad(this.world, s);
          if (typeof r === 'string') { this.a.toast(`Não dá para duplicar aqui: ${r}.`); return; }
          this.edit(r, 'Via duplicada ao lado.');
        }, '', 'Uma via igual, paralela, à direita desta (até os cruzamentos)')),
      ...(info.ring ? [] : [row(label('Vagas'),
        ...([[true, 'à direita'], [false, 'à esquerda']] as Array<[boolean, string]>).map(([right, name]) => {
          const order = right ? info.strips : info.strips.slice().reverse();
          let k = 0;
          while (k < order.length && (order[k].kind === 'sidewalk' || order[k].kind === 'curb')) k++;
          const has = order[k]?.kind === 'parking';
          return btn(`${has ? '✓' : '·'} ${name}`, () => {
            const to = withParking(sc.profile[s], right, !has);
            if (to < 0) { this.a.toast('Perfis demais neste mapa (máximo 256).'); return; }
            this.edit(changeProfiles(this.world, roadBetweenJunctions(this.world, s), to), has ? 'Vagas retiradas.' : 'Vagas paralelas à guia.');
          }, has ? '' : 'banned', has ? 'Tirar as vagas deste lado (até os cruzamentos)' : 'Pôr vagas paralelas à guia deste lado (até os cruzamentos)');
        }))]),
      row(btn('Desenhar com este perfil', () => this.a.useProfile(sc.profile[s]), 'main', 'Conta-gotas: desenhar outras vias iguais'),
        btn('Demolir', () => {
          const j = demolishSeg(this.world, s);
          if (j.settle()) { this.commands.push(j); if (j.charge) this.a.toast(`Devolvido R$ ${(-j.charge).toLocaleString('pt-BR')}`); }
          this.close();
        })),
    );
  }
}

function btn(text: string, fn: () => void, cls = '', title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); b.blur(); });
  return b;
}
function label(t: string): HTMLElement { const e = document.createElement('span'); e.className = 'label'; e.textContent = t; return e; }
function value(t: string): HTMLElement { const e = document.createElement('span'); e.className = 'value'; e.textContent = t; return e; }
function note(t: string): HTMLElement { const e = document.createElement('div'); e.className = 'note'; e.textContent = t; return e; }
function section(t: string): HTMLElement { const e = document.createElement('h4'); e.textContent = t; return e; }
function row(...c: HTMLElement[]): HTMLElement { const e = document.createElement('div'); e.className = 'row'; e.append(...c); return e; }
function select(opts: Array<[number, string]>, v: number, fn: (v: number) => void): HTMLSelectElement {
  const s = document.createElement('select');
  for (const [k, t] of opts) { const o = document.createElement('option'); o.value = String(k); o.textContent = t; s.append(o); }
  s.value = String(v);
  s.addEventListener('change', () => { fn(Number(s.value)); s.blur(); });
  return s;
}
