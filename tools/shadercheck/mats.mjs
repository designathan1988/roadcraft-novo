const THREE = globalThis.__THREE, build = globalThis.__build;
const { World } = await import('../../src/world/world.ts');
const { TerrainRenderer } = await import('../../src/render/terrain.ts');
const { createCity } = await import('../../src/render/city.ts');
const { createRoads, createTrafficLook } = await import('../../src/render/roads.ts');
const { RoadNetwork } = await import('../../src/roads/network.ts');
const w = new World();
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xb9cbdc, 0.00004);
const sun = new THREE.DirectionalLight(0xffffff, 3); scene.add(sun);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
const cam = new THREE.PerspectiveCamera(45, 1, 0.2, 60000);
const terrain = new TerrainRenderer(w);
const city = createCity(w, { submit() {} });
const warm = city.warmupMesh();
const roads = createRoads(new RoadNetwork(w), { submit() {} }, w.dirty, createTrafficLook(new SharedArrayBuffer(1 << 18)));
const warmRoad = roads.warmupMesh();
scene.add(terrain.mesh, warm, warmRoad);
const which = process.env.WHICH ?? 'wgsl';
for (const [name, mesh] of [['terreno', terrain.mesh], ['água', terrain.waterMesh], ['cascas', warm], ['vias', warmRoad]]) {
  try {
    const s = await build(mesh, scene, cam, which);
    console.log(`== ${name}: ok (${s.v.length} + ${s.f.length} chars)`);
    if (process.env.DUMP === name) console.log(s.v, '\n-----\n', s.f);
  } catch (e) { console.log(`== ${name}: ERRO`, e.stack); }
}
// peças (só WGSL: recorte em compute)
if (which === 'wgsl') {
  const { PropRenderer } = await import('../../src/render/props.ts');
  const pr = new PropRenderer(w, { submit() {} }, new SharedArrayBuffer(1 << 17), true);
  scene.add(pr.group);
  try {
    const s = await build(pr.group.children[0], scene, cam, which);
    console.log(`== peças: ok (${s.v.length} + ${s.f.length} chars)`);
    if (process.env.DUMP === 'peças') console.log(s.v, '\n-----\n', s.f);
  } catch (e) { console.log('== peças: ERRO', e.stack); }
  for (const name of ['reset', 'cull', 'clamp']) {
    try {
      const b = new globalThis.__THREE.WGSLNodeBuilder(null, globalThis.__renderer);
      b.compute = pr[name];
      b.build();
      console.log(`== compute ${name}: ok (${b.computeShader.length} chars)`);
      if (process.env.DUMP === name) console.log(b.computeShader);
    } catch (e) { console.log(`== compute ${name}: ERRO`, e.stack); }
  }
}
// tempo (nuvens, chuva, estrelas)
{
  const { Weather } = await import('../../src/render/weather.ts');
  const wt = new Weather();
  for (const [i, m] of wt.group.children.entries()) {
    try { const s = await build(m, scene, cam, which); console.log(`== tempo ${i}: ok (${s.v.length} + ${s.f.length} chars)`); }
    catch (e) { console.log(`== tempo ${i}: ERRO`, e.stack); }
  }
}
// peças no modo de compatibilidade (atributos instanciados)
{
  const { PropRenderer } = await import('../../src/render/props.ts');
  const pr = new PropRenderer(w, { submit() {} }, new SharedArrayBuffer(1 << 17), false);
  try { const s = await build(pr.group.children[0], scene, cam, which); console.log(`== peças (compat): ok (${s.v.length} + ${s.f.length} chars)`); }
  catch (e) { console.log('== peças (compat): ERRO', e.stack); }
}
