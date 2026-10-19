// Signs with text written by the player (street name, information, direction…). There are few, so
// each one is a small plate with a canvas texture (cached per text), above the sign's post.
// The list is rebuilt only when the camera moves or the texts change, by a query on the items' index.

import * as THREE from 'three/webgpu';
import type { World } from '../world/world.ts';
import { Item } from '../world/items.ts';
import { heightAt } from '../world/heights.ts';

const RADIUS = 450;

/** A sign's position key (ids change on load; the position does not). */
export const signKey = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;

export class TextSigns {
  readonly group = new THREE.Group();
  private world: World;
  private texts: Map<string, string>;
  private cache = new Map<string, THREE.MeshBasicNodeMaterial>();
  private plane = new THREE.PlaneGeometry(1, 1);
  private lastX = Infinity;
  private lastZ = Infinity;
  private lastVer = -1;
  version = 0;

  constructor(world: World, texts: Map<string, string>) { this.world = world; this.texts = texts; }

  private material(text: string, street: boolean): THREE.MeshBasicNodeMaterial {
    const key = `${street ? 's' : 'i'}|${text}`;
    let m = this.cache.get(key);
    if (m) return m;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = street ? '#1f4f9a' : '#f2f2ee';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = street ? '#ffffff' : '#2a2d30'; g.lineWidth = 8; g.strokeRect(6, 6, 500, 116);
    g.fillStyle = street ? '#ffffff' : '#1d2329';
    let size = 64;
    g.font = `700 ${size}px sans-serif`;
    while (g.measureText(text).width > 470 && size > 24) { size -= 4; g.font = `700 ${size}px sans-serif`; }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    m = new THREE.MeshBasicNodeMaterial({ map: tex });
    this.cache.set(key, m);
    return m;
  }

  update(eye: THREE.Vector3): void {
    if (this.version === this.lastVer && Math.hypot(eye.x - this.lastX, eye.z - this.lastZ) < 60) return;
    this.lastVer = this.version; this.lastX = eye.x; this.lastZ = eye.z;
    // the plane and the materials are shared; the meshes are made again, so each old one is disposed
    for (const c of [...this.group.children]) { this.group.remove(c); (c as THREE.Mesh).dispose(); }
    const it = this.world.items, c = it.t.cols;
    it.index.query(eye.x - RADIUS, eye.z - RADIUS, eye.x + RADIUS, eye.z + RADIUS, (i) => {
      if (c.type[i] !== Item.Sign) return;
      const text = this.texts.get(signKey(c.x0[i], c.z0[i]));
      if (!text) return;
      const street = c.variant[i] === 2;
      const y = (c.z1[i] !== 0 ? c.z1[i] : heightAt(this.world.heights, c.x0[i], c.z0[i])) + (street ? 2.75 : 2.35);
      // front and back (the text reads right from both sides)
      for (const turn of [0, Math.PI]) {
        const m = new THREE.Mesh(this.plane, this.material(text, street));
        m.position.set(c.x0[i], y, c.z0[i]);
        m.rotation.y = c.x1[i] + turn;
        m.scale.set(1.9, 0.48, 1);
        this.group.add(m);
      }
    });
  }

  /** A sample material (compiles at load). */
  warmup(): THREE.Mesh {
    const m = new THREE.Mesh(this.plane, this.material('Rua', true));
    m.position.set(0, -5000, 0);
    return m;
  }
}
