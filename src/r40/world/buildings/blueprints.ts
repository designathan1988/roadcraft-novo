
import { m } from '../units.ts';
import {
  type Building,
} from './types.ts';

/** Reusable building definitions: everything a building is except where it stands. */
export type BlueprintBody = Omit<Building, 'id' | 'x' | 'y' | 'rotation'>;

export const DEFAULT_GROUND_HEIGHT = m(3.6);
export const DEFAULT_STOREY_HEIGHT = m(3.1);
