// The fracture worker: triangles in, one StillData and its fragments out. Kept pure so the main thread never cuts a
// building while it draws.
import { fractureData, type FractureInput, type StillData } from './fracture.ts';

type Scope = {
  onmessage: ((e: MessageEvent<{ id: number; input: FractureInput }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  try {
    const still: StillData = fractureData(e.data.input);
    const transfer: Transferable[] = [still.position.buffer as ArrayBuffer, still.normal.buffer as ArrayBuffer, still.colour.buffer as ArrayBuffer];
    for (const s of still.slots) transfer.push(s.buffer as ArrayBuffer);
    scope.postMessage({ id: e.data.id, still }, transfer);
  } catch (error) {
    console.error('[fracture worker]', error);
    scope.postMessage({ id: e.data.id, error: String(error) });
  }
};
