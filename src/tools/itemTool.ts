// Paisagismo (objetos na calçada ou no chão) e Muros (traços de muro, cerca,
// sebe, defensa e gradil). Perto de uma via o ponto encaixa na calçada: os
// objetos junto ao meio-fio, os muros nas costas da calçada.

import type * as THREE from 'three/webgpu';
import type { Command, CommandStack } from '../core/commands.ts';
import { SIGN_STOP, signRuleCommand } from '../roads/signRule.ts';
import { addressAt } from '../roads/streetNames.ts';
import { bez, bezD } from '../roads/geometry.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { SegFlag } from '../roads/flags.ts';
import type { RoadPreview } from '../render/preview.ts';
import type { Hud } from '../ui/hud.ts';
import { heightAt } from '../world/heights.ts';
import { Item, ItemsCommand, MAX_RUN, isBarrier, isEffect } from '../world/items.ts';
import type { World } from '../world/world.ts';

const p2 = new Float64Array(2), d2 = new Float64Array(2);

/** Two commands already applied, as one undo step. */
function both(a: Command, b: Command): Command {
  return { label: a.label, apply: () => { a.apply(); b.apply(); }, invert: () => { b.invert(); a.invert(); } };
}

export const STREET_ITEMS: Array<[number, string]> = [
  [Item.Tree, 'Árvore'], [Item.Conifer, 'Pinheiro'], [Item.Palm, 'Palmeira'], [Item.Bush, 'Arbusto'], [Item.Bench, 'Banco'], [Item.Bin, 'Lixeira'],
  [Item.Lamp, 'Iluminação'], [Item.Hydrant, 'Hidrante'], [Item.Postbox, 'Caixa de correio'], [Item.Phone, 'Orelhão'],
  [Item.Drain, 'Boca de lobo'], [Item.Bollard, 'Frade'], [Item.Planter, 'Floreira'], [Item.Sign, 'Placa'],
  [Item.Smoke, 'Fumaça'], [Item.Steam, 'Vapor'], [Item.Fire, 'Fogo'], [Item.Fountain, 'Chafariz'],
  [Item.Dust, 'Poeira'], [Item.Soot, 'Fuligem'], [Item.Sparks, 'Faíscas'], [Item.Spray, 'Espuma e borrifo'],
];
const isElement = isEffect;
export const SIGN_TYPES: Array<[number, string]> = [
  [4, 'Pare'], [1, 'Dê a preferência'], [0, 'Velocidade máxima'], [5, 'Proibido estacionar'], [6, 'Sentido proibido'],
  [7, 'Pedestres'], [8, 'Escola'], [9, 'Direção'], [2, 'Placa de rua'], [10, 'Informação'], [3, 'Mão única'],
];
export const BARRIER_KINDS: Array<[number, string]> = [
  [Item.Fence, 'Cerca'], [Item.Wall, 'Muro'], [Item.Hedge, 'Sebe'], [Item.Guardrail, 'Defensa (guard-rail)'], [Item.Railing, 'Gradil urbano'],
  [Item.PoleLine, 'Postes com fios'],
];

interface Spot { x: number; z: number; y: number; yaw: number; onWalk: boolean }

export class ItemTool {
  mode: 'streetscape' | 'barrier' = 'streetscape';
  item: number = Item.Tree;
  sign = 4;
  /** Texto da próxima placa (nome da rua, informação, direção). */
  signText = '';
  /** Chamado quando uma placa com texto é posta (texto, posição, trecho mais perto). */
  onText: ((text: string, x: number, z: number, seg: number, street: boolean) => void) | null = null;
  barrier: number = Item.Fence;
  /** Luz dos postes com fios: 0 sem luz, 1 em postes alternados, 2 em todos. */
  poleLights = 0;
  private last: { x: number; z: number } | null = null;
  private world: World;
  private commands: CommandStack;
  private preview: RoadPreview;
  private hud: Hud;

  constructor(world: World, commands: CommandStack, preview: RoadPreview, hud: Hud) {
    this.world = world; this.commands = commands; this.preview = preview; this.hud = hud;
  }

  setMode(m: 'streetscape' | 'barrier'): void { this.mode = m; this.cancel(); }

  cancel(showHint = true): void {
    if (this.last) this.commands.endGroup();
    this.last = null;
    this.preview.hideAll();
    if (showHint) this.hint();
  }

