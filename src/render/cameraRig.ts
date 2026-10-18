// Câmera de construtor de cidades: perspectiva (livre ou de cima) e isométrica.
// Gira, arrasta pelo chão e aproxima até o cursor, da vista do mapa inteiro
// até a altura de uma pessoa na calçada.
//
// Como a do roadcraft (`view/cameraMotion.ts`): o estado (alvo, rumo, inclinação, distância) é a verdade e a
// câmera é refeita dele a cada quadro; a suavização fica nas ENTRADAS (velocidade das teclas, zoom e giro
// pendentes), nunca numa câmera "atrás" do estado. O ponto do chão agarrado (arrasto) ou sob o cursor (roda) fica
// exatamente sob o cursor em cada quadro. Antes, o alvo pulava para o fim e a distância vinha suavizando atrás:
// o ponto sob o cursor escorregava e voltava a cada giro da roda (a imagem "tremia").

import * as THREE from 'three/webgpu';
import { MAP_HALF } from '../config.ts';
import { heightAt } from '../world/heights.ts';

export type ViewMode = 'persp' | 'iso';

const MIN_DIST = 2.5;
const MAX_DIST = Math.max(16000, MAP_HALF * 3);
const MIN_PITCH = THREE.MathUtils.degToRad(2);
const MAX_PITCH = THREE.MathUtils.degToRad(89.5);
const ISO_PITCH = THREE.MathUtils.degToRad(30);
const EYE = 1.6;

/** Teclas: quanto tempo a velocidade leva para chegar e para parar (constante de tempo, s). */
const EASE_S = 0.1;
/** Um giro da roda é gasto nesta constante de tempo (s). */
const ZOOM_EASE_S = 0.085;
/** Giro de 45° do isométrico (Q/E) e o norte da bússola. */
const TURN_EASE_S = 0.12;
/** Altura do alvo acompanhando o chão (morros não dão tranco). */
const GROUND_EASE_S = 0.12;
/** Inércia ao soltar o arrasto: a velocidade cai nesta constante de tempo (s). */
const COAST_DECAY_S = 0.45;
/** Janela das amostras do arrasto para a velocidade ao soltar (ms). */
const FLING_MS = 100;
/** Velocidades das teclas: giro (rad/s), inclinação (rad/s), zoom (log por s). */
const TURN_PER_S = 1.6, TILT_PER_S = 1.2, ZOOM_PER_S = 2;

type Axis = 'fwd' | 'right' | 'turn' | 'tilt' | 'zoom';
const KEYS: Record<string, [Axis, 1 | -1]> = {
  KeyW: ['fwd', 1], ArrowUp: ['fwd', 1], KeyS: ['fwd', -1], ArrowDown: ['fwd', -1],
  KeyA: ['right', -1], ArrowLeft: ['right', -1], KeyD: ['right', 1], ArrowRight: ['right', 1],
  KeyQ: ['turn', 1], KeyE: ['turn', -1],
  KeyR: ['tilt', 1], KeyF: ['tilt', -1], PageUp: ['tilt', 1], PageDown: ['tilt', -1],
  Equal: ['zoom', 1], NumpadAdd: ['zoom', 1], Minus: ['zoom', -1], NumpadSubtract: ['zoom', -1],
};
const AXES: Axis[] = ['fwd', 'right', 'turn', 'tilt', 'zoom'];

/**
 * Inclinação que a câmera toma sozinha pela distância (roadcraft `cameraProfile.ts`): 48° de longe, quase na
 * horizontal (6°) na altura de quem anda na calçada. O zoom soma a diferença à inclinação do jogador.
 */
function profileTilt(dist: number): number {
  const half = dist * Math.tan(THREE.MathUtils.degToRad(22.5));
  const t = Math.min(1, Math.max(0, Math.log(Math.max(1e-6, half) / 1.2) / Math.log(80 / 1.2)));
  const k = t * t * (3 - 2 * t);
  return THREE.MathUtils.degToRad(6 + (48 - 6) * k);
}

export class CameraRig {
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  mode: ViewMode = 'persp';

  /** Estado: o alvo no chão, o rumo, a inclinação e a distância. A câmera é refeita disto a cada quadro. */
  readonly target = new THREE.Vector3(0, 0, 0);
  yaw = THREE.MathUtils.degToRad(35);
  pitch = THREE.MathUtils.degToRad(50);
  dist = 2200;
  /** Altura do alvo desenhada (segue o chão suavizada). */
  private y = 0;
  /** Inclinação desenhada: no isométrico vai para 30° suavizada. */
  private drawPitch = this.pitch;

