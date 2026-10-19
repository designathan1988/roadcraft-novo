// Projeto de prédio feito pelo jogador (criador): planta, telhado, acabamento, cor, peças no
// telhado e andares recuados. Vai nos campos `color` (bits) e `h` (cor da parede) do registro,
// que os prédios v2 não usam: o salvamento não muda de formato. Bit 31 de color = tem projeto.

export const SHAPES = ['Retângulo', 'Em L', 'Em U', 'Círculo', 'Hexágono', 'Octógono', 'Chanfrado'] as const;
export const ROOFS = ['Plana', 'Terraço', '2 águas', '4 águas', '1 água', 'Dente de serra'] as const;
export const FINISHES = ['Reboco', 'Tijolo', 'Vidro', 'Concreto', 'Metal', 'Madeira', 'Pedra', 'Cerâmica', 'Massa raspada', 'Painel'] as const;
/** Peças no telhado (bits). */
/** Janelas da fachada (por cima do que o acabamento daria). */
export const WINDOWS = ['Do acabamento', 'Faixa de vidro', 'Janelas largas', 'Janelas estreitas', 'Parede cega'] as const;
/** Ala lateral mais baixa (um terço dos andares). */
export const WINGS = ['Sem ala', 'Ala à esquerda', 'Ala à direita', 'Alas dos dois lados'] as const;
export const GEAR = { Tank: 1, Solar: 2, Chimney: 4, Spire: 8, Antenna: 16, AC: 32 } as const;
export const GEAR_NAMES: Array<[number, string]> = [[GEAR.Tank, 'Caixa d’água'], [GEAR.Solar, 'Painéis solares'], [GEAR.Chimney, 'Chaminé'], [GEAR.Spire, 'Agulha'], [GEAR.Antenna, 'Antena'], [GEAR.AC, 'Ar-condicionado']];
/** Cores prontas da paleta do criador. */
export const PALETTE = [0xece6da, 0xd9c7a6, 0xc9a98a, 0xa9b4b8, 0x9b4a32, 0x6e7f8a, 0x2f3b48, 0xe9d38f, 0x8fb9a8, 0xd98e73, 0xf2f2ef, 0x555b61];

export interface Design {
  shape: number; roof: number; finish: number; gear: number; setback: number; wall: number; windows?: number; wing?: number;
  /** Catalog project (1-based index into CATALOG; 0 = none): the building is drawn from that project. */
  catalog?: number;
}

export const DEFAULT_DESIGN: Design = { shape: 0, roof: 0, finish: 0, gear: 0, setback: 0, wall: 0xd9c7a6 };

/** Funções cívicas novas (Fn 14..33): projeto do criador e andares mínimos (o cemitério e o parquinho são à parte). */
export const CIVIC_DESIGNS: Record<number, [Design, number]> = {
  14: [{ shape: 0, roof: 3, finish: 6, gear: GEAR.Spire, setback: 0, wall: 0xe8e2d4 }, 2],
  15: [{ shape: 6, roof: 0, finish: 6, gear: 0, setback: 0, wall: 0xd8cfbd }, 3],
  16: [{ shape: 0, roof: 0, finish: 0, gear: GEAR.AC, setback: 0, wall: 0xf2c21a }, 2],
  17: [{ shape: 2, roof: 0, finish: 1, gear: GEAR.Solar, setback: 0, wall: 0xa5553a }, 4],
  18: [{ shape: 5, roof: 0, finish: 6, gear: 0, setback: 0, wall: 0xefe9de }, 2],
  19: [{ shape: 3, roof: 0, finish: 3, gear: 0, setback: 1, wall: 0xf2f2ef }, 3],
  20: [{ shape: 2, roof: 0, finish: 3, gear: GEAR.Antenna, setback: 0, wall: 0x9da3a6 }, 3],
  22: [{ shape: 6, roof: 4, finish: 4, gear: 0, setback: 0, wall: 0xb9bec2 }, 1],
  23: [{ shape: 0, roof: 0, finish: 2, gear: GEAR.AC, setback: 0, wall: 0x2e4554 }, 5],
  24: [{ shape: 0, roof: 0, finish: 0, gear: GEAR.AC, setback: 0, wall: 0xdfe8d8 }, 1],
  25: [{ shape: 0, roof: 2, finish: 0, gear: GEAR.Chimney, setback: 0, wall: 0xe9c46a }, 1],
  26: [{ shape: 0, roof: 1, finish: 5, gear: 0, setback: 0, wall: 0xd98e73 }, 1],
  27: [{ shape: 0, roof: 0, finish: 0, gear: GEAR.AC, setback: 0, wall: 0xe8a7a0 }, 1],
  28: [{ shape: 0, roof: 4, finish: 5, gear: 0, setback: 0, wall: 0x8a6a4a }, 1],
  29: [{ shape: 0, roof: 0, finish: 3, gear: GEAR.AC, setback: 0, wall: 0x2f3b48 }, 2],
  30: [{ shape: 0, roof: 1, finish: 6, gear: GEAR.Tank, setback: 2, wall: 0xe8dcc4 }, 9],
  31: [{ shape: 0, roof: 0, finish: 4, gear: GEAR.AC, setback: 0, wall: 0x6e757a }, 2],
  32: [{ shape: 1, roof: 3, finish: 5, gear: 0, setback: 0, wall: 0xf3e6c8 }, 2],
  33: [{ shape: 0, roof: 0, finish: 2, gear: GEAR.Antenna, setback: 0, wall: 0x43525f }, 12],
};

