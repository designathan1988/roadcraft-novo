/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { buildRoad, planRoad, snap } from '../src/roads/build.ts';
import { addressAt, streetName, streetOf } from '../src/roads/streetNames.ts';
import { SIGN_STOP, SIGN_YIELD, signRuleCommand } from '../src/roads/signRule.ts';
import { Ctl, Rule, effectiveControl } from '../src/roads/control.ts';
import { PROFILES } from '../src/roads/profiles.ts';
import { asSeg } from '../src/core/ids.ts';
import { CommandStack } from '../src/core/commands.ts';
import { streetChain } from '../src/roads/build.ts';
import { signTextCommand } from '../src/features/streetscape/signText.ts';

function flatWorld(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.unlimited = true;
  return w;
}
function road(w: World, ax: number, az: number, bx: number, bz: number, profile = 0): void {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, profile, 0);
  assert.ok(p.ok, p.reason);
  assert.ok(buildRoad(w, p, a, b, profile).settle());
}

test('rua: a mesma em todos os trechos, nome estável, numeração métrica par à direita', () => {
  const w = flatWorld();
  road(w, -300, 0, 300, 0); // vários trechos de até 112 m
  const segs = [...Array(w.roads.segs.end).keys()].filter((s) => w.roads.segs.alive[s]);
  assert.ok(segs.length >= 5);
  const names = new Set(segs.map((s) => streetName(w, asSeg(s))));
  assert.equal(names.size, 1, `nomes ${[...names]}`);
  assert.match([...names][0], /^Rua /);
  assert.equal(streetOf(w, asSeg(segs[2])).segs.length, segs.length);
  // começa na ponta de menor x: 100 m depois dela, número ~100; lado direito (andando para +x, z positivo) é par
  const right = addressAt(w, -200, 15)!, left = addressAt(w, -200, -15)!;
  assert.ok(Math.abs(right.number - 100) <= 2 && Math.abs(left.number - 100) <= 2, `${right.number} ${left.number}`);
  assert.equal(right.side, 'right'); assert.equal(right.number % 2, 0);
  assert.equal(left.number % 2, 1);
  const far = addressAt(w, 250, 15)!;
  assert.ok(Math.abs(far.number - 550) <= 2, `${far.number}`);
  // outro mundo com a mesma rua: o mesmo nome (não depende de ids nem de sessão)
  const w2 = flatWorld();
  road(w2, 300, 0, -300, 0);
  assert.equal(addressAt(w2, 0, 10)!.name, right.name);
});

test('nome dado pelo jogador vale para a rua inteira; avenida se chama Avenida', () => {
  const w = flatWorld();
  road(w, -200, 0, 200, 0);
  const s = w.roads.nearestSeg(100, 0, 5)![0];
  w.streetNames.set(s, 'Rua do Jogador');
  assert.equal(addressAt(w, -150, 10)!.name, 'Rua do Jogador');
  const av = PROFILES.findIndex((p) => p.name === 'profile.avenue');
  road(w, -200, 400, 200, 400, av);
  assert.match(addressAt(w, 0, 410)!.name, /^Avenida /);
});

test('placa = regra: Pare posto na perna muda a regra dela; tirar a placa devolve; desfazer volta', () => {
  const w = flatWorld();
  road(w, -200, 0, 200, 0);
  road(w, 0, -200, 0, 0);
  const n = w.roads.nearestNode(0, 0, 3);
  assert.equal(w.roads.nodes.cols.deg[n], 3);
  const leg = w.roads.nearestSeg(0, -30, 5)![0];
  const before = effectiveControl(w.roads, n);
  assert.notEqual(before.legs.get(leg), Rule.Stop);
  const add = signRuleCommand(w, 6, -25, SIGN_STOP, true);
  assert.ok(typeof add !== 'string', String(add));
  add.apply();
  const c = effectiveControl(w.roads, n);
  assert.equal(c.legs.get(leg), Rule.Stop);
  assert.equal(c.ctl, Ctl.Priority);
  const rem = signRuleCommand(w, 6, -25, SIGN_STOP, false);
  assert.ok(typeof rem !== 'string');
  rem.apply();
  assert.notEqual(effectiveControl(w.roads, n).legs.get(leg), Rule.Stop);
  rem.invert();
  assert.equal(effectiveControl(w.roads, n).legs.get(leg), Rule.Stop);
  // undo in order: the removal was already undone above, now the sign itself (D16: rem was inverted a second time)
  add.invert();
  assert.equal(effectiveControl(w.roads, n).legs.get(leg), before.legs.get(leg));
  // dê a preferência
  const y = signRuleCommand(w, 6, -25, SIGN_YIELD, true);
  assert.ok(typeof y !== 'string');
  y.apply();
  assert.equal(effectiveControl(w.roads, n).legs.get(leg), Rule.Yield);
  // longe do cruzamento: placa comum
  assert.equal(signRuleCommand(w, -150, 8, SIGN_STOP, true), '');
  // semáforo: a placa não muda a regra
  w.roads.setJunction(n, { ctl: Ctl.Signal });
  assert.equal(typeof signRuleCommand(w, 6, -25, SIGN_STOP, true), 'string');
});

test('D47: undoing a sign text puts the previous text back (and the street names), not nothing', () => {
  const w = flatWorld();
  road(w, -50, 0, 50, 0);
  const s = w.roads.nearestSeg(0, 0, 3)![0], chain = streetChain(w, s), key = '0,50';
  const stack = new CommandStack();
  stack.run(signTextCommand(w, key, 'A', chain, () => {}));
  stack.run(signTextCommand(w, key, 'B', chain, () => {}));
  stack.undo();
  assert.equal(w.signTexts.get(key), 'A');
  assert.equal(w.streetNames.get(s), 'A');
  stack.undo();
  assert.equal(w.signTexts.has(key), false);
  assert.equal(w.streetNames.has(s), false);
  stack.redo();
  assert.equal(w.signTexts.get(key), 'A');
});
