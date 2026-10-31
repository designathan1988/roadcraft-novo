import type { Material } from 'three';
import { type BuildingKit, type PartKind } from './kit.ts';
import { SHELL_PARTS } from './shellParts.ts';

/** How a part kind is drawn faded ("Ocultar outros") or not: its material, its order and whether it is drawn at all (a lantern's light is not). */
export function partLook(kit: BuildingKit, kind: PartKind, faded: boolean): { material: Material; renderOrder: number; visible: boolean } {
  if (kind === 'wash') return { material: kit.material.wash, renderOrder: 0, visible: !faded };
  // The shell's parts fade as the shell they were laid in (`shellParts.ts`).
  const dim = SHELL_PARTS.has(kind) ? kit.dimShell : kit.dimParts;
  return { material: faded ? dim : kit.material[kind], renderOrder: faded ? 1 : 0, visible: true };
}
