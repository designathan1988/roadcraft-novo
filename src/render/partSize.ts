// The 4.0 building parts' size on the screen, judged per instance in the props cull pass (Roadcraft 4.0 partCells.ts
// levelAt): the level a part draws at and where it leaves the drawing. Each kind's rules come from its model
// (propMeshes.ts PartMeta); the pixels a metre spans, from the view every frame. render/props.ts owns the cull pass and
// asks this for a part's scale, cull radius and level ends.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';
import { BAR_PIXELS, PART_ERROR_PX, type PropKind } from './propMeshes.ts';
import { SCALE_MIN, SCALE_OCTAVES } from '../jobs/parts40.ts';

const { uniform, uniformArray, float, uint, vec3, mix, select, min, max, length } = T;

/** vec4s per kind in `rulesU`: flags, the model's box, its reach, three bars. */
const RULE = { flags: 0, extent: 1, reach: 2, piece: 3, stride: 6 } as const;

export class PartSize {
  /**
   * Every kind's rules in one array (one uniform buffer: the cull pass sits near WebGPU's 12 a stage), RULE.stride vec4s a
   * kind: flags (x = 0 not a 4.0 building part, 1 a solid part, 2 a part of bars; y = 1 where its far level is a shell
   * part's top), its model's box, its reach from its origin, its bars (up to three; zero when unused).
   */
  private readonly rulesU: Node;
  /** Pixels a metre spans at a metre's distance in the perspective view, and everywhere in the isometric one (0 in the other). */
  private readonly pxU = uniform(0);
  private readonly orthoPxU = uniform(0);
  private scaleSet = 0;

  constructor(kinds: readonly PropKind[]) {
    const v4 = (a?: readonly number[]) => new THREE.Vector4(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0, 0);
    this.rulesU = uniformArray(kinds.flatMap((d) => [
      new THREE.Vector4(d.part ? (d.part.pieces.length ? 2 : 1) : 0, d.part?.topLevel ? 1 : 0, 0, 0),
      v4(d.part?.extent), v4(d.part?.reach), v4(d.part?.pieces[0]), v4(d.part?.pieces[1]), v4(d.part?.pieces[2]),
    ]), 'vec4');
  }

  /** Kind `kind`'s rule `k` (RULE). */
  private rule(kind: Node, k: number): Node {
    return this.rulesU.element(kind.mul(RULE.stride).add(k));
  }

  /**
   * The pixels a metre spans, from the view (before the cull, each frame): at a metre's distance in perspective,
   * everywhere in isometric; on the 1080-line screen the detail distances are scaled from (pixelScale: resolution, detail).
   * Whether the scale changed since the last view.
   */
  setView(camera: THREE.Camera, pixelScale: number): boolean {
    const pc = camera as THREE.PerspectiveCamera, oc = camera as THREE.OrthographicCamera;
    if (pc.isPerspectiveCamera) {
      this.pxU.value = 1080 * pixelScale / (2 * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2));
      this.orthoPxU.value = 0;
    } else {
      this.pxU.value = 0;
      this.orthoPxU.value = 1080 * pixelScale * oc.zoom / Math.max(1e-6, oc.top - oc.bottom);
    }
    const changed = pixelScale !== this.scaleSet;
    this.scaleSet = pixelScale;
    return changed;
  }

  /** Whether kind `kind` is a 4.0 building part. */
  isPart(kind: Node): Node {
    return this.rule(kind, RULE.flags).x.greaterThan(0.5);
  }

  /** A part's scale per axis from its pool record's `extra` (key bits above the type), read as the vertex stage reads it
   *  (jobs/parts40.ts partKey: 9 bits an axis, or 8 and the variant for the types that carry one: `variantType` 1.0, a
   *  float: WGSL's mix takes no u32 weight). */
  scale(extra: Node, variantType: Node): Node {
    const key = extra.shiftRight(uint(5));
    const q9 = (k: number) => float(key.shiftRight(uint(k * 9)).bitAnd(uint(511))).div(511);
    const q8 = (k: number) => float(key.shiftRight(uint(k * 8)).bitAnd(uint(255))).div(255);
    const sc = (k: number) => T.exp2(mix(q9(k), q8(k), variantType).mul(SCALE_OCTAVES)).mul(SCALE_MIN);
    return vec3(sc(0), sc(1), sc(2));
  }

  /** A part's cull radius: its model's reach at its own scale (its pose's w carries its colour, not a scale). */
  radius(kind: Node, s3: Node): Node {
    return length(this.rule(kind, RULE.reach).xyz.mul(s3));
  }

  /**
   * Where a part's levels end, metres from the eye ([level 0, level 1, level 2]), never past `reach` (its type's distance:
   * the cells hold its parts no farther): its far level (a shell part's top) once the half side its sides stand for is
   * under PART_ERROR_PX, and nothing once its diagonal is under a pixel, or its widest bar (the middle side of each)
   * under BAR_PIXELS. By its type's distance alone a window frame's 6 cm bars were drawn to 400 m (at 1080p), a fifth
   * of a pixel wide.
   */
  ends(kind: Node, s3: Node, reach: Node): Node[] {
    const pk = this.rule(kind, RULE.flags);
    const middle = (v: Node) => max(min(v.x, v.y), min(max(v.x, v.y), v.z));
    const piece = (k: number) => middle(this.rule(kind, RULE.piece + k).xyz.mul(s3));
    const barred = pk.x.greaterThan(1.5);
    const drawM = select(barred, max(max(piece(0), piece(1)), piece(2)), length(this.rule(kind, RULE.extent).xyz.mul(s3)));
    const drawPx = select(barred, float(BAR_PIXELS), float(1));
    // where a length spans `px` pixels (perspective); isometric: everywhere or nowhere
    const at = (metres: Node, px: Node) => select(this.orthoPxU.greaterThan(0), select(metres.mul(this.orthoPxU).greaterThanEqual(px), float(1e9), float(0)), metres.mul(this.pxU).div(px));
    const draw = min(at(drawM, drawPx), reach).toVar();
    const hasTop = pk.y.greaterThan(0.5);
    const top = at(min(s3.y, max(s3.x, s3.z)).mul(0.5), float(PART_ERROR_PX));
    const end0 = select(hasTop, min(top, draw), draw).toVar();
    const end1 = select(hasTop.and(draw.greaterThan(end0)), draw, float(0)).toVar();
    return [end0, end1, float(0)];
  }
}