/**
 * Marcos da cidade (o catálogo de lotes nomeados do roadcraft, `lots/*.json`): projetos prontos que o crescimento dá a
 * parte das torres comerciais. [projeto, andares mínimos].
 */
export const LANDMARKS: Array<[Design, number]> = [
  [{ shape: 3, roof: 0, finish: 2, gear: GEAR.Antenna, setback: 0, wall: 0x6e8fa3 }, 14], // roundGlass
  [{ shape: 0, roof: 0, finish: 2, gear: GEAR.Spire, setback: 3, wall: 0x2f3b48 }, 16], // glassSpire
  [{ shape: 6, roof: 0, finish: 6, gear: GEAR.Spire, setback: 3, wall: 0xd9c7a6 }, 14], // decoSpire
  [{ shape: 5, roof: 0, finish: 4, gear: GEAR.AC, setback: 1, wall: 0x9b6a3c }, 12], // octCopper
  [{ shape: 4, roof: 1, finish: 1, gear: GEAR.Solar, setback: 0, wall: 0xb5583a }, 10], // hexTerracotta
  [{ shape: 0, roof: 1, finish: 3, gear: GEAR.Solar, setback: 4, wall: 0xe8e4da }, 12], // stepGarden
  [{ shape: 2, roof: 0, finish: 2, gear: GEAR.Antenna, setback: 0, wall: 0x243248 }, 12], // twinNavy
  [{ shape: 6, roof: 0, finish: 2, gear: GEAR.Antenna, setback: 1, wall: 0x1f262e }, 14], // darkGlass
  [{ shape: 3, roof: 1, finish: 3, gear: 0, setback: 1, wall: 0xf2f2ef, windows: 1 }, 10], // waveWhite
  [{ shape: 1, roof: 0, finish: 1, gear: GEAR.Tank, setback: 0, wall: 0x9b4a32 }, 8], // loftBrick
  [{ shape: 0, roof: 3, finish: 6, gear: GEAR.Chimney, setback: 1, wall: 0xe8dcc4, wing: 3 }, 8], // beauxArts
  [{ shape: 0, roof: 0, finish: 3, gear: GEAR.AC, setback: 2, wall: 0xd98e73, windows: 3 }, 10], // pinkCorner
];

const FLAG = 0x80000000;

export function hasDesign(color: number): boolean { return (color & FLAG) !== 0; }

export function encodeDesign(d: Design): { color: number; h: number } {
  const c = FLAG | (d.shape & 7) | ((d.roof & 7) << 3) | ((d.finish & 7) << 6) | (((d.finish >> 3) & 1) << 30) | ((d.gear & 63) << 9) | ((d.setback & 15) << 15) | (((d.windows ?? 0) & 7) << 19) | (((d.wing ?? 0) & 3) << 22) | (((d.catalog ?? 0) & 63) << 24);
  return { color: c >>> 0, h: d.wall & 0xffffff };
}

export function decodeDesign(color: number, h: number): Design {
  return { shape: color & 7, roof: (color >> 3) & 7, finish: ((color >> 6) & 7) | (((color >>> 30) & 1) << 3), gear: (color >> 9) & 63, setback: (color >> 15) & 15, windows: (color >> 19) & 7, wing: (color >> 22) & 3, catalog: (color >>> 24) & 63, wall: Math.round(h) & 0xffffff };
}

/** Planta em partes no espaço local do lote (x ao longo da frente, z para a frente), dentro de w × d. */
export function footprint(shape: number, w: number, d: number): { rects: Array<[number, number, number, number]>; poly: Array<[number, number]> | null } {
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  const arm = Math.max(4, Math.min(w, d) * 0.4);
  switch (shape) {
    case 1: // L: faixa da frente inteira + braço do lado esquerdo até o fundo (sem sobrepor)
      return { rects: [[x0, x1, z1 - arm, z1], [x0, x0 + arm, z0, z1 - arm]], poly: null };
    case 2: // U: frente + dois braços
      return { rects: [[x0, x1, z1 - arm, z1], [x0, x0 + arm, z0, z1 - arm], [x1 - arm, x1, z0, z1 - arm]], poly: null };
    case 3: case 4: case 5: {
      const n = shape === 3 ? 20 : shape === 4 ? 6 : 8;
      const off = shape === 5 ? Math.PI / 8 : shape === 4 ? 0 : 0;
      const pts: Array<[number, number]> = [];
      for (let k = 0; k < n; k++) { const a = off + (k / n) * Math.PI * 2; pts.push([Math.cos(a) * w / 2, Math.sin(a) * d / 2]); }
      return { rects: [], poly: pts };
    }
    case 6: { // chanfrado: retângulo com cantos cortados
      const c = Math.min(w, d) * 0.18;
      return { rects: [], poly: [[x0 + c, z0], [x1 - c, z0], [x1, z0 + c], [x1, z1 - c], [x1 - c, z1], [x0 + c, z1], [x0, z1 - c], [x0, z0 + c]] };
    }
    default: return { rects: [[x0, x1, z0, z1]], poly: null };
  }
}

/** Catalog projects that stand as landmark towers (the rest are civic); the projects are world/catalog.ts. */
export const CIVIC_CATALOG = new Set(['bank', 'cemetery', 'church', 'cityHallBrick', 'cityHallWhite', 'fireStation', 'forum', 'hospitalA', 'hospitalB', 'police', 'school']);

