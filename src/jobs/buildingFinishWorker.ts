// Bakes the building finishes once at load, off the main thread, and sends the two texture arrays back (transferred).
import { bakeFinishes } from './buildingFinishes.ts';

const { albedo, normal } = bakeFinishes();
(self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage({ albedo, normal }, [albedo.buffer, normal.buffer]);
