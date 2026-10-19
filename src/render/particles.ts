// Elementos: fumaça, vapor, fogo e chafariz. Cada emissor perto da câmera vira
// uma linha de uma textura pequena; as partículas não existem na CPU — o shader
// anima cada uma pelo índice e pelo tempo (como a chuva). A lista de emissores
// é refeita só quando a câmera anda ou os itens/prédios mudam, consultando os
// índices espaciais num raio fixo (nunca a cidade inteira).

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';
import { nightU } from './scene.ts';
import { windU } from './weather.ts';
import { colorOnly } from './post.ts';
import type { World } from '../world/world.ts';
import { Dirty, cellOriginX, type DirtyReader } from '../core/grid.ts';
import { CELL_SIZE, MAP_CELLS } from '../config.ts';
import { Item } from '../world/items.ts';
import { chimneyOf } from '../world/arch.ts';
import { baseZone, Zone } from '../roads/zones.ts';
import { groundRange } from '../jobs/buildingGen.ts';
import { heightAt } from '../world/heights.ts';

const {
  vec2, vec3, vec4, float, int, ivec2, mix, smoothstep, clamp, textureLoad, time, instanceIndex, hash, fract, pow,
  cameraPosition, normalize, cross, positionLocal, uv, length, select, sRGBTransferEOTF, max, mx_noise_float, floor,
} = T;

/** Tipo de partícula (coluna w do emissor). */
export const Puff = { Smoke: 0, Steam: 1, Fire: 2, Fountain: 3, Dust: 4, Soot: 5, Sparks: 6, Spray: 7, Mist: 8 } as const;
const PER = 24;
const MAX_EMIT = 512;
const RADIUS = 1600;

export class Particles {
  readonly mesh: THREE.Mesh;
  private tex: THREE.DataTexture;
  private data = new Float32Array(MAX_EMIT * 4);
  private geo: THREE.InstancedBufferGeometry;
  private world: World;
  private lastX = Infinity;
  private lastZ = Infinity;
  private timer = 0;
  /** Buildings and items edited since the last look (own lists: a factory replaced by another building used to keep
   *  smoking, the building count being the same). */
  private builtEdits: DirtyReader;
  private itemEdits: DirtyReader;
  private due = true;
  count = 0;

