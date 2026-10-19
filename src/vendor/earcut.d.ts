// Types of earcut 3.2.3 (ISC, LICENSE-earcut), for its ES module next to it.
export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number> | null, dim?: number): number[];
export function deviation(data: ArrayLike<number>, holeIndices: ArrayLike<number> | null | undefined, dim: number, triangles: ArrayLike<number>): number;
export function flatten(data: number[][][]): { vertices: number[]; holes: number[]; dimensions: number };
