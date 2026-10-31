import type { Material } from 'three';

/** What `onBeforeRender` is handed of the renderer drawing a material: whether its depth buffer is reversed. */
interface DepthOwner { readonly capabilities: { readonly reversedDepthBuffer: boolean } }

/** DO NOT set `polygonOffsetFactor`/`polygonOffsetUnits` on a material by hand. */
export function pullTowardEye(material: Material, slope: number, steps: number): void {
  const units = Math.abs(steps);
  material.polygonOffset = true;
  material.polygonOffsetFactor = -Math.abs(slope);
  material.polygonOffsetUnits = -units;
  material.onBeforeRender = (renderer: DepthOwner) => {
    material.polygonOffsetUnits = renderer.capabilities.reversedDepthBuffer ? units : -units;
  };
}
