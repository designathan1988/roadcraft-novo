/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRS, poseAlong } from '../src/sim/reedsShepp.ts';

const close = (a: number, b: number, e = 1e-4) => Math.abs(a - b) < e;
const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

test('Reeds-Shepp: o caminho termina exatamente na pose pedida (300 poses ao acaso)', () => {
  let rng = 12345;
  const rnd = () => { rng = (rng * 1103515245 + 12345) >>> 0; return rng / 2 ** 32; };
  const out = new Float64Array(4);
  let found = 0;
  for (let k = 0; k < 300; k++) {
    const ax = rnd() * 40 - 20, az = rnd() * 40 - 20, ay = rnd() * 6.28;
    const bx = rnd() * 40 - 20, bz = rnd() * 40 - 20, by = rnd() * 6.28;
    const p = planRS(ax, az, ay, bx, bz, by, 5);
    if (!p) continue;
    found++;
    poseAlong(p, 5, ax, az, ay, p.total, out);
    assert.ok(close(out[0], bx) && close(out[1], bz) && close(angle(out[2] - by), 0), `pose ${k}: ${[...out]} contra ${bx},${bz},${by}`);
  }
  assert.ok(found > 290, `${found} de 300 com caminho`);
});

test('baliza: do lado da vaga, um pouco à frente, a ré entra na vaga em dois arcos', () => {
  // carro na faixa andando para +z (rumo 0), vaga 2,7 m à direita (x negativo: direita do motorista = (−cos, sen))
  const p = planRS(0, 0, 0, -2.7, -6, 0, 5)!;
  assert.ok(p);
  const rev = p.lens.filter((l) => l < 0).reduce((s, l) => s - l, 0);
  assert.ok(rev > 0.8 * p.total, `quase toda em ré: ${p.lens}`);
  assert.ok(p.total < 10, `${p.total} m`);
  const out = new Float64Array(4);
  poseAlong(p, 5, 0, 0, 0, p.total / 2, out);
  assert.equal(out[3], -1, 'engatado em ré');
});

test('caminhão de ré na doca: da faixa até a doca de frente para a rua, com limite de ré', () => {
  // via andando +z; doca 18 m à direita, de costas para o galpão (frente para a rua: rumo +90° = para +x)
  const p = planRS(0, 0, 0, -18, -4, Math.PI / 2, 9, 30);
  assert.ok(p, 'há caminho');
  const out = new Float64Array(4);
  poseAlong(p!, 9, 0, 0, 0, p!.total, out);
  assert.ok(close(out[0], -18) && close(out[1], -4));
});
