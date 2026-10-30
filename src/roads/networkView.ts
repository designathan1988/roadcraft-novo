// The read side of RoadNetwork that control and junction need, with no import back to network.ts.
import type { Quad } from './geometry.ts';
import type { IdColumn, NodeId, SegId } from '../core/ids.ts';

/** The junction fields those modules read (the full JunctionSpec is assignable to it). */
export interface JunctionLike {
  ctl: number;
  legs?: Array<[SegId, number]>;
  bans?: SegId[];
  lanes?: Array<[SegId, number, SegId[]]>;
  end?: 'bulb' | 'plain';
}

export interface NetworkView {
  readonly junctions: ReadonlyMap<NodeId, JunctionLike>;
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
      readonly a: IdColumn<NodeId>;
      readonly b: IdColumn<NodeId>;
      readonly len: Float32Array;
    };
  };
  segsOf(n: NodeId, out: SegId[]): SegId[];
  forSegsNear(x0: number, z0: number, x1: number, z1: number, visit: (seg: SegId) => void): void;
  quad(seg: SegId, out?: Quad): Quad;
}
