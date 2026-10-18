// Forma dos nós, igual para o desenho (worker de malha) e para o trânsito
// (worker de simulação): braço de cada ponta de trecho e recuo de cada braço.

import { armAngle, armRetreats, closestT, type Arm, type Quad } from './geometry.ts';
import { PROFILE_INFO } from './profiles.ts';
import type { RoadNetwork } from './network.ts';

/** Braço de uma ponta de trecho: direção para fora do nó e meias larguras. */
export function armOf(q: Quad, profile: number, end: 0 | 1): Arm {
  const info = PROFILE_INFO[profile];
  let dx = end === 0 ? q.cx - q.x0 : q.cx - q.x1, dz = end === 0 ? q.cz - q.z0 : q.cz - q.z1;
  if (Math.hypot(dx, dz) < 1e-6) { dx = end === 0 ? q.x1 - q.x0 : q.x0 - q.x1; dz = end === 0 ? q.z1 - q.z0 : q.z0 - q.z1; }
  const l = Math.hypot(dx, dz) || 1;
  return end === 0
    ? { dx: dx / l, dz: dz / l, left: info.left, right: info.right, asphLeft: info.asphaltLeft, asphRight: info.asphaltRight }
    : { dx: dx / l, dz: dz / l, left: info.right, right: info.left, asphLeft: info.asphaltRight, asphRight: info.asphaltLeft };
}

const tmp = new Float64Array(16);

/** Balão de retorno na ponta de rua sem saída (roadcraft `junction/bulb.ts`): raio do asfalto e largura da calçada. */
export const BULB_R = 10, BULB_WALK = 2.5;
/** Marca do nó com balão no grafo que vai para os workers (`RoadGraph.nctl`). */
export const NODE_BULB = 200;

/**
 * Recuo da ponta de rua sem saída com balão: onde o círculo do asfalto encontra a borda da pista (0 = sem balão:
 * via larga, trecho curto). O trecho termina ali e o balão desenha o resto, sem nada no mesmo plano.
 */
export function bulbRetreat(arm: Arm, len: number): number {
  const half = Math.max(arm.asphLeft, arm.asphRight);
  if (half > 6.5 || half < 1 || len < 40) return 0;
  return Math.min(Math.sqrt(BULB_R * BULB_R - half * half), len * 0.45);
}

/**
 * Recuo de cada braço de um nó (na ordem dada). `lens` limita o recuo a 45%
 * do trecho. Devolve também a ordem anti-horária dos braços.
 */
export function junctionRetreats(arms: Arm[], lens: number[], out: Float64Array, order: number[], bulb = false): void {
  const n = arms.length;
  order.length = 0;
  for (let i = 0; i < n; i++) order.push(i);
  if (n < 2) { if (n === 1) out[0] = bulb ? bulbRetreat(arms[0], lens[0]) : 0; return; }
  order.sort((a, b) => armAngle(arms[a].dx, arms[a].dz) - armAngle(arms[b].dx, arms[b].dz));
  armRetreats(order.map((i) => arms[i]), n >= 3 ? 3 : 0.3, tmp);
  for (let k = 0; k < n; k++) out[order[k]] = Math.min(tmp[k], lens[order[k]] * 0.45);
}

const bulbQ: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };

/**
 * O nó é ponta de rua sem saída com balão de retorno: via estreita, trecho longo e nenhuma outra via a menos do
 * balão e de uma folga (a geração deixa pontas encostadas em outras vias: ali o círculo cobriria a outra pista).
 * A página decide (e marca no grafo, NODE_BULB); a simulação usa esta mesma conta.
 */
export function bulbAt(net: RoadNetwork, n: number): boolean {
  const nc = net.nodes.cols;
  if (!net.nodes.alive[n] || nc.deg[n] !== 1) return false;
  // cada célula que encosta no nó pergunta de novo (malha, lotes, peças): guarda até a rede mudar
  let c = bulbCache.get(net);
  if (!c || c.version !== net.version) { c = { version: net.version, at: new Map() }; bulbCache.set(net, c); }
  const known = c.at.get(n);
  if (known !== undefined) return known;
  const v = bulbClear(net, n);
  c.at.set(n, v);
  return v;
}

const bulbCache = new WeakMap<RoadNetwork, { version: number; at: Map<number, boolean> }>();

function bulbClear(net: RoadNetwork, n: number): boolean {
  const nc = net.nodes.cols;
  const sc = net.segs.cols;
  const s = net.segsOf(n, [])[0];
  if (bulbRetreat(armOf(net.quad(s), sc.profile[s], sc.a[s] === n ? 0 : 1), sc.len[s]) <= 0) return false;
  const x = nc.x[n], z = nc.z[n], reach = BULB_R + BULB_WALK + 3;
  let clear = true;
  net.forSegsNear(x - reach - 30, z - reach - 30, x + reach + 30, z + reach + 30, (o) => {
    if (!clear || o === s) return;
    net.quad(o, bulbQ);
    const [, d] = closestT(bulbQ, x, z);
    if (d - PROFILE_INFO[sc.profile[o]].right < reach) clear = false;
  });
  return clear;
}
