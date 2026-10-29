// The read side of RoadNetwork that control and junction need, with no import back to network.ts.
import type { Quad } from './geometry.ts';

/** The junction fields those modules read (the full JunctionSpec is assignable to it). */
export interface JunctionLike {
  ctl: number;
  legs?: Array<[number, number]>;
  bans?: number[];
  lanes?: Array<[number, number, number[]]>;
  end?: 'bulb' | 'plain';
}

export interface NetworkView {
  readonly junctions: ReadonlyMap<number, JunctionLike>;
  readonly version: number;
  readonly nodes: {
    readonly alive: Uint8Array;
    readonly cols: { readonly x: Float32Array; readonly z: Float32Array; readonly deg: Uint8Array };
  };
  readonly segs: {
    readonly cols: {
      readonly profile: Uint16Array;
      readonly flags: Uint8Array;
      readonly cx: Float32Array;
      readonly cz: Float32Array;
      readonly a: Int32Array;
      readonly b: Int32Array;
      readonly len: Float32Array;
    };
  };
  segsOf(n: number, out: number[]): number[];
  forSegsNear(x0: number, z0: number, x1: number, z1: number, visit: (seg: number) => void): void;
  quad(seg: number, out?: Quad): Quad;
}
