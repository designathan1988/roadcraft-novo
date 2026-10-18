// Tempo: nuvens (uma camada de ruído no céu), chuva (riscos instanciados em
// volta da câmera, animados só no shader), chão molhado, estrelas e lua à
// noite. O estado muda devagar sozinho; tudo vem de poucos uniformes.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { colorOnly } from './post.ts';

const {
  uniform, vec2, vec3, vec4, float, mix, smoothstep, clamp, positionWorld, positionLocal, time, mx_fractal_noise_float,
  instanceIndex, hash, fract, cameraPosition, normalize, cross, sRGBTransferEOTF, attribute, sin, step,
} = T;

/** 0 céu limpo .. 1 encoberto. */
export const cloudsU = uniform(0.25);
/** 0 seco .. 1 chuva forte. */
export const rainU = uniform(0);
/** Chão molhado (sobe com a chuva, seca devagar). */
export const wetU = uniform(0);
/** 0 calmo .. 1 vendaval (chuva inclinada, árvores balançando). */
export const windU = uniform(0.2);
/** Para onde o vento sopra (x, z), para a chuva inclinar. */
export const windDirU = uniform(new THREE.Vector2(0.91, 0.41));
/** Clarão do relâmpago (0..1, cai em décimos de segundo). */
export const flashU = uniform(0);

const RAIN_DROPS = 14000;
/** Raio: 40 trechos, cada um com 4 triângulos (borda, miolo, borda: o miolo brilha, as bordas são o halo). */
const BOLT_SEGS = 40;
const BOLT_VERTS = BOLT_SEGS * 12;
const RAIN_BOX = 70;
/** Altura da camada de nuvens. */
const CLOUD_Y = 2200;

export class Weather {
  readonly group = new THREE.Group();
  private rng = Math.random;
  /** Alvos que o tempo persegue devagar. */
  private target = { clouds: 0.25, rain: 0, wind: 0.2, storm: 0 };
  /** Tempestade atual (0..1): relâmpagos e vento forte. */
  storm = 0;
  private strikeIn = 6;
  private flashT = 1;
  private bolt: THREE.Mesh;
  private clouds: THREE.Mesh;
  private rain: THREE.Mesh;
  private skirt: THREE.Mesh;
  /** Cor da neblina (linear), copiada a cada quadro. */
  private horizonU = uniform(new THREE.Color(0xb9cbdc));
  private boltPos: THREE.BufferAttribute;
  /** Direção para onde a câmera olha (ângulo no plano, como atan2(z, x)). */
  viewAngle = 0;
  /** Raio caiu: distância até a câmera (para o trovão). */
  onStrike: ((dist: number) => void) | null = null;
  private timer = 0;
  private eyeU = uniform(new THREE.Vector3());
  /** Raios por minuto escolhidos pelo jogador (0 = os da tempestade, sozinhos). */
  lightningRate = 0;
  /** Vento escolhido pelo jogador (0..1), ou null para o do tempo. */
  windFixed: number | null = null;
  /** Fixo pela opção (null = muda sozinho). */
  fixed: { clouds: number; rain: number; storm?: number } | null = null;

