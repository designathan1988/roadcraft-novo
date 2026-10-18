// Where people sit in each vehicle of `src/render/vehicles.ts` (model frame: +z forward, +x the driver's left,
// metres from the ground under the vehicle's centre). No three.js here.

/** A seat: hip point x, y, z. */
export type Seat = readonly [number, number, number];

const car = (frontZ: number, hipY: number, rearZ: number | null): Seat[] => [
  [0.37, hipY, frontZ], [-0.37, hipY, frontZ],
  ...(rearZ === null ? [] : [[0.37, hipY + 0.02, rearZ] as Seat, [-0.37, hipY + 0.02, rearZ] as Seat]),
];

/** Seats per car style (0 sedan, 1 hatch, 2 SUV, 3 van, 4 pickup), driver first; from the bodies' glass lines. */
const CAR_SEATS: Seat[][] = [
  car(-0.05, 0.58, -0.95), car(-0.15, 0.6, -1.05), car(0.12, 0.78, -0.85), car(1.25, 0.8, 0.1), car(0.45, 0.82, null),
];
/** The bus: the driver, then pairs of seats down the sides, front to back (16 places as the windows). */
const BUS_SEATS: Seat[] = [[0.75, 1.05, 5.0], ...Array.from({ length: 15 }, (_, i) => {
  const k = i + 2, side = k % 2 ? 1 : -1, row = Math.floor((k - 1) / 2);
  return [side * 0.75, 1.05, 4.2 - row * 1.25] as Seat;
})];
const TRUCK_SEATS: Seat[] = [[0.55, 1.35, 3.85], [-0.55, 1.35, 3.85]];

/** Seats of a vehicle by its pose kind (0 car, 1 bus, 2 truck) and car style. */
export function seatsOf(kind: number, style: number): readonly Seat[] {
  if (kind === 1) return BUS_SEATS;
  if (kind === 2) return TRUCK_SEATS;
  return CAR_SEATS[Math.min(style, CAR_SEATS.length - 1)] ?? CAR_SEATS[0];
}

/**
 * People aboard from the pose's light bits 3-5 (the simulation: the bus's load in sevenths of its 16 places; cars
 * and trucks 1, the driver); at least the driver.
 */
export function aboard(kind: number, lights: number, seats: number): number {
  const bits = (lights >> 3) & 7;
  const shown = kind === 1 ? Math.floor(bits * 16 / 7 + 0.5) : bits;
  return Math.max(1, Math.min(seats, shown));
}

/** The motorcycle's rider: pelvis over the saddle (the moto model of vehicles.ts). */
export const MOTO_PELVIS: Seat = [0, 0.98, -0.18];