  /** Altura do veículo seguido (null = alvo no chão). */
  followY: number | null = null;

  /** Topo do que é sólido no ponto (prédios), ou −∞: a câmera nunca fica dentro (puxada para a frente). */
  solid: ((x: number, z: number) => number) | null = null;
  /** Distância livre até o olho (suavizada): menor que `dist` quando um prédio está entre o alvo e o olho. */
  private pull = Infinity;

  /** Câmera atrás do veículo: alvo nele, olhando para onde ele vai. Refaz a câmera na hora (sem um quadro de atraso). */
  followPose(x: number, y: number, z: number, yaw: number, dt: number): void {
    this.target.set(x, y, z);
    let d = yaw + Math.PI - this.yaw;
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    // no primeiro quadro já fica atrás; depois acompanha as curvas pelo tempo (não por quadro)
    this.yaw += this.followY === null ? d : d * (1 - Math.exp(-dt * 2.5));
    this.followY = y;
    this.y = y;
    this.syncCamera();
  }

  /** Posição do olho (para LOD e seleção), também no modo isométrico. */
  readonly eye = new THREE.Vector3();
  private heights: Float32Array;
  private aspect = 1;
  private ray = new THREE.Raycaster();
  private v = new THREE.Vector3();
  private look = new THREE.Vector3();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private held = new Map<string, [Axis, 1 | -1]>();
  private shift = false;
  private vel: Record<Axis, number> = { fwd: 0, right: 0, turn: 0, tilt: 0, zoom: 0 };
  /** Zoom ainda por gastar (log do fator; > 0 afasta) e o ponto do chão que ele segura sob o cursor. */
  private pendingZoom = 0;
  private zoomNdc = new THREE.Vector2();
  private zoomGrab: THREE.Vector3 | null = null;
  /** Giro ainda por gastar (rad). */
  private pendingTurn = 0;
  /** Inércia do arrasto (m/s no chão). */
  private coast = new THREE.Vector2();
  private panSamples: Array<[number, number, number]> = [];

  constructor(heights: Float32Array) {
    this.heights = heights;
    this.persp = new THREE.PerspectiveCamera(45, 1, 0.2, 60000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 80000);
    this.target.y = heightAt(heights, 0, 0);
    this.y = this.target.y;
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.mode === 'iso' ? this.ortho : this.persp;
  }

  resize(w: number, h: number): void {
    this.aspect = w / Math.max(1, h);
    this.persp.aspect = this.aspect;
    this.persp.updateProjectionMatrix();
  }

