/** Zones (segment sides). Shared with the workers. 1-4 = medium density; 5-8 = low/high. */
export const Zone = { None: 0, Residential: 1, Commercial: 2, Industrial: 3, Mixed: 4, ResLow: 5, ResHigh: 6, ComLow: 7, ComHigh: 8 } as const;
export const ZONE_COLORS = [0x888888, 0x5fbf4a, 0x3d8ce0, 0xe0b23d, 0xb05fd0, 0x9ad98a, 0x2f8a2a, 0x8ab8ec, 0x1f5aa8];
/** Zona sem a densidade (residencial, comercial, industrial, misto). */
const BASE = [0, 1, 2, 3, 4, 1, 1, 2, 2];
export const baseZone = (z: number): number => BASE[z] ?? 0;
/** Density: 0 low, 1 medium, 2 high. */
const DENS = [1, 1, 1, 1, 1, 0, 2, 0, 2];
export const zoneDensity = (z: number): number => DENS[z] ?? 1;