  constructor() {
    // nuvens: plano alto, ruído que anda com o vento
    const cm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const p = positionWorld.xz.div(2600).add(vec2(time.mul(0.004), time.mul(0.0015)));
    const n = mx_fractal_noise_float(vec3(p.x, p.y, time.mul(0.002)), 4, 2, 0.5).mul(0.5).add(0.5);
    const cover = cloudsU.mul(0.9);
    const a = smoothstep(float(1).sub(cover), float(1.15).sub(cover.mul(0.6)), n);
    const day = float(1).sub(nightU);
    const light = mix(vec3(0.12, 0.13, 0.16), vec3(0.96, 0.96, 0.97), day).mul(mix(float(1), float(0.62), rainU));
    // câmera subindo para perto da camada (vista geral de mapas grandes): as nuvens somem
    const below = float(1).sub(smoothstep(float(CLOUD_Y - 1000), float(CLOUD_Y - 250), cameraPosition.y));
    cm.colorNode = vec4(sRGBTransferEOTF(light).add(vec3(0.9, 0.92, 1).mul(flashU.mul(3))), clamp(a.mul(mix(float(0.85), float(1), rainU)).mul(below), 0, 0.97));
    cm.fog = true;
    const clouds = this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000).rotateX(-Math.PI / 2), cm);
    clouds.position.y = CLOUD_Y;
    clouds.frustumCulled = false;
    clouds.renderOrder = -10;
    this.group.add(clouds);

    // chuva: riscos finos, posição pelo índice; caem e dão a volta numa caixa que segue a câmera
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(0.018, 0.9);
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    g.instanceCount = RAIN_DROPS;
    const rm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    const id = instanceIndex.toFloat();
    const hx = hash(id), hz = hash(id.add(7.31)), hy = hash(id.add(3.17));
    // cada gota fica parada no mundo (caindo) e dá a volta numa caixa em torno da câmera
    const base = vec3(hx, hy, hz).mul(RAIN_BOX).sub(vec3(0, time.mul(9), 0));
    const center = this.eyeU.add(fract(base.sub(this.eyeU).div(RAIN_BOX)).sub(0.5).mul(RAIN_BOX));
    const toCam = normalize(cameraPosition.sub(center));
    const side = normalize(cross(vec3(0, 1, 0), toCam));
    const wind = vec3(windDirU.x, 0, windDirU.y).mul(positionLocal.y);
    rm.positionNode = center.add(side.mul(positionLocal.x)).add(vec3(0, positionLocal.y, 0)).add(wind.mul(windU.mul(1.4).add(0.1)));
    // só uma fração das gotas aparece, pela força da chuva
    const shown = step(hash(id.add(1.1)), rainU);
    // gota colada na câmera vira um risco enorme: some perto
    const near = smoothstep(float(3), float(8), cameraPosition.distance(center));
    rm.colorNode = vec4(0.75, 0.78, 0.82, shown.mul(0.32).mul(near));
    rm.fog = true;
    const rain = this.rain = new THREE.Mesh(g, rm);
    rain.frustumCulled = false;
    rain.renderOrder = 20;
    this.group.add(rain);

    // estrelas: quadradinhos virados para a câmera numa esfera enorme
    const sg = new THREE.InstancedBufferGeometry();
    const sq = new THREE.PlaneGeometry(1, 1);
    sg.index = sq.index;
    sg.setAttribute('position', sq.attributes.position);
    const N = 2500;
    const dirs = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const u = this.rng() * 2 - 1, t = this.rng() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      dirs[i * 4] = r * Math.cos(t); dirs[i * 4 + 1] = Math.abs(u) * 0.95 + 0.05; dirs[i * 4 + 2] = r * Math.sin(t);
      dirs[i * 4 + 3] = 0.5 + this.rng() * this.rng() * 2.2;
    }
    sg.setAttribute('sdir', new THREE.InstancedBufferAttribute(dirs, 4));
    sg.instanceCount = N;
    const sm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    const sd = attribute('sdir', 'vec4');
    const R = 40000;
    const sc = cameraPosition.add(sd.xyz.mul(R));
    const tc = normalize(cameraPosition.sub(sc));
    const sx = normalize(cross(vec3(0, 1, 0), tc));
    const sy = cross(tc, sx);
    const size = sd.w.mul(R * 0.0011);
    sm.positionNode = sc.add(sx.mul(positionLocal.x.mul(size))).add(sy.mul(positionLocal.y.mul(size)));
    const twinkle = sin(time.mul(2.3).add(sd.x.mul(91))).mul(0.25).add(0.75);
    sm.colorNode = vec4(1, 1, 1, nightU.mul(float(1).sub(cloudsU)).mul(twinkle).mul(clamp(sd.w.mul(0.6), 0.25, 1)));
    sm.fog = false;
    const stars = new THREE.Mesh(sg, sm);
    stars.frustumCulled = false;
    stars.renderOrder = -900;
    this.group.add(stars);

    // saia do horizonte: com céu encoberto, a faixa entre a borda das nuvens e o horizonte
    // fica da cor da neblina (senão aparece o céu claro por baixo da camada de nuvens)
    const hm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide }));
    hm.colorNode = vec4(this.horizonU, smoothstep(float(0.45), float(0.9), cloudsU).mul(0.97));
    hm.fog = false;
    this.skirt = new THREE.Mesh(new THREE.CylinderGeometry(52000, 52000, 3200, 48, 1, true).translate(0, 1300, 0), hm);
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = -950;
    this.group.add(this.skirt);

    // raio: fita em zigue-zague refeita a cada descarga (64 trechos), brilho acima de 1 para o bloom pegar
    const bg = new THREE.BufferGeometry();
    this.boltPos = new THREE.BufferAttribute(new Float32Array(BOLT_VERTS * 3), 3);
    this.boltPos.setUsage(THREE.DynamicDrawUsage);
    bg.setAttribute('position', this.boltPos);
    // miolo (1) e borda (0) de cada vértice: o mesmo padrão em todos os trechos
    const core = new Float32Array(BOLT_VERTS);
    const pattern = [0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1];
    for (let i = 0; i < BOLT_VERTS; i++) core[i] = pattern[i % 12];
    bg.setAttribute('core', new THREE.BufferAttribute(core, 1));
    const bm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const glow = attribute('core', 'float');
    // miolo branco acima de 1 (o bloom faz o resto); bordas azuladas que somem: halo largo o bastante para não
    // sumir na suavização temporal, que dilui linhas de um pixel que duram poucos quadros
    bm.colorNode = vec4(mix(vec3(1.2, 1.4, 2.4), vec3(6, 6.2, 7), glow.mul(glow)).mul(flashU), clamp(flashU.mul(1.5), 0, 1).mul(glow.mul(glow).mul(0.85).add(0.15)));
    bm.fog = false;
    this.bolt = new THREE.Mesh(bg, bm);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.bolt.renderOrder = 25;
    this.group.add(this.bolt);
  }

  /** Monta o raio de uma nuvem até o chão perto de (x, z), em fita virada para a câmera. */
  private strike(eye: THREE.Vector3, ground: number, front = false, at: [number, number] | null = null): void {
    // metade das descargas cai à frente da câmera (as outras só se ouvem); ou onde o jogador clicou
    const a = at ? Math.atan2(at[1] - eye.z, at[0] - eye.x) : front || this.rng() < 0.5 ? this.viewAngle + (this.rng() - 0.5) * 1.2 : this.rng() * Math.PI * 2;
    const d = at ? Math.hypot(at[0] - eye.x, at[1] - eye.z) : 700 + this.rng() * 3300;
    const x = at ? at[0] : eye.x + Math.cos(a) * d, z = at ? at[1] : eye.z + Math.sin(a) * d;
    const top = ground + 1300 + this.rng() * 500;
    const p = this.boltPos.array as Float32Array;
    // lado da fita: perpendicular à direção da câmera
    const sx = -Math.sin(a), sz = Math.cos(a);
    let cx = x + (this.rng() - 0.5) * (at ? 120 : 300), cz = z + (this.rng() - 0.5) * (at ? 120 : 300);
    const segs = BOLT_SEGS;
    // halo mais largo de longe (alguns pixels na tela até a 4 km)
    const width = 6 + d * 0.004;
    let k = 0;
    for (let i = 0; i < segs; i++) {
      const y0 = top + (ground - top) * (i / segs), y1 = top + (ground - top) * ((i + 1) / segs);
      const t = (i + 1) / segs;
      const nx = i === segs - 1 ? x : cx + (this.rng() - 0.5) * 60 + (x - cx) * 0.12 * t;
      const nz = i === segs - 1 ? z : cz + (this.rng() - 0.5) * 60 + (z - cz) * 0.12 * t;
      const w0 = width * (1 - 0.4 * (i / segs)), w1 = width * (1 - 0.4 * t);
      // esquerda-miolo e miolo-direita (padrão de miolo/borda no atributo 'core')
      const L0 = [cx - sx * w0, y0, cz - sz * w0], C0 = [cx, y0, cz], R0 = [cx + sx * w0, y0, cz + sz * w0];
      const L1 = [nx - sx * w1, y1, nz - sz * w1], C1 = [nx, y1, nz], R1 = [nx + sx * w1, y1, nz + sz * w1];
      p.set([...L0, ...C0, ...C1, ...L0, ...C1, ...L1, ...C0, ...R0, ...R1, ...C0, ...R1, ...C1], k); k += 36;
      cx = nx; cz = nz;
    }
    this.boltPos.needsUpdate = true;
    this.bolt.visible = true;
    this.flashT = 0;
    this.onStrike?.(Math.hypot(x - eye.x, z - eye.z, ground - eye.y));
  }

  /** Força uma descarga (api e fotos). */
  strikeNow(eye: THREE.Vector3, ground: number): void { this.strike(eye, ground, true); }

  /** Raio no ponto (x, z) do chão (clique do jogador). */
  strikeAt(eye: THREE.Vector3, x: number, z: number, ground: number): void { this.strike(eye, ground, false, [x, z]); }

  /** Muda o tempo devagar; molha e seca o chão. */
  update(dt: number, gameDt: number, eye: THREE.Vector3, ground = 0, fog?: THREE.Color): void {
    this.eyeU.value.copy(eye);
    // sem chuva, os riscos nem são desenhados; acima da camada, as nuvens também não
    this.rain.visible = rainU.value > 0.003;
    this.clouds.visible = eye.y < CLOUD_Y - 250;
    this.skirt.position.set(eye.x, 0, eye.z);
    if (fog) (this.horizonU.value as THREE.Color).copy(fog);
    // clarão: pisca duas vezes e some
    this.flashT += dt;
    const f = this.flashT;
    flashU.value = f < 0.08 ? 1 : f < 0.14 ? 0.25 : f < 0.22 ? 0.85 : Math.max(0, 0.85 - (f - 0.22) * 4);
    if (flashU.value <= 0) this.bolt.visible = false;
    if (this.lightningRate > 0 || this.storm > 0.3) {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) {
        this.strikeIn = this.lightningRate > 0 ? (60 / this.lightningRate) * (0.5 + this.rng()) : 3 + this.rng() * 14 / this.storm;
        this.strike(eye, ground);
      }
    }
    if (this.fixed) {
      // tempo fixo (opção ou foto): já chega pronto
      cloudsU.value = this.fixed.clouds; rainU.value = this.fixed.rain; wetU.value = this.fixed.rain > 0 ? 1 : 0;
      this.storm = this.fixed.storm ?? 0;
      windU.value = this.windFixed ?? 0.2 + this.storm * 0.8;
      return;
    }
    {
      this.timer -= gameDt;
      if (this.timer <= 0) {
        // a cada 1 a 3 horas de jogo, um tempo novo
        this.timer = 3600 * (1 + this.rng() * 2);
        const r = this.rng();
        const w = this.rng();
        this.target = r < 0.55 ? { clouds: 0.1 + this.rng() * 0.3, rain: 0, wind: w * 0.4, storm: 0 }
          : r < 0.8 ? { clouds: 0.55 + this.rng() * 0.3, rain: 0, wind: 0.2 + w * 0.5, storm: 0 }
          : r < 0.93 ? { clouds: 0.9, rain: 0.4 + this.rng() * 0.6, wind: 0.3 + w * 0.4, storm: 0 }
          : { clouds: 1, rain: 0.9, wind: 0.8 + w * 0.2, storm: 1 };
      }
    }
    const k = Math.min(1, dt * 0.08);
    cloudsU.value += (this.target.clouds - cloudsU.value) * k;
    rainU.value += (this.target.rain - rainU.value) * k;
    windU.value += ((this.windFixed ?? this.target.wind) - windU.value) * k;
    this.storm += (this.target.storm - this.storm) * k;
    wetU.value = rainU.value > 0.05 ? Math.min(1, wetU.value + dt * 0.05) : Math.max(0, wetU.value - dt * 0.004);
  }
}

/** Vias e calçadas molhadas: mais escuras e mais lisas. */
export function wetLook(color: Node, rough: Node): [Node, Node] {
  return [color.mul(mix(float(1), float(0.62), wetU)), mix(rough, float(0.22), wetU.mul(0.8))];
}
