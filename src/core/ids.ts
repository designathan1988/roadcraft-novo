// Typed ids: every id is a plain number at run time (an index into its SoA table, core/table.ts), and a distinct type
// for the compiler, so a node id passed where a segment id is expected does not compile. The brand is erased: no
// object, no cost. Ids that pack several numbers (a lane, a junction arm, a segment end) are built and read back only
// through the encoders here.

declare const brand: unique symbol;
/** A number that is an id of kind `K`. */
export type Id<K extends string> = number & { readonly [brand]: K };

export type NodeId = Id<'node'>;
export type SegId = Id<'seg'>;

/** A typed array whose elements are ids of one kind (a table column holding references). */
export interface IdColumn<T extends number> extends Int32Array {
  [index: number]: T;
}

/** The column type of a table field that holds ids of one kind (an Int32Array at run time). */
export function idColumn<T extends number>(): new (length: number) => IdColumn<T> {
  return Int32Array as unknown as new (length: number) => IdColumn<T>;
}

/** No node / no segment: the empty reference of a column or a search that found nothing (always < 0). */
export const NO_NODE = -1 as NodeId;
export const NO_SEG = -1 as SegId;

/** A number known to be a node id (read from a column without the brand, a message, a save). */
export const asNode = (n: number): NodeId => n as NodeId;
/** A number known to be a segment id. */
export const asSeg = (n: number): SegId => n as SegId;