  hint(): void {
    if (this.mode === 'streetscape') this.hud.setHint('Clique numa calçada (ou no chão) para pôr o item escolhido; arraste ao longo dela para uma fileira. Shift+clique remove.');
    else this.hud.setHint(this.last ? 'Clique para continuar o traço; Enter ou Esc termina, Backspace volta um ponto.' : 'Clique para começar o traço. Perto de uma via ele vai para as costas da calçada. Shift+clique remove.');
  }

  /** Ponto encaixado: na calçada (meio-fio para objetos, costas para muros) ou livre no chão. */
  private spot(x: number, z: number, back: boolean): Spot {
    const net = this.world.roads, sc = net.segs.cols, nc = net.nodes.cols;
    const near = net.nearestSeg(x, z, 30);
    const ground = heightAt(this.world.heights, x, z);
    if (near && !(sc.flags[near[0]] & SegFlag.Ring)) {
      const s = near[0], t = near[1];
      const q = net.quad(s);
      bez(q, t, p2); bezD(q, t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      const tx = d2[0] / l, tz = d2[1] / l, lx = tz, lz = -tx;
      const u = (x - p2[0]) * lx + (z - p2[1]) * lz;
      const info = PROFILE_INFO[sc.profile[s]];
      const e = u > 0 ? info.edges[info.edges.length - 1] : info.edges[0];
      const outer = u > 0 ? e.u1 : e.u0;
      if (Math.abs(u) < Math.abs(outer) + (back ? 5 : 1.5) && e.strip.kind === 'sidewalk') {
        const wu = back ? outer - Math.sign(u) * 0.25 : (u > 0 ? e.u0 + 0.5 : e.u1 - 0.5);
        const y = nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * t + (e.strip.flush ? 0 : 0.15);
        // objeto olha para a rua; placa olha para quem vem na mão daquele lado
        const yaw = this.item === Item.Sign && !back ? (u > 0 ? Math.atan2(tx, tz) : Math.atan2(-tx, -tz)) : Math.atan2(-lx * Math.sign(u), -lz * Math.sign(u));
        return { x: p2[0] + lx * wu, z: p2[1] + lz * wu, y, yaw, onWalk: true };
      }
    }
    return { x, z, y: ground, yaw: 0, onWalk: false };
  }

  hover(hit: THREE.Vector3 | null): void {
    const pv = this.preview;
    if (!hit) { pv.hideAll(); return; }
    const sp = this.spot(hit.x, hit.z, this.mode === 'barrier');
    pv.showMarker(sp.x, sp.y, sp.z, 0.8, sp.onWalk ? 'seg' : 'free');
    if (this.mode === 'barrier' && this.last) {
      const a = this.last;
      const ya = heightAt(this.world.heights, a.x, a.z);
      pv.show({ x0: a.x, z0: a.z, cx: (a.x + sp.x) / 2, cz: (a.z + sp.z) / 2, x1: sp.x, z1: sp.z }, 0.3, [0, 1], [ya + 0.5, sp.y + 0.5], true, 0xffd36b);
    } else pv.hide();
  }

  click(hit: THREE.Vector3 | null, shift: boolean): void {
    if (!hit) return;
    const items = this.world.items;
    if (shift) {
      const id = items.nearest(hit.x, hit.z, 3);
      if (id >= 0 && isBarrier(items.t.cols.type[id]) === (this.mode === 'barrier')) {
        const ic = items.t.cols, sx = ic.x0[id], sz = ic.z0[id], kind = ic.type[id], variant = ic.variant[id];
        const c = new ItemsCommand(items, 'remover item');
        c.remove(id);
        // a Stop/Give-way sign taken away gives its junction arm back to the automatic rule
        const rule = kind === Item.Sign ? signRuleCommand(this.world, sx, sz, variant, false) : '';
        if (typeof rule !== 'string') { rule.apply(); this.commands.push(both(c, rule)); } else this.commands.push(c);
      }
      return;
    }
    if (this.mode === 'streetscape') {
      const sp = this.spot(hit.x, hit.z, false);
      const c = new ItemsCommand(items, 'pôr item');
      // objetos: x1 = rumo, z1 = altura (0 = do chão)
      // elementos (fumaça, fogo…): variante = força
      c.add([sp.x, sp.z, sp.yaw, sp.onWalk ? sp.y : 0, this.item, this.item === Item.Sign ? this.sign : isElement(this.item) ? 4 : 0]);
      // "a sign is a rule": a Stop/Give-way sign next to a junction arm sets that arm's rule (one undo for both)
      const rule = this.item === Item.Sign ? signRuleCommand(this.world, sp.x, sp.z, this.sign, true) : '';
      if (typeof rule !== 'string') { rule.apply(); this.commands.push(both(c, rule)); this.hud.toast(this.sign === SIGN_STOP ? 'Placa de Pare: quem chega por esta via para no cruzamento.' : 'Dê a preferência: quem chega por esta via dá a vez no cruzamento.'); }
      else { this.commands.push(c); if (rule) this.hud.toast(rule[0].toUpperCase() + rule.slice(1) + '.'); }
      if (this.item === Item.Sign && this.signText.trim()) {
        const near = this.world.roads.nearestSeg(sp.x, sp.z, 30);
        this.onText?.(this.signText.trim().slice(0, 32), sp.x, sp.z, near ? near[0] : -1, this.sign === 2);
      } else if (this.item === Item.Sign && this.sign === 2) {
        // street sign without a typed name: it shows the street's name (generated or the one the player gave)
        const name = addressAt(this.world, sp.x, sp.z, 30)?.name;
        if (name) this.onText?.(name, sp.x, sp.z, -1, false);
      }
      return;
    }
    const sp = this.spot(hit.x, hit.z, true);
    if (!this.last) { this.last = { x: sp.x, z: sp.z }; this.hint(); return; }
    const a = this.last;
    const L = Math.hypot(sp.x - a.x, sp.z - a.z);
    if (L < 0.5) return;
    const c = new ItemsCommand(items, 'muro');
    const n = Math.ceil(L / MAX_RUN);
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      c.add([a.x + (sp.x - a.x) * t0, a.z + (sp.z - a.z) * t0, a.x + (sp.x - a.x) * t1, a.z + (sp.z - a.z) * t1, this.barrier, this.barrier === Item.PoleLine ? this.poleLights : 0]);
    }
    this.commands.push(c);
    this.last = { x: sp.x, z: sp.z };
  }

