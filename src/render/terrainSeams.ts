// The terrain cut along the roads near the camera (jobs/terrainSeams.ts), as a layer of road cells: each cell within
// SEAM_REACH asks a worker for its seams (the part off the road of every 4 m cell a road's edge crosses), draws them
// with the terrain's own material, and tells the terrain which of its 4 m cells not to draw (`setSeams`) for as long
// as the seams are in. Rebuilt when the roads or the ground of a cell change. Nothing beyond SEAM_REACH: there the
// terrain is drawn whole, as before.

import { CELL_SIZE, HEIGHT_SPACING, MAP_CELLS } from '../config.ts';
import { Dirty, cellOriginX, type DirtyCells } from '../core/grid.ts';
import type { RoadNetwork } from '../roads/network.ts';
import { roadGraphTransfer } from '../shared/contracts/worker.ts';
import { SEAM_PAD } from '../jobs/terrainSeams.ts';
import type { JobPool } from '../jobs/pool.ts';
import { CellLayer, type LayerSource } from './cellLayer.ts';
import { SEAM_REACH, type TerrainRenderer } from './terrain.ts';
import type { NodeId, SegId } from '../core/ids.ts';

/** How far round a cell the roads that may cut it are looked for (m): its pad, and a segment's half length past it. */
const REACH = SEAM_PAD * HEIGHT_SPACING + 80;

export function createTerrainSeams(net: RoadNetwork, pool: JobPool, dirty: DirtyCells, terrain: TerrainRenderer): CellLayer {
  const near = (c: number, out: (s: SegId) => void): void => {
    const x = cellOriginX(c % MAP_CELLS), z = cellOriginX((c / MAP_CELLS) | 0);
    net.segIndex.query(x - REACH, z - REACH, x + CELL_SIZE + REACH, z + CELL_SIZE + REACH, out);
  };
  const src: LayerSource = {
    hasContent: (c) => { let any = false; near(c, () => { any = true; }); return any; },
    buildCell: (c, level, priority, done) => {
      // the finest level only: beyond its distance there is no cut
      if (level !== 0) { done(null); return; }
      const segs: SegId[] = [], nodes: NodeId[] = [];
      near(c, (s) => { segs.push(s); });
      const x = cellOriginX(c % MAP_CELLS), z = cellOriginX((c / MAP_CELLS) | 0);
      net.nodeIndex.query(x - REACH, z - REACH, x + CELL_SIZE + REACH, z + CELL_SIZE + REACH, (n) => { nodes.push(n); });
      const graph = net.gather(segs, nodes);
      pool.submit('terrainSeams', { graph, originX: x, originZ: z }, (r) => {
        // the holes ride with the mesh: the layer hands them to the terrain when it puts the mesh in (`installed`)
        if (r.mesh) holesOf.set(r.mesh, r.holes);
        done(r.mesh);
      }, { key: `seam:${c}`, priority: priority - 1, transfer: roadGraphTransfer(graph) });
    },
    buildTile: (_t, _priority, done) => done(null),
    installed: (c, level, m) => {
      if (level !== 0) return;
      const x = cellOriginX(c % MAP_CELLS), z = cellOriginX((c / MAP_CELLS) | 0);
      terrain.setSeams(x, z, m ? holesOf.get(m) ?? null : null);
    },
  };
  const holesOf = new WeakMap<object, Uint8Array>();
  // drawn by cells up to SEAM_REACH (the layer's own hysteresis keeps a cell fine up to 1.15 × detail, the terrain cuts
  // only within SEAM_REACH, so every cell it cuts has its seams drawn); no tiles, no plates, no shadow of its own (the
  // terrain's shadow copy stands for the ground)
  return new CellLayer(src, dirty, [Dirty.Roads, Dirty.Terrain], terrain.seamMaterial,
    { near: SEAM_REACH / 0.85, evict: SEAM_REACH * 2, margin: 8, shadows: false, detail: SEAM_REACH / 0.85, far: SEAM_REACH * 1.5, budget: 32e6, sparse: true });
}
