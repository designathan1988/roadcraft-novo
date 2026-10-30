// Bus QA: a line with four corners round a block, then the camera follows the first bus for several frames.
// The point is the body staying on the lane and turning through the bend, not pivoting about its front.
// Usage: node tools/fotos-onibus-qa.mjs [folder]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'onibus-qa'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const makeLine = `(async()=>{const g=window.__cidade.game,n=g.world.roads,nc=n.nodes.cols;
  const picks=[];
  for(const [dx,dz] of [[-80,-80],[80,-80],[80,80],[-80,80]]){
    let best=-1,bd=1e9;
    for(let i=0;i<nc.x.length;i++){
      if(!n.nodes.alive[i]||nc.deg[i]<2)continue;
      const d=Math.hypot(nc.x[i]-(177+dx),nc.z[i]-(711+dz));
      if(d<bd){bd=d;best=i;}
    }
    if(best>=0)picks.push(nc.x[best],nc.z[best]);
  }
  g.api.line(0,picks,4);
  await g.view(177,711,35,18,90,11);
  ${wait(4500)}
})()`;
const follow = `(async()=>{const g=window.__cidade.game,r=g.vehicles.reader,d=r.data,n=g.world.roads,nc=n.nodes.cols;
  if(!g.vehicles.follow){
    let jx=0,jz=0,jd=1e9;
    for(let i=0;i<nc.x.length;i++){
      if(!n.nodes.alive[i]||nc.deg[i]<3)continue;
      const q=Math.hypot(nc.x[i]-g.rig.eye.x,nc.z[i]-g.rig.eye.z);
      if(q>30&&q<jd){jd=q;jx=nc.x[i];jz=nc.z[i];}
    }
    let best=-1,bd=1e9;
    for(let i=0;i<r.count;i++){
      const o=i*11; if(Math.floor((d[o+8]%65536)/256)!==1)continue;
      const dd=Math.hypot(d[o+4]-jx,d[o+6]-jz);
      if(dd<bd){bd=dd;best=i;}
    }
    if(best>=0){const o=best*11;g.vehicles.pick(d[o+4],d[o+6],40);g.rig.dist=28;g.rig.pitch=10*Math.PI/180;}
  }
  ${wait(2200)}
})()`;
const seq = [
  [path.join(out, '02-seguir-a.png'), follow],
  [path.join(out, '03-seguir-b.png'), follow],
  [path.join(out, '04-seguir-c.png'), follow],
  [path.join(out, '05-seguir-d.png'), follow],
  [path.join(out, '06-seguir-e.png'), follow],
  [path.join(out, '07-seguir-f.png'), follow],
  [path.join(out, '08-seguir-g.png'), follow],
  [path.join(out, '09-seguir-h.png'), follow],
  [path.join(out, '10-seguir-i.png'), follow],
  [path.join(out, '11-seguir-j.png'), follow],
  [path.join(out, '12-seguir-k.png'), follow],
  [path.join(out, '13-seguir-l.png'), follow],
  [path.join(out, '14-seguir-m.png'), follow],
];
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-linha-larga.png'),
  '?cidade&mapa=10&limpo&hora=11&cam=177,711,35,18,90', makeLine,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));