  /** Espaço entre itens de uma fileira (m), por tipo. */
  private static spacing(t: number): number {
    const S: Record<number, number> = { [Item.Tree]: 9, [Item.Conifer]: 8, [Item.Palm]: 10, [Item.Bush]: 4, [Item.Bench]: 14, [Item.Bin]: 22, [Item.Lamp]: 25,
      [Item.Hydrant]: 60, [Item.Postbox]: 60, [Item.Phone]: 50, [Item.Drain]: 30, [Item.Bollard]: 2.5, [Item.Planter]: 6, [Item.Sign]: 40 };
    return S[t] ?? 10;
  }

  /** Fileira do item escolhido de a até b, cada um encaixado na calçada (um comando só). */
  row(ax: number, az: number, bx: number, bz: number): number {
    const L = Math.hypot(bx - ax, bz - az);
    const step = ItemTool.spacing(this.item);
    const n = Math.max(1, Math.floor(L / step) + 1);
    const c = new ItemsCommand(this.world.items, 'fileira');
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i * step / L;
      const sp = this.spot(ax + (bx - ax) * t, az + (bz - az) * t, false);
      if (this.world.items.nearest(sp.x, sp.z, Math.min(1.5, step * 0.5)) >= 0) continue;
      c.add([sp.x, sp.z, sp.yaw, sp.onWalk ? sp.y : 0, this.item, this.item === Item.Sign ? this.sign : isElement(this.item) ? 4 : 0]);
    }
    if (!c.empty) { this.commands.push(c); this.hud.toast('Fileira posta ao longo da calçada.'); }
    return n;
  }

  /** Pré-visualização da fileira: a linha e o primeiro ponto. */
  hoverRow(ax: number, az: number, hit: THREE.Vector3 | null): void {
    if (!hit) return;
    const a = this.spot(ax, az, false), b = this.spot(hit.x, hit.z, false);
    this.preview.show({ x0: a.x, z0: a.z, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, x1: b.x, z1: b.z }, 0.5, [0, 1], [a.y + 0.4, b.y + 0.4], true, 0x4cd28a);
  }

  /** Backspace: desfaz o último trecho e volta o ponto. */
  back(): void {
    if (!this.last) return;
    this.commands.undo();
    this.last = null;
    this.hint();
  }
}
