// Where people sit in each vehicle of `src/render/vehicles.ts` (model frame: +z forward, +x the driver's left,
// metres from the ground under the vehicle's centre). No three.js here. The cars follow the same seating package the
// bodies are built from (render/carBody.ts), so a hip point lands on its seat's cushion.

import { carSeatPoints, type CarStyle } from '../carBody.ts';

/** A seat: hip point x, y, z. */
export type Seat = readonly [number, number, number];

const CAR_STYLES: readonly Exclude<CarStyle, 'wagon'>[] = ['sedan', 'hatch', 'suv', 'van', 'pickup'];
const CAR_SEATS: readonly (readonly Seat[])[] = CAR_STYLES.map((s) => carSeatPoints(s));

/** The bus (roadcraft 4.0 heavyBody): floor at 0.38 m; the driver over the pedals, passengers down the sides. */
const BUS_FLOOR = 0.38;
const BUS_SEATS: Seat[] = [
  [0.655, BUS_FLOOR + 0.45, 4.8],
  ...Array.from({ length: 15 }, (_, i) => {
    const row = Math.floor(i / 2), side = i % 2 === 0 ? 1 : -1;
    return [side * 0.985, BUS_FLOOR + 0.55, 3.9 - row * 0.78] as Seat;
  }),
];
/** The lorry's cab: floor at 1.15 m, seats 0.62 m behind the cab's front; driver left, passenger right. */
const TRUCK_SEATS: Seat[] = [[0.70, 1.15 + 0.45, 3.09], [-0.70, 1.15 + 0.45, 3.09]];

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
