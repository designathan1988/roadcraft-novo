// Real building destruction: the drawn shell, floor slabs and interior partitions are cut into Voronoi fragments in a
// worker. The standing fragments stay in one still mesh per ruin; the pieces hit by the blast are cut out and fall,
// unsupported pieces come down, and below 35 % standing the rest collapses. Rubble stays in the still mesh.
import * as THREE from 'three/webgpu';
import { fractureData, fragmentGeometry, type FractureInput, type Fragment, type StillData } from './fracture.ts';

const GRAVITY = 9.8;
const MAX_RUINS = 8;
const RELEASE_FRAME = 64;
const COLLAPSE_BELOW = 0.35;
const EMPTY = new THREE.BufferGeometry();

interface Piece {
  readonly index: number;
  readonly fragment: Fragment;
  readonly mesh: THREE.Mesh;
  readonly slots: Int32Array;
  v: THREE.Vector3;
  w: THREE.Vector3;
  falling: boolean;
  settled: boolean;
}

interface Ruin {
  readonly still: THREE.Mesh;
  readonly data: StillData;
  readonly pieces: Piece[];
  readonly floor: number;
  standing: number;
}

interface Pending {
  input: FractureInput;
  floor: number;
  x: number; y: number; z: number; force: number;
}

export class Destruction {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide });
  private readonly ruins: Ruin[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Array<{ ruin: Ruin; piece: Piece; from: THREE.Vector3; power: number }> = [];
  private worker: Worker | null = null;
  private next = 1;

  constructor() {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./fractureWorker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<{ id: number; still?: StillData; error?: string }>) => {
          const job = this.pending.get(e.data.id);
          if (!job) return;
          this.pending.delete(e.data.id);
          if (!e.data.still) { console.error('[fracture]', e.data.error ?? 'no pieces'); return; }
          this.add(e.data.still, job);
        };
      } catch (error) {
        console.error('[fracture worker]', error);
        this.worker = null;
      }
    }
  }

  /** Builds a ruin from the real shell; the worker cuts it, with a synchronous fallback for tests and browsers without one. */
  spawn(input: FractureInput, floor: number, x: number, y: number, z: number, force: number): void {
    const id = this.next++;
    const job = { input, floor, x, y, z, force };
    if (this.worker) {
      this.pending.set(id, job);
      const transfer = [input.position.buffer as ArrayBuffer, input.normal.buffer as ArrayBuffer, input.colour.buffer as ArrayBuffer, input.index.buffer as ArrayBuffer];
      this.worker.postMessage({ id, input }, transfer);
    } else { console.log('[wreck] sync spawn', input.position.length / 3); this.add(fractureData(input), job); }
  }

  private add(data: StillData, job: Pending): void {
    if (!data.fragments.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    g.setAttribute('color', new THREE.BufferAttribute(data.colour, 3));
    g.computeBoundingSphere();
    const still = new THREE.Mesh(g, this.material);
    still.castShadow = true; still.receiveShadow = true;
    this.group.add(still);
    const pieces: Piece[] = data.fragments.map((fragment, index) => {
      const mesh = new THREE.Mesh(EMPTY, this.material);
      mesh.position.set(fragment.centre[0], fragment.centre[1], fragment.centre[2]);
      mesh.castShadow = true; mesh.receiveShadow = true;
      return { index, fragment, mesh, slots: data.slots[index]!, v: new THREE.Vector3(), w: new THREE.Vector3(), falling: false, settled: false };
    });
    const ruin: Ruin = { still, data, pieces, floor: job.floor, standing: pieces.length };
    this.ruins.push(ruin);
    while (this.ruins.length > MAX_RUINS) this.drop(this.ruins.shift()!);
    this.hit(ruin, job.x, job.y, job.z, job.force);
  }

  /** A blow: pieces in reach are released, and what does not hang on standing pieces follows. */
  private hit(ruin: Ruin, x: number, y: number, z: number, force: number): void {
    const reach = 4 + force * 0.8, power = 2 + force * 1.1;
    const at = new THREE.Vector3(x, y, z);
    for (const p of ruin.pieces) {
      if (p.falling) continue;
      const d = p.mesh.position.distanceTo(at) - p.fragment.radius * 0.5;
      if (d < reach) this.queue.push({ ruin, piece: p, from: at, power: power * Math.max(0.3, 1 - d / reach) });
    }
    this.unsupported(ruin);
    const upper = ruin.pieces.filter((p) => p.fragment.centre[1] > ruin.floor + 0.6);
    if (upper.filter((p) => !p.falling).length < upper.length * COLLAPSE_BELOW) {
      for (const p of ruin.pieces) if (!p.falling) this.queue.push({ ruin, piece: p, from: at, power: 0.7 });
    }
  }

  /** Pieces not joined to the ground through standing pieces fall as well. */
  private unsupported(ruin: Ruin): void {
    const held = new Uint8Array(ruin.pieces.length), stack: number[] = [];
    ruin.pieces.forEach((p, i) => { if (!p.falling && p.fragment.low <= ruin.floor + 0.6) { held[i] = 1; stack.push(i); } });
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of ruin.pieces[i]!.fragment.neighbours) if (!held[j] && !ruin.pieces[j]!.falling) { held[j] = 1; stack.push(j); }
    }
    ruin.pieces.forEach((p, i) => { if (!p.falling && !held[i]) this.queue.push({ ruin, piece: p, from: p.mesh.position.clone().add(new THREE.Vector3(0, 1, 0)), power: 0.55 }); });
  }

  private release(ruin: Ruin, p: Piece, from: THREE.Vector3, power: number): void {
    if (p.falling) return;
    p.falling = true; ruin.standing--;
    p.mesh.geometry = fragmentGeometry(ruin.data, p.index);
    this.group.add(p.mesh);
    const away = p.mesh.position.clone().sub(from);
    const d = away.length() || 1;
    away.divideScalar(d);
    p.v.copy(away).multiplyScalar(power * (0.5 + Math.random() * 0.6));
    p.v.y += power * 0.25 * Math.random();
    p.w.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3).multiplyScalar(0.4 + power / 10);
    // blank the standing copy of this piece
    const pos = ruin.still.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array, [cx, cy, cz] = p.fragment.centre;
    for (let s = 0; s < p.slots.length; s += 2) for (let i = p.slots[s]!; i < p.slots[s]! + p.slots[s + 1]!; i++) { a[i * 3] = cx; a[i * 3 + 1] = cy; a[i * 3 + 2] = cz; }
    pos.needsUpdate = true;
  }

  private land(ruin: Ruin, p: Piece): void {
    const still = ruin.still.geometry.getAttribute('position') as THREE.BufferAttribute, normal = ruin.still.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const sp = p.mesh.geometry.getAttribute('position') as THREE.BufferAttribute, sn = p.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    p.mesh.updateMatrix();
    const nm = new THREE.Matrix3().getNormalMatrix(p.mesh.matrix), v = new THREE.Vector3(), n = new THREE.Vector3();
    let from = 0;
    for (let s = 0; s < p.slots.length; s += 2) {
      const start = p.slots[s]!, count = p.slots[s + 1]!;
      for (let k = 0; k < count; k++, from++) {
        const o = start + k;
        v.fromBufferAttribute(sp, from).applyMatrix4(p.mesh.matrix); (still.array as Float32Array)[o * 3] = v.x; (still.array as Float32Array)[o * 3 + 1] = v.y; (still.array as Float32Array)[o * 3 + 2] = v.z;
        n.fromBufferAttribute(sn, from).applyMatrix3(nm).normalize(); (normal.array as Float32Array)[o * 3] = n.x; (normal.array as Float32Array)[o * 3 + 1] = n.y; (normal.array as Float32Array)[o * 3 + 2] = n.z;
      }
    }
    still.needsUpdate = true; normal.needsUpdate = true;
    this.group.remove(p.mesh);
    p.mesh.geometry.dispose(); p.mesh.geometry = EMPTY;
    p.settled = true;
  }

  update(dt: number): void {
    let done = 0;
    while (this.queue.length && done++ < RELEASE_FRAME) {
      const q = this.queue.shift()!;
      this.release(q.ruin, q.piece, q.from, q.power);
    }
    for (const ruin of this.ruins) {
      for (const p of ruin.pieces) {
        if (!p.falling || p.settled) continue;
        p.v.y -= GRAVITY * dt;
        p.mesh.position.addScaledVector(p.v, dt);
        p.mesh.rotation.x += p.w.x * dt; p.mesh.rotation.y += p.w.y * dt; p.mesh.rotation.z += p.w.z * dt;
        const rest = ruin.floor + p.fragment.radius * 0.3;
        if (p.mesh.position.y <= rest) { p.mesh.position.y = rest; p.v.set(0, 0, 0); p.w.set(0, 0, 0); this.land(ruin, p); }
      }
    }
  }

  private drop(ruin: Ruin): void {
    for (const p of ruin.pieces) if (p.mesh.geometry !== EMPTY) p.mesh.geometry.dispose();
    this.group.remove(ruin.still); ruin.still.geometry.dispose();
    for (const p of ruin.pieces) this.group.remove(p.mesh);
  }

  dispose(): void {
    for (const r of this.ruins) this.drop(r);
    this.ruins.length = 0; this.pending.clear(); this.queue.length = 0;
    this.worker?.terminate(); this.worker = null;
  }
}
