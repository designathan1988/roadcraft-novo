/** Bits de trecho de via (compartilhado com os workers). */
export const SegFlag = { Ring: 1, /** mobiliário: 0 completo, 1 básico (só postes), 2 nenhum (bits 1-2) */ FurnShift: 1, /** corte com muro de arrimo (senão talude) */ Wall: 8 } as const;
/** Mobiliário do trecho (0 completo, 1 básico, 2 nenhum). */
export const furnOf = (flags: number) => (flags >> 1) & 3;
