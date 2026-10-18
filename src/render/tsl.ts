// Os tipos do TSL no @types/three não aceitam aritmética mista de int/float
// nem variáveis reatribuídas; nos shaders usamos o TSL sem tipos estáticos.
import * as TSL from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const T: Record<string, any> = TSL;

/**
 * Vértice compacto (snorm16 posição, normal octaédrica snorm8): liga posição e
 * normal no material e devolve a normal de mundo como varying.
 */
export function useCompactVertex(m: { positionNode: Node; normalNode: Node }, name: string): Node {
  const { Fn, attribute, vec3, float, abs, max, select, normalize, varyingProperty, transformNormalToView } = T;
  const vN = varyingProperty('vec3', name);
  const vertex = Fn(() => {
    const e = attribute('nrm', 'vec4').xy;
    const n = vec3(e.x, e.y, float(1).sub(abs(e.x)).sub(abs(e.y))).toVar();
    const t = max(n.z.negate(), float(0));
    n.x.addAssign(select(n.x.greaterThanEqual(0), t.negate(), t));
    n.y.addAssign(select(n.y.greaterThanEqual(0), t.negate(), t));
    vN.assign(normalize(n));
    return attribute('position', 'vec4').xyz;
  });
  m.positionNode = vertex();
  m.normalNode = transformNormalToView(normalize(vN));
  return normalize(vN);
}

/**
 * Posição do quadro anterior para a velocidade do TRAA. O three só sabe a anterior pelo atributo `position` cru:
 * material que monta a posição no `positionNode` (terreno, água, props, veículos) gravava velocidade errada, o TRAA
 * dava peso total ao quadro atual ali e o chão e as árvores tremiam com tudo parado. `prev` = a mesma posição no
 * quadro anterior (veículos andando); sem ele, a atual (parado: só a câmera mexe).
 */
export function withPrevious<M extends { setupPosition: (b: Node) => Node }>(m: M, prev?: Node): M {
  const { positionLocal, positionPrevious } = T;
  const base = m.setupPosition.bind(m);
  m.setupPosition = (builder: Node) => {
    const r = base(builder);
    if (builder.needsPreviousData()) positionPrevious.assign(prev ?? positionLocal);
    return r;
  };
  return m;
}

/**
 * Máscara do esmaecimento entre níveis de detalhe: cada malha leva
 * `userData.fade` (0..1 entrando, −1..0 saindo); as duas máscaras se completam.
 */
export function lodFadeMask(): Node {
  const { uniform, interleavedGradientNoise, screenCoordinate, select } = T;
  const fade = uniform(1).onObjectUpdate(({ object }: { object: { userData: { fade?: number } } }) => object.userData.fade ?? 1);
  const n = interleavedGradientNoise(screenCoordinate.xy);
  return select(fade.greaterThanEqual(0), fade.sub(n), n.add(fade).add(1e-4)).greaterThan(0);
}
