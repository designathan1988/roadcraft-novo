// The ruin's worker: a building laid as its cell lays it (jobs/buildingGen.ts buildingForRuin, with its parts and
// furniture apart) and broken into fragments (fracture.ts), off the page. One job at a time, answered by id.

import { buildingForRuin } from '../../../jobs/buildingGen.ts';
import type { BoxColumns } from '../../../shared/contracts/worker.ts';
import { fractureBuilding, gather, ruinTransfer, type Attached, type RuinData } from './fracture.ts';

export type ToRuinWorker = { type: 'init'; heights: SharedArrayBuffer } | { type: 'ruin'; id: number; boxes: BoxColumns; index: number };
export type FromRuinWorker = { id: number; ruin: RuinData | null; error?: string };

interface Scope { onmessage: ((e: MessageEvent<ToRuinWorker>) => void) | null; postMessage(m: FromRuinWorker, t?: Transferable[]): void }
const scope = self as unknown as Scope;
let heights: Float32Array | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { heights = new Float32Array(m.heights); return; }
  try {
    if (!heights) throw new Error('ruin worker not initialized');
    const b = m.boxes, i = m.index;
    const att: Attached = { kinds: [], rows: [] };
    const mb = buildingForRuin(heights, b, i, gather(att));
    // the ruin carries no building tag (position.w 0): the hidden-building mask never hides it (render/inside.ts)
    const ruin = fractureBuilding(mb, b.seed[i] || i + 1, 0, att);
    scope.postMessage({ id: m.id, ruin }, ruin ? ruinTransfer(ruin) : []);
  } catch (err) {
    scope.postMessage({ id: m.id, ruin: null, error: err instanceof Error ? err.message : String(err) });
  }
};
