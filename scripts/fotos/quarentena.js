// Foto da quarentena (depois de reparo.js, na mesma sessão): um ladrilho do salvamento estragado; ao abrir, ele volta do
// relevo original e o salvamento inteiro é copiado intacto para saves/quarentena-<data>-cidade-1 (nunca apagado).
(async () => {
  const g = __cidade.game, net = g.world.roads, X = 1500, Z = 1500;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = await navigator.storage.getDirectory(), saves = await root.getDirectoryHandle('saves'), dir = await saves.getDirectoryHandle('cidade-1');
  let broken = '';
  { const name = 'tile_0066.bin', h = await dir.getFileHandle(name); const wr = await h.createWritable(); await wr.write(new Uint8Array([1, 2, 3, 4, 5])); await wr.close(); broken = name; } // o ladrilho da cena (x, z = 1500 no mapa de 10 km)
  await g.saving.load(); await wait(1500);
  const q = []; for await (const [name] of saves) if (name.startsWith('quarentena')) q.push(name);
  console.log('RESULTADO quarentena ' + JSON.stringify({ estragado: broken, quarentena: q, vias: net.segs.size }));
  await g.view(X + 20, Z, 20, 55, 160, 11);
})()
