// Bus stops (shelter + sign in the line's colour) and the lines' path
// when the bus tool is active. Few instances: rebuilt only
// when the lines or the roads change.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bez, bezD } from '../roads/geometry.ts';
import type { RoadNetwork } from '../roads/network.ts';
import { heightAt } from '../world/heights.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import type { Transit } from '../world/transit.ts';
import { PAINTS } from './vehicles.ts';
import { colorOnly } from './post.ts';
import { Dirty, cellId, cellX, type DirtyCells, type DirtyReader } from '../core/grid.ts';

const CAP = 2048;

function coloredBox(w: number, h: number, d: number, x: number, y: number, z: number, rgb: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  const col = new THREE.Color(rgb).convertSRGBToLinear();
  for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

export class TransitRenderer {
  readonly group = new THREE.Group();
  private shelters: THREE.InstancedMesh;
  private markers: THREE.InstancedMesh;
  private platforms: THREE.InstancedMesh;
  private entrances: THREE.InstancedMesh;
  private paths = new THREE.Group();
  private lineMat = colorOnly(new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85 }));
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private built = -1;
  /** Road edits since the last build (its own list of dirty road cells). */
  private roadEdits: DirtyReader | null = null;
  /** Cells within reach of a stop (a road edit there can turn a shelter or move a platform). */
  private stopCells = new Set<number>();

  constructor() {
    // shelter: roof, dark glass back, bench; facing +z (the road)
    const shelter = mergeGeometries([
      coloredBox(3.2, 0.12, 1.6, 0, 2.5, 0, 0xd6d8da),
      coloredBox(0.08, 2.5, 0.08, -1.5, 0, -0.6, 0x5a5f64), coloredBox(0.08, 2.5, 0.08, 1.5, 0, -0.6, 0x5a5f64),
      coloredBox(3.0, 1.9, 0.05, 0, 0.5, -0.7, 0x2c3a44),
      coloredBox(2.4, 0.08, 0.42, 0, 0.45, -0.4, 0x8a8e92),
    ])!;
    const shelterMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 });
    this.shelters = this.instanced(shelter, shelterMat, CAP);
    // the line's sign on a post beside it
    const marker = mergeGeometries([coloredBox(0.06, 2.9, 0.06, 1.9, 0, 0.4, 0xffffff), coloredBox(0.5, 0.5, 0.06, 1.9, 2.6, 0.4, 0xffffff)])!;
    this.markers = this.instanced(marker, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.5 }), CAP);
    // instances and a dummy path so the shaders compile at load
    this.markers.setColorAt(0, new THREE.Color(1, 1, 1));
    this.m.makeTranslation(0, -5000, 0);
    this.shelters.setMatrixAt(0, this.m); this.markers.setMatrixAt(0, this.m);
    this.shelters.count = 1; this.markers.count = 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -5000, 0, 1, -5000, 0], 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1], 3));
    this.paths.add(new THREE.Line(g, this.lineMat));
    this.paths.renderOrder = 10;
    // train station: 60 m platform with a canopy (one on each side of the track)
    const platform = mergeGeometries([
      coloredBox(3.4, 1.05, 60, 0, 0, 0, 0xb9b4aa),
      coloredBox(3.4, 0.05, 60, 0, 1.05, 0, 0xe8c840), // yellow safety strip (edge)
      coloredBox(3.0, 0.15, 36, 0.2, 4.4, 0, 0xd6d8da),
      ...[-15, -5, 5, 15].map((z) => coloredBox(0.15, 3.4, 0.15, 1.2, 1.05, z, 0x5a5f64)),
      coloredBox(0.6, 0.6, 1.6, 1.0, 3.6, 0, 0x1f4f9a),
    ])!;
    this.platforms = this.instanced(platform, shelterMat, 512);
    // metro entrance: covered stairs with a sign
    const entrance = mergeGeometries([
      coloredBox(3.2, 0.9, 6, 0, 0, 0, 0x8a8e92),
      coloredBox(3.4, 0.12, 6.4, 0, 2.6, 0, 0xd6d8da),
      coloredBox(0.1, 2.6, 0.1, 1.6, 0, 3.1, 0x5a5f64), coloredBox(0.1, 2.6, 0.1, -1.6, 0, 3.1, 0x5a5f64),
      coloredBox(0.08, 3.4, 0.08, 2.2, 0, 3.4, 0xffffff), coloredBox(0.7, 0.7, 0.08, 2.2, 3.2, 3.4, 0xc8241c),
    ])!;
    this.entrances = this.instanced(entrance, shelterMat, 512);
    this.m.makeTranslation(0, -5000, 0);
    this.platforms.setMatrixAt(0, this.m); this.entrances.setMatrixAt(0, this.m);
    this.platforms.count = 1; this.entrances.count = 1;
    this.group.add(this.shelters, this.markers, this.platforms, this.entrances, this.paths);
  }

  set showPaths(v: boolean) { this.paths.visible = v; }

  private instanced(g: THREE.BufferGeometry, m: THREE.Material, cap: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(g, m, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** The same mesh with room for `need` instances (a capacity past which stops used to be cut without a word). */
  private grown(mesh: THREE.InstancedMesh, need: number): THREE.InstancedMesh {
    if (need <= mesh.instanceMatrix.count) return mesh;
    let cap = mesh.instanceMatrix.count;
    while (cap < need) cap *= 2;
    const bigger = this.instanced(mesh.geometry, mesh.material as THREE.Material, cap);
    bigger.renderOrder = mesh.renderOrder;
    this.group.remove(mesh);
    mesh.dispose();
    this.group.add(bigger);
    return bigger;
  }

  /**
   * Rebuilds the stops when the lines change (`version`) or a road is edited within reach of a stop. (A version the
   * game bumped on every road edit rebuilt every stop of every line on each edit, anywhere in the map.)
   */
  update(transit: Transit, net: RoadNetwork, heights: Float32Array, version: number, dirty?: DirtyCells): void {
    if (dirty && !this.roadEdits) this.roadEdits = dirty.reader(Dirty.Roads);
    let near = false;
    if (this.roadEdits) for (const c of this.roadEdits.drain()) if (this.stopCells.has(c)) near = true;
    if (version === this.built && !near) return;
    this.built = version;
    this.stopCells.clear();
    let stops = 0;
    for (const l of transit.lines) stops += l.stops.length / 2;
    this.shelters = this.grown(this.shelters, stops);
    this.markers = this.grown(this.markers, stops);
    this.platforms = this.grown(this.platforms, stops * 2);
    this.entrances = this.grown(this.entrances, stops);
    for (const l of transit.lines) {
      for (let k = 0; k * 2 < l.stops.length; k++) {
        const x = l.stops[k * 2], z = l.stops[k * 2 + 1], r = 48;
        for (let cz = cellX(z - r); cz <= cellX(z + r); cz++) for (let cx = cellX(x - r); cx <= cellX(x + r); cx++) this.stopCells.add(cellId(cx, cz));
      }
    }
    let n = 0;
    const p2 = new Float64Array(2), d2 = new Float64Array(2);
    const col = new THREE.Color();
    for (const old of [...this.paths.children]) { (old as THREE.Line).geometry.dispose(); (old as THREE.Line).dispose(); this.paths.remove(old); }
    let np = 0, ne = 0;
    const sc = net.segs.cols, nc = net.nodes.cols;
    for (const l of transit.lines) {
      col.set(PAINTS[l.color & 15]);
      const rail = (l.mode ?? 0) > 0;
      const pts: number[] = [], cols: number[] = [];
      for (let k = 0; k * 2 < l.stops.length; k++) {
        const x = l.stops[k * 2], z = l.stops[k * 2 + 1];
        let y = heightAt(heights, x, z) + 0.15;
        // facing the nearest road (station: aligned with the track)
        let yaw = 0;
        const hit = net.nearestSeg(x, z, 40);
        if (hit) {
          const q = net.quad(hit[0]);
          bez(q, hit[1], p2); bezD(q, hit[1], d2);
          yaw = rail ? Math.atan2(d2[0], d2[1]) : Math.atan2(p2[0] - x, p2[1] - z);
          if (rail) {
            const s = hit[0];
            const ty = nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * hit[1];
            const half = PROFILE_INFO[sc.profile[s]].right;
            const l2 = Math.hypot(d2[0], d2[1]) || 1, lx = d2[1] / l2, lz = -d2[0] / l2;
            this.q.setFromAxisAngle(this.up, yaw);
            if (l.mode === 1 || ty > heightAt(heights, x, z) - 3) {
              for (const side of [-1, 1]) {
                const u = side * (half + 1.7);
                const r = new THREE.Quaternion().setFromAxisAngle(this.up, yaw + (side > 0 ? Math.PI : 0));
                this.m.compose(new THREE.Vector3(x + lx * u, ty, z + lz * u), r, new THREE.Vector3(1, 1, 1));
                this.platforms.setMatrixAt(np++, this.m);
              }
            } else {
              // underground metro: entrance on the surface, beside the path
              const u = half + 4;
              const gx = x + lx * u, gz = z + lz * u;
              this.m.compose(new THREE.Vector3(gx, heightAt(heights, gx, gz), gz), this.q, new THREE.Vector3(1, 1, 1));
              this.entrances.setMatrixAt(ne++, this.m);
            }
            y = ty + 1.2;
            pts.push(x, y + 4, z);
            cols.push(col.r, col.g, col.b);
            continue;
          }
        }
        this.q.setFromAxisAngle(this.up, yaw);
        // terminal: long shelter (three times) and taller
        const term = transit.terminalNear(x, z, 9) >= 0;
        this.m.compose(new THREE.Vector3(x, y, z), this.q, term ? new THREE.Vector3(3.2, 1.35, 1.4) : new THREE.Vector3(1, 1, 1));
        this.shelters.setMatrixAt(n, this.m);
        this.markers.setMatrixAt(n, this.m);
        this.markers.setColorAt(n, col);
        n++;
        pts.push(x, y + 4, z);
        cols.push(col.r, col.g, col.b);
      }
      if (pts.length >= 6) {
        pts.push(pts[0], pts[1], pts[2]); cols.push(col.r, col.g, col.b);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        const line = new THREE.Line(g, this.lineMat);
        line.frustumCulled = false;
        line.renderOrder = 10;
        this.paths.add(line);
      }
    }
    this.shelters.count = n;
    this.markers.count = n;
    this.platforms.count = np; this.entrances.count = ne;
    this.platforms.instanceMatrix.needsUpdate = true;
    this.entrances.instanceMatrix.needsUpdate = true;
    this.shelters.instanceMatrix.needsUpdate = true;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }
}
