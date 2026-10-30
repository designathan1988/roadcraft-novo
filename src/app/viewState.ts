// What the player chose to see, with one owner: the grid, the zone colours, the traffic view (the Layers panel) and
// the building seen inside. The overlay uniforms are derived from it and written only here; the HUD reads it.
// The vehicle being followed stays with Vehicles (its single owner: it moves the camera every frame).

import { gridU } from '../render/terrain.ts';
import { trafficOverlayU, zoneOverlayU } from '../render/roads.ts';
import type { Layers } from '../ui/hudActions.ts';

export class ViewState {
  private shown: Layers = { grid: false, zones: false, traffic: false };
  private zoneTool = false;
  /** The building seen inside, or -1. */
  insideId = -1;

  /** The layers the player turned on. */
  get layers(): Readonly<Layers> { return this.shown; }

  /** Turns a layer on or off. */
  set(layer: keyof Layers, on: boolean): void { this.shown[layer] = on; this.write(); }

  /** The zone tool shows the zone colours while it is in hand, whatever the layer. */
  zoneToolInHand(on: boolean): void { this.zoneTool = on; this.write(); }

  private write(): void {
    gridU.value = this.shown.grid ? 1 : 0;
    trafficOverlayU.value = this.shown.traffic ? 1 : 0;
    zoneOverlayU.value = this.shown.zones || this.zoneTool ? 1 : 0;
  }
}
