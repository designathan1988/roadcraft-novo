// Types of polygon-clipping 0.15.7 (its dist/polygon-clipping.d.ts), for the wrapped build next to it.
declare namespace clipping {
  type Pair = [number, number];
  type Ring = Pair[];
  type Polygon = Ring[];
  type MultiPolygon = Polygon[];
  type Geom = Polygon | MultiPolygon;
  function intersection(geom: Geom, ...geoms: Geom[]): MultiPolygon;
  function xor(geom: Geom, ...geoms: Geom[]): MultiPolygon;
  function union(geom: Geom, ...geoms: Geom[]): MultiPolygon;
  function difference(subjectGeom: Geom, ...clipGeoms: Geom[]): MultiPolygon;
}
export default clipping;
