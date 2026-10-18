// Conexões de faixa escolhidas à mão num cruzamento: para cada faixa que chega, as vias de saída
// que ela pode tomar. A mesma conta roda na página (setas pintadas, painel) e na simulação
// (conexões que os carros usam), então a seta sempre bate com o comportamento.

import { armOf } from './junction.ts';
import { PROFILE_INFO, TurnBit } from './profiles.ts';
import { banned, type JunctionSpec } from './control.ts';
import type { RoadNetwork } from './network.ts';

/** Faixas de um trecho num sentido (+1 de a para b). */
export function lanesIn(profile: number, dir: number): number {
  const info = PROFILE_INFO[profile];
  return dir > 0 ? info.lanesFwd : info.lanesBack;
}

/** Setas efetivas: as da faixa, ou pela posição (direita vira à direita, esquerda à esquerda). */
export function defaultTurns(turns: number, idx: number, count: number): number {
  if (turns) return turns;
  if (count === 1) return TurnBit.Left | TurnBit.Straight | TurnBit.Right;
  if (idx === 0) return TurnBit.Right | TurnBit.Straight;
  if (idx === count - 1) return TurnBit.Left | TurnBit.Straight;
  return TurnBit.Straight;
}

/** Movimento chegando pelo rumo h e saindo pelo braço o: bit de seta (esquerda, reto, direita). */
export function turnBit(hx: number, hz: number, ox: number, oz: number): number {
  const left = ox * hz - oz * hx;
  const fwd = ox * hx + oz * hz;
  return fwd > 0.7 ? TurnBit.Straight : left > 0 ? TurnBit.Left : TurnBit.Right;
}

/** Vias de saída escolhidas à mão para a faixa `idx` que chega por `seg`, ou null (automático). */
export function customExits(spec: JunctionSpec | undefined, seg: number, idx: number): number[] | null {
  const l = spec?.lanes;
  if (!l) return null;
  for (const [s, i, to] of l) if (s === seg && i === idx) return to;
  return null;
}

/** Braços do nó: trecho, ponta (0 = a), direção de saída. */
export function armsOf(net: RoadNetwork, n: number): Array<{ s: number; end: 0 | 1; dx: number; dz: number }> {
  const sc = net.segs.cols;
  return net.segsOf(n, []).map((s) => {
    const end: 0 | 1 = sc.a[s] === n ? 0 : 1;
    const a = armOf(net.quad(s), sc.profile[s], end);
    return { s, end, dx: a.dx, dz: a.dz };
  });
}

/**
 * Saídas automáticas e efetivas de cada faixa que chega por `seg` ao nó `n`: lista por faixa de
 * [trecho de saída, bit da seta]. `custom` diz se a faixa foi ajustada à mão.
 */
export function laneExits(net: RoadNetwork, n: number, seg: number, spec = net.junctions.get(n)): Array<{ exits: Array<[number, number]>; auto: Array<[number, number]>; custom: boolean }> {
  const sc = net.segs.cols;
  const arms = armsOf(net, n);
  const me = arms.find((a) => a.s === seg);
  if (!me) return [];
  const inDir = me.end === 1 ? 1 : -1;
  const m = lanesIn(sc.profile[seg], inDir);
  const info = PROFILE_INFO[sc.profile[seg]];
  const lanes = inDir > 0 ? info.fwd : info.back;
  const out: Array<{ exits: Array<[number, number]>; auto: Array<[number, number]>; custom: boolean }> = [];
  for (let a = 0; a < m; a++) {
    const auto: Array<[number, number]> = [], all: Array<[number, number]> = [];
    const turns = defaultTurns(lanes[a]?.turns ?? 0, a, m);
    for (const o of arms) {
      if (o.s === seg) continue;
      if (banned(spec, seg, o.s)) continue;
      if (PROFILE_INFO[sc.profile[seg]].rail !== PROFILE_INFO[sc.profile[o.s]].rail) continue;
      if (lanesIn(sc.profile[o.s], o.end === 0 ? 1 : -1) === 0) continue;
      const bit = arms.length <= 2 ? TurnBit.Straight : turnBit(-me.dx, -me.dz, o.dx, o.dz);
      all.push([o.s, bit]);
      if (arms.length <= 2 || (turns & bit)) auto.push([o.s, bit]);
    }
    const c = customExits(spec, seg, a);
    out.push({ exits: c ? all.filter(([s]) => c.includes(s)) : auto, auto, custom: !!c });
  }
  return out;
}

/** Setas pintadas da ponta (3 bits por faixa, faixa 0 nos bits baixos), ou 0 se nenhuma faixa foi ajustada. */
export function arrowCode(net: RoadNetwork, n: number, seg: number): number {
  const ex = laneExits(net, n, seg);
  if (!ex.some((e) => e.custom)) return 0;
  let code = 0;
  ex.forEach((e, a) => { if (a < 5) code += (e.exits.reduce((b, [, bit]) => b | bit, 0) || TurnBit.Straight) * 8 ** a; });
  return code;
}
