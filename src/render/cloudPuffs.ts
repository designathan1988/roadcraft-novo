// Player's clouds: each cloud (x, z, base height, size, density) becomes a cluster of
// camera-facing puffs. The list is small (up to 24) and goes in a texture; the puffs
// exist only in the shader (position from the index), like the rain and the particles.

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';
import { nightU } from './scene.ts';
import { colorOnly } from './tsl.ts';
import { flashU, windU } from './weather.ts';
import { CLOUD_DATA, CLOUD_TEX, MAX_CLOUDS, cloudCountU } from './cloudShadow.ts';

const {
  vec3, vec4, float, int, ivec2, smoothstep, textureLoad, time, instanceIndex, hash, cameraPosition, normalize, cross,
  positionLocal, uv, length, mix, floor, sRGBTransferEOTF, mx_noise_float, clamp,
} = T;

export interface Cloud { x: number; z: number; y: number; size: number; density: number }

export { MAX_CLOUDS } from './cloudShadow.ts';
const PUFFS = 64;

export class CloudPuffs {
  readonly mesh: THREE.Mesh;
  // the cloud list lives in cloudShadow.ts: the final image reads it for the clouds' shadows
  private tex = CLOUD_TEX;
  private data = CLOUD_DATA;
  private geo: THREE.InstancedBufferGeometry;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    g.index = q.index;
    g.setAttribute('position', q.attributes.position);
    g.setAttribute('uv', q.attributes.uv);
    g.instanceCount = 0;
    this.geo = g;
    const m = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    const id = instanceIndex.toFloat();
    const c = floor(id.div(PUFFS));
    const a = textureLoad(this.tex, ivec2(int(c), int(0)));
    const b = textureLoad(this.tex, ivec2(int(c), int(1)));
    const h0 = hash(id).sub(0.5), h1 = hash(id.add(0.31)), h2 = hash(id.add(0.77)).sub(0.5);
    // flattened cluster: wide horizontally, flat base, domed top
    const r = a.w;
    // dome: the middle puffs rise higher (rounded top), the edge ones stay low
    const rad = vec3(h0, 0, h2).length().mul(2);
    const off = vec3(h0.mul(r).mul(1.3), h1.sqrt().mul(r).mul(0.75).mul(float(1).sub(rad.mul(0.45))), h2.mul(r).mul(1.1));
    // the puffs slowly change shape (the cloud stays where the player put it)
    const wobble = vec3(mx_noise_float(vec3(id.mul(0.1), time.mul(windU.mul(0.05).add(0.02)), 0)).mul(r).mul(0.08), 0, 0);
    const center = a.xyz.add(off).add(wobble);
    const size = r.mul(float(0.28).add(hash(id.add(1.7)).mul(0.22)));
    const toCam = normalize(cameraPosition.sub(center));
    const side = normalize(cross(vec3(0, 1, 0), toCam));
    const up = cross(toCam, side);
    m.positionNode = center.add(side.mul(positionLocal.x.mul(size))).add(up.mul(positionLocal.y.mul(size)));
    const d = length(uv().sub(0.5)).mul(2);
    const n = mx_noise_float(vec3(uv().mul(2.3), id.mul(0.17).add(time.mul(0.02)))).mul(0.3);
    const disc = smoothstep(float(1), float(0.2), d.add(n));
    const day = float(1).sub(nightU);
    // light top, shaded base; dark bluish at night; the lightning lights it up
    // white top in the sun, greyish base (by the puff's height in the cluster and by the lower part of the disc)
    const shade = mix(float(0.72), float(1.05), clamp(off.y.div(r.mul(0.75)), 0, 1)).mul(mix(float(0.88), float(1.04), uv().y));
    const col = mix(vec3(0.1, 0.11, 0.15), vec3(0.98, 0.98, 1), day).mul(shade).add(vec3(0.9, 0.92, 1).mul(flashU.mul(2)));
    // near the camera the puff fades out (it does not become a smear on the screen)
    const near = smoothstep(r.mul(0.3), r.mul(1.2), cameraPosition.distance(center));
    m.colorNode = vec4(sRGBTransferEOTF(clamp(col, 0, 1)), disc.mul(b.x).mul(0.85).mul(near));
    m.fog = true;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
    this.mesh.visible = false;
  }

  /** Replaces the cloud list (only when the player changes it). */
  set(clouds: Cloud[]): void {
    const d = this.data;
    d.fill(0);
    const n = Math.min(MAX_CLOUDS, clouds.length);
    for (let i = 0; i < n; i++) {
      const c = clouds[i];
      d[i * 4] = c.x; d[i * 4 + 1] = c.y; d[i * 4 + 2] = c.z; d[i * 4 + 3] = c.size;
      d[(MAX_CLOUDS + i) * 4] = c.density;
    }
    this.geo.instanceCount = n * PUFFS;
    cloudCountU.value = n;
    this.mesh.visible = n > 0;
    this.tex.needsUpdate = true;
  }
}