  setMode(m: ViewMode): void {
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'iso') this.pendingTurn = Math.round(this.yaw / (Math.PI / 4)) * (Math.PI / 4) - this.yaw;
  }

  /** Vista de cima (perspectiva, olhando para baixo). */
  topDown(): void { this.mode = 'persp'; this.pitch = MAX_PITCH; }

  /** Gira suavemente até o rumo (bússola: norte). */
  turnTo(yaw: number): void {
    let d = yaw - this.yaw;
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.pendingTurn = d;
  }

  keyDown(code: string): void {
    if (code === 'ShiftLeft' || code === 'ShiftRight') { this.shift = true; return; }
    if (this.mode === 'iso' && (code === 'KeyQ' || code === 'KeyE')) {
      // isométrico: um oitavo de volta por toque, gasto suave
      this.pendingTurn += code === 'KeyQ' ? Math.PI / 4 : -Math.PI / 4;
      return;
    }
    const b = KEYS[code];
    if (b) { this.held.set(code, b); this.coast.set(0, 0); }
  }
  keyUp(code: string): void {
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.shift = false;
    this.held.delete(code);
  }
  clearKeys(): void { this.held.clear(); this.shift = false; }

  rotate(dx: number, dy: number): void {
    if (this.mode === 'iso') return;
    this.yaw -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, MIN_PITCH, MAX_PITCH);
    this.drawPitch = this.pitch;
    this.syncCamera();
  }

  /** Um giro da roda: aproxima (factor < 1) ou afasta, segurando o ponto do chão sob o cursor. */
  zoomAt(factor: number, ndcX: number, ndcY: number): void {
    // ponto novo (ou parado): agarra o chão sob o cursor; o que sobrou do giro anterior vai para ele
    if (this.pendingZoom === 0 || Math.hypot(ndcX - this.zoomNdc.x, ndcY - this.zoomNdc.y) > 0.004) {
      this.zoomNdc.set(ndcX, ndcY);
      this.zoomGrab = this.pick(ndcX, ndcY)?.clone() ?? null;
    }
    this.pendingZoom += Math.log(factor);
    this.coast.set(0, 0);
  }

  /** Arrasto pelo chão: o ponto agarrado acompanha o cursor, sem suavização. */
  private grab: THREE.Vector3 | null = null;
  beginPan(ndcX: number, ndcY: number): void {
    this.grab = this.pick(ndcX, ndcY)?.clone() ?? null;
    this.coast.set(0, 0);
    this.panSamples.length = 0;
  }
  pan(ndcX: number, ndcY: number): void {
    if (!this.grab) return;
    this.hold(this.grab, ndcX, ndcY);
    const now = performance.now();
    this.panSamples.push([now, this.target.x, this.target.z]);
    while (this.panSamples.length > 2 && now - this.panSamples[0][0] > FLING_MS) this.panSamples.shift();
  }
  endPan(): void {
    this.grab = null;
    // inércia: velocidade pelos mínimos quadrados das amostras dos últimos 100 ms
    const s = this.panSamples, now = performance.now();
    const recent = s.filter((p) => now - p[0] <= FLING_MS);
    this.coast.set(0, 0);
    if (recent.length >= 3) {
      const n = recent.length;
      let mt = 0, mx = 0, mz = 0;
      for (const [t, x, z] of recent) { mt += t; mx += x; mz += z; }
      mt /= n; mx /= n; mz /= n;
      let stt = 0, stx = 0, stz = 0;
      for (const [t, x, z] of recent) { const dt = t - mt; stt += dt * dt; stx += dt * (x - mx); stz += dt * (z - mz); }
      if (stt > 1e-6) {
        this.coast.set(stx / stt * 1000, stz / stt * 1000);
        // inércia só de um gesto rápido (um arrasto lento que parou não desliza)
        if (this.coast.length() < this.dist * 0.15) this.coast.set(0, 0);
      }
    }
    s.length = 0;
  }

  /** Move o alvo para o ponto do chão `p` ficar sob a coordenada de tela (duas passadas: o chão sob o alvo muda). */
  private hold(p: THREE.Vector3, ndcX: number, ndcY: number): void {
    for (let pass = 0; pass < 2; pass++) {
      this.syncCamera();
      this.ray.setFromCamera(this.ndc.set(ndcX, ndcY), this.camera);
      this.plane.constant = -p.y;
      const q = this.ray.ray.intersectPlane(this.plane, this.v);
      if (!q) return;
      this.target.x += p.x - q.x;
      this.target.z += p.z - q.z;
      this.clampTarget();
      if (this.followY === null) this.y = this.target.y = heightAt(this.heights, this.target.x, this.target.z);
    }
    this.syncCamera();
  }

  private clampTarget(): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x, -MAP_HALF, MAP_HALF);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -MAP_HALF, MAP_HALF);
  }

  /** Um quadro: teclas por velocidade suavizada com deslocamento exato no passo (não depende da taxa de quadros). */
  update(dt: number): void {
    const goal: Record<Axis, number> = { fwd: 0, right: 0, turn: 0, tilt: 0, zoom: 0 };
    for (const [axis, sign] of this.held.values()) goal[axis] += sign;
    const keep = Math.exp(-dt / EASE_S);
    const travel: Record<Axis, number> = { fwd: 0, right: 0, turn: 0, tilt: 0, zoom: 0 };
    for (const axis of AXES) {
      const g = Math.max(-1, Math.min(1, goal[axis])) * (this.shift ? 3 : 1);
      const v0 = this.vel[axis];
      travel[axis] = g * dt + (v0 - g) * EASE_S * (1 - keep);
      let v = g + (v0 - g) * keep;
      if (g === 0 && Math.abs(v) < 0.002) v = 0;
      this.vel[axis] = v;
    }
    if (travel.fwd !== 0 || travel.right !== 0) {
      const sp = Math.max(30, this.dist * 0.9);
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      const fx = travel.right * sp, fz = -travel.fwd * sp;
      this.target.x += fx * c + fz * s;
      this.target.z += -fx * s + fz * c;
      this.clampTarget();
    }
    // inércia do arrasto
    if (!this.grab && (this.coast.x !== 0 || this.coast.y !== 0)) {
      const k = Math.exp(-dt / COAST_DECAY_S);
      const f = COAST_DECAY_S * (1 - k);
      this.target.x += this.coast.x * f;
      this.target.z += this.coast.y * f;
      this.clampTarget();
      this.coast.multiplyScalar(k);
      if (this.coast.length() < 0.05) this.coast.set(0, 0);
    }
    if (this.mode !== 'iso') {
      this.yaw += travel.turn * TURN_PER_S;
      this.pitch = THREE.MathUtils.clamp(this.pitch + travel.tilt * TILT_PER_S, MIN_PITCH, MAX_PITCH);
    }
    if (this.pendingTurn !== 0) {
      const spend = Math.abs(this.pendingTurn) < 1e-4 ? this.pendingTurn : this.pendingTurn * (1 - Math.exp(-dt / TURN_EASE_S));
      this.pendingTurn -= spend;
      this.yaw += spend;
    }
    if (travel.zoom !== 0) this.setDist(this.dist * Math.exp(-travel.zoom * ZOOM_PER_S));

    // o alvo acompanha o chão (ou o veículo seguido, que pode estar numa ponte)
    if (this.followY === null) this.target.y = heightAt(this.heights, this.target.x, this.target.z);
    else this.target.y = this.followY;
    this.y += (this.target.y - this.y) * (1 - Math.exp(-dt / GROUND_EASE_S));
    const pitchGoal = this.mode === 'iso' ? ISO_PITCH : this.pitch;
    this.drawPitch += (pitchGoal - this.drawPitch) * (1 - Math.exp(-dt / TURN_EASE_S));

    // roda: gasta o zoom pendente segurando o ponto agarrado sob o mesmo lugar da tela
    if (this.pendingZoom !== 0) {
      const spend = Math.abs(this.pendingZoom) < 1e-4 ? this.pendingZoom : this.pendingZoom * (1 - Math.exp(-dt / ZOOM_EASE_S));
      this.pendingZoom -= spend;
      const before = this.dist;
      this.setDist(this.dist * Math.exp(spend));
      if (this.dist === before) this.pendingZoom = 0;
      if (this.zoomGrab && !this.grab && this.followY === null) { this.updatePull(dt); this.hold(this.zoomGrab, this.zoomNdc.x, this.zoomNdc.y); return; }
    }
    this.updatePull(dt);
    this.syncCamera();
  }

  /** Distância nova pelo zoom; a inclinação acompanha o perfil (perto do chão, a vista vai para a horizontal). */
  private setDist(d: number): void {
    const nd = THREE.MathUtils.clamp(d, MIN_DIST, MAX_DIST);
    if (this.mode !== 'iso' && this.followY === null) {
      this.pitch = THREE.MathUtils.clamp(this.pitch + profileTilt(nd) - profileTilt(this.dist), MIN_PITCH, MAX_PITCH);
      this.drawPitch = this.pitch;
    }
    this.dist = nd;
  }

  /**
   * Prédio entre o alvo e o olho (só perto: a vista de cima nunca entra): o olho vem para a frente dele.
   * Entra rápido (0,08 s) e volta devagar (0,35 s), para a imagem não pular ao passar pela quina.
   */
  private updatePull(dt: number): void {
    let want = Infinity;
    if (this.solid && this.mode !== 'iso' && this.dist < 320) {
      const cp = Math.cos(this.drawPitch), sp = Math.sin(this.drawPitch);
      const ux = Math.sin(this.yaw) * cp, uy = sp, uz = Math.cos(this.yaw) * cp;
      const lookY = this.y + Math.min(EYE, this.dist * 0.3);
      const N = 16;
      // alvo dentro de um prédio (apontando para ele): o raio começa lá dentro; só puxa num prédio depois que sai
      let leaving = lookY < this.solid(this.target.x, this.target.z) + 0.8;
      for (let i = 1; i <= N; i++) {
        const t = (this.dist * i) / N;
        const x = this.target.x + ux * t, z = this.target.z + uz * t, y = lookY + uy * t;
        const inside = y < this.solid(x, z) + 0.8;
        if (leaving) { leaving = inside; continue; }
        if (t < 3) continue;
        if (inside) { want = Math.max(MIN_DIST, t - this.dist / N - 1.5); break; }
      }
    }
    if (!Number.isFinite(want) && !Number.isFinite(this.pull)) return;
    const cur = Number.isFinite(this.pull) ? this.pull : this.dist;
    const goal = Number.isFinite(want) ? want : this.dist;
    const tau = goal < cur ? 0.08 : 0.35;
    const next = cur + (goal - cur) * (1 - Math.exp(-dt / tau));
    this.pull = !Number.isFinite(want) && next > this.dist - 0.05 ? Infinity : next;
  }

  private syncCamera(): void {
    const pitch = this.drawPitch, yaw = this.yaw, dist = Math.min(this.dist, this.pull);
    const tx = this.target.x, ty = this.y, tz = this.target.z;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const dir = this.v.set(Math.sin(yaw) * cp, sp, Math.cos(yaw) * cp); // do alvo para o olho
    this.eye.set(tx + dir.x * dist, ty + dir.y * dist, tz + dir.z * dist);
    // nunca abaixo do chão: no mínimo na altura dos olhos
    const g = heightAt(this.heights, this.eye.x, this.eye.z) + EYE;
    if (this.eye.y < g) this.eye.y = g;
    const look = this.look.set(tx, ty + Math.min(EYE, dist * 0.3), tz);

    const p = this.persp;
    p.position.copy(this.eye);
    p.lookAt(look);
    p.updateMatrixWorld();

    // isométrica: perto do que se vê, com a faixa de profundidade justa (antes ficava a 30 km com 50 km de
    // faixa: ~3 mm de resolução e as camadas finas brigavam)
    const o = this.ortho;
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    o.top = halfH; o.bottom = -halfH; o.left = -halfH * this.aspect; o.right = halfH * this.aspect;
    const reach = halfH * Math.max(1, this.aspect) * 3 + 1200;
    o.position.set(tx + dir.x * reach, ty + dir.y * reach, tz + dir.z * reach);
    o.lookAt(tx, ty, tz);
    o.near = 1; o.far = reach * 2;
    o.updateProjectionMatrix();
    o.updateMatrixWorld();
  }

  /** Ponto do terreno sob a coordenada de tela normalizada (-1..1). */
  pick(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const cam = this.camera;
    this.ray.setFromCamera(this.ndc.set(ndcX, ndcY), cam);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    const h = this.heights;
    // passo adaptativo pela folga até o chão, depois bisseção
    let t = 0, prev = 0;
    for (let i = 0; i < 400 && t < 60000; i++) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const gap = y - heightAt(h, x, z);
      if (gap <= 0) {
        let lo = prev, hi = t;
        for (let j = 0; j < 20; j++) {
          const m = (lo + hi) / 2;
          if (o.y + d.y * m - heightAt(h, o.x + d.x * m, o.z + d.z * m) > 0) lo = m; else hi = m;
        }
        return new THREE.Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
      }
      prev = t;
      t += Math.max(0.5, t * 0.002, gap * 0.5);
    }
    // não tocou: plano na altura do alvo
    if (Math.abs(d.y) < 1e-6) return null;
    const tp = (this.target.y - o.y) / d.y;
    return tp > 0 ? new THREE.Vector3(o.x + d.x * tp, this.target.y, o.z + d.z * tp) : null;
  }

  /** Estado para salvar. */
  state(): Float64Array {
    return new Float64Array([this.target.x, this.target.z, this.yaw, this.pitch, this.dist, this.mode === 'iso' ? 1 : 0]);
  }

  restore(s: Float64Array): void {
    this.target.set(s[0], heightAt(this.heights, s[0], s[1]), s[1]);
    this.yaw = s[2]; this.pitch = s[3]; this.dist = s[4];
    this.mode = s[5] === 1 ? 'iso' : 'persp';
    this.y = this.target.y;
    this.drawPitch = this.mode === 'iso' ? ISO_PITCH : this.pitch;
    this.pendingZoom = 0; this.pendingTurn = 0; this.coast.set(0, 0); this.pull = Infinity;
    for (const a of AXES) this.vel[a] = 0;
    this.syncCamera();
  }
}
