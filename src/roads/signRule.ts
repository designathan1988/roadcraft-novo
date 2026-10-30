// "A sign is a rule" (Roadcraft streetscape signs): a Stop or Give-way sign put on the sidewalk next to a junction
// arm changes that arm's rule; taking the sign away gives the arm back to the automatic choice. The sign and the
// rule are one command (undo takes both back). Only junctions of 3+ roads without traffic lights take it.

import type { Command } from '../core/commands.ts';
import type { World } from '../world/world.ts';
import { Ctl, Rule, effectiveControl, type JunctionSpec } from './control.ts';
import { PROFILE_INFO } from './profiles.ts';
import type { NodeId, SegId } from '../core/ids.ts';

/** Sign variants that are rules (jobs/props.ts SIGN). */
export const SIGN_STOP = 4, SIGN_YIELD = 1;
/** How far from the junction (m, along the road) a sign still belongs to it. */
export const SIGN_REACH = 40;

/** Junction arm a sign at (x, z) belongs to: [node, segment], or null. */
export function signArm(world: World, x: number, z: number): [NodeId, SegId] | null {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const near = net.nearestSeg(x, z, 25, (s) => !PROFILE_INFO[sc.profile[s]]?.rail);
  if (!near) return null;
  const [s, t] = near;
  const end = t < 0.5 ? sc.a[s] : sc.b[s];
  const dist = (t < 0.5 ? t : 1 - t) * sc.len[s];
  if (dist > SIGN_REACH || nc.deg[end] < 3) return null;
  return [end, s];
}

/**
 * The rule change a Stop/Give-way sign at (x, z) makes (adding = the sign is put; otherwise taken away), as a command
 * not yet applied; or a reason it changes nothing ('' = not a rule sign or not at a junction).
 */
export function signRuleCommand(world: World, x: number, z: number, variant: number, adding: boolean): Command | string {
  if (variant !== SIGN_STOP && variant !== SIGN_YIELD) return '';
  const arm = signArm(world, x, z);
  if (!arm) return '';
  const [node, seg] = arm;
  const net = world.roads;
  const before = net.junctions.get(node) ?? null;
  const ctl = effectiveControl(net, node, before ?? undefined, net.flow.get(node)).ctl;
  if (ctl === Ctl.Signal || ctl === Ctl.Ring || ctl === Ctl.Crossing) return 'o cruzamento tem semáforo ou é rotatória: a placa não muda a regra';
  const legs = (before?.legs ?? []).filter(([s]) => s !== seg);
  if (adding) legs.push([seg, variant === SIGN_STOP ? Rule.Stop : Rule.Yield]);
  // the rules by arm count only with signs: an automatic junction without signs becomes "signs"
  const baseCtl = before && before.ctl !== Ctl.Auto && before.ctl !== Ctl.None && before.ctl !== Ctl.YieldAll && before.ctl !== Ctl.Mini ? before.ctl : Ctl.Priority;
  const after: JunctionSpec | null = legs.length || (before && before.ctl !== Ctl.Auto && before.ctl !== Ctl.Priority)
    ? { ...(before ?? { ctl: baseCtl }), ctl: legs.length ? baseCtl : before!.ctl, legs }
    : null;
  return {
    label: adding ? 'placa com regra' : 'tirar placa com regra',
    apply: () => { if (net.nodes.alive[node]) net.setJunction(node, after); },
    invert: () => { if (net.nodes.alive[node]) net.setJunction(node, before); },
  };
}
