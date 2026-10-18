// Monta os shaders (WGSL e GLSL) dos materiais do jogo sem GPU, para pegar erros de TSL.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.navigator ??= {};
const THREE = await import('../../node_modules/three/build/three.webgpu.js');
const { WGSLNodeBuilder, GLSLNodeBuilder } = THREE;
const r = new THREE.WebGPURenderer({ canvas: { style: {}, addEventListener() {}, getContext() { return null; }, width: 100, height: 100 } });
r.backend.init = async () => {};
r.backend.hasFeature = () => false;
r.backend.compatibilityMode = false;
await r.init();

const mods = process.argv.slice(2);
export async function build(mesh, scene, camera, which = 'wgsl') {
  const B = which === 'wgsl' ? WGSLNodeBuilder : GLSLNodeBuilder;
  const b = new B(mesh, r);
  b.scene = scene; b.material = mesh.material; b.camera = camera; b.context.material = mesh.material;
  b.lightsNode = r.lighting.getNode(scene, camera);
  b.fogNode = r._nodes.getFogNode(scene);
  b.environmentNode = r._nodes.getEnvironmentNode(scene);
  b.build();
  return { v: b.vertexShader, f: b.fragmentShader };
}
globalThis.__build = build;
globalThis.__THREE = THREE;
globalThis.__renderer = r;
for (const m of mods) await import(new URL(m, import.meta.url).href);