  constructor(world: World) {
    this.world = world;
    this.builtEdits = world.dirty.reader(Dirty.Buildings);
    this.itemEdits = world.dirty.reader(Dirty.Props);
    this.tex = new THREE.DataTexture(this.data, MAX_EMIT, 1, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    const g = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    g.index = q.index;
    g.setAttribute('position', q.attributes.position);
    g.setAttribute('uv', q.attributes.uv);
    g.instanceCount = 0;
    this.geo = g;

    const m = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    const id = instanceIndex.toFloat();
    const e = floor(id.div(PER));
    const em = textureLoad(this.tex, ivec2(int(e), int(0)));
    const kind = em.w.mod(16).floor();
    const str = floor(em.w.div(16)).div(4).add(1); // força 1..4
    const h0 = hash(id), h1 = hash(id.add(0.37)).sub(0.5), h2 = hash(id.add(0.71)).sub(0.5), h3 = hash(id.add(1.13));
    const isSmoke = kind.equal(0).toFloat(), isSteam = kind.equal(1).toFloat(), isFire = kind.equal(2).toFloat(), isWater = kind.equal(3).toFloat();
    const isDust = kind.equal(4).toFloat(), isSoot = kind.equal(5).toFloat(), isSpark = kind.equal(6).toFloat(), isSpray = kind.equal(7).toFloat();
    const isMist = kind.equal(8).toFloat();
    const life = isSmoke.mul(9).add(isSteam.mul(3.2)).add(isFire.mul(1.1)).add(isWater.mul(1.9))
      .add(isDust.mul(6)).add(isSoot.mul(12)).add(isSpark.mul(0.9)).add(isSpray.mul(1.4)).add(isMist.mul(40));
    const t = fract(time.div(life).add(h0));
    const windDir = vec3(0.91, 0, 0.41);
    const drift = windDir.mul(windU.mul(1.4).add(0.25));
    // trajetórias por tipo
    const smokeP = vec3(h1.mul(1.2), t.mul(16).mul(str), h2.mul(1.2)).add(drift.mul(pow(t, 1.4).mul(22)));
    const steamP = vec3(h1.mul(0.8), t.mul(7).mul(str), h2.mul(0.8)).add(drift.mul(t.mul(5)));
    const fireP = vec3(h1.mul(1.4).mul(float(1).sub(t.mul(0.6))).mul(str), t.mul(t).mul(3.2).mul(str), h2.mul(1.4).mul(float(1).sub(t.mul(0.6))).mul(str));
    const tt = t.mul(1.9);
    const waterP = vec3(h1.mul(2.6).mul(tt), max(float(0), tt.mul(float(8.5).add(h3.mul(1.5))).mul(str.mul(0.5).add(0.5)).sub(tt.mul(tt).mul(4.9))), h2.mul(2.6).mul(tt));
    // poeira: nuvem baixa que rola com o vento; fuligem: flocos escuros que sobem devagar e caem; faíscas:
    // pulam em arco rápido; borrifo: névoa fina de água espalhando rente ao chão
    const dustP = vec3(h1.mul(5).mul(str), t.mul(2.2).add(h3.mul(0.5)), h2.mul(5).mul(str)).add(drift.mul(t.mul(9)));
    const sootP = vec3(h1.mul(3), t.mul(14).mul(str).sub(t.mul(t).mul(10)), h2.mul(3)).add(drift.mul(t.mul(16)));
    const ts = t.mul(0.9);
    const sparkP = vec3(h1.mul(5).mul(ts), max(float(0), ts.mul(float(6).add(h3.mul(4))).sub(ts.mul(ts).mul(9.8))), h2.mul(5).mul(ts)).mul(str.mul(0.4).add(0.6));
    const sprayP = vec3(h1.mul(4).mul(t), t.mul(1.6).sub(t.mul(t).mul(1.2)).add(0.2), h2.mul(4).mul(t)).mul(str.mul(0.5).add(0.5)).add(drift.mul(t.mul(3)));
    const offset = smokeP.mul(isSmoke).add(steamP.mul(isSteam)).add(fireP.mul(isFire)).add(waterP.mul(isWater))
      .add(dustP.mul(isDust)).add(sootP.mul(isSoot)).add(sparkP.mul(isSpark)).add(sprayP.mul(isSpray))
      // neblina: lençol baixo e largo que desliza devagar com o vento (altura pela força)
      .add(vec3(h1.mul(28), h3.mul(str).mul(2.5).add(1.5), h2.mul(28)).add(drift.mul(t.mul(10))).mul(isMist));
    const size = isSmoke.mul(t.mul(9).add(1.2)).add(isSteam.mul(t.mul(4.5).add(0.8)))
      .add(isFire.mul(float(1).sub(t).mul(1.7).add(0.35))).add(isWater.mul(0.32))
      .add(isDust.mul(t.mul(3).add(1.4))).add(isSoot.mul(0.22)).add(isSpark.mul(0.09)).add(isSpray.mul(t.mul(1.6).add(0.5)))
      .add(isMist.mul(16)).mul(str.mul(0.35).add(0.65));
    // fogo: chama alongada, apoiada no chão (o disco não afunda)
    const stretch = float(1).add(isFire.mul(0.7));
    const center = em.xyz.add(offset).add(vec3(0, size.mul(stretch).mul(0.45).mul(isFire.add(isSteam)), 0));
    const toCam = normalize(cameraPosition.sub(center));
    const side = normalize(cross(vec3(0, 1, 0), toCam));
    const up = cross(toCam, side);
    m.positionNode = center.add(side.mul(positionLocal.x.mul(size))).add(up.mul(positionLocal.y.mul(size).mul(stretch)));
    // aparência: disco macio, borda rasgada por ruído na fumaça
    const d = length(uv().sub(0.5)).mul(2);
    const n = mx_noise_float(vec3(uv().mul(3.1), id.mul(0.13).add(t.mul(2)))).mul(0.35);
    const flame = length(vec2(uv().x.sub(0.5).mul(float(1).add(uv().y.mul(1.4))), uv().y.sub(0.42))).mul(2);
    const shape = mix(d, flame, isFire);
    const disc = smoothstep(float(1), float(0.25), shape.add(n.mul(isSmoke.add(isSteam).add(isFire.mul(0.6)).add(isDust).add(isSpray).add(isMist))));
    const day = float(1).sub(nightU);
    const smokeC = mix(vec3(0.28, 0.27, 0.27), vec3(0.62, 0.61, 0.6), t).mul(mix(float(0.18), float(1), day));
    const steamC = vec3(0.95, 0.96, 0.98).mul(mix(float(0.22), float(1), day));
    const fireC = mix(vec3(3.2, 2.4, 0.9), vec3(1.6, 0.35, 0.06), smoothstep(float(0.1), float(0.8), t));
    const waterC = vec3(0.82, 0.9, 1).mul(mix(float(0.25), float(1), day));
    const dustC = vec3(0.66, 0.56, 0.42).mul(mix(float(0.2), float(1), day));
    const sootC = vec3(0.07, 0.07, 0.07);
    const sparkC = mix(vec3(4, 3.2, 1.4), vec3(3, 1.1, 0.2), t);
    const sprayC = vec3(0.88, 0.93, 1).mul(mix(float(0.25), float(1), day));
    const mistC = vec3(0.86, 0.88, 0.9).mul(mix(float(0.2), float(1), day));
    const col = mistC.mul(isMist).add(smokeC.mul(isSmoke)).add(steamC.mul(isSteam)).add(fireC.mul(isFire)).add(waterC.mul(isWater))
      .add(dustC.mul(isDust)).add(sootC.mul(isSoot)).add(sparkC.mul(isSpark)).add(sprayC.mul(isSpray));
    const a = isSmoke.mul(smoothstep(float(0), float(0.08), t).mul(pow(float(1).sub(t), 1.3)).mul(0.5))
      .add(isSteam.mul(smoothstep(float(0), float(0.1), t).mul(pow(float(1).sub(t), 2)).mul(0.55)))
      .add(isFire.mul(smoothstep(float(0), float(0.05), t).mul(float(1).sub(t)).mul(0.95)))
      .add(isWater.mul(float(1).sub(t.mul(t)).mul(0.6)))
      .add(isDust.mul(smoothstep(float(0), float(0.15), t).mul(float(1).sub(t)).mul(0.35)))
      .add(isSoot.mul(smoothstep(float(0), float(0.05), t).mul(float(1).sub(t)).mul(0.85)))
      .add(isSpark.mul(float(1).sub(t).mul(0.95)))
      .add(isSpray.mul(smoothstep(float(0), float(0.1), t).mul(float(1).sub(t)).mul(0.4)))
      .add(isMist.mul(smoothstep(float(0), float(0.2), t).mul(smoothstep(float(1), float(0.7), t)).mul(0.09)));
    m.colorNode = vec4(sRGBTransferEOTF(clamp(col, 0, 1)).add(max(col.sub(1), vec3(0))), a.mul(disc));
    m.fog = true;
    void vec2; void select;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.mesh.visible = false;
  }

  /** Refaz a lista se a câmera andou ou os itens/prédios mudaram (no máximo 2× por segundo). */
  /** Emissores de vida curta (explosão): x, y, z, tipo, força, até quando (s do relógio da página). */
  private bursts: Array<[number, number, number, number, number, number]> = [];
  private clock = 0;

  /** Fumaça, fogo, poeira e faíscas por alguns segundos num ponto. */
  burst(x: number, y: number, z: number, kind: number, strength: number, seconds: number): void {
    this.bursts.push([x, y, z, kind, strength, this.clock + seconds]);
    this.due = true;
    this.timer = 0;
  }

  update(dt: number, eye: THREE.Vector3): void {
    this.clock += dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const before = this.bursts.length;
    this.bursts = this.bursts.filter((b) => b[5] > this.clock);
    if (before !== this.bursts.length) this.due = true;
    // an edit within reach of the emitters gathered last time
    const reach = RADIUS + CELL_SIZE;
    for (const r of [this.builtEdits, this.itemEdits]) {
      for (const c of r.drain()) {
        const x = cellOriginX(c % MAP_CELLS) + CELL_SIZE / 2, z = cellOriginX((c / MAP_CELLS) | 0) + CELL_SIZE / 2;
        if (Math.abs(x - this.lastX) < reach && Math.abs(z - this.lastZ) < reach) this.due = true;
      }
    }
    if (!this.due && Math.hypot(eye.x - this.lastX, eye.z - this.lastZ) < 120) return;
    this.due = false;
    this.lastX = eye.x; this.lastZ = eye.z;
    this.rebuild(eye.x, eye.z);
  }

  /** Recolhe os emissores no raio: itens de elemento e chaminés de galpões. */
  rebuild(x: number, z: number): void {
    const w = this.world, d = this.data;
    let n = 0;
    const push = (px: number, py: number, pz: number, kind: number, strength: number) => {
      if (n >= MAX_EMIT) return;
      d[n * 4] = px; d[n * 4 + 1] = py; d[n * 4 + 2] = pz; d[n * 4 + 3] = kind + 16 * Math.max(0, Math.min(15, strength));
      n++;
    };
    const ic = w.items.t.cols;
    w.items.index.query(x - RADIUS, z - RADIUS, x + RADIUS, z + RADIUS, (i) => {
      const k = ELEMENT_KIND[ic.type[i]];
      if (k === undefined) return;
      const y = ic.z1[i] !== 0 ? ic.z1[i] : heightAt(w.heights, ic.x0[i], ic.z0[i]);
      push(ic.x0[i], y + (k === Puff.Fountain ? 0.6 : 0.1), ic.z0[i], k, ic.variant[i]);
    });
    const bc = w.buildings.cols;
    w.buildingIndex.query(x - RADIUS, z - RADIUS, x + RADIUS, z + RADIUS, (i) => {
      if (baseZone(bc.zone[i]) !== Zone.Industrial || bc.fn[i]) return;
      const ch = chimneyOf(bc.seed[i], bc.w[i], bc.d[i], Math.max(1, bc.floors[i]));
      if (!ch) return;
      const c = Math.cos(bc.rot[i]), s = Math.sin(bc.rot[i]);
      const f = { cx: bc.x[i], cz: bc.z[i], c, s, base: 0 };
      const hi = groundRange(w.heights, f, bc.w[i], bc.d[i])[1];
      push(f.cx + ch[0] * c + ch[1] * s, hi + ch[2] + 0.3, f.cz - ch[0] * s + ch[1] * c, Puff.Smoke, 4);
    });
    for (const [bx, by, bz, k, st] of this.bursts) push(bx, by, bz, k, st);
    this.count = n;
    this.geo.instanceCount = n * PER;
    this.mesh.visible = n > 0;
    this.tex.needsUpdate = true;
  }
}

/** Item de paisagismo que é emissor → tipo de partícula. */
const ELEMENT_KIND: Record<number, number> = {
  [Item.Smoke]: Puff.Smoke, [Item.Steam]: Puff.Steam, [Item.Fire]: Puff.Fire, [Item.Fountain]: Puff.Fountain,
  [Item.Dust]: Puff.Dust, [Item.Soot]: Puff.Soot, [Item.Sparks]: Puff.Sparks, [Item.Spray]: Puff.Spray, [Item.Mist]: Puff.Mist,
};
