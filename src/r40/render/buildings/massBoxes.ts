import {
  BufferAttribute, BufferGeometry,
} from 'three';

/** THE BOX LEVELS' BUILDINGS AS INSTANCES OF ONE BOX (`farTiles.ts` levels 2 and up): the box's 20 vertices once for the kit, each building's box `BOX_INSTANCE` numbers, laid by the masses' shader (`massingMaterial.ts` `boxes`) */

/** The unit box: four walls (corner, up, face, end of the wall) and a roof, its triangles as the boxes' mesh of masses laid them (counter-clockwise seen from outside). */
export function unitBox(): BufferGeometry {
  const vertex: number[] = [];
  for (let side = 0; side < 4; side++) {
    const p = side, q = (side + 1) % 4;
    vertex.push(p, 0, side, 0, q, 0, side, 1, q, 1, side, 1, p, 1, side, 0);
  }
  for (let corner = 0; corner < 4; corner++) vertex.push(corner, 1, 4, 0);
  const index: number[] = [];
  for (let quad = 0; quad < 5; quad++) { const f = quad * 4; index.push(f, f + 1, f + 2, f, f + 2, f + 3); }
  const g = new BufferGeometry();
  // Its place is the instance's: the position only names the vertices (three draws by the index).
  g.setAttribute('position', new BufferAttribute(new Float32Array(20 * 3), 3));
  g.setAttribute('boxVertex', new BufferAttribute(Float32Array.from(vertex), 4));
  g.setIndex(index);
  return g;
}
